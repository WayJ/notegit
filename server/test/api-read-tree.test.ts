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
import { readFlatTree, type RunGit } from '../src/api-read/tree.ts';
import { FIXTURE_DDL, addEmployee, addVault, addMember } from './credentials-fixtures.ts';

// S18-T2 目录树读取端点 GET /api/v1/vaults/{slug}/tree[?ref=<commit OID>]
// （D4 形态；D38 ref 只收 OID、分支名 400；D-IC-06 无权=不存在同形态）。
// 锚定/缺省 HEAD/截断上限/ETag 304/匿名 401/bob 侧信道逐项锁定。

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
let bobId: number;
let alphaId: number;
let emptyId: number;

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

async function seedVaultRepo(dataDir: string, vaultId: number, files: Record<string, string>): Promise<void> {
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
}

async function headOid(dataDir: string, vaultId: number): Promise<string> {
  return (await gitOut(['--git-dir', vaultRepoPath(dataDir, vaultId), 'rev-parse', 'refs/heads/main'])).trim();
}

/** 在既有提交之上追加一笔（clone→写→commit→push，快进） */
async function pushToVault(dataDir: string, vaultId: number, files: Record<string, string>): Promise<void> {
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
}

before(async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'notegit-s18t2-tree-'));
  const dbFile = path.join(dataDir, 'db', 'notegit.sqlite');
  await mkdir(path.dirname(dbFile), { recursive: true });
  const db = openDatabase(dbFile);
  migrate(db, MIGRATIONS);
  for (const ddl of FIXTURE_DDL) db.exec(ddl);

  aliceId = addEmployee(db, { username: 'alice' });
  bobId = addEmployee(db, { username: 'bob' });
  alphaId = addVault(db, 'alpha', aliceId);
  emptyId = addVault(db, 'hollow', aliceId);
  addMember(db, alphaId, aliceId, 'reader', aliceId);
  addMember(db, emptyId, aliceId, 'reader', aliceId);
  await initBareVaultRepo(dataDir, alphaId);
  await initBareVaultRepo(dataDir, emptyId);
  await seedVaultRepo(dataDir, alphaId, {
    'README.md': '# 导航\n',
    'docs/guide.md': '# 指南 v1\n\n旧内容\n',
    'docs/deep/nested.md': '嵌套\n',
    'assets/logo.png': 'png-stub',
  });

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

interface TreeEntryJson { path: string; type: string; size: number | null }

test('tree 缺省 HEAD：扁平路径数组与 git ls-tree -r -t 同集，形状符合 D4', async () => {
  const res = await h.app.inject({ method: 'GET', url: '/api/v1/vaults/alpha/tree', headers: bearer(aliceToken) });
  assert.equal(res.statusCode, 200, res.body);
  const body = JSON.parse(res.body) as { vault: string; ref: string; commit_oid: string; entries: TreeEntryJson[]; truncated: boolean };
  assert.equal(body.vault, 'alpha');
  assert.equal(body.ref, 'main', '缺省 ref=默认分支名');
  assert.equal(body.commit_oid, await headOid(h.dataDir, alphaId), 'commit_oid=默认分支 HEAD');
  assert.equal(body.truncated, false);
  // 与独立 spawn 的 ls-tree -r -t 对照（同集证明——不经生产读面）
  const expected = new Set<string>();
  for (const rec of (await gitOut(['--git-dir', vaultRepoPath(h.dataDir, alphaId), 'ls-tree', '-r', '-t', '-z', '--full-tree', 'refs/heads/main'])).split('\0')) {
    if (rec === '') continue;
    const meta = rec.slice(0, rec.indexOf('\t')).split(' ');
    if (meta[1] === 'commit') continue; // 子模块不属 v1 契约（tree|blob）
    expected.add(`${meta[1]} ${rec.slice(rec.indexOf('\t') + 1)}`);
  }
  const actual = new Set(body.entries.map((e) => `${e.type} ${e.path}`));
  assert.deepEqual(actual, expected);
  const guide = body.entries.find((e) => e.path === 'docs/guide.md');
  assert.ok(guide && guide.type === 'blob' && guide.size === Buffer.byteLength('# 指南 v1\n\n旧内容\n'), 'blob 条目带字节数');
  const dir = body.entries.find((e) => e.path === 'docs');
  assert.ok(dir && dir.type === 'tree' && dir.size === null, 'tree 条目 size=null');
});

