import type { DatabaseSync } from 'node:sqlite';
import { guardDetail } from './audit.ts';

/**
 * 恢复对账查询与残留清扫（S3-T6；backup-recovery §5 不变量 1–2、§7 步骤 7）。
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
