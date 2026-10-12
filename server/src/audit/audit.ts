import type { DatabaseSync } from 'node:sqlite';

/**
 * 审计事件基座（S2-T7；identity §8 唯一语义源，storage-model §3.8 落库形态）。
 *
 * - 主体 = 认证员工（employee_id）+ 凭据载体标识（credential_ref：credential:<id> /
 *   session:<id>，不含任何 token 材料）+ 入口（entry：web/api/git，architecture-notes
 *   §7.4 归因——载体优先级由认证缝 auth/lifecycle.ts 定稿，本模块只消费其 AuthSuccess）。
 * - commit author/committer 是客户端可填的内容元数据：只可能出现在 detail，永不进入
 *   主体字段（identity §8；架构 §4.4「以服务端认证身份记录实际推送者」）。
 * - 敏感信息脱敏 fail-closed：detail 含 ngt_ 明文或口令/密钥类键名、credential_ref 非
 *   限定形态 → 抛 AuditMaskingError，行不落库（凭据明文不入审计，identity §3.1/§8）。
 * - 发布类事件（vault.push / vault.web_submit）以 pending 预记录，引用更新后置终态
 *   （settleAuditEvent；storage-model §6）；管理类事件直接以终态插入（§5）。
 * - 排空计数 drainCount = backup-recovery §4 步骤 2 的 audit.drain_count 规范查询。
 *
 * event_kind 唯一注册表 = storage-model §5（D6 只读）；本基座不做 kind 白名单硬校验
 * （注册表演进走契约修订），但调用方（路由挂接点）只使用注册表内 kind。
 */

/** 脱敏守卫违规（identity §3.1/§8：凭据明文不入审计；fail-closed，行不落库） */
export class AuditMaskingError extends Error {
  constructor(field: string, reason: string) {
    super(`audit masking violation (${field}): ${reason}`);
    this.name = 'AuditMaskingError';
  }
}

export type AuditActorKind = 'employee' | 'bootstrap' | 'system';
export type AuditEntryKind = 'web' | 'api' | 'git';
export type AuditStatus = 'pending' | 'succeeded' | 'rejected' | 'unresolved';

/**
 * 主体归因（identity §8）：来自认证缝 AuthSuccess——认证员工 + 载体标识 + 入口。
 * 载体优先级（Authorization 头在场即优先，否则会话 Cookie）已在认证缝内定稿
 * （architecture-notes §7.1），调用方不得另行挑选载体。
 */
export interface AuditSubjectRef {
  readonly employeeId: number;
  /** credential:<id> / session:<id>（DDL 注释契约：不含任何 token 材料） */
  readonly carrierRef: string;
  /** 入口（identity §8）：Git Smart HTTP 入口自 S3-T5 起以 'git' 归因（Basic →
   *  token 载体，carrierRef 仍为 credential:<id>） */
  readonly entry: 'web' | 'api' | 'git';
}

export interface AuditEventInput {
  /** 服务端时钟（架构 §4.4；调用方注入，测试可控时） */
  occurredAt: string;
  actorKind: AuditActorKind;
  /** employee 主体必填（DDL 注释：employee_id NULL 当且仅当 actor_kind != 'employee'） */
  subject?: AuditSubjectRef;
  /** 非 employee 主体的入口（bootstrap=K5 初始化走 HTTP API；system=应用自身） */
  entry?: AuditEntryKind;
  /** employee 主体的无载体形态（K5 一次性令牌消费等）：目标员工 id 直填，
   *  credential_ref NULL（K5 非凭据载体——identity §8 载体 = credential/session） */
  employeeId?: number;
  eventKind: string;
  vaultId?: number | null;
  refName?: string | null;
  oldCommit?: string | null;
  newCommit?: string | null;
  /** 管理类缺省 succeeded（直接终态）；发布类预记录 pending（storage-model §5/§6） */
  status?: AuditStatus;
  detail?: Record<string, unknown>;
}

/** credential_ref 限定形态（DDL 注释：credential:<id> / session:<短哈希标识>——本基座用行 id） */
const CARRIER_REF_PATTERN = /^(credential|session):\d+$/;

/** ngt_ 明文形态：前缀 + ≥20 连续 token 字符（掩码形态 ngt_ab…wxyz 仅 2+4，不命中） */
const NGT_PLAINTEXT_PATTERN = /ngt_[A-Za-z0-9_-]{20,}/;

