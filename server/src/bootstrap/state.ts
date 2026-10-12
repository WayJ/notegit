import type { DatabaseSync } from 'node:sqlite';

/**
 * 初始化态判定（identity §7.1-1）：用户表（employees）为空 ⇒ 实例未初始化。
 * 每次调用实时查库（与 D-IC-05 无缓存纪律同向）。
 */
export function isUninitialized(db: DatabaseSync): boolean {
  const row = db.prepare('SELECT COUNT(*) AS n FROM employees').get() as { n: number };
  return row.n === 0;
}
