import type { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { drainCount, guardDetail, settleAuditEvent } from './audit.ts';
import { refReachedExpected } from '../githttp/receive-audit.ts';
import { runGit } from '../githttp/git-spawn.ts';
import { verifyVaultStoreConsistency } from '../gitrepo/lifecycle.ts';
import { vaultRepoPath } from '../vaults/repo-path.ts';

/**
 * 恢复对账查询与残留清扫（S3-T6；backup-recovery §5 不变量 1–2、§7 步骤 7），
 * S8-T6 扩展出显式对账入口 runRecoveryReconciliation（全量/显式形态——复用
 * 既有面，不重写）：
 *
 * - auditChain：storage-model §4 `-- @query audit.chain` 规范 SQL 的逐字化身
 *   （防漂移测试对照契约原文）——库内发布类成功事件 old→new 有序序列，与各 ref
 *   当前 OID 相邻成链即 §5 不变量 1。
 * - listPendingReconciliation：pending/unresolved 发布行清单（S8 恢复对账的消费
 *   接口，最小实现——对账流程按「行 new_commit vs ref 实际 OID」定终态：
 *   相等 → succeeded，不等 → rejected；见架构 §4.4「异常操作通过恢复核对标为
 *   成功、拒绝或待核对」）。
 * - sweepOrphanedPending：中断残留 pending → unresolved（待核对）。两类触发：
 *   进程内 receive 子进程退出后按 pushId 定域清扫（不误伤并发在途推送）；
 *   启动时全量清扫（单进程假设下启动时不存在在途写，残留皆为上次进程崩溃所留）。
 * - runRecoveryReconciliation：backup §7 步骤 7 的恢复核对全流程——① 维护态
 *   断言（未开维护即拒绝动手，fail-closed；经运行实例端点的实现见
 *   backup/run.ts httpMaintenanceControl）→ ② pending/unresolved 行按 refs 实际
 *   OID 定终态（判定规则与 post-receive 同源 refReachedExpected）→ ③ 全部库
 *   成链核对（verifyVaultRefChains：链首出生、相邻成链、链尾==实际、实际 ref
 *   无未记录者——§5 不变量 1–2）→ ④ 孤儿双向核对（consume
 *   verifyVaultStoreConsistency——不变量 3）→ ⑤ 收尾再断言维护仍在（完成前
 *   不得退出维护；对账器结构性不动闸门，只断言不切换）→ 逐项+汇总报告。
 */

/** storage-model §4 `-- @query audit.chain` 规范 SQL（逐字；防漂移测试对照契约原文） */
export const AUDIT_CHAIN_SQL = `-- 引用-审计成链核对（backup-recovery §5.1）：库内发布类成功事件的 old→new 序列，
-- 与各 ref 当前 OID 比对（应用层执行；恢复对账 §7 步骤 7 使用）。
-- 参数：?1 = vault_id
SELECT ref_name, old_commit, new_commit
FROM audit_events
WHERE vault_id = ?
  AND event_kind IN ('vault.push','vault.web_submit')
  AND status = 'succeeded'
ORDER BY occurred_at, id;`;

export interface AuditChainRow {
  readonly ref_name: string;
  readonly old_commit: string;
  readonly new_commit: string;
}

/** 引用-审计成链核对（backup-recovery §5.1）：成功终态 old→new 有序序列 */
export function auditChain(db: DatabaseSync, vaultId: number): AuditChainRow[] {
  return db.prepare(AUDIT_CHAIN_SQL).all(vaultId) as unknown as AuditChainRow[];
}

export interface PendingReconciliationRow {
  readonly id: number;
  readonly vault_id: number;
  readonly employee_id: number | null;
  readonly ref_name: string | null;
  readonly old_commit: string | null;
  readonly new_commit: string | null;
  readonly status: string;
  readonly occurred_at: string;
}

/** S8 恢复对账消费面（backup §7 步骤 7）：pending/待核对 发布行，按 id 置终态 */
export function listPendingReconciliation(db: DatabaseSync): PendingReconciliationRow[] {
  return db
    .prepare(
      `SELECT id, vault_id, employee_id, ref_name, old_commit, new_commit, status, occurred_at
       FROM audit_events
       WHERE event_kind IN ('vault.push','vault.web_submit')
         AND status IN ('pending','unresolved')
       ORDER BY id`,
    )
    .all() as unknown as PendingReconciliationRow[];
}

interface OpenPublishRow {
  readonly id: number;
  readonly status: string;
  readonly detail: string;
}

/** 发布类（审计主体行 detail JSON 携带 pushId 时的推送行） */
function openPublishRows(db: DatabaseSync, status: 'pending' | 'unresolved'): OpenPublishRow[] {
  return db
    .prepare(
      `SELECT id, status, detail FROM audit_events
       WHERE event_kind IN ('vault.push','vault.web_submit') AND status = ?`,
    )
    .all(status) as unknown as OpenPublishRow[];
}

/**
 * 中断残留清扫：pending → unresolved（待核对）。pushId 给定时只清扫该次推送的行
 * （并发在途推送不受殃及）；缺省全量（启动恢复形态——单进程假设下启动时无在途写）。
 * 返回清扫行数。
 */
export function sweepOrphanedPending(
  db: DatabaseSync,
  opts: { pushId?: string; reason: string },
): number {
  const rows = openPublishRows(db, 'pending').filter((row) => {
    if (opts.pushId === undefined) return true;
    try {
      return (JSON.parse(row.detail) as { pushId?: string }).pushId === opts.pushId;
    } catch {
      return false; // detail 非法 JSON：不在本 pushId 域内，留给全量清扫/对账
    }
  });
  const update = db.prepare(`UPDATE audit_events SET status = 'unresolved', detail = ? WHERE id = ?`);
  for (const row of rows) {
    let merged: Record<string, unknown>;
    try {
      merged = JSON.parse(row.detail) as Record<string, unknown>;
    } catch {
      merged = {};
    }
    update.run(guardDetail({ ...merged, reason: opts.reason }), row.id);
  }
  return rows.length;
}

// ── S8-T6 显式恢复对账（backup-recovery §7 步骤 7 的全量/显式形态）──────────

/** 对账流程失败（fail-closed中止；stage 标失败面：maintenance=维护断言） */
export class ReconciliationError extends Error {
  readonly stage: string;
  constructor(message: string, stage: string) {
    super(message);
    this.name = 'ReconciliationError';
    this.stage = stage;
  }
}

/**
 * 读库实际引用全集（git for-each-ref；空初始化库 → 空集）。引用名→OID 全量
 * 呈现——对账定终态与成链核对的「实际 refs」唯一读取面（OID 自运行时派生）。
 */
export async function readVaultRefs(repoDir: string): Promise<Map<string, string>> {
  const out = await runGit(['for-each-ref', '--format=%(refname) %(objectname)'], { cwd: repoDir });
  const refs = new Map<string, string>();
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const sep = trimmed.indexOf(' ');
    if (sep <= 0) continue;
    refs.set(trimmed.slice(0, sep), trimmed.slice(sep + 1));
  }
  return refs;
}

