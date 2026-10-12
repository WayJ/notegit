import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { reauthorizeAtExecutionPoint } from '../auth/lifecycle.ts';
import { recordAuditEvent } from '../audit/audit.ts';
import { branchWriteRules } from '../vaults/branch-rules.ts';
import { createDbMembershipSource } from '../vaults/membership.ts';
import { parseRemoteUser } from './cgi.ts';
import { refCommandRejection, type RefCommand } from './ref-rules.ts';
import { settlePushRejected } from './receive-audit.ts';

/**
 * update hook（S3-T5 写路径执行点复查；identity §5.1 第 3 层 / §5.2 行 4）：
 * git 在每个 ref 实际更新前逐 ref 调用（argv：<refname> <old> <new>；exit 非 0
 * 只拒绝该 ref）。消费 S2-T5 预留的 reauthorizeAtExecutionPoint 钩子——pre-receive
 * 检查通过后、执行点之前落在途的权限/配置变更在此实时复查并拒绝：
 *
 * - 成员撤权 → 拒（identity §5.2 行 4「在途 push 在执行点复查时被拒并记审计」）；
 * - 降级为只读 → 拒（任何写）；
 * - main_admin_only 开启 / 默认分支配置变化 → 按当前配置拒（refCommandRejection
 *   与 pre-receive 同一判定源 ref-rules.ts——ref 级规则两检查点同构）。
 *
 * 凭据级状态（过期/撤销/账号停用）不在本层复查——identity §5.3 在途条款：按其
 * 认证通过时刻放行完成，状态变更自下一请求生效。维护模式标志复查位（backup-
 * recovery §3）留给后续任务在同一执行点叠加。
 *
 * 拒绝即落审计：vault.push / status=rejected / entry=git，主体 = REMOTE_USER 的
 * 认证员工 + credential:<id> 载体（架构 §4.4；不信任 commit author）。这是 identity
 * §5.2 行 4 要求的执行点拒绝审计；S3-T6 的 pending 预记录与终态成链落地后与本
 * 行的关系（settle 合并或并存）由集成时 master 仲裁——detail.checkpoint='update'
 * 标记本行来源。放行不写审计（成功路径的审计预记录属 S3-T6）。
 *
 * 本文件既被 git 作为子进程执行（entry guard），也被测试导入其纯判定面
 * （executionPointRecheck）——导入不触发 hook 行为。
 */

/** 执行点复查结果：allowed=false 时 reason 为拒绝原因（stderr 与审计 detail 同源） */
export interface ExecutionPointOutcome {
  readonly allowed: boolean;
  readonly reason: string | null;
}

export interface ExecutionPointInput {
  readonly cmd: RefCommand;
  /** 认证主体（REMOTE_USER 解析面：cgi.ts parseRemoteUser） */
  readonly employeeId: number;
  readonly vaultSlug: string;
  /** NOTEGIT_VAULT_ID（CGI 层由 DB 稳定 ID 映射注入；撤权后仍可作为审计归属） */
  readonly vaultId: number;
}

/**
 * 执行点实时复查（纯判定面；全部实时查库、无缓存——D-IC-05）：
 * 1. reauthorizeAtExecutionPoint（identity §5.1 第 3 层）→ 撤权/非成员拒、只读拒；
 * 2. 重读库行取 BranchWriteRules → refCommandRejection（与 pre-receive 同源）。
 * 判定与审计解耦：调用方（hook 入口）负责拒绝时的审计写入。
 */
export function executionPointRecheck(db: DatabaseSync, input: ExecutionPointInput): ExecutionPointOutcome {
  const decision = reauthorizeAtExecutionPoint(
    createDbMembershipSource(db),
    input.employeeId,
    input.vaultSlug,
  );
  if (!decision.allowed) {
    if (decision.reason === 'forbidden') {
      return { allowed: false, reason: `${input.cmd.ref}：只读成员不可推送（执行点复查）` };
    }
    return {
      allowed: false,
      reason: `employee=${input.employeeId} 于 ${input.vaultSlug} 无成员关系（执行点复查：检查后、执行点前撤权或非成员）——拒绝`,
    };
  }
  const vault = db
    .prepare('SELECT default_branch, main_admin_only FROM vaults WHERE id = ?')
    .get(input.vaultId) as { default_branch: string; main_admin_only: number } | undefined;
  if (vault === undefined) {
    return { allowed: false, reason: `vault id=${input.vaultId} 配置缺失（执行点复查）——fail-closed 拒绝` };
  }
  const rejection = refCommandRejection(input.cmd, branchWriteRules(vault), decision.role);
  return rejection === null ? { allowed: true, reason: null } : { allowed: false, reason: rejection };
}

