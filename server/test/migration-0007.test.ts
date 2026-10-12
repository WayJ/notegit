import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../src/db/migrate.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { FIXTURE_DDL } from './credentials-fixtures.ts';

// S3-T8 迁移 0007（任务独占）：app_settings 表（storage-model §3.10 @schema 块
// 逐字迁移，D6 只读纪律）。运行时管理配置存储：键名即 validation-defaults.json
// 的配置键（validation.md §5.1），缺行 = 用默认值；配置 ≠ 规则版本（§7.3-4）。
// 审计事件 kind 注册表（storage-model §5）尚无 config 类 kind——设置变更的
// 审计与 HTTP 管理端点随 api.md 契约补录（open 项，见 notes）。

function memory(): DatabaseSync {
  return new DatabaseSync(':memory:');
}

/** 从 docs/contracts/storage-model.md 提取 `-- @schema app_settings` 块（剔除标记行） */
function contractAppSettingsLines(): string[] {
  const doc = readFileSync(path.resolve(import.meta.dirname, '../../docs/contracts/storage-model.md'), 'utf8');
  const m = /```sql\n-- @schema app_settings\n([\s\S]*?)```/.exec(doc);
  assert.ok(m, 'storage-model.md 应含 -- @schema app_settings 块');
  return m[1]!.split('\n').map((l) => l.trimEnd()).filter((l) => l.length > 0);
}

function migrationV7Lines(): string[] {
  const v7 = MIGRATIONS.find((m) => m.version === 7);
  assert.ok(v7, 'MIGRATIONS 应注册 version 7');
  return v7.statements.join('\n').split('\n').map((l) => l.trimEnd()).filter((l) => l.length > 0);
}

test('迁移 0007：与契约 @schema 块逐行等价（防漂移，D6）', () => {
  assert.deepEqual(
    migrationV7Lines(),
    contractAppSettingsLines(),
    '迁移 0007 应与 storage-model.md @schema app_settings 块逐行一致（顺序 + 逐字）',
  );
});

test('迁移 0007：在 0006 之上应用，app_settings 表/列落地，重入跳过', () => {
  const db = memory();
  const first = migrate(db, MIGRATIONS);
  assert.deepEqual(first.applied, [1, 2, 3, 4, 5, 6, 7]);

  const cols = (db.prepare('PRAGMA table_info(app_settings)').all() as { name: string }[]).map((c) => c.name);
  assert.deepEqual(cols.sort(), ['key', 'updated_at', 'updated_by', 'value']);

  const again = migrate(db, MIGRATIONS);
  assert.deepEqual(again.applied, []);
  assert.deepEqual(again.skipped, [1, 2, 3, 4, 5, 6, 7]);
  db.close();
});

test('迁移 0007 约束：key 主键（一配置键一行）；值域约束归加载器（JSON 解析+类型校验）', () => {
  const db = memory();
  migrate(db, MIGRATIONS);
  for (const ddl of FIXTURE_DDL) db.exec(ddl);
  db.prepare(`INSERT INTO employees (username, display_name, password_hash, created_at) VALUES ('e', 'e', 'x', '2026-10-13T00:00:00.000Z')`).run();
  const empId = Number((db.prepare('SELECT id FROM employees LIMIT 1').get() as { id: number }).id);
  const ins = db.prepare('INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)');
  ins.run('validation.limits.maxPushBytes', '1048576', empId, '2026-10-13T00:00:00.000Z');
  // 一键一行（主键）：重复 key 拒绝
  assert.throws(() => ins.run('validation.limits.maxPushBytes', '2097152', empId, '2026-10-13T00:00:00.000Z'), /UNIQUE/);
  // value 列为 TEXT（JSON 文本承载，storage-model §3.10）：NOT NULL 拒绝空值；
  // 非 JSON/类型不符的值由 limits 加载器拒绝（见 limits-config.test.ts——DB 层不做值域）
  assert.throws(() => ins.run('validation.limits.maxDocumentBytes', null, empId, '2026-10-13T00:00:00.000Z'), /NOT NULL/i);
  db.close();
});
