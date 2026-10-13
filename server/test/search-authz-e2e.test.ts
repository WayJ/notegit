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
import { FIXTURE_DDL, addEmployee, addVault, addMember } from './credentials-fixtures.ts';

// S5-T4 验收面 E2E（breakdown §2.4 S5-T4 行三条完成标准，真实形态——T3 索引
// 消费面：dataDir + 真实索引器启动对账收敛后查询）：
// 1) 陷阱用例：另一员工的高权账号（实例管理员）构造「无权库的标题命中」——
//    不出现在结果（数量精确，不泄露库存在性）；
// 2) 撤权后该员工搜索结果下一查询即消失（与无缓存授权一致——同一 token 连续
//    两查询，期间仅 DELETE 成员行）；
// 3) 结果与库内容对账一致（全量对账）：API 与页面两面的结果集 == 测试侧
//    独立构造的期望集（frontmatter 元数据）× git 直读（ls-tree 路径全集、
//    rev-parse 当前头 = commit_oid），不与非 .md 文件、未命中文档、无权库混淆。
// 形态与 search-e2e.test.ts 同构（真实 bare 仓库 + 直推种子 + 启动对账收敛）。

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

/** alpha 库种子文档（期望集的唯一来源——测试侧构造，不经生产解析面） */
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

/** 对账期望行（测试侧独立构造：frontmatter 值由构造者明知，非生产解析回声） */
interface Expected {
  vault: string;
  path: string;
  title: string | null;
  tags: string[];
  summary: string;
  matched: string[];
}

const KEYWORD = 'deploy';

