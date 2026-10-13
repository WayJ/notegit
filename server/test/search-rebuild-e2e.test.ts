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
import { createSession, DEFAULT_SESSION_TIMEOUTS } from '../src/auth/sessions.ts';
import { openDatabase } from '../src/db/connection.ts';
import { migrate } from '../src/db/migrate.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { initBareVaultRepo } from '../src/gitrepo/lifecycle.ts';
import { vaultRepoPath } from '../src/vaults/repo-path.ts';
import { deriveVaultIndex } from '../src/search/derive.ts';
import { FIXTURE_DDL, addEmployee, addVault, addMember } from './credentials-fixtures.ts';

// S5-T5 验收面 E2E（breakdown §2.4 S5-T5 行三条完成标准，真实形态；R9 = backup
// §8 同款方法）：
// 1) 删索引数据 → POST /api/v1/admin/search-index/rebuild 全量重建 → 进度可观测
//    （done/total 收敛）→ 结果与重建前对账一致（测试侧构造期望 × git 直读）；
// 2) 重建期间查询可降级（部分结果——选型记录），但权限过滤不降级：降级态复测
//    T4 陷阱用例（高权账号对无权库的已重建行不泄露）与撤权用例（成员行 DELETE
//    后下一查询即消失）；
// 3) 重建收口后全量一致恢复（含被降级缺省的库）。
// 形态与 search-authz-e2e.test.ts 同构（三库真实 bare 仓库 + 直推种子 + 启动
// 对账收敛）；降级窗口用 searchIndex.derive 注入缝按库门控（仅挡 gamma 的派生，
// alpha/beta 先完成——制造「无权库行已在表、重建仍在途」的降态陷阱）。

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

// 与 search-authz-e2e.test.ts 同款种子（期望集构造同源可对照）
const ALPHA_FILES: Record<string, string> = {
  'README.md': '# alpha deploy 导航\n\n目录说明（次段无关）。\n',
  'deploy-runbook.md': '---\ntitle: Deploy 手册\ntags: [ops]\n---\n\n发布步骤首段（不含关键词）。\n',
  'notes/oncall.md': '---\ntitle: 值班手册\ntags: [deploy]\n---\n\n轮值说明首段（不含关键词）。\n',
  'unrelated.md': '---\ntitle: 会议纪要\ntags: [meeting]\n---\n\n每周例会（完全无关）。\n',
};
const BETA_FILES: Record<string, string> = {
  'secret.md': '---\ntitle: deploy 机密\ntags: [classified]\n---\n\ndeploy 细节首段。\n',
};
const GAMMA_FILES: Record<string, string> = {
  'infra.md': '---\ntitle: 基础设施\ntags: []\n---\n\ndeploy 流程说明首段。\n',
  'policy.md': '---\ntitle: 权限策略\ntags: [audit]\n---\n\n审计要求（无关）。\n',
};

const KEYWORD = 'deploy';

/** 对账期望行（测试侧独立构造——非生产解析面回声） */
interface Expected {
  vault: string;
  path: string;
  matched: string[];
}

function expectedFor(vault: string, files: Record<string, string>): Expected[] {
  const out: Expected[] = [];
  for (const [p, text] of Object.entries(files)) {
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
    const title = fm ? (/^title: (.+)$/m.exec(fm[1]!)?.[1] ?? null) : null;
    const tagsRaw = fm ? (/^tags: \[(.*)\]$/m.exec(fm[1]!)?.[1] ?? '') : '';
    const tags = tagsRaw === '' ? [] : tagsRaw.split(',').map((t) => t.trim());
    const body = fm ? text.slice(fm[0]!.length) : text;
    const summary = body.split('\n').filter((l) => l.trim() !== '')[0] ?? '';
    const matched: string[] = [];
    if (title !== null && title.toLowerCase().includes(KEYWORD)) matched.push('title');
    if (tags.some((t) => t.toLowerCase().includes(KEYWORD))) matched.push('tags');
    if (summary.toLowerCase().includes(KEYWORD)) matched.push('summary');
    if (matched.length > 0) out.push({ vault, path: p, matched });
  }
  return out;
}

interface RebuildStatusFace {
  state: 'idle' | 'running' | 'completed';
  total: number;
  done: number;
  started_at: string | null;
  finished_at: string | null;
}

interface Harness {
  app: FastifyInstance;
  db: DatabaseSync;
  pepperKey: Buffer;
  dataDir: string;
  rootToken: string;
  bobToken: string;
  aliceToken: string;
  vaultIds: Record<string, number>;
  headOf(vault: string): Promise<string>;
  close(): Promise<void>;
}

