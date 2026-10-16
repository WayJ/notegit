import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../src/app.ts';
import { CredentialsService } from '../src/credentials/service.ts';
import { createSession, DEFAULT_SESSION_TIMEOUTS } from '../src/auth/sessions.ts';
import { openDatabase } from '../src/db/connection.ts';
import { migrate } from '../src/db/migrate.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { initBareVaultRepo } from '../src/gitrepo/lifecycle.ts';
import { vaultRepoPath } from '../src/vaults/repo-path.ts';
import { publishWebSubmit } from '../src/publish/index.ts';
import { readFlatTree } from '../src/api-read/tree.ts';
import { SearchIndexer } from '../src/search/indexer.ts';
import { recordAuditEvent, settleAuditEvent } from '../src/audit/audit.ts';
import {
  TREE_CACHE_TTL_MS,
  clearTreeCacheForTests,
  invalidateVaultTreeCache,
  treeCacheStats,
} from '../src/readcache/tree-cache.ts';
import { lsTreeSeq, pageEntrySeq } from './web-browse-fixtures.ts';
import { FIXTURE_DDL, addEmployee, addVault, addMember } from './credentials-fixtures.ts';

/**
 * S24-T1 跨请求 HEAD 树缓存（S24 D3 / E8 D49 测试策略）：
 *
 * - 对拍：缓存路径 vs 无缓存直读——同 (库, HEAD) 下冷读（未命中→spawn）与热读
 *   （命中→零 spawn）输出逐字节一致；tree/docs/browse/工作台四读面逐项锁定，
 *   另以独立 spawn 的 git ls-tree 交叉对照（不经生产读面——api-read-tree 同法）。
 * - 失效×2：web publish 提交点（发布返回即失效，无轮询参与——断言发布后仓库
 *   缓存条目已清 + 首读即新内容）；git push 后端钩子链（post-receive settle 置
 *   审计行 → 审计尾随同路失效——测试自持 SearchIndexer.pollOnce 确定性驱动，
 *   生产由 app 内索引器同一轮询驱动）。
 * - fail-closed：git 失败不返回缓存旧值（unavailable 如实）、不缓存错误（仓库
 *   恢复后首读即新读）；另锁 TTL ≤5s（D2 兜底上界）与失效的仓库隔离。
 *
 * 形态与 search-e2e.test.ts 同构：真实 Fastify（listen——git CLI HTTP push 全链）
 * + 文件 SQLite + tmp dataDir + dbFile（hook 子进程 settle 审计行——尾随失效输入）。
 */

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

async function writeMd(dir: string, file: string, body: string): Promise<void> {
  const abs = path.join(dir, file);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, body);
}

interface Harness {
  app: FastifyInstance;
  db: DatabaseSync;
  dataDir: string;
  kbId: number;
  brokenId: number;
  kbRepo: string;
  brokenRepo: string;
  kbHead: string;
  url: string;
  token: string;
  session: Record<string, string>;
  follower: SearchIndexer;
  close(): Promise<void>;
}

let h: Harness;

