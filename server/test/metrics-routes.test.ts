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
import { VaultService } from '../src/vaults/service.ts';
import { createVaultRepoOps } from '../src/gitrepo/lifecycle.ts';
import { vaultRepoPath } from '../src/vaults/repo-path.ts';
import { openDatabase } from '../src/db/connection.ts';
import { migrate } from '../src/db/migrate.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { publishWebSubmit } from '../src/publish/index.ts';
import { DISK_DOMAINS } from '../src/metrics/disk.ts';
import { FIXTURE_DDL, addEmployee, addMember } from './credentials-fixtures.ts';

// S8-T2 运维指标面 GET /api/v1/admin/metrics（实例管理员；R14 方法——健康、磁盘、
// 备份完成时间可查；架构 §10 最低清单）。验收断言（breakdown S8-T2 行）：
// - 递增断言：人为制造 校验失败 / 推送失败 后对应指标递增（真实流：HTTP push
//   授权拒绝 / 内容校验拒绝；网页发布管线内容校验拒绝）；
// - 认证失败计数递增（identity §8 替代呈现：api/git 两入口 401）；
// - 只读端点不产审计行。
// 端点未入 api.md 册（D11 建议稿模式——docs/s1/metrics-face-amendments.md）。

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
};

const run = promisify(execFile);

async function git(args: string[], opts: { cwd?: string } = {}): Promise<{ stdout: string; stderr: string }> {
  return run('git', args, { ...opts, env: GIT_ENV });
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
  docsRepo: string;
  port: number;
  tokens: Record<'maint' | 'alice' | 'bob' | 'carol', string>;
  aliceId: number;
  bobId: number;
  urlFor(slug: string, who: keyof Harness['tokens']): string;
  close(): Promise<void>;
}

let h: Harness;

