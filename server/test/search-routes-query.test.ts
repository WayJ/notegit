import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { CredentialsService } from '../src/credentials/service.ts';
import { openDatabase } from '../src/db/connection.ts';
import { migrate } from '../src/db/migrate.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { FIXTURE_DDL, addEmployee, addVault, addMember } from './credentials-fixtures.ts';

// S5-T4 查询端点 GET /api/v1/search?q=（建议稿形态——api.md 未入册，文本随
// docs/s1/search-index-amendments.md C3 待 D13 由 master 落）：任意认证员工；
// 按当前成员关系实时过滤（JOIN vault_members 逐请求查库，D7 无缓存授权同源）
// + token scope 交集（identity §3.4）；LIKE 子串转义；错误 400/422 与 §1 通用
// 401 同语义。索引行直插（索引器行为属 T3 测试域——本文件只测查询端点契约）。

interface Harness {
  app: FastifyInstance;
  db: DatabaseSync;
  pepper: { active: { version: number; key: Buffer }; retired: never[] };
  close(): Promise<void>;
}

let h: Harness;
let empToken: string;
let otherToken: string;
let empId: number;
let vMine: number;
let vOther: number;

async function startHarness(): Promise<Harness> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'notegit-t4-q-'));
  const dbFile = path.join(dataDir, 'db', 'notegit.sqlite');
  await mkdir(path.dirname(dbFile), { recursive: true });
  const db = openDatabase(dbFile);
  migrate(db, MIGRATIONS);
  for (const ddl of FIXTURE_DDL) db.exec(ddl);

  empId = addEmployee(db, { username: 'alice' });
  const other = addEmployee(db, { username: 'bob' });
  vMine = addVault(db, 'mine', empId);
  vOther = addVault(db, 'other', other);
  addMember(db, vMine, empId, 'reader', empId);
  addMember(db, vOther, other, 'admin', other);

  const ins = db.prepare(
    `INSERT INTO search_index (vault_id, path, commit_oid, title, tags, summary, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const now = new Date().toISOString();
  ins.run(vMine, 'mine/guide.md', 'c1', '新人 keyword 手册', JSON.stringify(['onboarding']), 'keyword 首段。', now);
  ins.run(vOther, 'other/trap.md', 'c2', 'keyword 陷阱标题', JSON.stringify(['keyword']), 'keyword 摘要。', now);

  const pepper = { active: { version: 1, key: randomBytes(32) }, retired: [] as never[] };
  const service = new CredentialsService({ db, pepper });
  const expires = new Date(Date.now() + 7 * 86_400_000).toISOString();
  empToken = service.createCredential(empId, { name: 'alice', expires_at: expires }).token;
  otherToken = service.createCredential(other, { name: 'bob', expires_at: expires }).token;

  const app = buildApp({
    db,
    pepper,
    bootstrapTokenFile: path.join(dataDir, 'config', 'admin-bootstrap.token'),
    // 无 dataDir（查询端点不依赖索引器接线——直读 search_index 表）
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

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

interface ApiHit {
  vault_slug: string;
  vault_name: string;
  path: string;
  commit_oid: string;
  title: string | null;
  tags: string[];
  summary: string;
  matched: string[];
}

async function search(token: string, q: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await h.app.inject({ method: 'GET', url: `/api/v1/search?q=${encodeURIComponent(q)}`, headers: bearer(token) });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

test('401 未认证（§1 通用语义）', async () => {
  const res = await h.app.inject({ method: 'GET', url: '/api/v1/search?q=keyword' });
  assert.equal(res.statusCode, 401);
  assert.equal((res.json() as { error: { code: string } }).error.code, 'E-AUTH-001');
});

test('400 E-RES-004：缺 q / 空 q / 纯空白 q', async () => {
  for (const url of ['/api/v1/search', '/api/v1/search?q=', '/api/v1/search?q=%20%20']) {
    const res = await h.app.inject({ method: 'GET', url, headers: bearer(empToken) });
    assert.equal(res.statusCode, 400, url);
    assert.equal((res.json() as { error: { code: string } }).error.code, 'E-RES-004', url);
  }
});

test('422 E-RES-007：q 超长（>200 字符）', async () => {
  const res = await h.app.inject({
    method: 'GET',
    url: `/api/v1/search?q=${encodeURIComponent('x'.repeat(201))}`,
    headers: bearer(empToken),
  });
  assert.equal(res.statusCode, 422);
  assert.equal((res.json() as { error: { code: string } }).error.code, 'E-RES-007');
});

test('成员视角：200 命中仅本人成员库；结果含 库/路径/commit/片段/命中字段；truncated=false', async () => {
  const { status, body } = await search(empToken, 'keyword');
  assert.equal(status, 200);
  assert.equal(body['q'], 'keyword');
  assert.equal(body['truncated'], false);
  const results = body['results'] as ApiHit[];
  assert.equal(results.length, 1, '无权库的标题命中不出现在结果');
  const hit = results[0]!;
  assert.equal(hit.vault_slug, 'mine');
  assert.equal(hit.vault_name, 'mine');
  assert.equal(hit.path, 'mine/guide.md');
  assert.equal(hit.commit_oid, 'c1');
  assert.equal(hit.title, '新人 keyword 手册');
  assert.deepEqual(hit.tags, ['onboarding']);
  assert.equal(hit.summary, 'keyword 首段。');
  assert.deepEqual(hit.matched, ['title', 'summary']);
});

test('另一员工视角：同一关键词只见其成员库（结果集互不泄露）', async () => {
  const { status, body } = await search(otherToken, 'keyword');
  assert.equal(status, 200);
  assert.deepEqual((body['results'] as ApiHit[]).map((r) => r.vault_slug), ['other']);
});

test('撤权下一请求即消失（实时 JOIN——无缓存授权同源）', async () => {
  const before = await search(empToken, 'keyword');
  assert.equal((before.body['results'] as ApiHit[]).length, 1);
  h.db.prepare('DELETE FROM vault_members WHERE vault_id = ? AND employee_id = ?').run(vMine, empId);
  const after = await search(empToken, 'keyword');
  assert.equal(after.status, 200);
  assert.deepEqual(after.body['results'], [], '撤权后该员工搜索结果下一查询即消失');
});

test('token scope 交集（identity §3.4）：scope 清单外的成员库不出结果', async () => {
  // 前一用例撤掉了 alice 在 mine 的成员关系——本用例自足重建（alice 两库成员）
  addMember(h.db, vMine, empId, 'reader', empId);
  addMember(h.db, vOther, empId, 'reader', empId);
  const scoped = new CredentialsService({ db: h.db, pepper: h.pepper }).createCredential(empId, {
    name: 'scoped',
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    scope: { access: 'read', vaults: ['mine'] },
  }).token;
  const { status, body } = await search(scoped, 'keyword');
  assert.equal(status, 200);
  assert.deepEqual((body['results'] as ApiHit[]).map((r) => r.vault_slug), ['mine'], 'scope 清单收窄搜索结果');
  h.db.prepare('DELETE FROM vault_members WHERE vault_id = ? AND employee_id = ?').run(vOther, empId);
});

test('LIKE 通配符经端点仍按字面匹配（% 编码传入不充当通配符）', async () => {
  const ins = h.db.prepare(
    `INSERT INTO search_index (vault_id, path, commit_oid, title, tags, summary, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const now = new Date().toISOString();
  ins.run(vMine, 'rate.md', 'c3', '费率 5% 表', '[]', '', now);
  ins.run(vMine, 'wild.md', 'c4', 'aXc 通配陷阱', '[]', '', now);
  const pct = await search(empToken, '5%');
  assert.deepEqual((pct.body['results'] as ApiHit[]).map((r) => r.path), ['rate.md']);
  const us = await search(empToken, 'a_c');
  assert.deepEqual(us.body['results'], [], '下划线不充当单字符通配符');
});
