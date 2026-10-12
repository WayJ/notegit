import type { DatabaseSync } from 'node:sqlite';
import type { Migration } from './migrations.ts';

export interface MigrationResult {
  readonly applied: number[];
  readonly skipped: number[];
}

// schema_version 引导表：形状 = storage-model.md §3.1（append-only 触发器随契约 DDL 在 S2-T2+ 落地）。
const BOOTSTRAP_SCHEMA_VERSION = `
CREATE TABLE IF NOT EXISTS schema_version (
  version     INTEGER NOT NULL PRIMARY KEY,
  applied_at  TEXT    NOT NULL,
  description TEXT    NOT NULL
) STRICT`;

/**
 * 前向迁移（storage-model §3.1：仅前向、有序、可重入检查）：
 * 已应用版本跳过；新版本按序执行；每个迁移一个事务，失败即回滚该迁移并抛出。
 */
export function migrate(db: DatabaseSync, migrations: readonly Migration[]): MigrationResult {
  // 守卫：版本必须严格递增（重复/乱序在执行任何语句前拒绝）
  for (let i = 1; i < migrations.length; i++) {
    const prev = migrations[i - 1]?.version;
    const curr = migrations[i]?.version;
    if (prev === undefined || curr === undefined || curr <= prev) {
      throw new Error(`migrations must have strictly increasing versions: got ${String(prev)} then ${String(curr)}`);
    }
  }

  db.exec(BOOTSTRAP_SCHEMA_VERSION);
  const appliedSet = new Set(
    (db.prepare('SELECT version FROM schema_version').all() as { version: number }[]).map((r) => r.version),
  );

  const applied: number[] = [];
  const skipped: number[] = [];
  for (const m of migrations) {
    if (appliedSet.has(m.version)) {
      skipped.push(m.version);
      continue;
    }
    db.exec('BEGIN');
    try {
      for (const stmt of m.statements) {
        db.exec(stmt);
      }
      db.prepare('INSERT INTO schema_version (version, applied_at, description) VALUES (?, ?, ?)').run(
        m.version,
        new Date().toISOString(),
        m.description,
      );
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    applied.push(m.version);
  }
  return { applied, skipped };
}