function expectedFor(vault: string, files: Record<string, string>): Expected[] {
  const out: Expected[] = [];
  for (const [p, text] of Object.entries(files)) {
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
    const title = fm ? /^title: (.+)$/m.exec(fm[1]!)?.[1] ?? null : null;
    const tagsRaw = fm ? /^tags: \[(.*)\]$/m.exec(fm[1]!)?.[1] ?? '' : '';
    const tags = tagsRaw === '' ? [] : tagsRaw.split(',').map((t) => t.trim());
    const body = fm ? text.slice(fm[0]!.length) : text;
    const summary = body.split('\n').filter((l) => l.trim() !== '')[0] ?? '';
    const matched: string[] = [];
    if (title !== null && title.toLowerCase().includes(KEYWORD)) matched.push('title');
    if (tags.some((t) => t.toLowerCase().includes(KEYWORD))) matched.push('tags');
    if (summary.toLowerCase().includes(KEYWORD)) matched.push('summary');
    if (matched.length > 0) out.push({ vault, path: p, title, tags, summary, matched });
  }
  return out;
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

async function seedVault(dataDir: string, vaultId: number, files: Record<string, string>): Promise<void> {
  const repoPath = vaultRepoPath(dataDir, vaultId);
  const work = path.join(dataDir, `seed-${vaultId}`);
  await git(['init', '-b', 'main', work]);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(work, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
  }
  // 非 .md 内容各库带一份（对账断言「结果 ⊆ .md 路径全集」的非成员侧）
  const logo = path.join(work, 'assets/logo.png');
  await mkdir(path.dirname(logo), { recursive: true });
  await writeFile(logo, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await git(['-C', work, 'add', '.']);
  await git(['-C', work, '-c', 'user.email=seed@notegit.test', '-c', 'user.name=seed', 'commit', '-m', 'seed']);
  await git(['-C', work, 'push', repoPath, 'HEAD:refs/heads/main']);
  await rm(work, { recursive: true, force: true });
}

async function startHarness(): Promise<Harness> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'notegit-t4-e2e-'));
  const dbFile = path.join(dataDir, 'db', 'notegit.sqlite');
  await mkdir(path.dirname(dbFile), { recursive: true });
  const db = openDatabase(dbFile);
  migrate(db, MIGRATIONS);
  for (const ddl of FIXTURE_DDL) db.exec(ddl);

  const root = addEmployee(db, { username: 'root', is_instance_admin: 1 }); // 高权账号（另一员工）
  const alice = addEmployee(db, { username: 'alice' });
  const bob = addEmployee(db, { username: 'bob' });
  const alpha = addVault(db, 'alpha', alice);
  const beta = addVault(db, 'beta', bob);
  const gamma = addVault(db, 'gamma', bob);
  // 成员关系：alice ∈ {alpha, gamma}；root ∈ {alpha}（实例管理员不自动获得库权限）；
  // bob ∈ {beta}。root/bob 对 gamma/alpha+gamma/beta 无成员关系即陷阱对。
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
    pepperKey: pepper.active.key,
    dataDir,
    rootToken: mk(root, 'root'),
    aliceToken: mk(alice, 'alice'),
    bobToken: mk(bob, 'bob'),
    vaultIds: { alpha, beta, gamma },
    headOf: async (vault: string) =>
      (await git(['--git-dir', vaultRepoPath(dataDir, h.vaultIds[vault]!), 'rev-parse', 'refs/heads/main'])).trim(),
    close: async () => {
      await app.close();
      db.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

before(async () => {
  h = await startHarness();
  // 等启动对账把三库索引到位（管理端点轮询——root 为实例管理员）
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
  title: string | null;
  tags: string[];
  summary: string;
  matched: string[];
}

async function apiSearch(token: string, q: string): Promise<{ q: string; truncated: boolean; results: ApiHit[] }> {
  const res = await h.app.inject({ method: 'GET', url: `/api/v1/search?q=${encodeURIComponent(q)}`, headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as never;
}

function pageSearch(employeeId: number, q: string): Promise<{ status: number; body: string }> {
  const sid = createSession(h.db, employeeId, h.pepperKey, new Date(), DEFAULT_SESSION_TIMEOUTS).sid;
  return h.app
    .inject({ method: 'GET', url: `/search?q=${encodeURIComponent(q)}`, headers: { cookie: `ngt_sid=${sid}` } })
    .then((res) => ({ status: res.statusCode, body: res.body }));
}

/** 页面结果行（data 属性）——与 API 同构的可对账序列 */
function pageRows(body: string): string[] {
  const out: string[] = [];
  const re = /<tr data-vault="([^"]*)" data-path="([^"]*)" data-commit="([^"]*)" data-matched="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) out.push(`${m[1]}:${m[2]}:${m[3]}:${m[4]}`);
  return out;
}

test('全量对账：alice（alpha+gamma 成员）的 API 结果集 == 构造期望 × git 直读；页面同行集', async () => {
  const expected = [...expectedFor('alpha', ALPHA_FILES), ...expectedFor('gamma', GAMMA_FILES)].sort((a, b) =>
    a.vault === b.vault ? (a.path < b.path ? -1 : 1) : a.vault < b.vault ? -1 : 1,
  );
  assert.equal(expected.length, 4, '期望集自检：alpha 3 行（README 摘要/runbook 标题/oncall 标签）+ gamma 1 行（infra 摘要）');

  const { truncated, results } = await apiSearch(h.aliceToken, KEYWORD);
  assert.equal(truncated, false);
  assert.deepEqual(
    results.map((r) => `${r.vault_slug}:${r.path}:${r.matched.join(',')}`),
    expected.map((e) => `${e.vault}:${e.path}:${e.matched.join(',')}`),
    '命中集与字段与构造期望一致（确定性排序 vault→path）',
  );

  const headAlpha = await h.headOf('alpha');
  const headGamma = await h.headOf('gamma');
  for (const r of results) {
    const exp = expected.find((e) => e.vault === r.vault_slug && e.path === r.path)!;
    assert.equal(r.title, exp.title);
    assert.deepEqual(r.tags, exp.tags);
    assert.equal(r.summary, exp.summary);
    assert.equal(r.commit_oid, r.vault_slug === 'alpha' ? headAlpha : headGamma, 'commit 三要素 = 该库默认分支当前头');
  }

  // git 直读对账：结果路径 ⊆ 该库当前 tree 的 .md 路径全集；非 .md（logo.png）不可达
  for (const vault of ['alpha', 'gamma']) {
    const out = await git(['--git-dir', vaultRepoPath(h.dataDir, h.vaultIds[vault]!), 'ls-tree', '-r', '--name-only', 'refs/heads/main']);
    const mdPaths = new Set(out.split('\n').filter((p) => p.endsWith('.md')));
    for (const r of results.filter((x) => x.vault_slug === vault)) assert.ok(mdPaths.has(r.path), `${vault}/${r.path} 在当前 tree 中真实存在`);
    assert.ok(![...mdPaths].includes('assets/logo.png'));
  }
  assert.ok(!results.some((r) => r.path.endsWith('.png')), '非 Markdown 内容不入结果');

  // 未命中文档不在结果（对账的完备性另一侧：unrelated/policy 不出现）
  assert.ok(!results.some((r) => r.path === 'unrelated.md' || r.path === 'policy.md'));

  // 页面同行集（两面一致）
  const page = await pageSearch(2, KEYWORD); // alice id=2（root=1）
  assert.equal(page.status, 200);
  assert.deepEqual(
    pageRows(page.body),
    results.map((r) => `${r.vault_slug}:${r.path}:${r.commit_oid}:${r.matched.join(',')}`),
    '页面与 API 同一判定面、同一结果集',
  );
});

test('陷阱用例：高权账号（实例管理员 root，非 beta/gamma 成员）——无权库的标题命中不出现', async () => {
  const { results } = await apiSearch(h.rootToken, KEYWORD);
  // root 仅 alpha 成员：期望恰 3 行，beta/secret.md（标题精确含关键词）与 gamma 命中一律不可见
  assert.deepEqual(
    results.map((r) => `${r.vault_slug}:${r.path}`),
    ['alpha:README.md', 'alpha:deploy-runbook.md', 'alpha:notes/oncall.md'],
    '数量精确=成员库命中数（不泄露无权库存在性）',
  );
  assert.ok(!JSON.stringify(results).includes('机密'), '无权库标题文本不进响应');
});

test('撤权：bob 的 beta 成员行 DELETE 后，同一 token 下一查询即消失（API 与页面）', async () => {
  const before = await apiSearch(h.bobToken, KEYWORD);
  assert.deepEqual(before.results.map((r) => `${r.vault_slug}:${r.path}`), ['beta:secret.md'], '撤权前可见');

  h.db.prepare('DELETE FROM vault_members WHERE vault_id = ? AND employee_id = ?').run(h.vaultIds['beta']!, 3); // bob id=3

  const after = await apiSearch(h.bobToken, KEYWORD);
  assert.deepEqual(after.results, [], '撤权后 API 下一查询即消失（无缓存授权同源）');
  const page = await pageSearch(3, KEYWORD);
  assert.equal(page.status, 200);
  assert.deepEqual(pageRows(page.body), [], '页面渲染同样下一请求消失');
});
