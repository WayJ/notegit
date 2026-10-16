import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { CredentialsService } from '../src/credentials/service.ts';
import { openDatabase } from '../src/db/connection.ts';
import { migrate } from '../src/db/migrate.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { initBareVaultRepo } from '../src/gitrepo/lifecycle.ts';
import { vaultRepoPath } from '../src/vaults/repo-path.ts';
import { invalidateVaultTreeCache } from '../src/readcache/tree-cache.ts';
import { FIXTURE_DDL, addEmployee, addVault, addMember } from './credentials-fixtures.ts';

// S18-T2 文档读取端点 GET /api/v1/vaults/{slug}/docs/{path}[?ref=<commit OID>]
// （D3 形态；D38 ref=OID 与 version 页同一棵树——历史 blob 鉴权同源；frontmatter
// 三态：合法对象 / 豁免·无块 null / 畸形 null+原文全量；非 .md 415 如实）。

const V1_DOC = '---\ntitle: 部署手册\ntags:\n  - deploy\n  - guide\nstatus: active\n---\n\n# 部署手册 v1\n\n旧内容标记\n';
const V2_DOC = '---\ntitle: 部署手册\ntags:\n  - deploy\nstatus: active\n---\n\n# 部署手册 v2\n\n新内容标记\n';

interface Harness {
  app: FastifyInstance;
  db: DatabaseSync;
  dataDir: string;
  close(): Promise<void>;
}

let h: Harness;
let aliceToken: string;
let bobToken: string;
let alphaId: number;
let v1Oid = '';

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function gitOut(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { env: process.env });
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => (err += c));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(Buffer.concat(out).toString('utf8')) : reject(new Error(`git ${args[0]}: ${err}`)),
    );
  });
}

let seedSeq = 0;

async function seedVaultRepo(dataDir: string, vaultId: number, files: Record<string, string>): Promise<string> {
  const repoPath = vaultRepoPath(dataDir, vaultId);
  const work = path.join(dataDir, `seed-${vaultId}-${++seedSeq}`);
  await gitOut(['init', '-b', 'main', work]);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(work, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
  }
  await gitOut(['-C', work, 'add', '.']);
  await gitOut(['-C', work, '-c', 'user.email=seed@notegit.test', '-c', 'user.name=seed', 'commit', '-m', 'seed']);
  await gitOut(['-C', work, 'push', repoPath, 'HEAD:refs/heads/main']);
  await rm(work, { recursive: true, force: true });
  return (await gitOut(['--git-dir', repoPath, 'rev-parse', 'refs/heads/main'])).trim();
}

/** 在既有提交之上追加一笔（clone→写→commit→push，快进）——返回新头 */
async function pushToVault(dataDir: string, vaultId: number, files: Record<string, string>): Promise<string> {
  const repoPath = vaultRepoPath(dataDir, vaultId);
  const work = path.join(dataDir, `push-${vaultId}-${++seedSeq}`);
  await gitOut(['clone', '--quiet', repoPath, work]);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(work, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
  }
  await gitOut(['-C', work, 'add', '.']);
  await gitOut(['-C', work, '-c', 'user.email=seed@notegit.test', '-c', 'user.name=seed', 'commit', '-q', '-m', 'more']);
  await gitOut(['-C', work, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main']);
  await rm(work, { recursive: true, force: true });
  invalidateVaultTreeCache(repoPath); // S24-T1：直连 push 无审计行——显式失效（对齐生产 push 语义）
  return (await gitOut(['--git-dir', repoPath, 'rev-parse', 'refs/heads/main'])).trim();
}

before(async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'notegit-s18t2-docs-'));
  const dbFile = path.join(dataDir, 'db', 'notegit.sqlite');
  await mkdir(path.dirname(dbFile), { recursive: true });
  const db = openDatabase(dbFile);
  migrate(db, MIGRATIONS);
  for (const ddl of FIXTURE_DDL) db.exec(ddl);

  const aliceId = addEmployee(db, { username: 'alice' });
  const bobId = addEmployee(db, { username: 'bob' });
  alphaId = addVault(db, 'alpha', aliceId);
  addMember(db, alphaId, aliceId, 'reader', aliceId);
  await initBareVaultRepo(dataDir, alphaId);
  v1Oid = await seedVaultRepo(dataDir, alphaId, {
    'docs/guide.md': V1_DOC,
    'README.md': '# 豁免导航\n\n无 frontmatter 的 README\n',
    'docs/broken-unterminated.md': '---\ntitle: 半截\n\n正文仍在。\n',
    'docs/broken-block.md': '---\ntitle: 表面合法\n  缩进: [破坏\n---\n\n正文此处。\n',
    'assets/logo.png': 'png-stub',
  });
  await pushToVault(dataDir, alphaId, { 'docs/guide.md': V2_DOC });

  const pepper = { active: { version: 1, key: randomBytes(32) }, retired: [] as never[] };
  const service = new CredentialsService({ db, pepper });
  const expires = new Date(Date.now() + 7 * 86_400_000).toISOString();
  aliceToken = service.createCredential(aliceId, { name: 'alice', expires_at: expires }).token;
  bobToken = service.createCredential(bobId, { name: 'bob', expires_at: expires }).token;

  const app = buildApp({ db, pepper, bootstrapTokenFile: path.join(dataDir, 'config', 'admin-bootstrap.token'), dataDir });
  await app.ready();
  h = { app, db, dataDir, close: async () => { await app.close(); db.close(); await rm(dataDir, { recursive: true, force: true }); } };
});

