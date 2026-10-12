import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../src/db/migrate.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';

// storage-model §3：DDL 唯一来源是 docs/contracts/storage-model.md 的 -- @schema 块；
// S2-T2 迁移 0002 落 employees + one_time_tokens（剔除 schema_version 引导建表行，
// architecture-notes §3），并以等价性测试防漂移。

const CONTRACT = path.resolve(import.meta.dirname, '../../docs/contracts/storage-model.md');

/** 从契约文档提取指定 @schema 块的 SQL（storage-model §0：文档即 DDL 唯一来源）。 */
function contractSchema(name: string): string {
  const text = readFileSync(CONTRACT, 'utf8');
  const blocks = [...text.matchAll(/```sql\n-- @schema (\w+)\n([\s\S]*?)```/g)];
  const hit = blocks.find((m) => m[1] === name);
  assert.ok(hit, `contract block -- @schema ${name} not found`);
  return hit[2];
}

function tableInfo(db: DatabaseSync, table: string) {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }[]).map((c) => ({
    name: c.name,
    type: c.type,
    notnull: c.notnull,
    dflt: c.dflt_value,
    pk: c.pk,
  }));
}

function freshMigrated(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  migrate(db, MIGRATIONS);
  return db;
}

test('迁移 0002：新建 employees 与 one_time_tokens 表并记录版本行', () => {
  const db = freshMigrated();
  const versions = db.prepare('SELECT version FROM schema_version ORDER BY version').all() as { version: number }[];
  assert.deepEqual(versions.map((r) => r.version), MIGRATIONS.map((m) => m.version)); // 出厂列表随任务 append 递增
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('employees','one_time_tokens')").get()?.n,
    2,
  );
  db.close();
});

test('迁移 0002：可重入——第二次运行跳过不重执行', () => {
  const db = freshMigrated();
  const again = migrate(db, MIGRATIONS);
  assert.deepEqual(again.applied, []);
  assert.deepEqual(again.skipped, MIGRATIONS.map((m) => m.version));
  db.close();
});

test('迁移 0002 与契约 @schema 块等价（table_info 防漂移，architecture-notes §3）', () => {
  const mine = freshMigrated();
  const contract = new DatabaseSync(':memory:');
  contract.exec('PRAGMA foreign_keys = ON');
  // 契约块按 storage-model §3 顺序执行（employees 先于引用它的 one_time_tokens）
  contract.exec(contractSchema('employees'));
  contract.exec(contractSchema('one_time_tokens'));
  for (const table of ['employees', 'one_time_tokens']) {
    assert.deepEqual(tableInfo(mine, table), tableInfo(contract, table), `table ${table} drifted from contract`);
  }
  mine.close();
  contract.close();
});

test('迁移 0002：schema_version append-only 触发器落地并拒绝 UPDATE/DELETE（契约 §3.1，S2-T1 顺延项）', () => {
  const db = freshMigrated();
  assert.throws(() => db.exec('UPDATE schema_version SET description = \'x\''), /append-only/);
  assert.throws(() => db.exec('DELETE FROM schema_version'), /append-only/);
  db.close();
});

test('迁移 0002：one_time_tokens.employee_id 外键生效（FK 拒绝孤儿令牌）', () => {
  const db = freshMigrated();
  db.exec('PRAGMA foreign_keys = ON');
  db.exec("INSERT INTO employees (username, display_name, password_hash, created_at) VALUES ('a', 'A', 'h', '2026-01-01T00:00:00Z')");
  db.prepare(
    "INSERT INTO one_time_tokens (purpose, token_hash, employee_id, expires_at, created_at) VALUES ('password_reset', 'hmacv1$aa', 1, '2026-01-02T00:00:00Z', '2026-01-01T00:00:00Z')",
  ).run();
  assert.throws(() =>
    db.prepare(
      "INSERT INTO one_time_tokens (purpose, token_hash, employee_id, expires_at, created_at) VALUES ('bootstrap', 'hmacv1$bb', 9999, '2026-01-02T00:00:00Z', '2026-01-01T00:00:00Z')",
    ).run()
  );
  db.close();
});
