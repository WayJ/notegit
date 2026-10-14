import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../src/db/migrate.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';

// storage-model §3.7 迁移纪律（S2-T6/T7 先例；S4-T6 任务约束「D11 模式」）：契约
// @schema 块早已含 drafts 表（S1-T5 契约先行），本迁移落表 + 防漂移——迁移内容
// 逐字取自契约块（D6 只读纪律），对照测试逐行等价断言（顺序 + 逐字）。
// 依据：架构 §6「草稿保存在数据库，按作者私有……发布后清理或标为已提交」；
// identity §5.1 第 2 层（访问时复查库权限——应用层保证，见 drafts/ 模块）。

function memory(): DatabaseSync {
  return new DatabaseSync(':memory:');
}

/** 从 docs/contracts/storage-model.md 提取 `-- @schema drafts` 块（剔除标记行） */
function contractDraftLines(): string[] {
  const doc = readFileSync(path.resolve(import.meta.dirname, '../../docs/contracts/storage-model.md'), 'utf8');
  const m = /```sql\n-- @schema drafts\n([\s\S]*?)```/.exec(doc);
  assert.ok(m, 'storage-model.md 应含 -- @schema drafts 块');
  return m[1]!.split('\n').map((l) => l.trimEnd()).filter((l) => l.length > 0);
}

function migrationV8Lines(): string[] {
  const v8 = MIGRATIONS.find((m) => m.version === 8);
  assert.ok(v8, 'MIGRATIONS 应注册 version 8');
  return v8.statements.join('\n').split('\n').map((l) => l.trimEnd()).filter((l) => l.length > 0);
}

/** 派生版本表（S11-T1 起本文件同样采用）：从 1 连续递增即合法——append 新迁移不再需要改本文件 */
function allVersions(): number[] {
  return Array.from({ length: MIGRATIONS.length }, (_, i) => i + 1);
}

test('迁移 0008：与契约 @schema 块逐行等价（防漂移，D6/D11 模式）', () => {
  assert.deepEqual(
    migrationV8Lines(),
    contractDraftLines(),
    '迁移 0008 应与 storage-model.md @schema drafts 块逐行一致（顺序 + 逐字）',
  );
});

test('迁移 0008：schema_version 引导行不在迁移内容中（runner 持有引导表）', () => {
  const v8 = MIGRATIONS.find((m) => m.version === 8);
  assert.ok(v8);
  assert.ok(!v8.statements.join('\n').includes('schema_version'), '迁移内容不得携带 schema_version 建表/触发器');
});

test('迁移 0008：全量应用后 drafts 表/列落地，重入跳过', () => {
  const db = memory();
  const versions = allVersions();
  const first = migrate(db, MIGRATIONS);
  assert.deepEqual(first.applied, versions); // 从 1 连续递增（S5-T3 追加 9、S11-T1 追加 10 起「包含且有序」派生）

  const cols = (db.prepare('PRAGMA table_info(drafts)').all() as { name: string }[]).map((c) => c.name);
  assert.deepEqual(cols.sort(), [
    'base_commit', 'committed_at', 'content', 'created_at', 'employee_id',
    'id', 'path', 'status', 'updated_at', 'vault_id',
  ]);

  const again = migrate(db, MIGRATIONS);
  assert.deepEqual(again.applied, []);
  assert.deepEqual(again.skipped, versions);
  db.close();
});

test('迁移 0008 约束：status CHECK、UNIQUE(vault_id,employee_id,path)、外键生效', () => {
  const db = memory();
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db, MIGRATIONS);
  const now = '2026-10-13T00:00:00.000Z';
  db.prepare(`INSERT INTO employees (username, display_name, password_hash, created_at) VALUES ('e', 'e', 'x', ?)`).run(now);
  const empId = (db.prepare('SELECT id FROM employees WHERE username = ?').get('e') as { id: number }).id;
  db.prepare(`INSERT INTO vaults (slug, name, created_by, created_at) VALUES ('v', 'v', ?, ?)`).run(empId, now);
  const vaultId = (db.prepare('SELECT id FROM vaults WHERE slug = ?').get('v') as { id: number }).id;

  const insert = db.prepare(
    `INSERT INTO drafts (vault_id, employee_id, path, content, base_commit, status, committed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // 合法行：active 草稿（缺省 status/committed_at）
  db.prepare(
    `INSERT INTO drafts (vault_id, employee_id, path, content, base_commit, created_at, updated_at)
     VALUES (?, ?, 'docs/a.md', 'x', '', ?, ?)`,
  ).run(vaultId, empId, now, now); // base_commit NOT NULL——空库 null 以 '' 哨兵存储（服务层映射）
  const row = db.prepare('SELECT status, committed_at FROM drafts').get() as { status: string; committed_at: string | null };
  assert.equal(row.status, 'active', "缺省 status='active'");
  assert.equal(row.committed_at, null, '缺省 committed_at 为空');
  // 合法行：committed 终态（架构 §6「发布后清理或标为已提交」）
  insert.run(vaultId, empId, 'docs/b.md', 'y', 'a'.repeat(40), 'committed', now, now, now);
  // status CHECK（active/committed 封闭集）
  assert.throws(() => insert.run(vaultId, empId, 'docs/c.md', 'y', null, 'gone', null, now, now));
  // UNIQUE(vault_id, employee_id, path)：每作者每路径一份现行草稿
  assert.throws(() =>
    db.prepare(
      `INSERT INTO drafts (vault_id, employee_id, path, content, base_commit, created_at, updated_at)
       VALUES (?, ?, 'docs/a.md', 'z', '', ?, ?)`,
    ).run(vaultId, empId, now, now)
  );
  // 同库同路径不同作者：不冲突（按作者私有——各自一份）
  db.prepare(`INSERT INTO employees (username, display_name, password_hash, created_at) VALUES ('e2', 'e2', 'x', ?)`).run(now);
  const emp2 = (db.prepare('SELECT id FROM employees WHERE username = ?').get('e2') as { id: number }).id;
  insert.run(vaultId, emp2, 'docs/a.md', 'z', '', 'active', null, now, now);
  // 外键：vault / employee 必须真实存在
  assert.throws(() => insert.run(999, empId, 'docs/d.md', 'y', '', 'active', null, now, now));
  assert.throws(() => insert.run(vaultId, 999, 'docs/d.md', 'y', '', 'active', null, now, now));
  db.close();
});
