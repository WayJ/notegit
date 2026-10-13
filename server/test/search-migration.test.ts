import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../src/db/migrate.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';

// S5-T3 迁移 0009：派生搜索索引两表（search_index / search_index_state）。
// 依据：架构 §3.1（标题/标签/摘要/搜索索引 = 派生数据，可从 Git 重建）、§9
// （内容搜索基于已发布分支派生索引；索引延迟可观测）；storage-model §2 明示
// 「派生（不在本 schema）」——本表在契约 DDL 之外落地（D11 模式：实现 + 契约
// 补正建议稿 docs/s1/search-index-amendments.md，master 评审后归位）。
//
// 结构性要点（区别于权威表）：
// - 无外键：派生行不得阻塞权威侧删库（vaults 行删除不被陈旧索引行 FK 卡住；
//   孤儿行由启动对账清理——见 search-indexer 测试）。
// - 逐路径一行：PRIMARY KEY (vault_id, path)——同库同路径新版本覆盖旧行
//   （全量替换语义，T5 重建复用同一写面）。
// - state 表按库一行：head_commit/indexed_at/lag_ms/consecutive_failures 等
//   可观测字段（延迟指标 + 时间戳 + 失败告警的数据面）。

const NOW = '2026-10-13T12:00:00.000Z';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db, MIGRATIONS);
  return db;
}

test('迁移 0009：search_index/search_index_state 落地，版本号追加于 0008 之后', () => {
  const db = freshDb();
  const versions = db.prepare('SELECT version FROM schema_version ORDER BY version').all() as { version: number }[];
  assert.equal(versions[versions.length - 1]!.version, 9, '最新迁移版本 = 9（S5-T3 独占，0008 之后 append）');
  const tables = (
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('search_index','search_index_state')`).all() as { name: string }[]
  ).map((r) => r.name);
  assert.deepEqual(tables.sort(), ['search_index', 'search_index_state']);
});

test('search_index：vault/path 主键去重，title 可空（README 豁免文件），tags 为 JSON 文本', () => {
  const db = freshDb();
  const ins = db.prepare(
    `INSERT INTO search_index (vault_id, path, commit_oid, title, tags, summary, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  ins.run(1, 'notes/a.md', 'a'.repeat(40), '标题', '["x","y"]', '首段', NOW);
  // README 等 frontmatter 豁免文件：title NULL 合法（派生面如实记录「无 title」）
  ins.run(1, 'README.md', 'a'.repeat(40), null, '[]', '# nav', NOW);
  assert.throws(
    () => ins.run(1, 'notes/a.md', 'b'.repeat(40), '重复路径', '[]', 'x', NOW),
    /UNIQUE constraint failed/,
    '同库同路径唯一（新版本由全量替换写面覆盖，不并存）',
  );
  // STRICT：vault_id 只收整数（TEXT 值入库被拒）
  assert.throws(() => ins.run('one', 'x.md', 'a'.repeat(40), null, '[]', '', NOW), /cannot store TEXT value in INTEGER column/);
});

test('search_index 无外键：删 vaults 行不被派生行阻塞（权威侧操作优先，孤儿由对账清理）', () => {
  const db = freshDb();
  db.prepare(
    `INSERT INTO employees (username, display_name, password_hash, created_at) VALUES ('alice', 'Alice', 'x', ?)`,
  ).run(NOW);
  db.prepare(`INSERT INTO vaults (slug, name, created_by, created_at) VALUES ('v', 'V', 1, ?)`).run(NOW);
  db.prepare(
    `INSERT INTO search_index (vault_id, path, commit_oid, title, tags, summary, indexed_at) VALUES (1, 'a.md', '${'a'.repeat(40)}', 't', '[]', 's', ?)`,
  ).run(NOW);
  db.prepare(
    `INSERT INTO search_index_state (vault_id, branch, head_commit, triggered_by, triggered_at, indexed_at, duration_ms, lag_ms, updates)
     VALUES (1, 'main', '${'a'.repeat(40)}', 'startup-reconcile', NULL, ?, 5, NULL, 1)`,
  ).run(NOW);
  // 权威侧删行不抛 FK 错（对照：有外键时此处必抛）
  db.prepare('DELETE FROM vaults WHERE id = 1').run();
  const left = db.prepare('SELECT COUNT(*) AS n FROM search_index').get() as { n: number };
  assert.equal(left.n, 1, '派生行留存（清理是对账职责，不是删除事务职责）');
});

test('search_index_state：按库一行（主键），失败计数与最近错误字段可写', () => {
  const db = freshDb();
  const up = db.prepare(
    `INSERT INTO search_index_state (vault_id, branch, head_commit, triggered_by, triggered_at, indexed_at, duration_ms, lag_ms, updates, consecutive_failures, last_error, last_error_at)
     VALUES (?, 'main', NULL, 'startup-reconcile', NULL, ?, 0, NULL, 0, ?, ?, ?)`,
  );
  up.run(7, NOW, 3, 'derive failed: boom', NOW);
  assert.throws(() => up.run(7, NOW, 0, null, NOW), /UNIQUE constraint failed/, '一库一行（幂等 upsert 语义的基础）');
  const row = db.prepare(`SELECT consecutive_failures, last_error FROM search_index_state WHERE vault_id = 7`).get() as {
    consecutive_failures: number;
    last_error: string;
  };
  assert.equal(row.consecutive_failures, 3);
  assert.equal(row.last_error, 'derive failed: boom');
});
