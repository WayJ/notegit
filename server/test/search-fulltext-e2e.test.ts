import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { CredentialsService } from '../src/credentials/service.ts';
import { openDatabase } from '../src/db/connection.ts';
import { migrate } from '../src/db/migrate.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { initBareVaultRepo } from '../src/gitrepo/lifecycle.ts';
import { vaultRepoPath } from '../src/vaults/repo-path.ts';
import { FIXTURE_DDL, addEmployee, addVault, addMember } from './credentials-fixtures.ts';

// S11-T1 全文检索 v1 E2E（DOD-E2-05；D20：search_index 扩 body 列 + query 扩
// path/body LIKE）。对照 research §2.3 F-3 现状：仅元数据命中——实测 q=roadmap
// 0 命中而 docs/roadmap.md 存在。本文件用真实索引器（启动对账）+ 真实查询端点
// 验证三个验收面：
// 1) 文件名词命中：q=roadmap 命中 docs/roadmap.md（matched=['path']）；
// 2) 正文词命中：q=差旅 命中次段正文（matched=['body']——summary 只是首段）；
// 3) 可见性过滤与撤权语义在新命中面上不变（bob 非成员 0 命中；撤权下一查询消失）。
// 形态与 search-authz-e2e.test.ts 同构（真实 bare 仓库 + 直推种子 + 启动对账收敛）。

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
};

const run = promisify(execFile);

async function git(args: readonly string[], opts: { cwd?: string } = {}): Promise<string> {
  return (await run('git', args as string[], { ...opts, env: GIT_ENV })).stdout;
}

/** docs 库种子：roadmap 一词只出现在路径；差旅 一词只出现在正文次段 */
const DOCS_FILES: Record<string, string> = {
  'README.md': '# docs 导航\n\n目录说明。\n',
  'docs/roadmap.md': '---\ntitle: 路线图\ntags: [规划]\n---\n\n产品与架构路线的说明首段。\n\n差旅政策：出差住宿与交通报销按季度结算。\n',
};
/** bob-notes 库种子：值班 一词只出现在正文（bob 自有库的正向对照——0 命中不是索引坏了） */
const BOB_FILES: Record<string, string> = {
  'notes.md': '---\ntitle: 值班安排\ntags: [运维]\n---\n\n轮值表的说明首段。\n\n值班 escalation 联系方式见内网。\n',
};

interface Harness {
  app: FastifyInstance;
  db: DatabaseSync;
  rootToken: string;
  aliceToken: string;
  bobToken: string;
  docsVaultId: number;
  docsHead: string;
  close(): Promise<void>;
}

let h: Harness;

async function seedVault(dataDir: string, vaultId: number, files: Record<string, string>): Promise<void> {
  const repoPath = vaultRepoPath(dataDir, vaultId);
  const work = path.join(dataDir, `seed-${vaultId}`);
  await git(['init', '-b', 'main', work]);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(work, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
  }
  await git(['-C', work, 'add', '.']);
  await git(['-C', work, '-c', 'user.email=seed@notegit.test', '-c', 'user.name=seed', 'commit', '-m', 'seed']);
  await git(['-C', work, 'push', repoPath, 'HEAD:refs/heads/main']);
  await rm(work, { recursive: true, force: true });
}

