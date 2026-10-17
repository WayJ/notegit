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
// （0002 已随 S2-T2 并入，0003 为 S2-T3 预留）。display_hint 列：D11 ADR（2026-10-13）
// 已将增列同步进契约 @schema 块——此后迁移与契约应逐行等价（S2-T5 随 D11 同步收敛）。

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


/** 派生版本表（S4-T6 起）：从 1 连续递增即合法——append 新迁移不再需要改本文件 */
function allVersions(): number[] {
  return Array.from({ length: MIGRATIONS.length }, (_, i) => i + 1);
}

test('迁移 0004：与契约 @schema 块逐行等价（S37 origin 行除外，防漂移）', () => {
  const contract = contractCredentialsLines()
    .filter((l) => !l.includes('S37 增补'))
    // origin 行剔除后，契约的 last_used_at 尾逗号恢复为 v4 的无逗号尾列形态（逗号位→空格，列宽不变）
    .map((l) => (l.trim().startsWith('last_used_at TEXT,') ? l.replace('last_used_at TEXT,', 'last_used_at TEXT ') : l));
  const mine = migrationV4Lines();
  // D11 后契约已含 display_hint 列：迁移与契约应完全一致（顺序 + 逐字）。
  // S37 origin 列经迁移 0011 append（已发版基线 0001–0010 不可改写）——0004 比对剔除该行
  // （origin 行在 last_used_at 之后，剔除后 v4 尾列无逗号形态与契约一致）。
  assert.deepEqual(
    mine,
    contract,
    '迁移 0004 应与 storage-model.md @schema credentials 块逐行一致（S37 origin 行除外）',
  );
});

test('迁移 0004：schema_version 引导行不在迁移内容中（runner 持有引导表）', () => {
  const v4 = MIGRATIONS.find((m) => m.version === 4);
  assert.ok(v4);
  assert.ok(!v4.statements.join('\n').includes('schema_version'), '迁移内容不得携带 schema_version 建表/触发器');
});

test('迁移 0004：在 v2（employees）之上应用，credentials 表与约束落地，重入跳过', () => {
  const db = memory();
  const first = migrate(db, MIGRATIONS);
  assert.deepEqual(first.applied, allVersions());  // 集成修正：0007（T8 app_settings）已并入

  const cols = (db.prepare('PRAGMA table_info(credentials)').all() as { name: string }[]).map((c) => c.name);
  assert.deepEqual(cols.sort(), [
    'created_at', 'display_hint', 'employee_id', 'expires_at', 'id', 'last_used_at', 'name', 'origin', 'revoked_at', 'scope_access', 'scope_vaults', 'token_hash',
  ]);
  // 迁移 0011（S37）：origin 默认 'self'（既有行语义不变），CHECK 限定两值
  const originCol = (db.prepare('PRAGMA table_info(credentials)').all() as { name: string; dflt_value: string }[]).find((c) => c.name === 'origin');
  assert.ok(originCol, 'origin 列应存在');
  assert.ok(originCol.dflt_value.includes('self'), "origin 默认值应为 'self'");
  db.prepare(`INSERT INTO employees (username, display_name, password_hash, is_instance_admin, active, created_at) VALUES ('o1','o1','x',1,1,?)`).run(new Date().toISOString());
  assert.throws(() =>
    db.prepare(`INSERT INTO credentials (employee_id, name, token_hash, display_hint, created_at, expires_at, origin) VALUES (1,'c','h1','ngt_ab…wxyz',?,?,'bogus')`).run(new Date().toISOString(), new Date().toISOString()),
    /CHECK constraint failed/i,
    'origin CHECK 应拒绝非法取值',
  );
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'credentials'").all() as { name: string }[];
  assert.ok(idx.some((r) => r.name === 'idx_credentials_employee'), '应有 idx_credentials_employee 索引（identity §3.5）');

  const again = migrate(db, MIGRATIONS);
  assert.deepEqual(again.applied, []);
  assert.deepEqual(again.skipped, allVersions());  // 集成修正：0007（T8 app_settings）已并入
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

test('出厂迁移列表：v1 基线、v2（S2-T2）在前、v4 append 在后（0003 为 S2-T3 sessions，已集成于前）', () => {
  const versions = MIGRATIONS.map((m) => m.version);
  assert.deepEqual(versions, allVersions());  // 集成修正：0005/0006 已并入；0007（T8 app_settings）append
});
