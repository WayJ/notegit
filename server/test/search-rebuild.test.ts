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
import { deriveVaultIndex } from '../src/search/derive.ts';
import { FIXTURE_DDL, addEmployee, addMember, addVault } from './credentials-fixtures.ts';

// S5-T5 重建入口 POST /api/v1/admin/search-index/rebuild 的端点语义面（E2E 对账/
// 降级断言在 search-rebuild-e2e.test.ts）：
// - 实例管理员门槛（401 未认证 / 403 非管理员 E-AUTHZ-001）；
// - 触发 202 + rebuild 进度面（done/total/state/时间戳）；GET /api/v1/admin/search-index
//   同面暴露（T3 指标面复用：rebuilding 状态 + 进度计数）；
// - 幂等选型 = 拒绝：重建中再触发 409 E-RES-008 + 当前进度（排队无增益——单进程
//   逐库串行、重跑产出相同；选型记录 docs/s1/search-index-amendments.md C4）；
// - 触发记 search.rebuild 审计行（运行态写入，maintenance.enable 同款形态）；
//   409 拒绝不记（无迁移不记）；
// - 维护模式放行（backup §7 步骤 9：恢复流程在维护模式内触发重建——派生索引
//   不入备份一致性集合，属运行态写入，gate.ts RUNTIME_WRITE_ALLOWLIST 登记）；
// - 无 dataDir（无索引器）形态：503 如实不可用；GET 报 rebuild idle。
// 端点未入 api.md（D11 模式——建议稿 C4，D13 裁决归位）。

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
  vaultId: number;
  adminToken: string;
  userToken: string;
  close(): Promise<void>;
}

let h: Harness;
/** 派生门控（幂等拒绝测试的注入缝）：blocked 时单库 derive 挂起至 release */
let blockDerive = false;
let releaseDerive: (() => void) | null = null;

async function startHarness(): Promise<Harness> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'notegit-t5-routes-'));
  const dbFile = path.join(dataDir, 'db', 'notegit.sqlite');
  await mkdir(path.dirname(dbFile), { recursive: true });
  const db = openDatabase(dbFile);
  migrate(db, MIGRATIONS);
  for (const ddl of FIXTURE_DDL) db.exec(ddl);

  const admin = addEmployee(db, { username: 'admin', is_instance_admin: 1 });
  const user = addEmployee(db, { username: 'user' });
  const vaultId = addVault(db, 'docs', admin);
  addMember(db, vaultId, admin, 'editor', admin);
  addMember(db, vaultId, user, 'reader', admin);

  await initBareVaultRepo(dataDir, vaultId);
  const seed = path.join(dataDir, 'seed');
  await git(['init', '-b', 'main', seed]);
  const abs = path.join(seed, 'a.md');
  await writeFile(abs, '---\ntitle: 文档A\ntags: [x]\n---\n\nA 首段。\n');
  await git(['-C', seed, 'add', '.']);
  await git(['-C', seed, '-c', 'user.email=seed@notegit.test', '-c', 'user.name=seed', 'commit', '-m', 'seed']);
  await git(['-C', seed, 'push', vaultRepoPath(dataDir, vaultId), 'main']);

  const pepper = { active: { version: 1, key: randomBytes(32) }, retired: [] as never[] };
  const service = new CredentialsService({ db, pepper });
  const expires = new Date(Date.now() + 7 * 86_400_000).toISOString();

  const app = buildApp({
    db,
    pepper,
    bootstrapTokenFile: path.join(dataDir, 'config', 'admin-bootstrap.token'),
    dataDir,
    searchIndex: {
      pollMs: 40,
      derive: async (repoPath, branch) => {
        if (blockDerive) await new Promise<void>((resolve) => { releaseDerive = resolve; });
        return deriveVaultIndex(repoPath, branch);
      },
    },
  });
  await app.ready();
  return {
    app,
    db,
    vaultId,
    adminToken: service.createCredential(admin, { name: 'admin', expires_at: expires }).token,
    userToken: service.createCredential(user, { name: 'user', expires_at: expires }).token,
    close: async () => {
      releaseDerive?.(); // 防挂：门控未释放也不拖住 stop()
      await app.close();
      db.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

before(async () => {
  h = await startHarness();
  // 等启动对账索引到位（干净起点）
  const deadline = Date.now() + 10_000;
  for (;;) {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/admin/search-index',
      headers: { authorization: `Bearer ${h.adminToken}` },
    });
    const row = (res.json() as { vaults: { indexed_at: string | null }[] }).vaults.find((v) => v);
    if (row?.indexed_at != null) break;
    if (Date.now() > deadline) throw new Error('等待启动对账索引超时');
    await new Promise((r) => setTimeout(r, 30));
  }
});