// ── hook 进程入口（仅当 git 以本文件为可执行脚本调用时运行）────────────────

const invokedAsHook =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsHook) {
  void main();
}

async function main(): Promise<void> {
  let code = 1;
  try {
    code = await check();
  } catch (err) {
    console.error(`[notegit update] 异常拒绝：${err instanceof Error ? err.message : String(err)}`);
  }
  process.exit(code);
}

async function check(): Promise<number> {
  const [refname = '', oldOid = '', newOid = ''] = process.argv.slice(2);
  const parsed = parseRemoteUser(process.env['REMOTE_USER'] ?? '');
  const dbFile = process.env['NOTEGIT_DB'];
  const vaultIdRaw = process.env['NOTEGIT_VAULT_ID'];
  const slug = process.env['NOTEGIT_VAULT_SLUG'];
  const vaultId = /^\d+$/.test(vaultIdRaw ?? '') ? Number(vaultIdRaw) : Number.NaN;
  if (
    refname === '' ||
    oldOid === '' ||
    newOid === '' ||
    parsed === null ||
    dbFile === undefined ||
    slug === undefined ||
    !Number.isSafeInteger(vaultId)
  ) {
    console.error('[notegit update] 环境缺失（argv/REMOTE_USER/NOTEGIT_DB/NOTEGIT_VAULT_ID/NOTEGIT_VAULT_SLUG）——fail-closed 拒绝');
    return 1;
  }

  // 审计写入需要读写连接（S3-T6 起 pre-receive 预记录同为读写连接）；
  // busy_timeout 对齐应用连接（selection §4），避免与应用并发写撞 SQLITE_BUSY
  const db = new DatabaseSync(dbFile);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA foreign_keys = ON');
    const { allowed, reason } = executionPointRecheck(db, {
      cmd: { ref: refname, oldOid, newOid },
      employeeId: parsed.employeeId,
      vaultSlug: slug,
      vaultId,
    });
    if (allowed || reason === null) return 0; // reason 与 allowed 反相（构造保证）
    console.error(`[notegit update] 拒绝：${reason}`);
    auditRejection(db, {
      employeeId: parsed.employeeId,
      credentialId: parsed.credentialId,
      vaultId,
      cmd: { ref: refname, oldOid, newOid },
      reason,
    });
    return 1;
  } finally {
    db.close();
  }
}

/**
 * 拒绝审计（vault.push/rejected/entry=git）。审计写失败不改变拒绝本身（fail-closed
 * 于写判定，审计异常走 stderr 运维可见——拒绝已生效，不因审计故障放行）。
 *
 * S3-T6 集成裁决（T5 留下的「settle 合并或并存由集成时仲裁」）：HTTP 集成形态经
 * NOTEGIT_PUSH_ID 关联 pre-receive 预记录的 pending 行——settle 为 rejected
 * （一行一命令的生命周期，不另起行）；无 pushId 或无预记录行（T5 直调测试形态、
 * 旁路调用）时回退独立插行，行为与 S3-T5 落地时一致。detail.checkpoint='update'
 * 两种形态都标记执行点来源。
 */
function auditRejection(
  db: DatabaseSync,
  input: {
    employeeId: number;
    credentialId: number;
    vaultId: number;
    cmd: RefCommand;
    reason: string;
  },
): void {
  const pushId = process.env['NOTEGIT_PUSH_ID'];
  if (pushId !== undefined) {
    try {
      const settled = settlePushRejected(db, {
        pushId,
        refName: input.cmd.ref,
        reason: input.reason,
        detail: { checkpoint: 'update' },
      });
      if (settled > 0) return;
    } catch (err) {
      console.error(`[notegit update] 预记录清算失败（回退独立插行）：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  try {
    recordAuditEvent(db, {
      occurredAt: new Date().toISOString(), // 服务端时钟（架构 §4.4；hook 即服务端进程）
      actorKind: 'employee',
      subject: {
        employeeId: input.employeeId,
        carrierRef: `credential:${input.credentialId}`,
        entry: 'git',
      },
      eventKind: 'vault.push',
      vaultId: input.vaultId,
      refName: input.cmd.ref,
      oldCommit: input.cmd.oldOid,
      newCommit: input.cmd.newOid,
      status: 'rejected',
      detail: { checkpoint: 'update', reason: input.reason },
    });
  } catch (err) {
    console.error(`[notegit update] 审计写入失败（拒绝仍然生效）：${err instanceof Error ? err.message : String(err)}`);
  }
}
