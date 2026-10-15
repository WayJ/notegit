import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db/connection.ts';
import { migrate } from '../src/db/migrate.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { createSession, DEFAULT_SESSION_TIMEOUTS } from '../src/auth/sessions.ts';
import { FIXTURE_DDL, addEmployee, addVault, addMember } from './credentials-fixtures.ts';

// S15-T1 检索筛选（W04/DOD-E4-05；S15 D1/D3）：/search 库筛选 GET 参数 vault
// （默认 all）。下拉=全部+当前员工有权库（数据面与 /vaults 列表同一实时 JOIN
// vault_members——无权库绝不出现为选项，D26 侧信道延伸）；vault=<slug> 命中集
// 收窄到该库（既有 LIKE 子串/可见性过滤/100 截断语义全保持——search/query.ts
// 鉴权语义不动，收窄参数调用侧装配）；直传 vault=<无权或不存在 slug> 按
// D-IC-06「无权=不存在」处理——与未知库同形态（命中集空+如实提示，零泄露，
// 不报「你无权」）；⌘K/Ctrl-K 聚焦搜索框（页内增强——/search 页唯一内联
// script 块内；无 JS 时 GET 表单仍可提交，渐进增强）；未认证 302 不变。

interface Harness {
  app: FastifyInstance;
  db: DatabaseSync;
  pepper: { active: { version: number; key: Buffer }; retired: never[] };
  close(): Promise<void>;
}

let h: Harness;
let empId: number;
let otherId: number;
let vMine: number;
let vTeam: number;
let vProduct: number;