test('tree ref=历史 OID 锚定：取旧版本树（新提交路径不出现；缩写 OID 归一全 SHA）', async () => {
  const oldHead = await headOid(h.dataDir, alphaId);
  await pushToVault(h.dataDir, alphaId, { 'docs/new.md': '新来的\n' });
  const res = await h.app.inject({ method: 'GET', url: `/api/v1/vaults/alpha/tree?ref=${oldHead.slice(0, 12)}`, headers: bearer(aliceToken) });
  assert.equal(res.statusCode, 200, res.body);
  const body = JSON.parse(res.body) as { ref: string; commit_oid: string; entries: TreeEntryJson[] };
  assert.equal(body.commit_oid, oldHead, '缩写归一全 SHA');
  assert.equal(body.ref, oldHead.slice(0, 12), 'ref 回显请求值');
  assert.ok(body.entries.some((e) => e.path === 'docs/guide.md'), '旧树含 guide.md');
  assert.ok(!body.entries.some((e) => e.path === 'docs/new.md'), '锚定提交之后的新路径不出现');
});

test('tree ref=分支名 400 如实（D38 v1 只收 commit OID）', async () => {
  const res = await h.app.inject({ method: 'GET', url: '/api/v1/vaults/alpha/tree?ref=main', headers: bearer(aliceToken) });
  assert.equal(res.statusCode, 400);
  const body = JSON.parse(res.body) as { error: { code: string; message: string } };
  assert.equal(body.error.code, 'E-RES-004');
  assert.match(body.error.message, /OID/);
});

test('tree ref=未知 hex OID 404 反存在性（与路径不存在同信封）', async () => {
  const res = await h.app.inject({ method: 'GET', url: `/api/v1/vaults/alpha/tree?ref=${'a'.repeat(40)}`, headers: bearer(aliceToken) });
  assert.equal(res.statusCode, 404);
  const body = JSON.parse(res.body) as { error: { code: string } };
  assert.equal(body.error.code, 'E-RES-001');
});

test('tree 空库（unborn HEAD）404 E-RES-001 如实', async () => {
  const res = await h.app.inject({ method: 'GET', url: '/api/v1/vaults/hollow/tree', headers: bearer(aliceToken) });
  assert.equal(res.statusCode, 404);
  const body = JSON.parse(res.body) as { error: { code: string } };
  assert.equal(body.error.code, 'E-RES-001');
});

test('tree bob 无权 404 与未知库同形态（D-IC-06 零泄露）', async () => {
  const denied = await h.app.inject({ method: 'GET', url: '/api/v1/vaults/alpha/tree', headers: bearer(bobToken) });
  const missing = await h.app.inject({ method: 'GET', url: '/api/v1/vaults/no-such/tree', headers: bearer(bobToken) });
  assert.equal(denied.statusCode, 404);
  assert.equal(missing.statusCode, 404);
  assert.equal(denied.body, missing.body, '逐字节同体');
});

test('tree 匿名 401', async () => {
  const res = await h.app.inject({ method: 'GET', url: '/api/v1/vaults/alpha/tree' });
  assert.equal(res.statusCode, 401);
  const body = JSON.parse(res.body) as { error: { code: string } };
  assert.equal(body.error.code, 'E-AUTH-001');
});

test('tree ETag=commit OID 协商缓存：If-None-Match 命中 304、头形态 no-cache', async () => {
  const first = await h.app.inject({ method: 'GET', url: '/api/v1/vaults/alpha/tree', headers: bearer(aliceToken) });
  assert.equal(first.statusCode, 200);
  const oid = (JSON.parse(first.body) as { commit_oid: string }).commit_oid;
  assert.equal(first.headers.etag, `"${oid}"`, 'ETag=带引号 commit OID');
  assert.equal(first.headers['cache-control'], 'no-cache');
  const again = await h.app.inject({ method: 'GET', url: '/api/v1/vaults/alpha/tree', headers: { ...bearer(aliceToken), 'if-none-match': `"${oid}"` } });
  assert.equal(again.statusCode, 304);
  assert.equal(again.body, '');
});

test('readFlatTree 注入缝：单次 spawn、超 1000 条截断如实标注（D4 上限）', async () => {
  const total = 1001;
  const records: string[] = [];
  for (let i = 0; i < total; i++) records.push(`100644 blob ${String(i).padStart(40, '0')} 5\tdocs/f-${i}.md`);
  let calls = 0;
  const fake: RunGit = (_args, _opts) => {
    calls += 1;
    return Promise.resolve(records.join('\0') + '\0');
  };
  const read = await readFlatTree(vaultRepoPath(h.dataDir, alphaId), 'HEAD', fake);
  assert.equal(read.kind, 'ok');
  if (read.kind !== 'ok') return;
  assert.equal(calls, 1, '恒单次 spawn');
  assert.equal(read.truncated, true, '超上限如实标注');
  assert.equal(read.entries.length, 1000, '恰好 1000 条');
  assert.equal(read.entries[999]?.path, 'docs/f-999.md', '保序截断');
});
