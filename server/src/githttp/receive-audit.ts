import { writeFileSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import type { DatabaseSync } from 'node:sqlite';
import { guardDetail, recordAuditEvent, settleAuditEvent, type AuditSubjectRef } from '../audit/audit.ts';

/**
 * receive 审计链（S3-T6；架构 §4.4、storage-model §6 跨存储发布审计模式）：
 *
 * 审计与 Git 引用更新不能假设跨存储原子提交——预记录先于引用更新，引用更新后
 * 核对实际结果置终态；异常（进程中断）不产生虚假成功，残留行标待核对（unresolved）
 * 由恢复对账消费（backup-recovery §7 步骤 7；清扫/查询见 audit/reconciliation.ts）。
 *
 * 生命周期与各锚点：
 * 1. pre-receive（receive 开始、任何 ref 更新前）：preRecordPendingPush 每 ref 命令
 *    一行 pending（同一事务批量预记录，storage-model §6）。审计写失败 → 整包拒绝
 *    （fail-closed：宁可拒推送，不产生无审计的引用更新）。
 * 2. pre-receive 自身拒绝（授权/内容校验）：settlePushRejected 全部行置 rejected。
 * 3. post-receive（git 已完成全部 ref 更新后）：settlePushByRefState 逐行核对
 *    ref 实际 OID——== new 置 succeeded（old→new 成链），否则置 rejected（如
 *    update 钩子拒绝 / 非快进拒绝：引用未到达该值，绝不虚报成功）。
 * 4. 中断（receive-pack 被杀、post-receive 未跑完）：行停留 pending，HTTP 层子进程
 *    退出后按 pushId 清扫 → unresolved；服务重启时全量清扫 → unresolved。
 *    quarantine 原子性兜底：pre-receive 阶段对象只落 <repo>/objects/incoming-*
 *    隔离区，receive-pack 异常终止时不会迁入主对象库（无半写对象）。
 *
 * E-LIMIT-004/005 计量挂接（T4 honest-gap 的消费侧）：pushBytes 由 HTTP 层计数
 * （CONTENT_LENGTH 直取；chunked 推送经计数透传流累计并落盘），vaultCurrentBytes
 * 由 pre-receive 就地测库目录占用（排除在途隔离区）——两者进校验器输入与审计
 * detail；判定阈值随 T8 配置生效。
 */

/** pushId：一次 HTTP receive 请求一个，HTTP 层生成经 CGI 环境透传给全部 hook */
export function newPushId(): string {
  return `push-${randomUUID()}`;
}

/** receive-pack 喂给 hook 的 ref 命令（与 pre-receive.ts RefCommand 同构） */
export interface PushCommand {
  readonly ref: string;
  readonly oldOid: string;
  readonly newOid: string;
}

/** 计数文件落盘路径（HTTP 层 → pre-receive 的 chunked 推送计量通道） */
export function pushBytesFile(repoPath: string, pushId: string): string {
  return path.join(repoPath, `notegit-push-${pushId}.bytes`);
}

/**
 * 读计数终值（chunked 推送）：HTTP 层在请求体流尽时写盘（计数流 flush 同步落笔），
 * 正常时序必先于 pre-receive；重试窗口仅为兜底。读不到返回 null（计量缺失：校验器
 * 输入省略 pushBytes，判定阈值 T8 生效——见文件头注释）。
 */
export async function readPushBytes(file: string, retryMs = 600): Promise<number | null> {
  const deadline = Date.now() + retryMs;
  for (;;) {
    try {
      const text = (await readFile(file, 'utf8')).trim();
      const n = Number(text);
      if (Number.isSafeInteger(n) && n >= 0) return n;
    } catch {
      // 未就绪或不可读——重试窗口内再来
    }
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 50));
  }
}

export interface PreRecordInput {
  readonly subject: AuditSubjectRef;
  readonly vaultId: number;
  readonly commands: readonly PushCommand[];
  readonly pushId: string;
  readonly occurredAt: string;
  /** 附加 detail（计量值等；pushId 恒注入） */
  readonly detail?: Record<string, unknown>;
}

/**
 * pending 预记录（storage-model §6 步骤 1）：BEGIN IMMEDIATE 单事务批量插入，
 * 全部成功才提交——多 ref 全有或全无。返回行 id（终态核对锚点）。
 */