/** 按生产形状落一笔成功 push 审计行（工作台首页最近文档行的数据源——B7 同法） */
function seedPushAuditRow(db: DatabaseSync, employeeId: number, vaultId: number, newCommit: string): void {
  recordAuditEvent(db, {
    occurredAt: '2026-10-16T01:00:00.000Z',
    actorKind: 'employee',
    subject: { employeeId, carrierRef: `session:${employeeId}`, entry: 'git' },
    eventKind: 'vault.push',
    vaultId,
    refName: 'refs/heads/main',
    oldCommit: null,
    newCommit,
    status: 'pending',
    detail: { pushId: `s24t1-${vaultId}-${newCommit.slice(0, 7)}` },
  });
  const id = Number((db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id);
  settleAuditEvent(db, id, 'succeeded');
}

before(async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'notegit-s24t1-'));
  const dbFile = path.join(dataDir, 'db', 'notegit.sqlite');
  await mkdir(path.dirname(dbFile), { recursive: true });
  const db = openDatabase(dbFile);
  migrate(db, MIGRATIONS);
  for (const ddl of FIXTURE_DDL) db.exec(ddl);

  const alice = addEmployee(db, { username: 'alice' });
  const kbId = addVault(db, 'kb', alice);
  const brokenId = addVault(db, 'broken', alice);
  addMember(db, kbId, alice, 'editor', alice);
  addMember(db, brokenId, alice, 'editor', alice);
  await initBareVaultRepo(dataDir, kbId);
  await initBareVaultRepo(dataDir, brokenId);
  const kbRepo = vaultRepoPath(dataDir, kbId);
  const brokenRepo = vaultRepoPath(dataDir, brokenId);

  // 种子：两库各一笔直连 push（首读前完成——缓存冷态；push 后显式失效）
  const seedWork = await mkdtemp(path.join(dataDir, 'seed-'));
  for (const [repo, seed] of [
    [kbRepo, { 'README.md': '# 导航\n', 'docs/seed.md': '---\ntitle: 种子\ntags: [s24]\n---\n\n种子首段。\n' }],
    [brokenRepo, { 'README.md': '# broken\n', 'docs/keep.md': '---\ntitle: 保留\ntags: [b]\n---\n\n保留正文。\n' }],
  ] as const) {
    await git(['init', '-b', 'main', `${seedWork}/${path.basename(repo)}`]);
    await writeMd(`${seedWork}/${path.basename(repo)}`, 'README.md', seed['README.md']!);
    for (const [rel, content] of Object.entries(seed)) {
      if (rel === 'README.md') continue;
      await writeMd(`${seedWork}/${path.basename(repo)}`, rel, content);
    }
    await git(['-C', `${seedWork}/${path.basename(repo)}`, 'add', '.']);
    await git(['-C', `${seedWork}/${path.basename(repo)}`, '-c', 'user.email=seed@notegit.test', '-c', 'user.name=seed', 'commit', '-q', '-m', 'seed']);
    await git(['-C', `${seedWork}/${path.basename(repo)}`, 'push', '--quiet', repo, 'HEAD:refs/heads/main']);
    invalidateVaultTreeCache(repo);
  }
  await rm(seedWork, { recursive: true, force: true });

  // 工作台首页最近文档行（供 headPaths 面对拍）：按生产形状落一笔成功 push 审计行
  const kbHead = (await git(['--git-dir', kbRepo, 'rev-parse', 'refs/heads/main'])).trim();
  seedPushAuditRow(db, alice, kbId, kbHead);

  const pepper = { active: { version: 1, key: randomBytes(32) }, retired: [] as never[] };
  const credentials = new CredentialsService({ db, pepper });
  const token = credentials.createCredential(alice, {
    name: 's24-alice',
    expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  }).token;

  const app = buildApp({
    db,
    pepper,
    bootstrapTokenFile: path.join(dataDir, 'config', 'admin-bootstrap.token'),
    dataDir,
    dbFile, // HTTP push 的 hook 子进程直连本库（settle 行写这里——尾随失效输入）
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = app.addresses()[0]!.port;
  const now = new Date();
  h = {
    app,
    db,
    dataDir,
    kbId,
    brokenId,
    kbRepo,
    brokenRepo,
    kbHead,
    url: `http://alice:${token}@127.0.0.1:${port}/git/kb.git`,
    token,
    session: { cookie: `ngt_sid=${createSession(db, alice, pepper.active.key, now, DEFAULT_SESSION_TIMEOUTS).sid}` },
    // 测试自持尾随索引器（不 start——生产由 app 内索引器同一轮询驱动；本实例
    // 只为在 push settle 后确定性推进 pollOnce，驱动与索引派生同路的缓存失效）
    follower: new SearchIndexer({ db, dataDir }),
    close: async () => {
      await app.close();
      db.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
  clearTreeCacheForTests();
});

after(async () => {
  await h.close();
});

function bearer(): Record<string, string> {
  return { authorization: `Bearer ${h.token}` };
}

interface TreeEntryJson { path: string; type: string; size: number | null }

// ── 对拍（D49：缓存路径 vs 无缓存直读，同 (库, HEAD) 逐字节一致） ────────────

test('对拍：tree 端点冷读=热读逐字节一致，热读零 spawn，且与独立 ls-tree 同集', async () => {
  const first = await h.app.inject({ method: 'GET', url: '/api/v1/vaults/kb/tree', headers: bearer() });
  assert.equal(first.statusCode, 200, first.body);
  const s0 = treeCacheStats();
  assert.ok(s0.spawns >= 2, `冷读确实经缓存层 spawn（rev-parse+ls-tree，实得 spawns=${s0.spawns}）`);
  const second = await h.app.inject({ method: 'GET', url: '/api/v1/vaults/kb/tree', headers: bearer() });
  const s1 = treeCacheStats();
  assert.equal(second.statusCode, 200);
  assert.equal(first.body, second.body, '冷读（直读等价路径）与热读（缓存命中）响应逐字节一致');
  assert.equal(s1.spawns - s0.spawns, 0, '热读零 spawn（全部命中单源缓存）');
  assert.ok(s1.hits - s0.hits >= 2, 'rev-parse 与 ls-tree 均命中');
  // 交叉对照：与另行 spawn 的 ls-tree -r -t 同集（不经生产读面——api-read-tree 同法）
  const body = JSON.parse(second.body) as { entries: TreeEntryJson[] };
  const expected = new Set<string>();
  for (const rec of (await git(['--git-dir', h.kbRepo, 'ls-tree', '-r', '-t', '-z', '--full-tree', 'refs/heads/main'])).split('\0')) {
    if (rec === '') continue;
    const meta = rec.slice(0, rec.indexOf('\t')).split(' ');
    if (meta[1] === 'commit') continue;
    expected.add(`${meta[1]} ${rec.slice(rec.indexOf('\t') + 1)}`);
  }
  assert.deepEqual(new Set(body.entries.map((e) => `${e.type} ${e.path}`)), expected);
});

test('对拍：docs 端点冷读=热读逐字段一致（fetched_at 为响应时刻除外），热读零缓存 spawn', async () => {
  const url = '/api/v1/vaults/kb/docs/docs/seed.md';
  const first = await h.app.inject({ method: 'GET', url, headers: bearer() });
  assert.equal(first.statusCode, 200, first.body);
  const s0 = treeCacheStats();
  const second = await h.app.inject({ method: 'GET', url, headers: bearer() });
  const s1 = treeCacheStats();
  assert.equal(second.statusCode, 200);
  // fetched_at=服务端响应时刻（契约明示不可信为内容时间）——对拍剔除该字段，
  // 其余（frontmatter/body/body_raw/size_bytes/commit_oid 等）逐字段一致
  const a = JSON.parse(first.body) as Record<string, unknown>;
  const b = JSON.parse(second.body) as Record<string, unknown>;
  delete a['fetched_at'];
  delete b['fetched_at'];
  assert.deepEqual(a, b, 'docs 内容字段逐字节一致（仅响应时刻字段豁免）');
  // blob 正文（cat-file）不在树缓存面——仍有其自身 spawn；树族调用（ref 解析×2 + 父目录 ls-tree）全命中
  assert.equal(s1.spawns - s0.spawns, 0, '热读树族调用零 spawn');
});

test('对拍：browse 目录页与工作台首页冷读=热读一致（条目序列/最近文档行）', async () => {
  const browse1 = await (await h.app.inject({ method: 'GET', url: '/vaults/kb/browse', headers: h.session })).body;
  const browse2 = await (await h.app.inject({ method: 'GET', url: '/vaults/kb/browse', headers: h.session })).body;
  assert.deepEqual(pageEntrySeq(browse1), pageEntrySeq(browse2), 'browse 条目序列冷热一致');
  assert.deepEqual(pageEntrySeq(browse1), await lsTreeSeq(h.kbRepo, 'main', ''), '与独立 ls-tree 同集同序');
  const s0 = treeCacheStats();
  const browse3 = await (await h.app.inject({ method: 'GET', url: '/vaults/kb/browse', headers: h.session })).body;
  const s1 = treeCacheStats();
  assert.deepEqual(pageEntrySeq(browse3), pageEntrySeq(browse1));
  assert.equal(s1.spawns - s0.spawns, 0, 'browse 热读树族零 spawn（log/cat-file 不在缓存面）');

  const rowRe = /<tr data-vault="([^"]*)" data-path="([^"]*)" data-commit="([^"]*)"/g;
  const rowsOf = (body: string): string[] => [...body.matchAll(rowRe)].map((m) => `${m[1]}:${m[2]}:${m[3]}`).sort();
  const home1 = await (await h.app.inject({ method: 'GET', url: '/', headers: h.session })).body;
  assert.deepEqual(
    rowsOf(home1),
    [`kb:README.md:${h.kbHead}`, `kb:docs/seed.md:${h.kbHead}`].sort(),
    '首页最近文档行在位（HEAD 求交后——种子提交的两路径）',
  );
  const home2 = await (await h.app.inject({ method: 'GET', url: '/', headers: h.session })).body;
  const s2 = treeCacheStats();
  const home3 = await (await h.app.inject({ method: 'GET', url: '/', headers: h.session })).body;
  const s3 = treeCacheStats();
  assert.deepEqual(rowsOf(home2), rowsOf(home1), '工作台首页最近文档行冷热一致');
  assert.deepEqual(rowsOf(home3), rowsOf(home1));
  assert.equal(s3.spawns - s2.spawns, 0, 'headPaths 热读零 spawn（单源缓存服务）');
});