async function startHarness(): Promise<Harness> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'notegit-metrics-routes-'));
  const dbFile = path.join(dataDir, 'db', 'notegit.sqlite');
  await mkdir(path.dirname(dbFile), { recursive: true });
  const db = openDatabase(dbFile);
  migrate(db, MIGRATIONS);
  for (const ddl of FIXTURE_DDL) db.exec(ddl);

  const pepper = { active: { version: 1, key: randomBytes(32) }, retired: [] as never[] };
  const maint = addEmployee(db, { username: 'maint', is_instance_admin: 1 });
  const alice = addEmployee(db, { username: 'alice' });
  const bob = addEmployee(db, { username: 'bob' });
  const carol = addEmployee(db, { username: 'carol' });

  const vaultService = new VaultService({ db, repoOps: createVaultRepoOps(dataDir) });
  const docs = await vaultService.createVaultWithRepo(
    { name: 'Docs', slug: 'docs' },
    { employeeId: alice, entry: 'web', carrierRef: 'session:fixture' },
  );
  addMember(db, docs.id, bob, 'editor', alice);
  addMember(db, docs.id, carol, 'reader', alice);
  db.prepare('UPDATE vaults SET main_admin_only = 1 WHERE id = ?').run(docs.id);

  const credentials = new CredentialsService({ db, pepper });
  const expires = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const tokens = {} as Harness['tokens'];
  for (const [who, id] of [['maint', maint], ['alice', alice], ['bob', bob], ['carol', carol]] as const) {
    tokens[who] = credentials.createCredential(id, { name: `metrics-${who}`, expires_at: expires }).token;
  }

  // 种子内容：file 传输直推（HTTP 接入前无 hook——不产审计行，指标基线干净）
  const docsRepo = vaultRepoPath(dataDir, docs.id);
  const seed = path.join(dataDir, 'seed');
  await git(['init', '-b', 'main', seed]);
  await writeMd(seed, 'README.md', '# nav\n');
  await writeMd(seed, 'notes/first.md', '---\ntitle: First\n---\nbody\n');
  await git(['-C', seed, 'add', '.']);
  await git(['-C', seed, '-c', 'user.email=seed@notegit.test', '-c', 'user.name=seed', 'commit', '-m', 'seed']);
  await git(['-C', seed, 'push', docsRepo, 'main']);

  const app = buildApp({
    db,
    pepper,
    bootstrapTokenFile: path.join(dataDir, 'config', 'admin-bootstrap.token'),
    dataDir,
    dbFile,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = app.addresses()[0]!.port;

  return {
    app,
    db,
    dataDir,
    docsRepo,
    port,
    tokens,
    aliceId: alice,
    bobId: bob,
    urlFor: (slug, who) => `http://${who}:${h.tokens[who]}@127.0.0.1:${port}/git/${slug}.git`,
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

// ── 面读取辅助 ─────────────────────────────────────────────────────────────

interface Face {
  disk: { wired: boolean; data_dir?: string; domains?: { name: string; used_bytes: number }[]; watermark?: Record<string, unknown> };
  pushes: { failed: number; unresolved: number };
  web_submits: { failed: number };
  validation: { failed: number; timing: Record<'web-submit' | 'pre-receive', { count: number; p50_ms: number | null; p95_ms: number | null; max_ms: number | null }> };
  auth_failures: { total: number; by_entry: { api: number; web: number; git: number }; last_at: string | null };
  backup: { wired: boolean; last_completed_at: string | null };
}

async function face(): Promise<Face> {
  const res = await h.app.inject({
    method: 'GET',
    url: '/api/v1/admin/metrics',
    headers: { authorization: `Bearer ${h.tokens.maint}` },
  });
  assert.equal(res.statusCode, 200, `管理员读取指标面应 200：${res.body}`);
  return res.json() as Face;
}

function auditRowCount(): number {
  return (h.db.prepare('SELECT COUNT(*) AS n FROM audit_events').get() as { n: number }).n;
}

// ── 门槛与面形 ─────────────────────────────────────────────────────────────

test('门槛：未认证 401（并计入认证失败指标 api 桶——identity §8 替代呈现）', async () => {
  const before = await face();
  const res = await h.app.inject({ method: 'GET', url: '/api/v1/admin/metrics' });
  assert.equal(res.statusCode, 401);
  const after = await face();
  assert.equal(after.auth_failures.total, before.auth_failures.total + 1, '认证失败计数应递增');
  assert.equal(after.auth_failures.by_entry.api, before.auth_failures.by_entry.api + 1, 'api 入口桶递增');
  assert.equal(after.auth_failures.by_entry.git, before.auth_failures.by_entry.git);
  assert.equal(typeof after.auth_failures.last_at, 'string');
});

test('门槛：非实例管理员 403 E-AUTHZ-001（授权拒绝不是认证失败——计数不动）', async () => {
  const before = await face();
  const res = await h.app.inject({
    method: 'GET',
    url: '/api/v1/admin/metrics',
    headers: { authorization: `Bearer ${h.tokens.alice}` },
  });
  assert.equal(res.statusCode, 403);
  assert.equal((res.json() as { error: { code: string } }).error.code, 'E-AUTHZ-001');
  const after = await face();
  assert.equal(after.auth_failures.total, before.auth_failures.total, '403 不计认证失败');
});

test('面形：架构 §10 最低清单字段齐备（磁盘分域/水位、失败推送、校验耗时、认证失败、备份预留）', async () => {
  const f = await face();
  // 磁盘：四分域 + 水位
  assert.equal(f.disk.wired, true);
  assert.equal(f.disk.data_dir, h.dataDir);
  assert.deepEqual(
    (f.disk.domains ?? []).map((d) => d.name).sort(),
    [...DISK_DOMAINS].sort(),
    '分域清单 = backup §2 四分域',
  );
  const wm = f.disk.watermark!;
  for (const key of ['used_ratio', 'level', 'alert', 'warn_ratio', 'critical_ratio']) {
    assert.ok(key in wm, `水位应含 ${key}`);
  }
  // 计数与耗时面
  for (const key of ['failed', 'unresolved']) assert.ok(key in f.pushes);
  assert.ok('failed' in f.web_submits);
  assert.ok('failed' in f.validation);
  assert.ok(f.validation.timing['web-submit'] && f.validation.timing['pre-receive'], '两判定 scope 的耗时分位齐备');
  // 备份完成时间：S8-T4 接线（wired 恒 true；完成时间 = 最新 backup.completed
  // 审计行——本测试无备份运行，如实 null；行到值的接线断言在 backup-run.test.ts）
  assert.equal(f.backup.wired, true);
  assert.equal(f.backup.last_completed_at, null);
});

test('只读端点：GET 不产审计行', async () => {
  const n0 = auditRowCount();
  await face();
  await face();
  assert.equal(auditRowCount(), n0, '指标面只读，不记审计行');
});

// ── 递增断言（breakdown 验收：校验失败 / 推送失败两场景）──────────────────

test('递增①推送失败：编辑者写 main_admin_only 默认分支被 pre-receive 授权拒绝 → pushes.failed +1、validation.failed 不动', async () => {
  // 口径注记：只读成员的 push 在 HTTP 授权层即 403（refs 发现先于 receive 管线，
  // 不产审计行）；非快进 force push 拒绝落 unresolved（receive-aborted，S8-T6
  // 恢复对账定终态）。同步 settle rejected 的失败推送形态 = pre-receive 授权
  // 拒绝（settlePushRejected 于 hook 内即时清算——storage-model §6 步骤 2）。
  const before = await face();
  const clone = path.join(h.dataDir, 'clone-bob');
  await git(['clone', h.urlFor('docs', 'bob'), clone]);
  await git(['-C', clone, 'config', 'user.email', 'bob@notegit.test']);
  await git(['-C', clone, 'config', 'user.name', 'bob']);
  await writeMd(clone, 'notes/by-bob.md', '---\ntitle: ByBob\n---\nbody\n');
  await git(['-C', clone, 'add', '.']);
  await git(['-C', clone, 'commit', '-m', 'bob change']);
  await assert.rejects(
    git(['-C', clone, 'push', 'origin', 'main']),
    (e: Error & { stderr?: string }) => /main_admin_only|仅库管理员|仅管理员/.test(String(e.stderr)),
  );
  const after = await face();
  assert.equal(after.pushes.failed, before.pushes.failed + 1, '推送失败计数递增（审计面：vault.push rejected）');
  assert.equal(after.pushes.unresolved, before.pushes.unresolved, '同步清算的拒绝不进待核对');
  assert.equal(after.validation.failed, before.validation.failed, '授权拒绝未运行内容校验——校验失败不动');
});

test('递增②校验失败：无 frontmatter 内容 push 被 pre-receive 拒绝 → pushes.failed 与 validation.failed 各 +1', async () => {
  const before = await face();
  const clone = path.join(h.dataDir, 'clone-alice');
  await git(['clone', h.urlFor('docs', 'alice'), clone]);
  await git(['-C', clone, 'config', 'user.email', 'alice@notegit.test']);
  await git(['-C', clone, 'config', 'user.name', 'alice']);
  await writeMd(clone, 'notes/bad.md', 'no frontmatter at all\n');
  await git(['-C', clone, 'add', '.']);
  await git(['-C', clone, 'commit', '-m', 'add bad']);
  await assert.rejects(
    git(['-C', clone, 'push', 'origin', 'main']),
    (e: Error & { stderr?: string }) => /E-FM-001|内容校验未通过/.test(String(e.stderr)),
  );
  const after = await face();
  assert.equal(after.pushes.failed, before.pushes.failed + 1);
  assert.equal(after.validation.failed, before.validation.failed + 1, '校验失败计数递增（detail.reason=validation）');
});

test('递增③网页发布校验失败：管线 validation 阶段拒绝 → web_submits.failed 与 validation.failed 各 +1，web-submit 耗时计数 +1', async () => {
  const before = await face();
  // bob=editor：main_admin_only 下默认分支不可写，走 feature 分支（编辑者可建），
  // 使拒绝发生在 validation 阶段而非 branch-rules
  const r = await publishWebSubmit({
    db: h.db,
    dataDir: h.dataDir,
    subject: { employeeId: h.bobId, carrierRef: `session:${h.bobId}` },
    vaultSlug: 'docs',
    branch: 'feature/web-bad',
    baseCommit: null,
    changes: [{ kind: 'upsert', path: 'notes/web-bad.md', mode: '100644', content: 'missing title here\n' }],
    message: 'web bad',
    identity: { name: 'bob', email: 'bob@notegit.test' },
  });
  assert.equal(r.kind, 'rejected');
  if (r.kind === 'rejected') assert.equal(r.stage, 'validation', '拒绝应发生在内容校验阶段');
  const after = await face();
  assert.equal(after.web_submits.failed, before.web_submits.failed + 1, '网页发布失败计数递增');
  assert.equal(after.validation.failed, before.validation.failed + 1);
  assert.equal(after.pushes.failed, before.pushes.failed, '网页发布不进推送计数');
  assert.equal(
    after.validation.timing['web-submit']!.count,
    before.validation.timing['web-submit']!.count + 1,
    'app 进程内校验耗时样本递增（runServerValidation 计时）',
  );
});

test('递增④git 入口认证失败：错误 Basic 凭据 401 → by_entry.git 递增', async () => {
  const before = await face();
  const res = await fetch(`http://127.0.0.1:${h.port}/git/docs.git/info/refs?service=git-upload-pack`, {
    headers: { authorization: 'Basic ' + Buffer.from(`alice:${'ngt_' + 'x'.repeat(43)}`).toString('base64') },
  });
  assert.equal(res.status, 401);
  await res.arrayBuffer(); // 排干响应体（keep-alive 卫生）
  const after = await face();
  assert.equal(after.auth_failures.by_entry.git, before.auth_failures.by_entry.git + 1, 'git 入口桶递增');
  assert.equal(after.auth_failures.total, before.auth_failures.total + 1);
});