export function preRecordPendingPush(db: DatabaseSync, input: PreRecordInput): number[] {
  const detail = { pushId: input.pushId, ...(input.detail ?? {}) };
  const ids: number[] = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const cmd of input.commands) {
      recordAuditEvent(db, {
        occurredAt: input.occurredAt,
        actorKind: 'employee',
        subject: input.subject,
        eventKind: 'vault.push',
        vaultId: input.vaultId,
        refName: cmd.ref,
        oldCommit: cmd.oldOid,
        newCommit: cmd.newOid,
        status: 'pending',
        detail,
      });
      ids.push(Number((db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id));
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return ids;
}

/** 行 detail 携带指定 pushId 的发布行（status 限定） */
function rowsOfPush(
  db: DatabaseSync,
  pushId: string,
  statuses: readonly string[],
): { id: number; ref_name: string | null; new_commit: string | null; detail: string }[] {
  const placeholders = statuses.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT id, ref_name, new_commit, detail FROM audit_events
       WHERE event_kind IN ('vault.push','vault.web_submit') AND status IN (${placeholders})`,
    )
    .all(...statuses) as { id: number; ref_name: string | null; new_commit: string | null; detail: string }[];
  return rows.filter((row) => {
    try {
      return (JSON.parse(row.detail) as { pushId?: string }).pushId === pushId;
    } catch {
      return false;
    }
  });
}

/**
 * pre-receive 拒绝路径：该 pushId 全部（或指定 ref 的）pending 行置 rejected
 * （原因入 detail）。refName 给定时只清算该 ref 命令的行（update 执行点拒绝
 * 的合流路径——T5/T6 集成裁决：一行一命令的生命周期，不另起行）。返回清算行数。
 */
export function settlePushRejected(
  db: DatabaseSync,
  opts: { pushId: string; reason: string; detail?: Record<string, unknown>; refName?: string },
): number {
  let settled = 0;
  for (const row of rowsOfPush(db, opts.pushId, ['pending'])) {
    if (opts.refName !== undefined && row.ref_name !== opts.refName) continue;
    settleAuditEvent(db, row.id, 'rejected', { reason: opts.reason, ...(opts.detail ?? {}) });
    settled += 1;
  }
  return settled;
}

export interface SettleByRefStateInput {
  readonly pushId: string;
  /** ref 实际 OID（null = ref 不存在；删除命令 new 为全零时与 null 相等） */
  readonly actualOf: (refName: string) => Promise<string | null>;
  /** 终态合并 detail（rulesVersion / 计量终值等） */
  readonly detail?: Record<string, unknown>;
}

/**
 * post-receive 终态核对（storage-model §6 步骤 3）：逐行核对引用实际结果——
 * actual == new_commit 置 succeeded（old→new 成链），否则 rejected（引用未到达
 * 预期值：update 拒绝 / 非快进拒绝 / 后续推送已改值——不虚报成功）。
 * ref 不存在（actual=null）与全零 OID 同态：删除命令成功删除即 succeeded（DDL
 * 注释：删除 ref 时 new_commit 为全零 OID）。
 * 只动 pending/unresolved 行，不翻已定终态。
 */
export async function settlePushByRefState(db: DatabaseSync, input: SettleByRefStateInput): Promise<void> {
  const ZERO_OID = '0'.repeat(40);
  for (const row of rowsOfPush(db, input.pushId, ['pending', 'unresolved'])) {
    const actual = row.ref_name === null ? null : await input.actualOf(row.ref_name);
    const achieved = (actual ?? ZERO_OID) === (row.new_commit ?? ZERO_OID);
    settleAuditEvent(db, row.id, achieved ? 'succeeded' : 'rejected', input.detail);
  }
}

/**
 * push 字节计数透传流（HTTP 层计量点）：字节原样透传、精确累计，流结束时把终值
 * 同步落盘（writeFileSync——flush 钩子内完成，读方无竞态窗口）。落盘失败只留痕
 * 不阻断推送（计量缺失时校验器输入省略，判定阈值 T8 生效）。
 */
export function createPushByteCounter(file: string): Transform & { readonly bytes: number } {
  let bytes = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, cb) {
      bytes += chunk.length;
      cb(null, chunk);
    },
    flush(cb) {
      try {
        writeFileSync(file, String(bytes));
      } catch (err) {
        console.error(`[notegit githttp] 警告：push 计量落盘失败（${file}）：${err instanceof Error ? err.message : String(err)}`);
      }
      cb();
    },
  });
  // defineProperty 而非 Object.assign：后者取值快照（getter 被立即求值），读不到累计值
  Object.defineProperty(counter, 'bytes', { get: () => bytes });
  return counter as Transform & { readonly bytes: number };
}

/**
 * 库当前占用字节（E-LIMIT-005 计量；E-LIMIT-005 = vaultCurrentBytes + pushBytes）：
 * 递归求和库目录全部文件，排除 objects/incoming-*（receive 在途隔离区对象——
 * 排除后即「推送前存量」口径）。
 */
export async function measureVaultBytes(repoDir: string): Promise<number> {
  let total = 0;
  const walk = async (dir: string, depth: { inObjects: boolean }): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (depth.inObjects && entry.name.startsWith('incoming-')) continue; // quarantine
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(child, { inObjects: depth.inObjects || entry.name === 'objects' });
      } else if (entry.isFile()) {
        total += (await stat(child)).size;
      }
    }
  };
  await walk(repoDir, { inObjects: false });
  return total;
}
