import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../src/db/migrate.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { addEmployee } from './credentials-fixtures.ts';

// storage-model §3.5/§3.6（DDL 唯一来源）：迁移 0005 = vaults + vault_members 表；
// schema_version 引导行剔除（runner 持有，architecture-notes §3）；仅 append 注册
// （0002/T2、0003/T3、0004/T4 在前，0006+ 为后续任务预留）。

function memory(): DatabaseSync {
  return new DatabaseSync(':memory:');
}

/** 从 docs/contracts/storage-model.md 提取 `-- @schema <name>` 块（剔除标记行） */
function contractSchemaLines(name: 'vaults' | 'vault_members'): string[] {
  const doc = readFileSync(path.resolve(import.meta.dirname, '../../docs/contracts/storage-model.md'), 'utf8');
  const m = new RegExp(`\`\`\`sql\n-- @schema ${name}\n([\\s\\S]*?)\`\`\``).exec(doc);
  assert.ok(m, `storage-model.md 应含 -- @schema ${name} 块`);
  return m[1]!.split('\n').map((l) => l.trimEnd()).filter((l) => l.length > 0);
}

function migrationV5Lines(): string[] {
  const v5 = MIGRATIONS.find((m) => m.version === 5);
  assert.ok(v5, 'MIGRATIONS 应注册 version 5');
  return v5.statements.join('\n').split('\n').map((l) => l.trimEnd()).filter((l) => l.length > 0);
}

test('迁移 0005：vaults 与 vault_members 与契约 @schema 块逐行等价（防漂移）', () => {
  const mine = migrationV5Lines();
  const vaults = contractSchemaLines('vaults');
  const members = contractSchemaLines('vault_members');
  // 迁移按 vaults → vault_members（含 idx）顺序拼接；契约块同样按此序提取拼接后对比
  const contract = [...vaults, ...members];
  assert.deepEqual(mine, contract, '迁移 0005 应与 storage-model.md @schema vaults/vault_members 块逐行一致');
});

test('迁移 0005：schema_version 引导行不在迁移内容中（runner 持有引导表）', () => {
  const v5 = MIGRATIONS.find((m) => m.version === 5);
  assert.ok(v5);
  assert.ok(!v5.statements.join('\n').includes('schema_version'), '迁移内容不得携带 schema_version 建表/触发器');
});

test('出厂迁移列表：v1 基线 + v2/v3/v4（S2-T2/T3/T4）在前、v5（S2-T6）append 在后', () => {
  const versions = MIGRATIONS.map((m) => m.version);
  assert.deepEqual(versions, [1, 2, 3, 4, 5]);
});

test('迁移 0005：全量迁移后表/列/索引落地，重入跳过', () => {
  const db = memory();
  const first = migrate(db, MIGRATIONS);
  assert.deepEqual(first.applied, [1, 2, 3, 4, 5]);

  const vaultCols = (db.prepare('PRAGMA table_info(vaults)').all() as { name: string }[]).map((c) => c.name);
  assert.deepEqual(vaultCols.sort(), [
    'created_at', 'created_by', 'default_branch', 'id', 'main_admin_only', 'name', 'slug',
  ]);
  const memberCols = (db.prepare('PRAGMA table_info(vault_members)').all() as { name: string }[]).map((c) => c.name);
  assert.deepEqual(memberCols.sort(), ['employee_id', 'granted_at', 'granted_by', 'role', 'vault_id']);

  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'vault_members'").all() as { name: string }[];
  assert.ok(idx.some((r) => r.name === 'idx_vault_members_employee'), '应有 idx_vault_members_employee 索引（架构 §4.2「我的库」列表）');

  const again = migrate(db, MIGRATIONS);
  assert.deepEqual(again.applied, []);
  assert.deepEqual(again.skipped, [1, 2, 3, 4, 5]);
  db.close();
});

test('迁移 0005 约束：slug 唯一、角色三档 CHECK、PK 防重复授权、FK 生效', () => {
  const db = memory();
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db, MIGRATIONS);
  const now = new Date().toISOString();
  const emp = addEmployee(db, { username: 'founder' });
  const emp2 = addEmployee(db, { username: 'member' });

  const insertVault = db.prepare(
    `INSERT INTO vaults (slug, name, default_branch, main_admin_only, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  insertVault.run('alpha', 'Alpha', 'main', 0, emp, now);
  // slug 实例内唯一（架构 §7.2）
  assert.throws(() => insertVault.run('alpha', 'Another', 'main', 0, emp, now), /UNIQUE/);
  // main_admin_only 布尔 CHECK（架构 §4.3 可配置位）
  assert.throws(() => insertVault.run('beta', 'Beta', 'main', 2, emp, now), /CHECK/);
  // created_by 外键
  assert.throws(() => insertVault.run('beta', 'Beta', 'main', 0, 999, now), /FOREIGN KEY/);

  const vaultId = (db.prepare('SELECT id FROM vaults WHERE slug = ?').get('alpha') as { id: number }).id;
  const insertMember = db.prepare(
    `INSERT INTO vault_members (vault_id, employee_id, role, granted_by, granted_at) VALUES (?, ?, ?, ?, ?)`,
  );
  insertMember.run(vaultId, emp2, 'reader', emp, now);
  // PK 防重复授权：一员工一库至多一行（架构 §4.2）
  assert.throws(() => insertMember.run(vaultId, emp2, 'editor', emp, now), /UNIQUE/);
  // 三档角色 CHECK（架构 §4.2 角色表）
  assert.throws(() => insertMember.run(vaultId, emp, 'owner', emp, now), /CHECK/);
  // vault/employee 外键
  assert.throws(() => insertMember.run(999, emp, 'reader', emp, now), /FOREIGN KEY/);
  assert.throws(() => insertMember.run(vaultId, 999, 'reader', emp, now), /FOREIGN KEY/);
  db.close();
});

test('迁移 0005 默认值：私有默认（无成员行即不可见）、default_branch=main、main_admin_only=0', () => {
  const db = memory();
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db, MIGRATIONS);
  const emp = addEmployee(db, { username: 'creator' });
  db.prepare(`INSERT INTO vaults (slug, name, created_by, created_at) VALUES ('fresh', 'Fresh', ?, ?)`).run(emp, new Date().toISOString());
  const row = db.prepare('SELECT default_branch, main_admin_only FROM vaults WHERE slug = ?').get('fresh') as {
    default_branch: string;
    main_admin_only: number;
  };
  assert.equal(row.default_branch, 'main');
  assert.equal(row.main_admin_only, 0);
  // 私有默认 = 新库对非创建者无成员行（授权数据层不自动可见）
  const n = (db.prepare('SELECT COUNT(*) AS n FROM vault_members WHERE vault_id = (SELECT id FROM vaults WHERE slug = ?)').get('fresh') as { n: number }).n;
  assert.equal(n, 0, '建库本身只写 vaults 行；成员行由建库流程显式落（创建者=admin）');
  db.close();
});