/** 一行待核对发布行的终态处置结果（逐项报告单位） */
export interface ReconcileSettlement {
  readonly id: number;
  readonly vaultId: number | null;
  readonly refName: string | null;
  readonly from: 'pending' | 'unresolved';
  readonly newCommit: string | null;
  readonly actualOid: string | null;
  readonly to: 'succeeded' | 'rejected';
}

/** 单引用成链核对（§5 不变量 1–2 的逐 ref 结论） */
export interface ChainRefCheck {
  readonly ref: string;
  /** ref 当前实际 OID（磁盘上不存在 = null） */
  readonly actualOid: string | null;
  /** 成功终态序列末条 new（无任何成功记录 = null——unrecorded-ref 形态） */
  readonly lastRecordedNew: string | null;
  readonly problems: readonly string[];
}

/** 单库成链核对结论（vaultProblems 为库级：repo-unreadable） */
export interface ChainVaultCheck {
  readonly vaultId: number;
  readonly ok: boolean;
  readonly vaultProblems: readonly string[];
  readonly refs: readonly ChainRefCheck[];
}

const CHAIN_ZERO = '0'.repeat(40);

/**
 * 成链核对（backup §5 不变量 1–2）：每库成功终态序列 vs 实际 refs——
 * 链首出生（首条 old=全零）、相邻成链（第 n 条 old == 第 n-1 条 new）、
 * 链尾 == ref 实际 OID（无「记成功但 ref 未更新」及反向）、实际存在的 ref
 * 无未记录者。refs 为 null = 库目录不可读（库级 repo-unreadable）。
 */
