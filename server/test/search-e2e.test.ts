import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../src/app.ts';
import { CredentialsService } from '../src/credentials/service.ts';
import { openDatabase } from '../src/db/connection.ts';
import { migrate } from '../src/db/migrate.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { initBareVaultRepo } from '../src/gitrepo/lifecycle.ts';
import { vaultRepoPath } from '../src/vaults/repo-path.ts';
import { publishWebSubmit } from '../src/publish/index.ts';
import { FIXTURE_DDL, addEmployee, addMember, addVault } from './credentials-fixtures.ts';

// S5-T3 验收面 E2E（breakdown §2.4 S5-T3 行三条完成标准，真实形态）：
// 1) push（经 HTTP → pre/post-receive settle 钩子）后索引最终一致——轮询断言
//    含延迟上界记录（观测值随测试输出留档）；
// 2) 网页发布（发布组件 settle）后索引最终一致——同一审计尾随触发面；
// 3) 拒绝发布（rejected）不触发索引（发布未成立不该动派生面）。
// 失败不阻断（D7）与告警可见的组合断言在 search-indexer/search-routes 测试
// （注入缝在构造期，本文件的索引器为真实形态）。
// 形态与 receive-audit.test.ts 同构：真实 Fastify + 文件 SQLite + tmp dataDir
// 真实 bare 仓库 + 标准 git 客户端（HTTP push 全链）。

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
};

const run = promisify(execFile);

async function git(args: string[], opts: { cwd?: string } = {}): Promise<string> {
  return (await run('git', args, { ...opts, env: GIT_ENV })).stdout;
}

async function writeMd(dir: string, file: string, body: string): Promise<void> {
  const abs = path.join(dir, file);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, body);
}

interface Harness {
  app: FastifyInstance;
  db: DatabaseSync;
  dataDir: string;
  vaultId: number;
  repoPath: string;
  url: string;
  close(): Promise<void>;
}

let h: Harness;