async function startHarness(): Promise<Harness> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'notegit-s15t1-filter-'));
  const dbFile = path.join(dataDir, 'db', 'notegit.sqlite');
  await mkdir(path.dirname(dbFile), { recursive: true });
  const db = openDatabase(dbFile);
  migrate(db, MIGRATIONS);
  for (const ddl of FIXTURE_DDL) db.exec(ddl);

  empId = addEmployee(db, { username: 'alice' });
  otherId = addEmployee(db, { username: 'bob' });
  vMine = addVault(db, 'mine', empId);
  vTeam = addVault(db, 'team', otherId);
  vProduct = addVault(db, 'product-notes', empId);
  addMember(db, vMine, empId, 'reader', empId);
  addMember(db, vTeam, empId, 'admin', empId);
  addMember(db, vTeam, otherId, 'reader', otherId);
  addMember(db, vProduct, empId, 'admin', empId); // bob 非 product-notes 成员

  const ins = db.prepare(
    `INSERT INTO search_index (vault_id, path, commit_oid, title, tags, summary, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const now = new Date().toISOString();
  ins.run(vMine, 'guide.md', 'c1', '新人 keyword 手册', JSON.stringify(['onboarding', 'keyword']), 'keyword 首段摘要。', now);
  ins.run(vTeam, 'shared.md', 'c2', 'keyword 协作页', JSON.stringify(['keyword']), 'team keyword 摘要。', now);
  ins.run(vProduct, 'secret.md', 'c3', 'keyword 产品发布', JSON.stringify(['keyword']), 'product keyword 摘要。', now);
  // 截断注记用：mine 内 101 行独立关键词命中（不污染 keyword 集合断言）
  for (let i = 0; i < 101; i++) {
    ins.run(vMine, `bulk/bulk-${String(i).padStart(3, '0')}.md`, `b${i}`, `bulk 批次 ${i}`, '[]', 'bulk 正文片段。', now);
  }

  const pepper = { active: { version: 1, key: randomBytes(32) }, retired: [] as never[] };
  const app = buildApp({
    db,
    pepper,
    bootstrapTokenFile: path.join(dataDir, 'config', 'admin-bootstrap.token'),
  });
  await app.ready();
  return {
    app,
    db,
    pepper,
    close: async () => {
      await app.close();
      db.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

before(async () => {
  h = await startHarness();
});
after(async () => {
  await h.close();
});

function session(employeeId: number): Record<string, string> {
  const sid = createSession(h.db, employeeId, h.pepper.active.key, new Date(), DEFAULT_SESSION_TIMEOUTS).sid;
  return { cookie: `ngt_sid=${sid}` };
}

async function get(url: string, headers?: Record<string, string>): Promise<{ status: number; body: string; location?: string }> {
  const res = await h.app.inject({ method: 'GET', url, headers });
  return { status: res.statusCode, body: res.body, location: res.headers['location'] };
}

/** 结果行（库/路径对）提取（data-* 属性为既有断言面） */
function hitRows(body: string): string[] {
  return [...body.matchAll(/<tr data-vault="([^"]*)" data-path="([^"]*)"/g)].map((m) => `${m[1]}:${m[2]}`);
}

test('未认证 302 /login 不变（vault 参数不影响门槛）', async () => {
  const res = await get('/search?q=keyword&vault=team');
  assert.equal(res.status, 302);
  assert.equal(res.location, '/login');
});

test('下拉=全部+有权库（实时成员过滤）：alice 见三库；bob 只见 team（无 product-notes/mine）', async () => {
  const alice = await get('/search', session(empId));
  assert.equal(alice.status, 200);
  assert.ok(alice.body.includes('<option value="all"'), '「全部库」选项在位');
  assert.ok(alice.body.includes('<option value="mine"'), '有权库 mine 入选项');
  assert.ok(alice.body.includes('<option value="team"'), '有权库 team 入选项');
  assert.ok(alice.body.includes('<option value="product-notes"'), 'alice 是 product-notes 成员——如实入选项');

  const bob = await get('/search', session(otherId));
  assert.equal(bob.status, 200);
  assert.ok(bob.body.includes('<option value="team"'), 'bob 有权库 team 入选项');
  assert.ok(!bob.body.includes('<option value="mine"'), '非成员库 mine 不入 bob 选项');
  assert.ok(!bob.body.includes('<option value="product-notes"'), 'bob 下拉无 product-notes');
});

test('vault=all：命中集=各自有权库全集（alice 三库；bob 仅 team——无权库行不出现）', async () => {
  const alice = await get('/search?q=keyword&vault=all', session(empId));
  assert.equal(alice.status, 200);
  assert.deepEqual(hitRows(alice.body), ['mine:guide.md', 'product-notes:secret.md', 'team:shared.md']);

  const bob = await get('/search?q=keyword&vault=all', session(otherId));
  assert.equal(bob.status, 200);
  assert.deepEqual(hitRows(bob.body), ['team:shared.md'], 'bob 视角：无权库（mine/product-notes）行不出现');
});

test('vault=具体库：命中收窄到该库；下拉选中态保持', async () => {
  const res = await get('/search?q=keyword&vault=team', session(empId));
  assert.equal(res.status, 200);
  assert.deepEqual(hitRows(res.body), ['team:shared.md'], '收窄到 team，mine 行不出现');
  assert.ok(res.body.includes('<option value="team" selected'), '选中态回显');
  assert.ok(!res.body.includes('<option value="mine" selected'), '未选中项不带 selected');
});

test('q+vault 组合：库内无命中如实空态（state-note）', async () => {
  const res = await get('/search?q=bulk&vault=team', session(empId));
  assert.equal(res.status, 200);
  assert.deepEqual(hitRows(res.body), [], 'bulk 行仅在 mine——team 视角空命中');
  assert.ok(res.body.includes('state-note'), '空态如实提示');
});

test('直传无权库（bob × vault=product-notes）：D-IC-06 无权=不存在——空命中+如实提示+零泄露', async () => {
  const res = await get('/search?q=keyword&vault=product-notes', session(otherId));
  assert.equal(res.status, 200);
  assert.deepEqual(hitRows(res.body), [], '无权库命中集为空');
  assert.ok(res.body.includes('无匹配结果'), '如实提示（无匹配结果形态）');
  assert.ok(!res.body.includes('你无权'), '不报「你无权」——不区分两种语义');
  assert.ok(!res.body.includes('product-notes'), '零泄露：slug 不出现在页面任何位置（含下拉与提示）');
});

test('直传不存在库：与无权库同形态（两响应逐字节同体）', async () => {
  const unknown = await get('/search?q=keyword&vault=no-such-vault', session(otherId));
  const denied = await get('/search?q=keyword&vault=product-notes', session(otherId));
  assert.equal(unknown.status, 200);
  assert.deepEqual(hitRows(unknown.body), []);
  assert.equal(unknown.body, denied.body, '未知库与无权库同页同体（D-IC-06——不区分两种语义）');
});

test('q+vault 组合与截断注记：100 上限如实标注', async () => {
  const res = await get('/search?q=bulk&vault=mine', session(empId));
  assert.equal(res.status, 200);
  const rows = hitRows(res.body);
  assert.equal(rows.length, 100, '命中 101 行仅显示前 100');
  assert.ok(
    rows.every((r) => r.startsWith('mine:bulk/')),
    '收窄到 mine 的 bulk 行',
  );
  assert.ok(res.body.includes('超过 100 条'), '截断注记在位');
});

test('⌘K/Ctrl-K 接线：唯一内联 script 含 keydown 监听与 focus 调用', async () => {
  const res = await get('/search', session(empId));
  assert.equal(res.status, 200);
  assert.equal([...res.body.matchAll(/<script>/g)].length, 1, '恰一内联 script 块');
  assert.ok(!res.body.includes('<script src='), '无共享脚本引用（页内增强）');
  assert.ok(res.body.includes("addEventListener('keydown'"), 'keydown 监听在位');
  assert.ok(res.body.includes('ev.metaKey || ev.ctrlKey'), '修饰键判定在位');
  assert.ok(res.body.includes("ev.key === 'k'"), 'k 键判定在位');
  assert.ok(res.body.includes('preventDefault()'), 'preventDefault 在位');
  assert.ok(res.body.includes("getElementById('q')") && res.body.includes('.focus()'), '聚焦搜索框');
});

test('无 JS 表单提交路径：GET action=/search、q 与 vault 字段在位', async () => {
  const res = await get('/search', session(empId));
  assert.equal(res.status, 200);
  assert.ok(/<form method="get" action="\/search"/.test(res.body), 'GET 表单（无 JS 可提交）');
  assert.ok(/<input[^>]*name="q"/.test(res.body), 'q 字段在位');
  assert.ok(/<select[^>]*name="vault"/.test(res.body), 'vault 字段在位');
  assert.ok(/<button[^>]*type="submit"/.test(res.body), '提交按钮在位');
});

test('撤权即从下拉与命中集消失（实时成员过滤——D26 同判定面）', async () => {
  addMember(h.db, vProduct, otherId, 'reader', empId); // 授权 bob
  const granted = await get('/search', session(otherId));
  assert.ok(granted.body.includes('<option value="product-notes"'), '授权后下拉即呈现（实时）');
  const hit = await get('/search?q=keyword&vault=product-notes', session(otherId));
  assert.deepEqual(hitRows(hit.body), ['product-notes:secret.md'], '授权后命中集收窄可见');

  h.db.prepare('DELETE FROM vault_members WHERE vault_id = ? AND employee_id = ?').run(vProduct, otherId); // 撤权
  const revoked = await get('/search', session(otherId));
  assert.ok(!revoked.body.includes('<option value="product-notes"'), '撤权后下拉下一请求即消失');
  const after = await get('/search?q=keyword&vault=product-notes', session(otherId));
  assert.deepEqual(hitRows(after.body), [], '撤权后直传命中集为空');
  assert.ok(!after.body.includes('product-notes'), '撤权后零泄露');
});