after(async () => {
  await h.close();
});

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function postRebuild(token: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await h.app.inject({ method: 'POST', url: '/api/v1/admin/search-index/rebuild', headers: bearer(token) });
  let body: Record<string, unknown> = {};
  try {
    body = res.json() as Record<string, unknown>;
  } catch {
    /* 非 JSON 体（204 类） */
  }
  return { status: res.statusCode, body };
}

async function getRebuildStatus(token: string): Promise<RebuildStatusFace> {
  const res = await h.app.inject({ method: 'GET', url: '/api/v1/admin/search-index', headers: bearer(token) });
  assert.equal(res.statusCode, 200, res.body);
  return (res.json() as { rebuild: RebuildStatusFace }).rebuild;
}

async function waitCompleted(token: string, deadlineMs = 10_000): Promise<RebuildStatusFace> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const rebuild = await getRebuildStatus(token);
    if (rebuild.state === 'completed' && rebuild.done === rebuild.total) return rebuild;
    if (Date.now() > deadline) throw new Error(`等待重建完成超时（${rebuild.state} ${rebuild.done}/${rebuild.total}）`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

test('POST rebuild 认证门槛：未认证 401、非实例管理员 403 E-AUTHZ-001', async () => {
  const anon = await h.app.inject({ method: 'POST', url: '/api/v1/admin/search-index/rebuild' });
  assert.equal(anon.statusCode, 401);
  const forbidden = await postRebuild(h.userToken);
  assert.equal(forbidden.status, 403);
  assert.equal((forbidden.body['error'] as { code: string }).code, 'E-AUTHZ-001');
});

test('触发 202 + 进度面：完成后 state=completed、done=total；state 行 triggered_by=manual、lag=NULL', async () => {
  const trigger = await postRebuild(h.adminToken);
  assert.equal(trigger.status, 202, JSON.stringify(trigger.body));
  const started = trigger.body['rebuild'] as RebuildStatusFace;
  assert.equal(started.state, 'running');
  assert.equal(started.total, 1);
  assert.ok(started.started_at !== null);
  assert.equal(started.finished_at, null);

  const done = await waitCompleted(h.adminToken);
  assert.equal(done.total, 1);
  assert.equal(done.done, 1);
  assert.ok(done.finished_at !== null);
  assert.ok(Date.parse(done.finished_at) >= Date.parse(done.started_at!), '完成不早于开始');

  const row = h.db
    .prepare('SELECT triggered_by, lag_ms, duration_ms FROM search_index_state WHERE vault_id = ?')
    .get(h.vaultId) as { triggered_by: string; lag_ms: number | null; duration_ms: number };
  assert.equal(row.triggered_by, 'manual', '重建型触发（DDL CHECK 预留位）');
  assert.equal(row.lag_ms, null, '重建型无发布延迟分母（C1 建议稿口径）');
  assert.ok(row.duration_ms >= 0);
});

test('幂等选型=拒绝：重建中再触发 409 E-RES-008 且 409 拒绝不记审计', async () => {
  const auditCount = (): number =>
    (h.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_kind = 'search.rebuild'").get() as { n: number }).n;
  const before = auditCount();

  blockDerive = true; // 挂住本库派生——制造「重建在途」窗口
  try {
    const first = await postRebuild(h.adminToken);
    assert.equal(first.status, 202);
    const again = await postRebuild(h.adminToken);
    assert.equal(again.status, 409, '重建中再触发被拒（选型=拒绝，不排队）');
    const err = again.body['error'] as { code: string; details?: { rebuild?: RebuildStatusFace } };
    assert.equal(err.code, 'E-RES-008');
    assert.equal(err.details?.rebuild?.state, 'running', '409 响应携带当前进度（管理员可观测）');
    assert.equal(err.details?.rebuild?.total, 1);
    assert.equal(auditCount(), before + 1, '只有成功触发记审计——409 拒绝不记（无迁移不记）');
  } finally {
    releaseDerive?.();
    releaseDerive = null;
    blockDerive = false;
  }
  await waitCompleted(h.adminToken);
});

test('审计：search.rebuild 行 = 直接终态、主体=触发管理员、实例级（无 vault_id）', async () => {
  const rows = h.db
    .prepare(
      `SELECT actor_kind, employee_id, credential_ref, entry, status, vault_id, detail
       FROM audit_events WHERE event_kind = 'search.rebuild' ORDER BY id`,
    )
    .all() as Record<string, unknown>[];
  assert.ok(rows.length >= 1, '前序测试已产生触发审计行');
  const last = rows[rows.length - 1]!;
  assert.equal(last['actor_kind'], 'employee');
  assert.equal(last['employee_id'], 1, '主体 = 触发的实例管理员（认证员工）');
  assert.match(last['credential_ref'] as string, /^credential:\d+$/, 'Bearer 载体标识');
  assert.equal(last['entry'], 'api');
  assert.equal(last['status'], 'succeeded', '管理类直接终态（无 pending 生命周期）');
  assert.equal(last['vault_id'], null, '实例级事件（非逐库）');
});

test('维护模式放行：维护中 POST rebuild 不被 503 拦（运行态写入——backup §7 步骤 9）', async () => {
  const on = await h.app.inject({ method: 'POST', url: '/api/v1/admin/maintenance', headers: bearer(h.adminToken) });
  assert.equal(on.statusCode, 204);
  try {
    const during = await postRebuild(h.adminToken);
    assert.equal(during.status, 202, '派生索引不入备份一致性集合——维护内可触发（恢复流程步骤 9）');
    assert.equal((during.body['rebuild'] as RebuildStatusFace).state, 'running');
    const read = await h.app.inject({ method: 'GET', url: '/api/v1/admin/search-index', headers: bearer(h.adminToken) });
    assert.equal(read.statusCode, 200, '读面不受维护影响');
    await waitCompleted(h.adminToken);
  } finally {
    const off = await h.app.inject({ method: 'DELETE', url: '/api/v1/admin/maintenance', headers: bearer(h.adminToken) });
    assert.equal(off.statusCode, 204);
  }
});

test('无索引器形态（无 dataDir）：POST 503 如实不可用；GET 报 rebuild idle', async () => {
  const db = openDatabase(':memory:');
  migrate(db, MIGRATIONS);
  for (const ddl of FIXTURE_DDL) db.exec(ddl);
  const admin = addEmployee(db, { username: 'admin', is_instance_admin: 1 });
  const pepper = { active: { version: 1, key: randomBytes(32) }, retired: [] as never[] };
  const token = new CredentialsService({ db, pepper })
    .createCredential(admin, { name: 'a', expires_at: new Date(Date.now() + 86_400_000).toISOString() })
    .token;
  const app = buildApp({ db, pepper, bootstrapTokenFile: '/dev/null' });
  try {
    const post = await app.inject({ method: 'POST', url: '/api/v1/admin/search-index/rebuild', headers: bearer(token) });
    assert.equal(post.statusCode, 503, '索引器未接线——如实不可用（非 500）');
    assert.equal((post.json() as { error: { code: string } }).error.code, 'E-SRCH-001');
    const get = await app.inject({ method: 'GET', url: '/api/v1/admin/search-index', headers: bearer(token) });
    assert.equal(get.statusCode, 200);
    const body = get.json() as { running: boolean; rebuild: RebuildStatusFace };
    assert.equal(body.running, false);
    assert.equal(body.rebuild.state, 'idle', '无索引器形态 rebuild 面如实 idle');
  } finally {
    await app.close();
    db.close();
  }
});
