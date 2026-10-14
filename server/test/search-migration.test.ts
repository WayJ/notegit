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
//
// S11-T1（迁移 0010，本任务独占）：search_index 扩 body 列（D20：派生可重建；
// 全文检索 v1 的存储面）。ALTER ADD COLUMN 保留既有行（body=''——空串不参与
// 正文命中）；STRICT/主键不变；建议稿 docs/s11/storage-amendments.md。

const NOW = '2026-10-13T12:00:00.000Z';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db, MIGRATIONS);
  return db;
}

test('迁移 0009/0010：search_index/search_index_state 落地，版本号「包含且有序」（E1 惯例——append 不改本断言）', () => {
  const db = freshDb();
  const versions = db.prepare('SELECT version FROM schema_version ORDER BY version').all() as { version: number }[];
  const list = versions.map((r) => r.version);
  // 「包含且有序」而非全等硬编码：9（S5-T3 两表）与 10（S11-T1 body 列）先后在场，
  // 且从 1 连续递增（后续任务 append 新版本不需要回头改这里）
  assert.ok(list.indexOf(9) >= 0 && list.indexOf(10) > list.indexOf(9), '9 与 10 先后在场（S11-T1 于 0009 后 append）');
  assert.deepEqual(list, Array.from({ length: list.length }, (_, i) => i + 1), '版本号从 1 连续递增');
  const tables = (
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('search_index','search_index_state')`).all() as { name: string }[]
  ).map((r) => r.name);
  assert.deepEqual(tables.sort(), ['search_index', 'search_index_state']);
});

test('迁移 0010：search_index 增 body 列（TEXT NOT NULL DEFAULT \'\'）——既有写面不携带 body 仍可插入', () => {
  const db = freshDb();
  const cols = (db.prepare('PRAGMA table_info(search_index)').all() as { name: string; type: string; notnull: number; dflt_value: string }[])
    .filter((c) => c.name === 'body');
  assert.equal(cols.length, 1, 'body 列存在（S11-T1 全文检索 v1——D20 派生可重建）');
  const body = cols[0]!;
  assert.equal(body.type, 'TEXT');
  assert.equal(body.notnull, 1, 'NOT NULL（缺省空串——非 .md/历史行 body=\'\'，不参与正文命中）');
  assert.equal(body.dflt_value, "''", 'DEFAULT \'\'：迁移前的既有行与未携带 body 的写面自动得空串');
  // 迁移前的既有写面形态（v9 的 INSERT 列清单）不携带 body——仍可插入，读回空串
  db.prepare(
    `INSERT INTO search_index (vault_id, path, commit_oid, title, tags, summary, indexed_at) VALUES (1, 'a.md', '${'a'.repeat(40)}', 't', '[]', 's', ?)`,
  ).run(NOW);
  const row = db.prepare('SELECT body FROM search_index WHERE path = ?').get('a.md') as { body: string };
  assert.equal(row.body, '');
  // STRICT 与主键不变：vault_id 仍拒 TEXT；同库同路径仍唯一
  assert.throws(
    () => db.prepare(`INSERT INTO search_index (vault_id, path, commit_oid, tags, summary, body, indexed_at) VALUES ('one', 'x.md', '${'a'.repeat(40)}', '[]', '', '', ?)`).run(NOW),
    /cannot store TEXT value in INTEGER column/,
  );
  assert.throws(
    () => db.prepare(`INSERT INTO search_index (vault_id, path, commit_oid, title, tags, summary, body, indexed_at) VALUES (1, 'a.md', '${'b'.repeat(40)}', null, '[]', '', 'x', ?)`).run(NOW),
    /UNIQUE constraint failed/,
  );
});

test('迁移重入：0010 应用后全量再跑 applied=[]，body 列与既有行不变', () => {
  const db = freshDb();
  db.prepare(
    `INSERT INTO search_index (vault_id, path, commit_oid, title, tags, summary, body, indexed_at) VALUES (1, 'a.md', '${'a'.repeat(40)}', 't', '[]', 's', '正文', ?)`,
  ).run(NOW);
  const again = migrate(db, MIGRATIONS);
  assert.equal(again.applied.length, 0, '重入零应用（迁移重入测试延续）');
  const row = db.prepare('SELECT path, body FROM search_index').get() as { path: string; body: string };
  assert.deepEqual({ path: row.path, body: row.body }, { path: 'a.md', body: '正文' }, '既有行与 body 值原样保留');
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