async function startHarness(): Promise<Harness> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'notegit-s11-t1-'));
  const dbFile = path.join(dataDir, 'db', 'notegit.sqlite');
  await mkdir(path.dirname(dbFile), { recursive: true });
  const db = openDatabase(dbFile);
  migrate(db, MIGRATIONS);
  for (const ddl of FIXTURE_DDL) db.exec(ddl);

  const root = addEmployee(db, { username: 'root', is_instance_admin: 1 }); // 对账收敛轮询用
  const alice = addEmployee(db, { username: 'alice' });
  const bob = addEmployee(db, { username: 'bob' });
  const docs = addVault(db, 'docs', alice);
  const bobNotes = addVault(db, 'bob-notes', bob);
  addMember(db, docs, alice, 'admin', alice); // bob 非 docs 成员——可见性陷阱对
  addMember(db, bobNotes, bob, 'admin', bob);

  await initBareVaultRepo(dataDir, docs);
  await initBareVaultRepo(dataDir, bobNotes);
  await seedVault(dataDir, docs, DOCS_FILES);
  await seedVault(dataDir, bobNotes, BOB_FILES);

  const pepper = { active: { version: 1, key: randomBytes(32) }, retired: [] as never[] };
  const service = new CredentialsService({ db, pepper });
  const expires = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const mk = (id: number, name: string) => service.createCredential(id, { name, expires_at: expires }).token;

  const app = buildApp({
    db,
    pepper,
    bootstrapTokenFile: path.join(dataDir, 'config', 'admin-bootstrap.token'),
    dataDir, // 索引器随 dataDir 接线（启动对账在 start 内异步跑）
    searchIndex: { pollMs: 50 },
  });
  await app.ready();

  return {
    app,
    db,
    rootToken: mk(root, 'root'),
    aliceToken: mk(alice, 'alice'),
    bobToken: mk(bob, 'bob'),
    docsVaultId: docs,
    docsHead: (await git(['--git-dir', vaultRepoPath(dataDir, docs), 'rev-parse', 'refs/heads/main'])).trim(),
    close: async () => {
      await app.close();
      db.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

before(async () => {
  h = await startHarness();
  // 等启动对账把两库索引到位（管理端点轮询——root 为实例管理员）
  const deadline = Date.now() + 10_000;
  for (;;) {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/admin/search-index',
      headers: { authorization: `Bearer ${h.rootToken}` },
    });
    const status = res.json() as { vaults: { up_to_date: boolean; rows: number }[] };
    if (status.vaults.length === 2 && status.vaults.every((v) => v.up_to_date && v.rows > 0)) break;
    if (Date.now() > deadline) throw new Error('等待启动对账索引超时');
    await new Promise((r) => setTimeout(r, 25));
  }
});

after(async () => {
  await h.close();
});

interface ApiHit {
  vault_slug: string;
  path: string;
  commit_oid: string;
  title: string | null;
  matched: string[];
}

async function apiSearch(token: string, q: string): Promise<{ truncated: boolean; results: ApiHit[] }> {
  const res = await h.app.inject({
    method: 'GET',
    url: `/api/v1/search?q=${encodeURIComponent(q)}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as never;
}

test('文件名词命中：q=roadmap 命中 docs/roadmap.md（matched=[path]——F-3 现状 0 命中的对照）', async () => {
  const { truncated, results } = await apiSearch(h.aliceToken, 'roadmap');
  assert.equal(truncated, false);
  assert.equal(results.length, 1, 'roadmap 一词只存在于路径——恰一行命中');
  const hit = results[0]!;
  assert.equal(hit.vault_slug, 'docs');
  assert.equal(hit.path, 'docs/roadmap.md');
  assert.equal(hit.commit_oid, h.docsHead, 'commit 三要素 = 该库默认分支当前头');
  assert.equal(hit.title, '路线图');
  assert.deepEqual(hit.matched, ['path'], '命中字段 = 路径（title/tags/summary/body 均不含该词）');
});

test('正文词命中：q=差旅 命中次段正文（matched=[body]——summary 只是首段不含）', async () => {
  const { truncated, results } = await apiSearch(h.aliceToken, '差旅');
  assert.equal(truncated, false);
  assert.equal(results.length, 1);
  const hit = results[0]!;
  assert.equal(hit.path, 'docs/roadmap.md');
  assert.deepEqual(hit.matched, ['body'], '命中字段 = 正文（frontmatter 剥离后的派生 body 列）');
});

test('可见性过滤延续：bob（非 docs 成员）q=roadmap / q=差旅 均 0 命中；自有库正文命中正常', async () => {
  assert.deepEqual((await apiSearch(h.bobToken, 'roadmap')).results, [], '非成员库的文件名命中不可见');
  assert.deepEqual((await apiSearch(h.bobToken, '差旅')).results, [], '非成员库的正文命中不可见');
  // 正向对照：bob 自有库的正文词照常命中（0 命中不是索引/查询面损坏）
  const own = await apiSearch(h.bobToken, '值班 escalation');
  assert.equal(own.results.length, 1);
  assert.equal(own.results[0]!.path, 'notes.md');
  assert.deepEqual(own.results[0]!.matched, ['body']);
});

test('撤权下一查询即消失（既有语义在新命中面上延续）', async () => {
  const before = await apiSearch(h.aliceToken, 'roadmap');
  assert.equal(before.results.length, 1);
  h.db.prepare('DELETE FROM vault_members WHERE vault_id = ?').run(h.docsVaultId);
  const after = await apiSearch(h.aliceToken, 'roadmap');
  assert.deepEqual(after.results, [], '撤权后文件名命中下一查询消失（逐请求 JOIN 不变）');
});