async function startE2E(): Promise<Harness> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'notegit-t3-e2e-'));
  const dbFile = path.join(dataDir, 'db', 'notegit.sqlite');
  await mkdir(path.dirname(dbFile), { recursive: true });
  const db = openDatabase(dbFile);
  migrate(db, MIGRATIONS);
  for (const ddl of FIXTURE_DDL) db.exec(ddl);

  const alice = addEmployee(db, { username: 'alice' });
  const vaultId = addVault(db, 'docs', alice);
  addMember(db, vaultId, alice, 'editor', alice);

  await initBareVaultRepo(dataDir, vaultId);
  const repoPath = vaultRepoPath(dataDir, vaultId);
  const seed = path.join(dataDir, 'seed');
  await git(['init', '-b', 'main', seed]);
  await writeMd(seed, 'README.md', '# nav\n');
  await writeMd(seed, 'seed.md', '---\ntitle: 种子\ntags: [seed]\n---\n\n种子首段。\n');
  await git(['-C', seed, 'add', '.']);
  await git(['-C', seed, '-c', 'user.email=seed@notegit.test', '-c', 'user.name=seed', 'commit', '-m', 'seed']);
  await git(['-C', seed, 'push', repoPath, 'main']);

  const pepper = { active: { version: 1, key: randomBytes(32) }, retired: [] as never[] };
  const credentials = new CredentialsService({ db, pepper });
  const token = credentials.createCredential(alice, {
    name: 'git-alice',
    expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  }).token;

  const app = buildApp({
    db,
    pepper,
    bootstrapTokenFile: path.join(dataDir, 'config', 'admin-bootstrap.token'),
    dataDir,
    dbFile, // HTTP push 的 hook 子进程直连本库（settle 行写这里——索引触发输入）
    searchIndex: { pollMs: 50 }, // 测试节奏（生产默认 250ms / NOTEGIT_SEARCH_POLL_MS）
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = app.addresses()[0]!.port;
  return {
    app,
    db,
    dataDir,
    vaultId,
    repoPath,
    url: `http://alice:${token}@127.0.0.1:${port}/git/docs.git`,
    close: async () => {
      await app.close();
      db.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

before(async () => {
  h = await startE2E();
});

after(async () => {
  await h.close();
});

interface StateRow {
  head_commit: string | null;
  indexed_at: string;
  lag_ms: number | null;
  triggered_by: string;
  updates: number;
}

function stateRow(): StateRow | undefined {
  return h.db.prepare('SELECT head_commit, indexed_at, lag_ms, triggered_by, updates FROM search_index_state WHERE vault_id = ?').get(h.vaultId) as
    | StateRow
    | undefined;
}

async function refHead(): Promise<string> {
  return (await git(['--git-dir', h.repoPath, 'rev-parse', 'refs/heads/main'])).trim();
}

/** 最终一致轮询（完成标准的断言形态）：deadline 内等条件成立，返回观测毫秒数 */
async function waitUntil(cond: () => boolean, deadlineMs = 10_000): Promise<number> {
  const started = Date.now();
  for (;;) {
    if (cond()) return Date.now() - started;
    if (Date.now() - started > deadlineMs) throw new Error(`最终一致轮询超时（>${deadlineMs}ms）`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** 延迟上界（记录值——轮询断言附带）：测试环境实测上界 5000ms */
const OBSERVED_BOUND_MS = 5_000;

function indexRow(path: string): { title: string | null; tags: string; summary: string; commit_oid: string } | undefined {
  return h.db
    .prepare('SELECT title, tags, summary, commit_oid FROM search_index WHERE vault_id = ? AND path = ?')
    .get(h.vaultId, path) as never;
}

test('启动对账把种子内容索引到位（索引器随 app 接线）', async () => {
  const head = await refHead();
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (stateRow()?.head_commit === head) break;
    if (Date.now() > deadline) throw new Error('等待启动对账索引超时');
    await new Promise((r) => setTimeout(r, 25));
  }
  const st = stateRow()!;
  assert.equal(st.triggered_by, 'startup-reconcile');
  const seed = indexRow('seed.md')!;
  assert.equal(seed.title, '种子');
  assert.deepEqual(JSON.parse(seed.tags), ['seed']);
});

test('网页发布后索引最终一致（轮询断言含延迟上界记录）', async () => {
  const base = await refHead();
  const t0 = Date.now();
  const publish = await publishWebSubmit({
    db: h.db,
    dataDir: h.dataDir,
    subject: { employeeId: 1, carrierRef: 'session:1' },
    vaultSlug: 'docs',
    branch: 'main',
    baseCommit: base,
    changes: [
      { kind: 'upsert', path: 'web/edited.md', mode: '100644', content: '---\ntitle: 网页编辑\ntags:\n  - web\n---\n\n网页发布首段。\n' },
    ],
    message: 'web edit',
    identity: { name: 'alice', email: 'alice@notegit.test' },
  });
  assert.equal(publish.kind, 'published');

  const waited = await waitUntil(() => stateRow()?.head_commit === publish.newOid);
  console.log(`[S5-T3 e2e] 网页发布→索引一致 观测延迟 ${waited}ms（断言上界 ${OBSERVED_BOUND_MS}ms）`);
  assert.ok(waited <= OBSERVED_BOUND_MS, `最终一致延迟 ${waited}ms 超上界 ${OBSERVED_BOUND_MS}ms`);

  const st = stateRow()!;
  assert.equal(st.triggered_by, 'vault.web_submit', '触发源 = 网页发布审计行');
  assert.ok(typeof st.lag_ms === 'number' && st.lag_ms >= 0 && st.lag_ms <= OBSERVED_BOUND_MS, `lag_ms 指标在界内（实测 ${String(st.lag_ms)}ms）`);
  assert.ok(Date.parse(st.indexed_at) >= t0, 'indexed_at 时间戳不早于发布');

  const row = indexRow('web/edited.md')!;
  assert.equal(row.title, '网页编辑');
  assert.deepEqual(JSON.parse(row.tags), ['web']);
  assert.equal(row.summary, '网页发布首段。');
  assert.equal(row.commit_oid, publish.newOid);
});

test('HTTP push 后索引最终一致（T6 settle 钩子触发面，含延迟上界记录）', async () => {
  const clone = path.join(h.dataDir, 'clone-push');
  await git(['clone', h.url, clone]);
  await writeMd(clone, 'pushed.md', '---\ntitle: 推送文档\ntags: [push]\n---\n\n推送首段。\n');
  await git(['-C', clone, 'add', '.']);
  await git(['-C', clone, '-c', 'user.email=alice@notegit.test', '-c', 'user.name=alice', 'commit', '-m', 'push doc']);
  const t0 = Date.now();
  await git(['-C', clone, 'push', 'origin', 'main']);
  const newHead = await refHead();

  const waited = await waitUntil(() => stateRow()?.head_commit === newHead);
  console.log(`[S5-T3 e2e] push→索引一致 观测延迟 ${waited}ms（断言上界 ${OBSERVED_BOUND_MS}ms）`);
  assert.ok(waited <= OBSERVED_BOUND_MS, `最终一致延迟 ${waited}ms 超上界 ${OBSERVED_BOUND_MS}ms`);

  const st = stateRow()!;
  assert.equal(st.triggered_by, 'vault.push', '触发源 = push settle 审计行');
  assert.ok(typeof st.lag_ms === 'number' && st.lag_ms >= 0 && st.lag_ms <= OBSERVED_BOUND_MS, `lag_ms 指标在界内（实测 ${String(st.lag_ms)}ms）`);

  const row = indexRow('pushed.md')!;
  assert.equal(row.title, '推送文档');
  assert.deepEqual(JSON.parse(row.tags), ['push']);
  assert.equal(row.summary, '推送首段。');
  assert.equal(row.commit_oid, newHead);
  // 前次网页发布的行仍在（全量替换保留未变路径）
  assert.ok(indexRow('web/edited.md') !== undefined);
});

test('拒绝的推送不触发索引（发布未成立不动派生面）', async () => {
  const clone = path.join(h.dataDir, 'clone-reject');
  await git(['clone', h.url, clone]);
  await writeMd(clone, 'invalid.md', '没有 frontmatter 的正文。\n');
  await git(['-C', clone, 'add', '.']);
  await git(['-C', clone, '-c', 'user.email=alice@notegit.test', '-c', 'user.name=alice', 'commit', '-m', 'bad']);
  await git(['-C', clone, 'push', 'origin', 'main']).then(
    () => assert.fail('无效内容推送应被拒绝'),
    () => {},
  );
  await new Promise((r) => setTimeout(r, 300)); // 超过数个轮询周期
  assert.ok(indexRow('invalid.md') === undefined, '被拒内容不入索引');
  const st = stateRow()!;
  assert.ok(!st.head_commit?.includes('invalid'), '索引头未被被拒推送移动');
});
