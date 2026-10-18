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

// API 面提交历史 GET /api/v1/vaults/{slug}/commits[?limit=&path=&ref=<commit OID>]
// （平台 S37 知识库「版本历史/新建文档基线」数据源；此前只有 Web 历史页、无 API——
// 平台 /commits 调用 404 即由此来）。鉴权与 tree/docs 同缝；无权=不存在同形态（D-IC-06）。

interface Harness {
  app: FastifyInstance;
  db: DatabaseSync;
  dataDir: string;
  close(): Promise<void>;
}

let h: Harness;
let aliceToken: string;
let bobToken: string;
let aliceId: number;
let alphaId: number;

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

async function commitToVault(dataDir: string, vaultId: number, message: string, files: Record<string, string>): Promise<void> {
  const repoPath = vaultRepoPath(dataDir, vaultId);
  const work = path.join(dataDir, `seed-${vaultId}-${++seedSeq}`);
  await gitOut(['clone', '--quiet', repoPath, work]);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(work, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
  }
  await gitOut(['-C', work, 'add', '.']);
  await gitOut(['-C', work, '-c', 'user.email=alice@notegit.test', '-c', 'user.name=alice', 'commit', '-q', '-m', message]);
  await gitOut(['-C', work, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main']);
  await rm(work, { recursive: true, force: true });
  invalidateVaultTreeCache(repoPath);
}

async function logOids(dataDir: string, vaultId: number, extra: readonly string[] = []): Promise<string[]> {
  const out = await gitOut([
    '--git-dir', vaultRepoPath(dataDir, vaultId), 'log', '--format=%H', ...extra, 'refs/heads/main',
  ]);
  return out.trim().split('\n').filter((line) => line !== '');
}

before(async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'notegit-s37-commits-'));
  const dbFile = path.join(dataDir, 'db', 'notegit.sqlite');
  await mkdir(path.dirname(dbFile), { recursive: true });
  const db = openDatabase(dbFile);
  migrate(db, MIGRATIONS);
  for (const ddl of FIXTURE_DDL) db.exec(ddl);

  aliceId = addEmployee(db, { username: 'alice' });
  const bobId = addEmployee(db, { username: 'bob' });
  alphaId = addVault(db, 'alpha', aliceId);
  const hollowId = addVault(db, 'hollow', aliceId);
  addMember(db, alphaId, aliceId, 'editor', aliceId);
  addMember(db, hollowId, aliceId, 'editor', aliceId);
  await initBareVaultRepo(dataDir, alphaId);
  await initBareVaultRepo(dataDir, hollowId);
  await commitToVault(dataDir, alphaId, 'first: 根提交', { 'README.md': '# 导航\n', 'docs/guide.md': '# 指南 v1\n' });
  await commitToVault(dataDir, alphaId, 'second: 改指南', { 'docs/guide.md': '# 指南 v2\n' });
  await commitToVault(dataDir, alphaId, 'third: 加公告', { 'NOTICE.md': '公告\n' });

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

interface CommitJson {
  oid: string;
  short_oid: string;
  message: string;
  author_name: string;
  author_email: string;
  authored_at: string;
}

test('缺省 HEAD：与 git log 同集同序，形状含 oid/short_oid/message/author_name', async () => {
  const res = await h.app.inject({ method: 'GET', url: '/api/v1/vaults/alpha/commits', headers: bearer(aliceToken) });
  assert.equal(res.statusCode, 200, res.body);
  const body = JSON.parse(res.body) as { vault: string; ref: string; commit_oid: string; commits: CommitJson[]; has_more: boolean };
  assert.equal(body.vault, 'alpha');
  assert.equal(body.ref, 'main');
  assert.equal(body.has_more, false);
  assert.deepEqual(body.commits.map((c) => c.oid), await logOids(h.dataDir, alphaId), '与 git log 同集同序');
  const first = body.commits[0]!;
  assert.equal(first.message, 'third: 加公告');
  assert.equal(first.author_name, 'alice');
  assert.match(first.authored_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(first.short_oid.length >= 7 && first.oid.startsWith(first.short_oid));
});

test('path 过滤：只含触及该路径的提交', async () => {
  const res = await h.app.inject({
    method: 'GET', url: '/api/v1/vaults/alpha/commits?path=docs%2Fguide.md', headers: bearer(aliceToken),
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = JSON.parse(res.body) as { commits: CommitJson[] };
  assert.deepEqual(body.commits.map((c) => c.message), ['second: 改指南', 'first: 根提交']);
});

test('limit 探测 has_more；limit 超界拒绝', async () => {
  const res = await h.app.inject({
    method: 'GET', url: '/api/v1/vaults/alpha/commits?limit=2', headers: bearer(aliceToken),
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = JSON.parse(res.body) as { commits: CommitJson[]; has_more: boolean };
  assert.equal(body.commits.length, 2);
  assert.equal(body.has_more, true);
  const bad = await h.app.inject({
    method: 'GET', url: '/api/v1/vaults/alpha/commits?limit=101', headers: bearer(aliceToken),
  });
  assert.equal(bad.statusCode, 400);
});

test('ref 锚定：首条=锚定提交；非 OID 形态 400（D38 同判）', async () => {
  const [head, second] = await logOids(h.dataDir, alphaId);
  const res = await h.app.inject({
    method: 'GET', url: `/api/v1/vaults/alpha/commits?ref=${second}`, headers: bearer(aliceToken),
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = JSON.parse(res.body) as { commit_oid: string; commits: CommitJson[]; has_more: boolean };
  assert.equal(body.commit_oid, second);
  assert.equal(body.commits[0]!.oid, second);
  assert.notEqual(body.commits[0]!.oid, head);
  const bad = await h.app.inject({
    method: 'GET', url: '/api/v1/vaults/alpha/commits?ref=HEAD~1', headers: bearer(aliceToken),
  });
  assert.equal(bad.statusCode, 400);
});

test('空库（unborn 默认分支）：返回空列表而非 404——平台建库即进目录/新建文档的基线路径', async () => {
  const res = await h.app.inject({ method: 'GET', url: '/api/v1/vaults/hollow/commits', headers: bearer(aliceToken) });
  assert.equal(res.statusCode, 200, res.body);
  const body = JSON.parse(res.body) as { commits: unknown[]; has_more: boolean };
  assert.deepEqual(body.commits, []);
  assert.equal(body.has_more, false);
});

test('鉴权：匿名 401；非成员 404 同形态（不泄露树内容）', async () => {
  const anon = await h.app.inject({ method: 'GET', url: '/api/v1/vaults/alpha/commits' });
  assert.equal(anon.statusCode, 401);
  const stranger = await h.app.inject({ method: 'GET', url: '/api/v1/vaults/alpha/commits', headers: bearer(bobToken) });
  assert.equal(stranger.statusCode, 404);
  assert.equal(JSON.parse(stranger.body).error.code, 'E-RES-001');
});