let h: Harness;
/** gamma 派生门控（降级窗口注入）：blocked 时 gamma 的 derive 挂起至 release */
let gammaBlocked = false;
let gammaRelease: (() => void) | null = null;

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
  const dataDir = await mkdtemp(path.join(tmpdir(), 'notegit-t5-e2e-'));
  const dbFile = path.join(dataDir, 'db', 'notegit.sqlite');
  await mkdir(path.dirname(dbFile), { recursive: true });
  const db = openDatabase(dbFile);
  migrate(db, MIGRATIONS);
  for (const ddl of FIXTURE_DDL) db.exec(ddl);

  const root = addEmployee(db, { username: 'root', is_instance_admin: 1 });
  const alice = addEmployee(db, { username: 'alice' });
  const bob = addEmployee(db, { username: 'bob' });
  const alpha = addVault(db, 'alpha', alice);
  const beta = addVault(db, 'beta', bob);
  const gamma = addVault(db, 'gamma', bob);
  // 成员关系同 T4 陷阱构造：alice ∈ {alpha, gamma}；root ∈ {alpha}；bob ∈ {beta}
  addMember(db, alpha, alice, 'admin', alice);
  addMember(db, gamma, alice, 'reader', bob);
  addMember(db, alpha, root, 'editor', alice);
  addMember(db, beta, bob, 'admin', bob);

  await initBareVaultRepo(dataDir, alpha);
  await initBareVaultRepo(dataDir, beta);
  await initBareVaultRepo(dataDir, gamma);
  await seedVault(dataDir, alpha, ALPHA_FILES);
  await seedVault(dataDir, beta, BETA_FILES);
  await seedVault(dataDir, gamma, GAMMA_FILES);

  const gammaRepo = vaultRepoPath(dataDir, gamma);
  const pepper = { active: { version: 1, key: randomBytes(32) }, retired: [] as never[] };
  const service = new CredentialsService({ db, pepper });
  const expires = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const mk = (id: number, name: string) => service.createCredential(id, { name, expires_at: expires }).token;

  const app = buildApp({
    db,
    pepper,
    bootstrapTokenFile: path.join(dataDir, 'config', 'admin-bootstrap.token'),
    dataDir,
    searchIndex: {
      pollMs: 50,
      // 降级窗口注入缝：blocked 时仅挡 gamma 的派生（真实派生面的包装，不改语义）
      derive: async (repoPath, branch) => {
        if (gammaBlocked && repoPath === gammaRepo) {
          await new Promise<void>((resolve) => {
            gammaRelease = resolve;
          });
        }
        return deriveVaultIndex(repoPath, branch);
      },
    },
  });
  await app.ready();

  return {
    app,
    db,
    pepperKey: pepper.active.key,
    dataDir,
    rootToken: mk(root, 'root'),
    aliceToken: mk(alice, 'alice'),
    bobToken: mk(bob, 'bob'),
    vaultIds: { alpha, beta, gamma },
    headOf: async (vault: string) =>
      (await git(['--git-dir', vaultRepoPath(dataDir, h.vaultIds[vault]!), 'rev-parse', 'refs/heads/main'])).trim(),
    close: async () => {
      gammaRelease?.(); // 防挂：任一降态窗口未释放也不拖住 stop()
      await app.close();
      db.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

before(async () => {
  h = await startHarness();
  // 等启动对账把三库索引到位（重建/降态断言的干净起点）
  const deadline = Date.now() + 10_000;
  for (;;) {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/admin/search-index',
      headers: { authorization: `Bearer ${h.rootToken}` },
    });
    const status = res.json() as { vaults: { up_to_date: boolean; rows: number }[] };
    if (status.vaults.length === 3 && status.vaults.every((v) => v.up_to_date && v.rows > 0)) break;
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
  matched: string[];
}

async function apiSearch(token: string, q = KEYWORD): Promise<ApiHit[]> {
  const res = await h.app.inject({
    method: 'GET',
    url: `/api/v1/search?q=${encodeURIComponent(q)}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  return (res.json() as { results: ApiHit[] }).results;
}

/** 稳定可比形态：vault:path:matched（排序 vault→path 与查询面确定性排序一致） */
function keyOf(hits: readonly ApiHit[]): string[] {
  return hits.map((r) => `${r.vault_slug}:${r.path}:${r.matched.join(',')}`);
}

async function postRebuild(): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/v1/admin/search-index/rebuild',
    headers: { authorization: `Bearer ${h.rootToken}` },
  });
  return { status: res.statusCode, body: (res.json ?? (() => ({})))() as Record<string, unknown> };
}

async function getStatus(): Promise<{ rebuild: RebuildStatusFace; vaults: { slug: string; up_to_date: boolean }[] }> {
  const res = await h.app.inject({
    method: 'GET',
    url: '/api/v1/admin/search-index',
    headers: { authorization: `Bearer ${h.rootToken}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as never;
}

async function waitRebuild(cond: (s: RebuildStatusFace) => boolean, deadlineMs = 10_000): Promise<RebuildStatusFace> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const { rebuild } = await getStatus();
    if (cond(rebuild)) return rebuild;
    if (Date.now() > deadline) throw new Error(`等待重建进度超时（state=${rebuild.state} done=${rebuild.done}/${rebuild.total}）`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function stateRows(): { vault_id: number; triggered_by: string; lag_ms: number | null; duration_ms: number | null }[] {
  return h.db
    .prepare('SELECT vault_id, triggered_by, lag_ms, duration_ms FROM search_index_state ORDER BY vault_id')
    .all() as never;
}

test('R9 对账：删索引数据 → 全量重建 → 进度可观测收敛 → 与重建前对账一致', async () => {
  // 重建前基线（三账号快照 + 期望集）
  const expectedAlice = [...expectedFor('alpha', ALPHA_FILES), ...expectedFor('gamma', GAMMA_FILES)]
    .map((e) => `${e.vault}:${e.path}:${e.matched.join(',')}`).sort();
  const expectedRoot = expectedFor('alpha', ALPHA_FILES).map((e) => `${e.vault}:${e.path}:${e.matched.join(',')}`).sort();
  const expectedBob = expectedFor('beta', BETA_FILES).map((e) => `${e.vault}:${e.path}:${e.matched.join(',')}`).sort();
  const beforeAlice = keyOf(await apiSearch(h.aliceToken));
  const beforeRoot = keyOf(await apiSearch(h.rootToken));
  const beforeBob = keyOf(await apiSearch(h.bobToken));
  assert.deepEqual(beforeAlice, expectedAlice, '重建前基线自检（alice）');
  assert.deepEqual(beforeRoot, expectedRoot, '重建前基线自检（root）');
  assert.deepEqual(beforeBob, expectedBob, '重建前基线自检（bob）');

  // 删索引数据（派生面整体蒸发——重建输入态）
  h.db.exec('DELETE FROM search_index');
  h.db.exec('DELETE FROM search_index_state');
  assert.deepEqual(await apiSearch(h.aliceToken), [], '删索引后查询空（降级为空集——如实）');

  // 全量重建（R9 方法：应用内触发 + 进度可观测）
  const trigger = await postRebuild();
  assert.equal(trigger.status, 202, `触发应 202：${JSON.stringify(trigger.body)}`);
  const started = trigger.body['rebuild'] as RebuildStatusFace;
  assert.equal(started.state, 'running');
  assert.equal(started.total, 3, 'total = 库数');
  const done = await waitRebuild((s) => s.state === 'completed' && s.done === s.total);
  assert.ok(done.started_at !== null && done.finished_at !== null);
  assert.ok(Date.parse(done.finished_at) >= Date.parse(done.started_at), '完成时间不早于开始');

  // 重建型触发的可观测口径（C1 建议稿：triggered_by=manual、lag 重建型为 NULL）
  const rows = stateRows();
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.triggered_by, 'manual');
    assert.equal(row.lag_ms, null, '重建型触发无发布延迟分母');
    assert.ok(typeof row.duration_ms === 'number' && row.duration_ms >= 0);
  }

  // 对账一致（与重建前逐账号相等）
  assert.deepEqual(keyOf(await apiSearch(h.aliceToken)), expectedAlice, 'alice 重建后与期望一致');
  assert.deepEqual(keyOf(await apiSearch(h.rootToken)), expectedRoot, 'root 重建后与期望一致');
  assert.deepEqual(keyOf(await apiSearch(h.bobToken)), expectedBob, 'bob 重建后与期望一致');

  // git 直读对账（R9 同款）：commit 三要素 = 各库默认分支当前头；路径在当前 tree 中
  const heads: Record<string, string> = {
    alpha: await h.headOf('alpha'),
    beta: await h.headOf('beta'),
    gamma: await h.headOf('gamma'),
  };
  for (const vault of ['alpha', 'beta', 'gamma'] as const) {
    const ls = await git(['--git-dir', vaultRepoPath(h.dataDir, h.vaultIds[vault]!), 'ls-tree', '-r', '--name-only', 'refs/heads/main']);
    const mdPaths = new Set(ls.split('\n').filter((p) => p.endsWith('.md')));
    const all = [...beforeAlice, ...beforeRoot, ...beforeBob]; // 覆盖三账号全命中
    for (const key of all.filter((k) => k.startsWith(`${vault}:`))) {
      const p = key.split(':')[1]!;
      assert.ok(mdPaths.has(p), `${vault}/${p} 在当前 tree 中真实存在`);
    }
  }
  const after = await apiSearch(h.aliceToken);
  for (const hit of after) assert.equal(hit.commit_oid, heads[hit.vault_slug]!, `${hit.vault_slug} 行 commit = 当前头`);
});

test('降级态：重建中无权库已重建行不泄露（陷阱复测）、部分结果如实、页面同判定面', async () => {
  // 门控 gamma（仅挡 gamma 的派生）：alpha/beta 先完成 → beta 的行已在表而 root 无权
  gammaBlocked = true;
  try {
    h.db.exec('DELETE FROM search_index');
    h.db.exec('DELETE FROM search_index_state');
    const trigger = await postRebuild();
    assert.equal(trigger.status, 202);

    // 降级窗口：alpha+beta 已重建（done=2），gamma 在途
    await waitRebuild((s) => s.state === 'running' && s.done === 2);
    const mid = await getStatus();
    assert.equal(mid.rebuild.total, 3);
    const betaRow = h.db.prepare('SELECT path FROM search_index WHERE vault_id = ?').get(h.vaultIds['beta']!) as
      | { path: string }
      | undefined;
    assert.ok(betaRow !== undefined, 'beta 行已在表（降态陷阱的前提：无权库数据物理存在）');

    // 陷阱复测（T4 同款断言在降级态）：root 只见 alpha 三行，beta/gamma 一律不可见
    const rootMid = await apiSearch(h.rootToken);
    assert.deepEqual(
      keyOf(rootMid),
      ['alpha:README.md:summary', 'alpha:deploy-runbook.md:title', 'alpha:notes/oncall.md:tags'],
      '降级态不泄露：无权库（beta）已重建的行不出现在高权账号结果（数量精确）',
    );
    assert.ok(!JSON.stringify(rootMid).includes('机密'), '无权库标题文本不进降级态响应');

    // 部分结果如实（选型=部分结果不 503）：alice 的 gamma 命中缺省（在途），alpha 命中完整
    const aliceMid = await apiSearch(h.aliceToken);
    assert.deepEqual(
      keyOf(aliceMid),
      ['alpha:README.md:summary', 'alpha:deploy-runbook.md:title', 'alpha:notes/oncall.md:tags'],
      '部分降级：在途库的命中缺省、已重建库的命中完整',
    );

    // 页面同一判定面（降级态同样过滤）
    const sid = createSession(h.db, 1, h.pepperKey, new Date(), DEFAULT_SESSION_TIMEOUTS).sid; // root id=1
    const page = await h.app.inject({
      method: 'GET',
      url: `/search?q=${encodeURIComponent(KEYWORD)}`,
      headers: { cookie: `ngt_sid=${sid}` },
    });
    assert.equal(page.statusCode, 200);
    const pageRows = [...page.body.matchAll(/<tr data-vault="([^"]*)" data-path="([^"]*)"/g)].map((m) => `${m[1]}:${m[2]}`);
    assert.deepEqual(
      pageRows.sort(),
      ['alpha:README.md', 'alpha:deploy-runbook.md', 'alpha:notes/oncall.md'],
      '页面降态同样不泄露（与 API 同一实时过滤面）',
    );
    assert.ok(!page.body.includes('机密'), '页面不出现无权库文本');

    // 撤权复测（降态同源）：bob 的 beta 成员行 DELETE → 同一 token 下一查询即消失
    const bobMid = await apiSearch(h.bobToken);
    assert.deepEqual(
      keyOf(bobMid),
      expectedFor('beta', BETA_FILES).map((e) => `${e.vault}:${e.path}:${e.matched.join(',')}`),
      '降态撤权前 bob 可见 beta（自己有权）',
    );
    h.db.prepare('DELETE FROM vault_members WHERE vault_id = ? AND employee_id = ?').run(h.vaultIds['beta']!, 3); // bob id=3
    assert.deepEqual((await apiSearch(h.bobToken)), [], '降态撤权下一查询即消失（权限过滤不降级）');
    addMember(h.db, h.vaultIds['beta']!, 3, 'admin', 1); // 还原成员关系（后续收口断言用）

    // 收口：释放门控 → 重建完成 → 全量一致恢复（降级缺省的 gamma 回来）
    gammaRelease?.();
    gammaRelease = null;
    await waitRebuild((s) => s.state === 'completed' && s.done === s.total);
    const aliceFull = await apiSearch(h.aliceToken);
    assert.deepEqual(
      keyOf(aliceFull).sort(),
      [...keyOf(aliceMid), 'gamma:infra.md:summary'].sort(),
      '收口后全量恢复：降级缺省的 gamma 命中回归',
    );
  } finally {
    gammaBlocked = false;
    gammaRelease?.();
    gammaRelease = null;
  }
});