after(async () => {
  await h.close();
});

interface DocJson {
  vault: string;
  path: string;
  ref: string;
  commit_oid: string;
  frontmatter: Record<string, unknown> | null;
  body: string;
  body_raw: string;
  size_bytes: number;
  fetched_at: string;
}

test('docs ref=历史 OID 锚定读取：内容与 version 页同一棵树（D38）', async () => {
  const res = await h.app.inject({ method: 'GET', url: `/api/v1/vaults/alpha/docs/docs/guide.md?ref=${v1Oid}`, headers: bearer(aliceToken) });
  assert.equal(res.statusCode, 200, res.body);
  const doc = JSON.parse(res.body) as DocJson;
  assert.equal(doc.vault, 'alpha');
  assert.equal(doc.path, 'docs/guide.md');
  assert.equal(doc.commit_oid, v1Oid);
  assert.equal(doc.ref, v1Oid);
  assert.equal(doc.body_raw, V1_DOC, 'body_raw=该提交原文');
  assert.equal(doc.body, '\n# 部署手册 v1\n\n旧内容标记\n', 'body=闭合 --- 之后原文（与 view/version/search 同一切面）');
  assert.deepEqual(doc.frontmatter, { title: '部署手册', tags: ['deploy', 'guide'], status: 'active' });
  assert.equal(doc.size_bytes, Buffer.byteLength(V1_DOC), 'size_bytes=原始字节长');
  assert.ok(!Number.isNaN(Date.parse(doc.fetched_at)), 'fetched_at ISO 8601');
  // 同一树证明：version 页（S5-T2 读取面）呈现同版内容
  const page = await h.app.inject({ method: 'GET', url: `/vaults/alpha/version/${v1Oid}/docs/guide.md`, headers: bearer(aliceToken) });
  assert.equal(page.statusCode, 200);
  assert.ok(page.body.includes('旧内容标记'), 'version 页呈现同版正文');
  assert.ok(!page.body.includes('新内容标记'), 'version 页无新版本内容');
});

test('docs 缺省 HEAD：最新版本 + ref=默认分支名', async () => {
  const res = await h.app.inject({ method: 'GET', url: '/api/v1/vaults/alpha/docs/docs/guide.md', headers: bearer(aliceToken) });
  assert.equal(res.statusCode, 200, res.body);
  const doc = JSON.parse(res.body) as DocJson;
  assert.equal(doc.ref, 'main');
  assert.equal(doc.body.includes('新内容标记'), true, 'HEAD=最新内容');
  assert.deepEqual(doc.frontmatter, { title: '部署手册', tags: ['deploy'], status: 'active' });
});

test('docs frontmatter 三态——豁免/无块：null + 原文全量', async () => {
  const res = await h.app.inject({ method: 'GET', url: '/api/v1/vaults/alpha/docs/README.md', headers: bearer(aliceToken) });
  assert.equal(res.statusCode, 200, res.body);
  const doc = JSON.parse(res.body) as DocJson;
  assert.equal(doc.frontmatter, null);
  assert.equal(doc.body, '# 豁免导航\n\n无 frontmatter 的 README\n');
  assert.equal(doc.body_raw, doc.body);
});

test('docs frontmatter 三态——畸形未闭合块：null + 原文全量（不阻断读取）', async () => {
  const res = await h.app.inject({ method: 'GET', url: '/api/v1/vaults/alpha/docs/docs/broken-unterminated.md', headers: bearer(aliceToken) });
  assert.equal(res.statusCode, 200, res.body);
  const doc = JSON.parse(res.body) as DocJson;
  assert.equal(doc.frontmatter, null);
  assert.equal(doc.body, '---\ntitle: 半截\n\n正文仍在。\n', '原文全量给 body');
});

test('docs frontmatter 三态——闭合块解析失败降级：null + 原文全量', async () => {
  const res = await h.app.inject({ method: 'GET', url: '/api/v1/vaults/alpha/docs/docs/broken-block.md', headers: bearer(aliceToken) });
  assert.equal(res.statusCode, 200, res.body);
  const doc = JSON.parse(res.body) as DocJson;
  assert.equal(doc.frontmatter, null, '解析失败如实降级');
  assert.equal(doc.body, '---\ntitle: 表面合法\n  缩进: [破坏\n---\n\n正文此处。\n', '畸形不剥离——原文全量');
});