export function verifyVaultRefChains(
  db: DatabaseSync,
  vaultIds: readonly number[],
  refsByVault: ReadonlyMap<number, ReadonlyMap<string, string> | null>,
): ChainVaultCheck[] {
  return vaultIds.map((vaultId) => {
    const refs = refsByVault.get(vaultId) ?? null;
    if (refs === null) {
      return { vaultId, ok: false, vaultProblems: ['repo-unreadable'], refs: [] };
    }
    // auditChain 按 (occurred_at, id) 有序——按 ref 分组保序聚合
    const byRef = new Map<string, { old_commit: string | null; new_commit: string | null }[]>();
    for (const row of auditChain(db, vaultId)) {
      const list = byRef.get(row.ref_name) ?? [];
      list.push(row);
      byRef.set(row.ref_name, list);
    }
    const refNames = new Set<string>([...refs.keys(), ...byRef.keys()]);
    const refChecks: ChainRefCheck[] = [...refNames].sort().map((ref) => {
      const records = byRef.get(ref) ?? [];
      const actualOid = refs.get(ref) ?? null;
      const problems = new Set<string>();
      if (records.length === 0) {
        problems.add('unrecorded-ref'); // ref 实际存在但无成功终态记录（不变量 1 反向）
      } else {
        if ((records[0]!.old_commit ?? CHAIN_ZERO) !== CHAIN_ZERO) {
          problems.add('first-old-not-zero'); // 记录不从出生开始——历史缺口
        }
        for (let i = 1; i < records.length; i++) {
          if ((records[i]!.old_commit ?? CHAIN_ZERO) !== (records[i - 1]!.new_commit ?? CHAIN_ZERO)) {
            problems.add('gap'); // 相邻断链
          }
        }
        const lastNew = records[records.length - 1]!.new_commit ?? CHAIN_ZERO;
        if (lastNew !== (actualOid ?? CHAIN_ZERO)) {
          problems.add('final-link-mismatch'); // 记成功但 ref 未更新 / ref 越过记录（不变量 2）
        }
      }
      return {
        ref,
        actualOid,
        lastRecordedNew: records.length === 0 ? null : records[records.length - 1]!.new_commit,
        problems: [...problems],
      };
    });
    return {
      vaultId,
      ok: refChecks.every((r) => r.problems.length === 0),
      vaultProblems: [],
      refs: refChecks,
    };
  });
}

/** 恢复对账逐项+汇总报告（backup §7 步骤 7 产物；§8 R11 消费） */
export interface ReconciliationReport {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly vaultIds: readonly number[];
  readonly settled: readonly ReconcileSettlement[];
  readonly chains: readonly ChainVaultCheck[];
  readonly orphanRepoIds: readonly number[];
  readonly missingRepoIds: readonly number[];
  readonly maintenance: { readonly assertedAtStart: true; readonly stillEnabledAtEnd: boolean };
  readonly summary: {
    readonly settled: number;
    readonly succeeded: number;
    readonly rejected: number;
    readonly pendingResidue: number;
    readonly chainViolationRefs: number;
    readonly orphanRepos: number;
    readonly missingRepos: number;
    readonly ok: boolean;
  };
}

export interface ReconcileOptions {
  readonly db: DatabaseSync;
  readonly dataDir: string;
  /** 维护态断言缝：isEnabled 经运行实例维护端点如实呈现（backup §3 生效机制） */
  readonly control: { isEnabled(): Promise<boolean> };
  readonly now?: () => Date;
}

/**
 * 恢复对账全流程（backup-recovery §7 步骤 7）：维护断言 → 待核行列定终态 →
 * 成链核对 → 孤儿核对 → 收尾维护断言 → 报告。对账器不动维护闸门（只断言不
 * 切换——退出维护走维护生命周期端点，由恢复流程步骤 10 人工执行）；判不通过
 * 也不退出维护（异常态留人工裁决）。维护未开 → ReconciliationError，零行被改。
 */
