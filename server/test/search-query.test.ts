import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { newDb, addEmployee, addVault, addMember } from './credentials-fixtures.ts';
import { searchKeyword, SEARCH_RESULT_LIMIT, SEARCH_MAX_Q_CHARS } from '../src/search/query.ts';

// S5-T4 查询面（server/src/search/query.ts）单元测试：SQL LIKE 子串匹配
// title/tags/summary（转义 %/_、ASCII 大小写不敏感）+ 成员关系实时 JOIN 过滤
// （D7：过滤与授权层同一无缓存原则——撤权下一查询即消失）+ token scope 交集
// （identity §3.4）+ 确定性排序与上限。TDD：本文件先 RED（模块不存在）后实现。

function setup(): { db: DatabaseSync; emp: number } {
  const db = newDb();
  const emp = addEmployee(db, { username: 'alice' });
  return { db, emp };
}

/** 直插索引行（查询面测试不依赖索引器——表形态即契约输入；body 缺省空串=迁移前行形态） */
function seedIndex(
  db: DatabaseSync,
  vaultId: number,
  path: string,
  fields: { title?: string | null; tags?: string[]; summary?: string; body?: string; commitOid?: string },
): void {
  db.prepare(
    `INSERT INTO search_index (vault_id, path, commit_oid, title, tags, summary, body, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    vaultId,
    path,
    fields.commitOid ?? 'c0',
    fields.title ?? null,
    JSON.stringify(fields.tags ?? []),
    fields.summary ?? '',
    fields.body ?? '',
    new Date().toISOString(),
  );
}

test('标题命中：结果含 库/路径/commit/摘要 片段与命中字段', () => {
  const { db, emp } = setup();
  const vid = addVault(db, 'docs', emp);
  addMember(db, vid, emp, 'reader', emp);
  seedIndex(db, vid, 'notes/kpi.md', {
    title: '季度 KPI 复盘',
    tags: ['metrics'],
    summary: '本季度指标首段。',
    commitOid: 'abc123',
  });
  const r = searchKeyword(db, emp, 'KPI');
  assert.equal(r.hits.length, 1);
  const hit = r.hits[0]!;
  assert.equal(hit.vaultSlug, 'docs');
  assert.equal(hit.vaultName, 'docs');
  assert.equal(hit.path, 'notes/kpi.md');
  assert.equal(hit.commitOid, 'abc123');
  assert.equal(hit.title, '季度 KPI 复盘');
  assert.deepEqual(hit.tags, ['metrics']);
  assert.equal(hit.summary, '本季度指标首段。');
  // S11-T1：路径含 kpi（ASCII 折叠）——matched 扩 ['title','path']
  assert.deepEqual(hit.matched, ['title', 'path']);
  assert.equal(r.truncated, false);
});

test('tags 命中：逐标签精确匹配（跨标签 JSON 边界的子串不算命中）', () => {
  const { db, emp } = setup();
  const vid = addVault(db, 'docs', emp);
  addMember(db, vid, emp, 'editor', emp);
  seedIndex(db, vid, 'a.md', { title: null, tags: ['onboarding', 'guide'], summary: 'x' });
  // 标签内子串命中
  assert.deepEqual(searchKeyword(db, emp, 'board').hits.map((h) => h.path), ['a.md']);
  assert.deepEqual(searchKeyword(db, emp, 'onboarding').hits[0]!.matched, ['tags']);
  // JSON 文本跨界子串（"onboard","guide" 的 JSON 拼接含 `d","g`）：候选行必须被精确过滤掉
  assert.deepEqual(searchKeyword(db, emp, 'd","g').hits, []);
});

test('摘要命中与多字段命中（matched 顺序 title→tags→summary）', () => {
  const { db, emp } = setup();
  const vid = addVault(db, 'docs', emp);
  addMember(db, vid, emp, 'reader', emp);
  seedIndex(db, vid, 's.md', { title: '部署手册 deploy', tags: ['deploy'], summary: 'deploy 步骤首段。' });
  const hit = searchKeyword(db, emp, 'deploy').hits[0]!;
  assert.equal(hit.path, 's.md');
  assert.deepEqual(hit.matched, ['title', 'tags', 'summary']);
  // 仅摘要命中
  seedIndex(db, vid, 'only-summary.md', { title: null, tags: [], summary: '唯一 deploy 关键词在正文首段。' });
  const hits = searchKeyword(db, emp, '唯一 deploy').hits.map((h) => h.path);
  assert.deepEqual(hits, ['only-summary.md']);
});

test('LIKE 通配符按字面匹配：% 与 _ 不充当通配符', () => {
  const { db, emp } = setup();
  const vid = addVault(db, 'docs', emp);
  addMember(db, vid, emp, 'reader', emp);
  seedIndex(db, vid, 'literal.md', { title: '费率 5% 手册', tags: [], summary: '' });
  seedIndex(db, vid, 'underscore.md', { title: 'snake_case 命名', tags: [], summary: '' });
  seedIndex(db, vid, 'wild.md', { title: 'aXc 通配陷阱', tags: [], summary: '' }); // a_c 作通配符才会命中
  assert.deepEqual(searchKeyword(db, emp, '5%').hits.map((h) => h.path), ['literal.md']);
  assert.deepEqual(searchKeyword(db, emp, 'snake_case').hits.map((h) => h.path), ['underscore.md']);
  assert.deepEqual(searchKeyword(db, emp, 'a_c').hits, []);
});

test('ASCII 大小写不敏感（SQLite LIKE 语义）；空关键词返回空结果（防御）', () => {
  const { db, emp } = setup();
  const vid = addVault(db, 'docs', emp);
  addMember(db, vid, emp, 'reader', emp);
  seedIndex(db, vid, 'a.md', { title: 'kpi 指标', tags: [], summary: '' });
  assert.equal(searchKeyword(db, emp, 'KPI').hits.length, 1);
  assert.equal(searchKeyword(db, emp, 'Kpi').hits.length, 1);
  assert.deepEqual(searchKeyword(db, emp, '').hits, []);
  assert.deepEqual(searchKeyword(db, emp, '   ').hits, []);
});

test('非成员库的命中不可见（高权账号陷阱的查询面形态）：实例管理员也不例外', () => {
  const { db, emp } = setup();
  const admin = addEmployee(db, { username: 'root', is_instance_admin: 1 });
  const mine = addVault(db, 'mine', emp);
  const other = addVault(db, 'other', admin); // admin 建的库，但未授权 emp
  addMember(db, mine, emp, 'reader', emp); // emp 不是 other 的成员
  seedIndex(db, mine, 'mine.md', { title: '机密 keyword 文档', tags: [], summary: '' });
  seedIndex(db, other, 'trap.md', { title: 'keyword 陷阱标题', tags: ['keyword'], summary: 'keyword 首段' });
  // emp 搜 keyword：只见自己成员库
  assert.deepEqual(searchKeyword(db, emp, 'keyword').hits.map((h) => h.path), ['mine.md']);
  // 高权账号（实例管理员、且是 other 的库管理员）不是 mine 成员：只见 other
  addMember(db, other, admin, 'admin', admin);
  assert.deepEqual(searchKeyword(db, admin, 'keyword').hits.map((h) => h.path), ['trap.md']);
  // 无任何成员关系的账号：零结果（不泄露库存在性）
  const nobody = addEmployee(db, { username: 'nobody' });
  assert.deepEqual(searchKeyword(db, nobody, 'keyword').hits, []);
});

test('撤权下一查询即消失（无缓存授权同源——同一 db 实例上立即生效）', () => {
  const { db, emp } = setup();
  const vid = addVault(db, 'docs', emp);
  const other = addVault(db, 'other', emp);
  addMember(db, vid, emp, 'reader', emp);
  addMember(db, other, emp, 'reader', emp);
  seedIndex(db, vid, 'a.md', { title: 'keyword a', tags: [], summary: '' });
  seedIndex(db, other, 'b.md', { title: 'keyword b', tags: [], summary: '' });
  assert.equal(searchKeyword(db, emp, 'keyword').hits.length, 2);
  db.prepare('DELETE FROM vault_members WHERE vault_id = ? AND employee_id = ?').run(vid, emp);
  const after = searchKeyword(db, emp, 'keyword');
  assert.deepEqual(after.hits.map((h) => h.vaultSlug), ['other'], '撤权库的命中下一查询消失');
});

test('token scope 交集（identity §3.4）：非空清单收窄、空清单=全部有权库', () => {
  const { db, emp } = setup();
  const v1 = addVault(db, 'v1', emp);
  const v2 = addVault(db, 'v2', emp);
  addMember(db, v1, emp, 'reader', emp);
  addMember(db, v2, emp, 'reader', emp);
  seedIndex(db, v1, 'a.md', { title: 'keyword a', tags: [], summary: '' });
  seedIndex(db, v2, 'b.md', { title: 'keyword b', tags: [], summary: '' });
  assert.deepEqual(searchKeyword(db, emp, 'keyword', [v1]).hits.map((h) => h.vaultSlug), ['v1']);
  assert.deepEqual(searchKeyword(db, emp, 'keyword', []).hits.map((h) => h.vaultSlug).sort(), ['v1', 'v2']);
});

test('确定性排序（vault slug → path）与上限（100 行 + truncated 标志）', () => {
  const { db, emp } = setup();
  const vB = addVault(db, 'beta', emp);
  const vA = addVault(db, 'alpha', emp);
  addMember(db, vA, emp, 'reader', emp);
  addMember(db, vB, emp, 'reader', emp);
  for (let i = 0; i < SEARCH_RESULT_LIMIT + 5; i++) {
    seedIndex(db, vB, `b${String(i).padStart(3, '0')}.md`, { title: `keyword b${i}`, tags: [], summary: '' });
  }
  seedIndex(db, vA, 'z.md', { title: 'keyword z', tags: [], summary: '' });
  seedIndex(db, vA, 'a.md', { title: 'keyword a', tags: [], summary: '' });
  const page1 = searchKeyword(db, emp, 'keyword');
  assert.equal(page1.hits.length, SEARCH_RESULT_LIMIT);
  assert.equal(page1.truncated, true);
  assert.deepEqual(page1.hits.slice(0, 3).map((h) => h.path), ['a.md', 'z.md', 'b000.md'], '排序 vault slug → path');
  // 恰好 100 行：不截断（vB 留 98 行 + vA 两行；删 b098–b104 共 7 行）
  db.prepare(`DELETE FROM search_index WHERE vault_id = ? AND path >= 'b098'`).run(vB);
  const exact = searchKeyword(db, emp, 'keyword');
  assert.equal(exact.hits.length, SEARCH_RESULT_LIMIT);
  assert.equal(exact.truncated, false);
});

test('关键词长度上界常量（路由层校验消费）：200 字符', () => {
  assert.equal(SEARCH_MAX_Q_CHARS, 200);
  assert.equal(SEARCH_RESULT_LIMIT, 100);
});

// ── S11-T1 全文检索 v1：path/body 命中与 matched 标注扩展（D20；F-3 对照） ──

test('文件名命中：q=roadmap 命中 docs/roadmap.md（matched=[path]）；ASCII 大小写不敏感同语义', () => {
  const { db, emp } = setup();
  const vid = addVault(db, 'docs', emp);
  addMember(db, vid, emp, 'reader', emp);
  // roadmap 一词只在路径——title/tags/summary/body 均不含（F-3 现状该行 0 命中）
  seedIndex(db, vid, 'docs/roadmap.md', { title: '路线图', tags: ['规划'], summary: '路线说明首段。', body: '\n路线说明首段。\n' });
  seedIndex(db, vid, 'README.md', { title: null, tags: [], summary: '# 导航', body: '# 导航\n' });
  const r = searchKeyword(db, emp, 'roadmap');
  assert.deepEqual(r.hits.map((h) => h.path), ['docs/roadmap.md']);
  assert.deepEqual(r.hits[0]!.matched, ['path']);
  assert.equal(searchKeyword(db, emp, 'ROADMAP').hits.length, 1, 'path 命中同样 ASCII 大小写不敏感');
});

test('正文命中：q=差旅 命中 body 次段（matched=[body]——summary 只是首段不含次段词）', () => {
  const { db, emp } = setup();
  const vid = addVault(db, 'docs', emp);
  addMember(db, vid, emp, 'reader', emp);
  seedIndex(db, vid, 'policy.md', {
    title: '制度汇编',
    tags: ['行政'],
    summary: '制度总览首段。',
    body: '\n制度总览首段。\n\n差旅政策：报销按季度结算。\n',
  });
  const r = searchKeyword(db, emp, '差旅');
  assert.deepEqual(r.hits.map((h) => h.path), ['policy.md']);
  assert.deepEqual(r.hits[0]!.matched, ['body']);
  // body=''（迁移前行形态/非 .md 语义）：不参与正文命中
  seedIndex(db, vid, 'legacy.md', { title: null, tags: [], summary: '', body: '' });
  assert.equal(searchKeyword(db, emp, '制度总览').hits.length, 1, '空 body 行不因空串误命中');
});

test('matched 标注全集与顺序：title→tags→summary→path→body（五字段同词命中的固定序）', () => {
  const { db, emp } = setup();
  const vid = addVault(db, 'docs', emp);
  addMember(db, vid, emp, 'reader', emp);
  seedIndex(db, vid, 'deploy/deploy.md', {
    title: 'deploy 手册',
    tags: ['deploy'],
    summary: 'deploy 步骤首段。',
    body: '\ndeploy 步骤首段。\n\ndeploy 全文第二段。\n',
  });
  const hit = searchKeyword(db, emp, 'deploy').hits[0]!;
  assert.equal(hit.path, 'deploy/deploy.md');
  assert.deepEqual(hit.matched, ['title', 'tags', 'summary', 'path', 'body'], 'S11-T1 标注集 = 五字段固定序');
});

test('path/body 的 LIKE 语义与既有完全同一：%/_ 按字面匹配（不充当通配符）', () => {
  const { db, emp } = setup();
  const vid = addVault(db, 'docs', emp);
  addMember(db, vid, emp, 'reader', emp);
  seedIndex(db, vid, 'rate.md', { title: null, tags: [], summary: '', body: '达成率 100% 的正文。\n' });
  seedIndex(db, vid, 'snake_case.md', { title: null, tags: [], summary: '' }); // 路径含 _
  seedIndex(db, vid, 'wild.md', { title: null, tags: [], summary: '', body: 'aXc 正文\n' }); // a_c 作通配才会命中
  assert.deepEqual(searchKeyword(db, emp, '100%').hits.map((h) => h.path), ['rate.md'], 'body 中 % 字面匹配');
  assert.deepEqual(searchKeyword(db, emp, 'snake_case').hits.map((h) => h.path), ['snake_case.md'], 'path 中 _ 字面匹配');
  assert.deepEqual(searchKeyword(db, emp, 'a_c').hits, [], '下划线不通配 body/path');
});

test('非成员库的 path/body 命中不可见（可见性过滤延续到新命中面）', () => {
  const { db, emp } = setup();
  const other = addEmployee(db, { username: 'bob' });
  const mine = addVault(db, 'mine', emp);
  const theirs = addVault(db, 'theirs', other);
  addMember(db, mine, emp, 'reader', emp);
  addMember(db, theirs, other, 'admin', other); // bob 是自有库成员（对照侧可命中）
  seedIndex(db, mine, 'roadmap-mine.md', { title: null, tags: [], summary: '', body: 'keyword 正文' });
  seedIndex(db, theirs, 'roadmap-theirs.md', { title: null, tags: [], summary: '', body: 'keyword 正文' });
  assert.deepEqual(searchKeyword(db, emp, 'roadmap').hits.map((h) => h.path), ['roadmap-mine.md'], '仅本人成员库');
  assert.deepEqual(searchKeyword(db, other, 'keyword').hits.map((h) => h.path), ['roadmap-theirs.md']);
});