/** 口令/密钥类敏感键名（任意深度的 detail 键）——这类值根本不该进审计 */
const SENSITIVE_KEY_PATTERN = /password|passphrase|secret|authorization/i;

function maskGuard(field: string, text: string): void {
  if (NGT_PLAINTEXT_PATTERN.test(text)) {
    throw new AuditMaskingError(field, 'ngt_ token 明文不得进入审计（identity §3.1/§8）');
  }
}

function guardDetail(detail: Record<string, unknown>): string {
  maskGuard('detail', JSON.stringify(detail));
  const walk = (obj: Record<string, unknown>): void => {
    for (const [key, value] of Object.entries(obj)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        throw new AuditMaskingError(`detail.${key}`, '口令/密钥类键名不得进入审计（凭据明文不入审计）');
      }
      if (value !== null && typeof value === 'object') walk(value as Record<string, unknown>);
    }
  };
  walk(detail);
  return JSON.stringify(detail);
}

/** 审计事件写入（管理类直接终态；发布类 pending 预记录——storage-model §5/§6） */
export function recordAuditEvent(db: DatabaseSync, input: AuditEventInput): void {
  const subject = input.subject;
  if (input.actorKind === 'employee') {
    if (subject === undefined && input.employeeId === undefined) {
      throw new AuditMaskingError('subject', 'actor_kind=employee 必须携带认证主体（subject 或 employeeId）');
    }
  } else if (subject !== undefined || input.employeeId !== undefined) {
    throw new AuditMaskingError('subject', 'actor_kind != employee 不得携带员工主体（DDL 注释一致性）');
  }
  if (input.subject !== undefined && input.employeeId !== undefined) {
    throw new AuditMaskingError('subject', 'subject 与 employeeId 互斥（二选一归因形态）');
  }
  if (subject !== undefined && !CARRIER_REF_PATTERN.test(subject.carrierRef)) {
    throw new AuditMaskingError('credential_ref', '载体标识只接受 credential:<id> / session:<id>（不含任何凭据材料）');
  }
  const entry: AuditEntryKind = subject?.entry ?? input.entry ?? 'api';
  const detail = guardDetail(input.detail ?? {});
  db.prepare(
    `INSERT INTO audit_events
       (occurred_at, actor_kind, employee_id, credential_ref, entry, event_kind,
        vault_id, ref_name, old_commit, new_commit, status, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.occurredAt,
    input.actorKind,
    subject?.employeeId ?? input.employeeId ?? null,
    subject?.carrierRef ?? null,
    entry,
    input.eventKind,
    input.vaultId ?? null,
    input.refName ?? null,
    input.oldCommit ?? null,
    input.newCommit ?? null,
    input.status ?? 'succeeded',
    detail,
  );
}

/** 终态置位（storage-model §6 步骤 3：引用更新后核对结果；恢复对账标 unresolved 用） */
export function settleAuditEvent(
  db: DatabaseSync,
  id: number,
  status: Exclude<AuditStatus, 'pending'>,
  detailMerge?: Record<string, unknown>,
): void {
  if (detailMerge === undefined) {
    db.prepare('UPDATE audit_events SET status = ? WHERE id = ?').run(status, id);
    return;
  }
  const row = db.prepare('SELECT detail FROM audit_events WHERE id = ?').get(id) as { detail: string } | undefined;
  if (row === undefined) throw new Error(`audit event ${id} not found`);
  const merged = { ...JSON.parse(row.detail), ...detailMerge };
  db.prepare('UPDATE audit_events SET status = ?, detail = ? WHERE id = ?').run(status, guardDetail(merged), id);
}

/** storage-model §4 `-- @query audit.drain_count` 规范 SQL（逐字；防漂移测试对照契约原文） */
export const AUDIT_DRAIN_COUNT_SQL = `-- 排空检查（backup-recovery §4 步骤 2）：权威数据上无 pending/unresolved 写操作。
-- 参数：无
SELECT COUNT(*) AS n FROM audit_events WHERE status IN ('pending','unresolved');`;

/**
 * 排空计数（backup-recovery §4 步骤 2）：权威数据上无 pending/unresolved 写操作
 * 才允许进入快照步骤。单进程传播上界 0 ⇒ 开启闸门后即可调用（backup §3）。
 */
export function drainCount(db: DatabaseSync): number {
  const compiled = db.prepare(AUDIT_DRAIN_COUNT_SQL);
  return (compiled.get() as { n: number }).n;
}