// ── 失效×2（D48：web publish 提交点 + git push 后端钩子链同路） ──────────────

test('失效×web publish：发布返回即失效（仓库缓存条目已清），首读即新内容', async () => {
  const before = await h.app.inject({ method: 'GET', url: '/api/v1/vaults/kb/tree', headers: bearer() });
  assert.equal(before.statusCode, 200);
  assert.ok(treeCacheStats().entries >= 1, '前置：本库已有缓存条目');

  const base = (await git(['--git-dir', h.kbRepo, 'rev-parse', 'refs/heads/main'])).trim();
  const publish = await publishWebSubmit({
    db: h.db,
    dataDir: h.dataDir,
    subject: { employeeId: 1, carrierRef: 'session:1' },
    vaultSlug: 'kb',
    branch: 'main',
    baseCommit: base,
    changes: [
      { kind: 'upsert', path: 'web/new.md', mode: '100644', content: '---\ntitle: 网页发布\ntags: [web]\n---\n\n网页发布首段。\n' },
    ],
    message: 's24 tree-cache invalidation',
    identity: { name: 'alice', email: 'alice@notegit.test' },
  });
  assert.equal(publish.kind, 'published');

  // 提交点失效直证：发布组件返回时（早于任何轮询节奏保证）树缓存已清——
  // 无读取发生则条目数为 0（发布前后本测试不读他库）
  assert.equal(treeCacheStats().entries, 0, 'web publish 提交点已失效本仓库全部缓存条目');

  // 首读（发布后第一次读）：即见新内容——无 sleep、无 pollOnce 参与
  const after = await h.app.inject({ method: 'GET', url: '/api/v1/vaults/kb/tree', headers: bearer() });
  assert.equal(after.statusCode, 200, after.body);
  const body = JSON.parse(after.body) as { commit_oid: string; entries: TreeEntryJson[] };
  assert.equal(body.commit_oid, publish.kind === 'published' ? publish.newOid : '', '首读即锚定新头');
  assert.ok(body.entries.some((e) => e.path === 'web/new.md'), '首读即见新路径');
  assert.ok(body.entries.some((e) => e.path === 'docs/seed.md'), '未变路径保留');
});

