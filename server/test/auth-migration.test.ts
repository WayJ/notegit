import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../src/db/migrate.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';

// storage-model.md §3.3（DDL 唯一来源）：迁移 0003 落 sessions。employees 基础表
// （含口令/状态列）已由 S2-T2 的 0002 按同一契约 §3.2 块落地（等价性测试见 T2 的
// migration-0002.test.ts），本迁移不重复建表、无需 ALTER 补列。

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db, MIGRATIONS);
  return db;
}

function columns(db: DatabaseSync, table: string): { name: string; notnull: number; type: string }[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; notnull: number; type: string }[];
}

test('迁移 0003 已注册：版本 [1, 2, 3]，v3 仅含 sessions（与 0002 无重复建表）', () => {
  const versions = MIGRATIONS.map((m) => m.version);
  assert.deepEqual(versions, [1, 2, 3, 4, 5, 6, 7]);  // 集成修正：0005/0006 已并入；0007（T8 app_settings）append
  const v3 = MIGRATIONS.find((m) => m.version === 3);
  assert.ok(v3, '版本 3 应存在');
  assert.match(v3?.description ?? '', /sessions/);
  const joined = (v3?.statements ?? []).join('\n');
  assert.ok(!/CREATE\s+TABLE\s+employees/i.test(joined), '0003 不应重复建 employees（0002 已建）');
  assert.ok(/CREATE\s+TABLE\s+sessions/i.test(joined), '0003 应建 sessions');
});

test('migrate 后 sessions 列集与契约 §3.3 一致', () => {
  const db = freshDb();
  const cols = columns(db, 'sessions').map((c) => c.name);
  assert.deepEqual(cols, [
    'id', 'employee_id', 'sid_hash', 'created_at', 'last_seen_at', 'absolute_expires_at',
  ]);
  const byName = Object.fromEntries(columns(db, 'sessions').map((c) => [c.name, c]));
  assert.equal(byName.employee_id?.notnull, 1, 'employee_id NOT NULL');
  assert.equal(byName.sid_hash?.notnull, 1, 'sid_hash NOT NULL');
  assert.equal(byName.absolute_expires_at?.notnull, 1, 'absolute_expires_at NOT NULL');
  db.close();
});

test('employees 口令/状态列就位（0002 落地，本任务功能的前提面）', () => {
  const db = freshDb();
  const cols = new Set(columns(db, 'employees').map((c) => c.name));
  for (const c of ['password_hash', 'active', 'deactivated_at', 'is_instance_admin']) {
    assert.ok(cols.has(c), `employees 应含 ${c}`);
  }
  db.close();
});

test('sessions 约束生效：sid_hash 唯一、FK、STRICT，按账号批量失效索引存在', () => {
  const db = freshDb();
  db.prepare(
    `INSERT INTO employees (username, display_name, password_hash, is_instance_admin, active, invited_by, created_at, deactivated_at)
     VALUES ('u1', 'u1', 'x', 0, 1, NULL, '2026-01-01T00:00:00.000Z', NULL)`,
  ).run();
  const ins = db.prepare('INSERT INTO sessions (employee_id, sid_hash, created_at, last_seen_at, absolute_expires_at) VALUES (?, ?, ?, ?, ?)');
  ins.run(1, 'aa', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z');
  assert.throws(() =>
    ins.run(1, 'aa', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z'),
    /UNIQUE/, 'sid_hash 唯一');
  assert.throws(() =>
    ins.run(999, 'bb', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z'),
    /FOREIGN KEY/, 'employee_id 外键');
  assert.throws(() =>
    ins.run('not-a-number', 'cc', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z'),
    /cannot store TEXT value in INTEGER column/, 'STRICT 类型强制（employee_id 拒非整数文本）');
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='sessions' AND name='idx_sessions_employee'").get();
  assert.ok(idx, 'idx_sessions_employee 应存在（identity §2 口令重置/停用按账号批量失效）');
  db.close();
});

test('重入：migrate 二次执行跳过 0003，不重复建表', () => {
  const db = freshDb();
  const again = migrate(db, MIGRATIONS);
  assert.deepEqual(again.applied, []);
  assert.deepEqual(again.skipped, [1, 2, 3, 4, 5, 6, 7]);  // 集成修正：0007（T8 app_settings）已并入
  db.close();
});