export async function runRecoveryReconciliation(opts: ReconcileOptions): Promise<ReconciliationReport> {
  const now = opts.now ?? (() => new Date());
  const startedAt = now().toISOString();

  // ① 维护断言（fail-closed：对账只在维护模式下执行——§7 步骤 7 前置「仍处维护
  //    模式」由部署/恢复流程保证，此处诚实复核，不达标不动任何数据）
  if (!(await opts.control.isEnabled())) {
    throw new ReconciliationError(
      '维护模式未开启：恢复对账只在维护模式下执行（backup-recovery §7 步骤 7）——先经实例维护端点开启后重试',
      'maintenance',
    );
  }

  // 各库实际引用全集（每库读一次，定终态与成链核对共用；不可读 = null 留库级问题）
  const vaultIds = (
    opts.db.prepare('SELECT id FROM vaults ORDER BY id').all() as { id: number }[]
  ).map((r) => r.id);
  const refsByVault = new Map<number, Map<string, string> | null>();
  for (const vaultId of vaultIds) {
    try {
      refsByVault.set(vaultId, await readVaultRefs(vaultRepoPath(opts.dataDir, vaultId)));
    } catch {
      refsByVault.set(vaultId, null); // 目录缺失/不可读——孤儿核对与库级问题呈现
    }
  }

  // ② 待核行列定终态（判定规则与 post-receive 同源 refReachedExpected——复用不重写）
  const settled: ReconcileSettlement[] = [];
  for (const row of listPendingReconciliation(opts.db)) {
    const refs = row.vault_id === null ? null : (refsByVault.get(row.vault_id) ?? null);
    const actual = row.ref_name === null || refs === null ? null : (refs.get(row.ref_name) ?? null);
    const to: 'succeeded' | 'rejected' = refReachedExpected(actual, row.new_commit) ? 'succeeded' : 'rejected';
    settleAuditEvent(opts.db, row.id, to, {
      reconciledBy: 'recovery-reconcile',
      ...(row.vault_id === null ? { reason: 'vault-missing' } : {}),
      ...(actual !== null ? { actualOid: actual } : {}),
    });
    settled.push({
      id: row.id,
      vaultId: row.vault_id,
      refName: row.ref_name,
      from: row.status as 'pending' | 'unresolved',
      newCommit: row.new_commit,
      actualOid: actual,
      to,
    });
  }

  // ③ 成链核对（§5 不变量 1–2）＋ ④ 孤儿双向核对（不变量 3，consume 既有面）
  const chains = verifyVaultRefChains(opts.db, vaultIds, refsByVault);
  const store = verifyVaultStoreConsistency(opts.dataDir, vaultIds);

  // ⑤ 收尾维护断言（完成前不得退出维护——中途被退则结论不可信，报告如实呈现）
  const stillEnabledAtEnd = await opts.control.isEnabled();
  const pendingResidue = drainCount(opts.db);
  const succeeded = settled.filter((s) => s.to === 'succeeded').length;
  const chainViolationRefs = chains.reduce(
    (n, c) => n + c.refs.filter((r) => r.problems.length > 0).length,
    0,
  );
  const ok =
    pendingResidue === 0 &&
    chainViolationRefs === 0 &&
    chains.every((c) => c.vaultProblems.length === 0) &&
    store.orphanRepoIds.length === 0 &&
    store.missingRepoIds.length === 0 &&
    stillEnabledAtEnd;

  return {
    startedAt,
    finishedAt: now().toISOString(),
    vaultIds,
    settled,
    chains,
    orphanRepoIds: store.orphanRepoIds,
    missingRepoIds: store.missingRepoIds,
    maintenance: { assertedAtStart: true, stillEnabledAtEnd },
    summary: {
      settled: settled.length,
      succeeded,
      rejected: settled.length - succeeded,
      pendingResidue,
      chainViolationRefs,
      orphanRepos: store.orphanRepoIds.length,
      missingRepos: store.missingRepoIds.length,
      ok,
    },
  };
}