test('docs 流式 tags 解析', async () => {
  const oid = await pushToVault(h.dataDir, alphaId, { 'docs/flow.md': '---\ntitle: 流式\ntags: [a, "b c"]\n---\n\n正文\n' });
  const res = await h.app.inject({ method: 'GET', url: `/api/v1/vaults/alpha/docs/docs/flow.md?ref=${oid}`, headers: bearer(aliceToken) });
  assert.equal(res.statusCode, 200, res.body);
  const doc = JSON.parse(res.body) as DocJson;
  assert.deepEqual(doc.frontmatter, { title: '流式', tags: ['a', 'b c'] });
});

test('docs 非 .md 415 如实拒（v1 仅知识文档）', async () => {
  const res = await h.app.inject({ method: 'GET', url: '/api/v1/vaults/alpha/docs/assets/logo.png', headers: bearer(aliceToken) });
  assert.equal(res.statusCode, 415);
  const body = JSON.parse(res.body) as { error: { code: string; message: string } };
  assert.equal(body.error.code, 'E-RES-009');
  assert.match(body.error.message, /\.md/);
});

test('docs 目录路径与不存在路径 404 反存在性', async () => {
  const dir = await h.app.inject({ method: 'GET', url: '/api/v1/vaults/alpha/docs/docs', headers: bearer(aliceToken) });
  assert.equal(dir.statusCode, 404);
  const gone = await h.app.inject({ method: 'GET', url: '/api/v1/vaults/alpha/docs/docs/gone.md', headers: bearer(aliceToken) });
  assert.equal(gone.statusCode, 404);
  const body = JSON.parse(gone.body) as { error: { code: string } };
  assert.equal(body.error.code, 'E-RES-001');
});

test('docs ref 畸形/未知：分支名 400、未知 OID 404（与 tree 同判）', async () => {
  const branch = await h.app.inject({ method: 'GET', url: '/api/v1/vaults/alpha/docs/docs/guide.md?ref=main', headers: bearer(aliceToken) });
  assert.equal(branch.statusCode, 400);
  const unknown = await h.app.inject({ method: 'GET', url: `/api/v1/vaults/alpha/docs/docs/guide.md?ref=${'b'.repeat(40)}`, headers: bearer(aliceToken) });
  assert.equal(unknown.statusCode, 404);
  const body = JSON.parse(unknown.body) as { error: { code: string } };
  assert.equal(body.error.code, 'E-RES-001');
});

test('docs bob 无权 404 与未知库同形态（D-IC-06 零泄露）', async () => {
  const denied = await h.app.inject({ method: 'GET', url: '/api/v1/vaults/alpha/docs/docs/guide.md', headers: bearer(bobToken) });
  const missing = await h.app.inject({ method: 'GET', url: '/api/v1/vaults/no-such/docs/docs/guide.md', headers: bearer(bobToken) });
  assert.equal(denied.statusCode, 404);
  assert.equal(missing.statusCode, 404);
  assert.equal(denied.body, missing.body, '逐字节同体');
});

test('docs 匿名 401', async () => {
  const res = await h.app.inject({ method: 'GET', url: '/api/v1/vaults/alpha/docs/docs/guide.md' });
  assert.equal(res.statusCode, 401);
  const body = JSON.parse(res.body) as { error: { code: string } };
  assert.equal(body.error.code, 'E-AUTH-001');
});

test('docs ETag=commit OID：命中 304；HEAD 前进后旧 ETag 200 新内容（即时生效）', async () => {
  const first = await h.app.inject({ method: 'GET', url: '/api/v1/vaults/alpha/docs/docs/guide.md', headers: bearer(aliceToken) });
  assert.equal(first.statusCode, 200);
  const head = (JSON.parse(first.body) as { commit_oid: string }).commit_oid;
  assert.equal(first.headers.etag, `"${head}"`);
  assert.equal(first.headers['cache-control'], 'no-cache');
  const cached = await h.app.inject({ method: 'GET', url: '/api/v1/vaults/alpha/docs/docs/guide.md', headers: { ...bearer(aliceToken), 'if-none-match': `"${head}"` } });
  assert.equal(cached.statusCode, 304);
  assert.equal(cached.body, '');
  // HEAD 前进：旧 ETag 重验证 → 200 + 新 commit 锚（内容即 commit 锚定——S16 热修同构）
  const v3 = await pushToVault(h.dataDir, alphaId, { 'docs/guide.md': V2_DOC.replace('v2', 'v3') });
  const stale = await h.app.inject({ method: 'GET', url: '/api/v1/vaults/alpha/docs/docs/guide.md', headers: { ...bearer(aliceToken), 'if-none-match': `"${head}"` } });
  assert.equal(stale.statusCode, 200);
  assert.equal(stale.headers.etag, `"${v3}"`);
  assert.ok((JSON.parse(stale.body) as { body: string }).body.includes('v3'));
  // 锚定 ref 不受 HEAD 前进影响：旧 ETag 仍 304
  const anchored = await h.app.inject({ method: 'GET', url: `/api/v1/vaults/alpha/docs/docs/guide.md?ref=${head}`, headers: { ...bearer(aliceToken), 'if-none-match': `"${head}"` } });
  assert.equal(anchored.statusCode, 304);
});