test('失效×git push：post-receive settle 审计行经审计尾随同路失效，首读即新内容', async () => {
  const before = await h.app.inject({ method: 'GET', url: '/api/v1/vaults/kb/tree', headers: bearer() });
  assert.equal(before.statusCode, 200);
  assert.ok(treeCacheStats().entries >= 1, '前置：本库已有缓存条目');

  // HTTP push 全链（githttp 钩子链 → pre-receive 校验 → post-receive settle 审计行）
  const clone = path.join(h.dataDir, 'clone-push');
  await git(['clone', h.url, clone]);
  await writeMd(clone, 'pushed.md', '---\ntitle: 推送文档\ntags: [push]\n---\n\n推送首段。\n');
  await git(['-C', clone, 'add', '.']);
  await git(['-C', clone, '-c', 'user.email=alice@notegit.test', '-c', 'user.name=alice', 'commit', '-q', '-m', 'push doc']);
  await git(['-C', clone, 'push', '--quiet', 'origin', 'main']);
  const newHead = (await git(['--git-dir', h.kbRepo, 'rev-parse', 'refs/heads/main'])).trim();

  // 审计尾随同路失效（与索引派生同触发点）：pollOnce 确定性推进一轮尾随
  await h.follower.pollOnce();
  assert.equal(treeCacheStats().entries, 0, '尾随失效已清本仓库全部缓存条目');

  // 首读（失效后第一次读）：即见新内容
  const after = await h.app.inject({ method: 'GET', url: '/api/v1/vaults/kb/tree', headers: bearer() });
  assert.equal(after.statusCode, 200, after.body);
  const body = JSON.parse(after.body) as { commit_oid: string; entries: TreeEntryJson[] };
  assert.equal(body.commit_oid, newHead, '首读即锚定新头');
  assert.ok(body.entries.some((e) => e.path === 'pushed.md'), '首读即见推送新路径');
});

