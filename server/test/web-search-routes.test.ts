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

// S5-T4 搜索页 GET /search?q=（S4 骨架 append；api.md §13 表行待 D13——建议稿
// docs/s1/search-index-amendments.md C3）：会话认证（未认证 302 /login）；结果
// 仅本人成员库（查询面实时 JOIN——与 API 端点同一判定面）；插值唯一通道
// escapeHtml（XSS 诱饵不执行）；q 回显转义；结果行 data-* 属性供断言；空 q
// 呈现表单空态、超长 q 422 页内提示。

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
let vOther: number;

async function startHarness(): Promise<Harness> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'notegit-t4-page-'));
  const dbFile = path.join(dataDir, 'db', 'notegit.sqlite');
  await mkdir(path.dirname(dbFile), { recursive: true });
  const db = openDatabase(dbFile);
  migrate(db, MIGRATIONS);
  for (const ddl of FIXTURE_DDL) db.exec(ddl);

  empId = addEmployee(db, { username: 'alice' });
  otherId = addEmployee(db, { username: 'bob' });
  vMine = addVault(db, 'mine', empId);
  vOther = addVault(db, 'other', otherId);
  addMember(db, vMine, empId, 'reader', empId);
  addMember(db, vOther, otherId, 'admin', otherId);

  const ins = db.prepare(
    `INSERT INTO search_index (vault_id, path, commit_oid, title, tags, summary, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const now = new Date().toISOString();
  ins.run(vMine, 'guide.md', 'c1', '新人 keyword 手册', JSON.stringify(['onboarding', 'keyword']), 'keyword 首段摘要。', now);
  ins.run(vOther, 'trap.md', 'c2', 'keyword 陷阱标题', JSON.stringify(['keyword']), 'keyword 摘要。', now);

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

test('未认证 302 /login', async () => {
  const res = await get('/search?q=keyword');
  assert.equal(res.status, 302);
  assert.equal(res.location, '/login');
});

test('空 q 呈现表单空态（200，无结果区）', async () => {
  const res = await get('/search', session(empId));
  assert.equal(res.status, 200);
  assert.ok(res.body.includes('<form'));
  assert.ok(!res.body.includes('data-vault='), '无关键词不出结果行');
});

test('命中行含 库/路径/commit/片段 与命中字段；仅本人成员库（陷阱行不出现）；链接指向 view', async () => {
  const res = await get('/search?q=keyword', session(empId));
  assert.equal(res.status, 200);
  const rows = [...res.body.matchAll(/<tr data-vault="([^"]*)" data-path="([^"]*)" data-commit="([^"]*)" data-matched="([^"]*)"/g)];
  assert.deepEqual(
    rows.map((m) => `${m[1]}:${m[2]}:${m[3]}:${m[4]}`),
    ['mine:guide.md:c1:title,tags,summary'],
    '仅成员库命中；无权库 trap 行不出现',
  );
  assert.ok(res.body.includes('keyword 首段摘要。'), '摘要片段呈现');
  assert.ok(res.body.includes('href="/vaults/mine/view/guide.md"'), '路径链接指向 view 页');
  assert.ok(res.body.includes('href="/vaults/mine/browse"'), '库名链接指向 browse 页');
});

test('XSS 诱饵：title/q 含 HTML 不执行（转义后呈现）', async () => {
  h.db
    .prepare(
      `INSERT INTO search_index (vault_id, path, commit_oid, title, tags, summary, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(vMine, 'evil.md', 'c3', '<script>alert(1)</script> 引诱', '[]', '', new Date().toISOString());
  const res = await get(`/search?q=${encodeURIComponent('<script>alert(1)</script>')}`, session(empId));
  assert.equal(res.status, 200);
  assert.ok(!res.body.includes('<script>alert'), 'script 标签不可达');
  assert.ok(res.body.includes('&lt;script&gt;'), '转义后如实呈现');
});

test('撤权下一请求即消失（页面形态与 API 同判定面）', async () => {
  const before = await get('/search?q=keyword', session(empId));
  assert.ok(before.body.includes('data-vault="mine"'));
  h.db.prepare('DELETE FROM vault_members WHERE vault_id = ? AND employee_id = ?').run(vMine, empId);
  const after = await get('/search?q=keyword', session(empId));
  assert.equal(after.status, 200);
  assert.ok(!after.body.includes('data-vault='), '撤权后命中下一请求（页面渲染）即消失');
  addMember(h.db, vMine, empId, 'reader', empId); // 还原（后续用例）
});

test('超长 q：422 页内提示（提示与表单同页）', async () => {
  const res = await get(`/search?q=${encodeURIComponent('x'.repeat(201))}`, session(empId));
  assert.equal(res.status, 422);
  assert.ok(res.body.includes('<form'), '表单仍在（可修正重查）');
});
