import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../src/db/migrate.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { addEmployee } from './credentials-fixtures.ts';

// storage-model §3.4 + §3.1 迁移纪律：迁移 0004 = credentials 表（契约 @schema 块），
// schema_version 引导行剔除（runner 持有，architecture-notes §3）；仅 append 注册
// （0002 已随 S2-T2 并入，0003 为 S2-T3 预留）。display_hint 列为 master 2026-10-12
// 批准的契约补正（api.md §4 需要、schema 原缺列）。

function memory(): DatabaseSync {
  return new DatabaseSync(':memory:');
}

/** 从 docs/contracts/storage-model.md 提取 `-- @schema credentials` 块（剔除标记行） */
function contractCredentialsLines(): string[] {
  const doc = readFileSync(path.resolve(import.meta.dirname, '../../docs/contracts/storage-model.md'), 'utf8');
  const m = /```sql\n-- @schema credentials\n([\s\S]*?)```/.exec(doc);
  assert.ok(m, 'storage-model.md 应含 -- @schema credentials 块');
  return m[1]!.split('\n').map((l) => l.trimEnd()).filter((l) => l.length > 0);
}

function migrationV4Lines(): string[] {
  const v4 = MIGRATIONS.find((m) => m.version === 4);
  assert.ok(v4, 'MIGRATIONS 应注册 version 4');
  return v4.statements.join('\n').split('\n').map((l) => l.trimEnd()).filter((l) => l.length > 0);
}

test('迁移 0004：契约 @schema 块逐行在迁移中按序保留，唯一增列 = display_hint（master 裁定）', () => {
  const contract = contractCredentialsLines();
  const mine = migrationV4Lines();
  // 契约行是迁移行的按序子序列（逐字保留，防漂移）
  let i = 0;
  for (const line of contract) {
    while (i < mine.length && mine[i] !== line) i++;
    assert.ok(i < mine.length, `迁移 0004 缺契约行：${line}`);
    i++;
  }
  // 迁移相对契约的唯一增量 = display_hint 列行（含依据注释）
  const mineSet = new Map<string, number>();
  for (const l of mine) mineSet.set(l, (mineSet.get(l) ?? 0) + 1);
  for (const l of contract) mineSet.set(l, (mineSet.get(l) ?? 1) - 1);
  const extra = [...mineSet.entries()].filter(([, n]) => n > 0).flatMap(([l, n]) => Array<string>(n).fill(l));
  assert.equal(extra.length, 1, `迁移 0004 相对契约只允许 display_hint 增列，实得多行：${JSON.stringify(extra)}`);
  assert.match(extra[0]!, /display_hint\s+TEXT/);
});

test('迁移 0004：schema_version 引导行不在迁移内容中（runner 持有引导表）', () => {
  const v4 = MIGRATIONS.find((m) => m.version === 4);
  assert.ok(v4);
  assert.ok(!v4.statements.join('\n').includes('schema_version'), '迁移内容不得携带 schema_version 建表/触发器');
});

test('迁移 0004：在 v2（employees）之上应用，credentials 表与约束落地，重入跳过', () => {
  const db = memory();
  const first = migrate(db, MIGRATIONS);
  assert.deepEqual(first.applied, [1, 2, 4]);

  const cols = (db.prepare('PRAGMA table_info(credentials)').all() as { name: string }[]).map((c) => c.name);
  assert.deepEqual(cols.sort(), [
    'created_at', 'display_hint', 'employee_id', 'expires_at', 'id', 'last_used_at', 'name', 'revoked_at', 'scope_access', 'scope_vaults', 'token_hash',
  ]);
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'credentials'").all() as { name: string }[];
  assert.ok(idx.some((r) => r.name === 'idx_credentials_employee'), '应有 idx_credentials_employee 索引（identity §3.5）');

  const again = migrate(db, MIGRATIONS);
  assert.deepEqual(again.applied, []);
  assert.deepEqual(again.skipped, [1, 2, 4]);
  db.close();
});

test('迁移 0004 约束：token_hash 唯一、scope_access CHECK、employee 外键（v2 表）生效', () => {
  const db = memory();
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db, MIGRATIONS);
  const empId = addEmployee(db, { username: 'e' });

  const insert = db.prepare(
    `INSERT INTO credentials (employee_id, name, token_hash, display_hint, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const now = new Date().toISOString();
  insert.run(empId, 'a', 'hmacv1$aa', 'ngt_ab…wxyz', now, now);
  // token_hash 唯一索引（以 HMAC 输出为唯一索引键——identity §3.2）
  assert.throws(() => insert.run(empId, 'b', 'hmacv1$aa', 'ngt_cd…wxyz', now, now));
  // scope_access CHECK
  assert.throws(() =>
    db.prepare(`INSERT INTO credentials (employee_id, name, token_hash, display_hint, scope_access, created_at, expires_at) VALUES (?, ?, ?, ?, 'write', ?, ?)`).run(empId, 'c', 'hmacv1$bb', 'ngt_ef…wxyz', now, now));
  // employee 外键（归属关系不可变更的库层保障）
  assert.throws(() => insert.run(999, 'd', 'hmacv1$cc', 'ngt_gh…wxyz', now, now));
  db.close();
});

test('出厂迁移列表：v1 基线、v2（S2-T2）在前、v4 append 在后（0003 为 S2-T3 预留）', () => {
  const versions = MIGRATIONS.map((m) => m.version);
  assert.deepEqual(versions, [1, 2, 4]);
});
