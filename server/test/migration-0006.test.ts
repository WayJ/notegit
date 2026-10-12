import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../src/db/migrate.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { FIXTURE_DDL } from './credentials-fixtures.ts';

// storage-model §3.8 + §3.1 迁移纪律：迁移 0006 = audit_events 表（契约 @schema 块
// 逐字迁移，D6 只读纪律）。0005 为 S2-T6（vaults）并行预留，双方各自 append 自己的
// 版本号，并入 sprint/S2 时由集成侧按序交错（任务约束：迁移独占 0006，注册仅 append）。
// 依据：identity §8 审计主体；backup-recovery §4 步骤 2 排空 / §5 成链（本表承载）。
//
// vaults 属 T6 的 0005（本分支尚无）：foreign_keys=ON 下 audit_events.vault_id 外键
// 要求父表在场（即使插 NULL）——约束/行为用例先应用 T6 夹具（合并后为 no-op）。

function memory(): DatabaseSync {
  return new DatabaseSync(':memory:');
}

/** 从 docs/contracts/storage-model.md 提取 `-- @schema audit_events` 块（剔除标记行） */
function contractAuditLines(): string[] {
  const doc = readFileSync(path.resolve(import.meta.dirname, '../../docs/contracts/storage-model.md'), 'utf8');
  const m = /```sql\n-- @schema audit_events\n([\s\S]*?)```/.exec(doc);
  assert.ok(m, 'storage-model.md 应含 -- @schema audit_events 块');
  return m[1]!.split('\n').map((l) => l.trimEnd()).filter((l) => l.length > 0);
}

function migrationV6Lines(): string[] {
  const v6 = MIGRATIONS.find((m) => m.version === 6);
  assert.ok(v6, 'MIGRATIONS 应注册 version 6');
  return v6.statements.join('\n').split('\n').map((l) => l.trimEnd()).filter((l) => l.length > 0);
}

test('迁移 0006：与契约 @schema 块逐行等价（防漂移，D6）', () => {
  assert.deepEqual(
    migrationV6Lines(),
    contractAuditLines(),
    '迁移 0006 应与 storage-model.md @schema audit_events 块逐行一致（顺序 + 逐字）',
  );
});

test('迁移 0006：schema_version 引导行不在迁移内容中（runner 持有引导表）', () => {
  const v6 = MIGRATIONS.find((m) => m.version === 6);
  assert.ok(v6);
  assert.ok(!v6.statements.join('\n').includes('schema_version'), '迁移内容不得携带 schema_version 建表/触发器');
});

test('迁移 0006：在 v4 之上应用，audit_events 表/列/索引落地，重入跳过', () => {
  const db = memory();
  const first = migrate(db, MIGRATIONS);
  assert.deepEqual(first.applied, [1, 2, 3, 4, 5, 6]);  // 集成修正：0005（T6）已插于 4 与 6 之间

  const cols = (db.prepare('PRAGMA table_info(audit_events)').all() as { name: string }[]).map((c) => c.name);
  assert.deepEqual(cols.sort(), [
    'actor_kind', 'credential_ref', 'detail', 'employee_id', 'entry', 'event_kind',
    'id', 'new_commit', 'occurred_at', 'old_commit', 'ref_name', 'status', 'vault_id',
  ]);
  const idx = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'audit_events'").all() as { name: string; sql: string }[];
  const names = idx.map((r) => r.name);
  assert.ok(names.includes('idx_audit_vault_time'), 'idx_audit_vault_time（架构 §4.4 按库/时间查询）');
  assert.ok(names.includes('idx_audit_employee_time'), 'idx_audit_employee_time（按主体检索）');
  assert.ok(names.includes('idx_audit_open'), 'idx_audit_open（backup-recovery §4 排空部分索引）');
  // 部分索引谓词在场（排空检查只扫在途写）
  const open = idx.find((r) => r.name === 'idx_audit_open');
  assert.match(open?.sql ?? '', /status\s+IN\s*\('pending','unresolved'\)/i);

  const again = migrate(db, MIGRATIONS);
  assert.deepEqual(again.applied, []);
  assert.deepEqual(again.skipped, [1, 2, 3, 4, 5, 6]);  // 集成修正：0005（T6）已并入
  db.close();
});

test('迁移 0006 约束：actor_kind/entry/status CHECK、employee 外键生效', () => {
  const db = memory();
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db, MIGRATIONS);
  for (const ddl of FIXTURE_DDL) db.exec(ddl);  // vaults 父表（T6 的 0005 前置，见头注）
  db.prepare(`INSERT INTO employees (username, display_name, password_hash, created_at) VALUES ('e', 'e', 'x', '2026-10-13T00:00:00.000Z')`).run();
  const empId = (db.prepare('SELECT id FROM employees WHERE username = ?').get('e') as { id: number }).id;

  const insert = db.prepare(
    `INSERT INTO audit_events (occurred_at, actor_kind, employee_id, credential_ref, entry, event_kind, status, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const now = '2026-10-13T00:00:00.000Z';
  // 合法行：employee 主体（identity §8：employee_id 在场当且仅当 actor_kind=employee）
  insert.run(now, 'employee', empId, 'session:1', 'web', 'employee.create', 'succeeded', '{}');
  // 合法行：bootstrap 主体（employee_id NULL）
  insert.run(now, 'bootstrap', null, null, 'api', 'account.bootstrap', 'succeeded', '{}');
  // actor_kind CHECK
  assert.throws(() => insert.run(now, 'robot', null, null, 'api', 'x', 'succeeded', '{}'));
  // entry CHECK（web/api/git，identity §8）
  assert.throws(() => insert.run(now, 'system', null, null, 'cli', 'x', 'succeeded', '{}'));
  // status CHECK（pending/succeeded/rejected/unresolved，架构 §4.4 + 待核对）
  assert.throws(() => insert.run(now, 'system', null, null, 'api', 'x', 'done', '{}'));
  // employee 外键（主体必须指向真实员工）
  assert.throws(() => insert.run(now, 'employee', 999, null, 'api', 'x', 'succeeded', '{}'));
  db.close();
});

test('迁移 0006 约束：employee_id 与 actor_kind 的一致性可被应用层保证（DB 不强约束，注释契约）', () => {
  // DDL 注释：employee_id NULL 当且仅当 actor_kind != 'employee'（应用层保证）——
  // 即 DB 层允许 system 带主体，审计基座（server/src/audit/）负责写入口径。
  const db = memory();
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db, MIGRATIONS);
  for (const ddl of FIXTURE_DDL) db.exec(ddl);  // vaults 父表（T6 的 0005 前置，见头注）
  db.prepare(
    `INSERT INTO audit_events (occurred_at, actor_kind, entry, event_kind, status, detail)
     VALUES ('2026-10-13T00:00:00.000Z', 'system', 'api', 'backup.completed', 'succeeded', '{}')`,
  ).run();
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM audit_events').get() as { n: number }).n, 1);
  db.close();
});