// ── fail-closed（D48：git 调用失败绝不缓存错误、不返回缓存旧值） ─────────────

test('fail-closed：git 失败不返回缓存旧值（unavailable 如实），不缓存错误（恢复后即新读）', async () => {
  const first = await readFlatTree(h.brokenRepo, 'refs/heads/main');
  assert.equal(first.kind, 'ok');
  if (first.kind !== 'ok') return;
  assert.ok(first.entries.length > 0, '前置：broken 库可读且已入缓存');
  assert.ok(treeCacheStats().entries >= 1);

  // 仓库目录失联（存储不一致形态）：失效后读——spawn 失败必须如实 unavailable，
  // 绝不回落到失效前的缓存旧值
  const backup = path.join(h.dataDir, 'broken-backup');
  await cp(h.brokenRepo, backup, { recursive: true });
  await rm(h.brokenRepo, { recursive: true, force: true });
  invalidateVaultTreeCache(h.brokenRepo);
  const gone1 = await readFlatTree(h.brokenRepo, 'refs/heads/main');
  assert.equal(gone1.kind, 'unavailable', 'git 失败按现行为同形态失败（不返回缓存旧值）');
  const gone2 = await readFlatTree(h.brokenRepo, 'refs/heads/main');
  assert.equal(gone2.kind, 'unavailable', '失败不被缓存——每次读取重新 spawn（而非复用失败结果）');

  // 仓库恢复：错误未被缓存 ⇒ 首读即恢复真实读取（若错误被缓存会仍 unavailable）
  const { rename } = await import('node:fs/promises');
  await rename(backup, h.brokenRepo);
  const restored = await readFlatTree(h.brokenRepo, 'refs/heads/main');
  assert.equal(restored.kind, 'ok', '恢复后首读即新读（错误未入缓存）');
  if (restored.kind === 'ok') assert.deepEqual(restored.entries, first.entries, '恢复读与初始直读同集（对拍）');
});

// ── 契约边界（D2：TTL ≤5s；失效仓库隔离） ────────────────────────────────────

test('TTL 兜底 ≤5 秒（D2 上界锁定）', () => {
  assert.ok(TREE_CACHE_TTL_MS > 0 && TREE_CACHE_TTL_MS <= 5_000, `TREE_CACHE_TTL_MS=${TREE_CACHE_TTL_MS} 超出兜底上界`);
});

test('失效仓库隔离：失效 broken 库不影响 docs 库缓存命中', async () => {
  await readFlatTree(h.kbRepo, 'refs/heads/main'); // 现值填充（此前发布/推送已失效过）
  let s = treeCacheStats();
  const hit = await readFlatTree(h.kbRepo, 'refs/heads/main');
  assert.equal(hit.kind, 'ok');
  assert.equal(treeCacheStats().spawns - s.spawns, 0, 'kb 库持续命中');

  invalidateVaultTreeCache(h.brokenRepo);
  s = treeCacheStats();
  const stillHit = await readFlatTree(h.kbRepo, 'refs/heads/main');
  assert.equal(stillHit.kind, 'ok');
  assert.equal(treeCacheStats().spawns - s.spawns, 0, '他库失效不清本库条目（前缀隔离）');

  const reSpawned = await readFlatTree(h.brokenRepo, 'refs/heads/main');
  assert.equal(reSpawned.kind, 'ok');
  assert.ok(treeCacheStats().spawns - s.spawns >= 1, '被失效库重新 spawn（失效真实生效）');
});
