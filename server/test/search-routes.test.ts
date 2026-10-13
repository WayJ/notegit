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
import { recordAuditEvent } from '../src/audit/audit.ts';
import { FIXTURE_DDL, addEmployee, addMember, addVault } from './credentials-fixtures.ts';

// S5-T3 最小管理端点 GET /api/v1/admin/search-index（延迟指标与时间戳可查）：
// 实例管理员门槛（401 未认证 / 403 非管理员）；逐库返回 indexed_at/lag_ms/
// duration_ms/updates 与失败告警字段（consecutive_failures/last_error）+ 实时
// 新鲜度（up_to_date：state.head_commit vs 默认分支当前头）。端点未入 api.md
// 契约（D11 模式——建议稿 docs/s1/search-index-amendments.md，master 评审归位）。

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
  seed: string;
  adminToken: string;
  userToken: string;
  close(): Promise<void>;
}

let h: Harness;

async function startHarness(): Promise<Harness> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'notegit-t3-routes-'));
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
  await writeMd(seed, 'README.md', '# nav\n');
  await writeMd(seed, 'a.md', '---\ntitle: 文档A\ntags: [x]\n---\n\nA 首段。\n');
  await git(['-C', seed, 'add', '.']);
  await git(['-C', seed, '-c', 'user.email=seed@notegit.test', '-c', 'user.name=seed', 'commit', '-m', 'seed']);
  await git(['-C', seed, 'push', vaultRepoPath(dataDir, vaultId), 'main']);

  const pepper = { active: { version: 1, key: randomBytes(32) }, retired: [] as never[] };
  const service = new CredentialsService({ db, pepper });
  const expires = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const adminToken = service.createCredential(admin, { name: 'admin', expires_at: expires }).token;
  const userToken = service.createCredential(user, { name: 'user', expires_at: expires }).token;

  const app = buildApp({
    db,
    pepper,
    bootstrapTokenFile: path.join(dataDir, 'config', 'admin-bootstrap.token'),
    dataDir, // 索引器随 dataDir 接线（启动对账在 start 内异步跑）
    searchIndex: { pollMs: 40 },
  });
  await app.ready();
  return {
    app,
    db,
    dataDir,
    vaultId,
    seed,
    adminToken,
    userToken,
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

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

interface VaultStatusRow {
  vault_id: number;
  slug: string;
  branch: string;
  head_commit: string | null;
  live_commit: string | null;
  up_to_date: boolean;
  indexed_at: string | null;
  triggered_by: string | null;
  triggered_at: string | null;
  duration_ms: number | null;
  lag_ms: number | null;
  updates: number | null;
  consecutive_failures: number | null;
  last_error: string | null;
  last_error_at: string | null;
  rows: number;
}

async function getStatus(token: string): Promise<{ running: boolean; pollMs: number; vaults: VaultStatusRow[] }> {
  const res = await h.app.inject({ method: 'GET', url: '/api/v1/admin/search-index', headers: bearer(token) });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as never;
}

/** 等待启动对账把库索引到位（app.ready 不含后台对账——轮询至可见） */
async function waitIndexed(deadlineMs = 10_000): Promise<VaultStatusRow> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const status = await getStatus(h.adminToken);
    const row = status.vaults.find((v) => v.vault_id === h.vaultId);
    if (row !== undefined && row.indexed_at !== null) return row;
    if (Date.now() > deadline) throw new Error('等待启动对账索引超时');
    await new Promise((r) => setTimeout(r, 30));
  }
}

test('GET /api/v1/admin/search-index：未认证 401、非实例管理员 403', async () => {
  const anon = await h.app.inject({ method: 'GET', url: '/api/v1/admin/search-index' });
  assert.equal(anon.statusCode, 401);
  const forbidden = await h.app.inject({ method: 'GET', url: '/api/v1/admin/search-index', headers: bearer(h.userToken) });
  assert.equal(forbidden.statusCode, 403);
  const errBody = forbidden.json() as { error: { code: string } };
  assert.equal(errBody.error.code, 'E-AUTHZ-001');
});

test('GET /api/v1/admin/search-index：管理员可见延迟指标与时间戳（启动对账后 up_to_date）', async () => {
  const row = await waitIndexed();
  assert.equal(row.slug, 'docs');
  assert.equal(row.branch, 'main');
  assert.ok(row.head_commit !== null && row.head_commit.length === 40);
  assert.equal(row.live_commit, row.head_commit, '实时头 = 已索引头');
  assert.equal(row.up_to_date, true);
  assert.equal(row.rows, 2, 'README + a.md 两行');
  assert.ok(row.indexed_at !== null);
  assert.ok(typeof row.duration_ms === 'number' && row.duration_ms >= 0, '派生耗时指标');
  assert.equal(row.consecutive_failures, 0);
  assert.equal(row.last_error, null);
});

test('新鲜度实时：默认分支前进（无审计行的旁路 push）→ up_to_date=false 且头可比对', async () => {
  await waitIndexed();
  await writeMd(h.seed, 'late.md', '---\ntitle: 迟到\n---\n\n迟到首段。\n');
  await git(['-C', h.seed, 'add', '.']);
  await git(['-C', h.seed, '-c', 'user.email=seed@notegit.test', '-c', 'user.name=seed', 'commit', '-m', 'late']);
  await git(['-C', h.seed, 'push', vaultRepoPath(h.dataDir, h.vaultId), 'main']);

  const status = await getStatus(h.adminToken);
  const row = status.vaults.find((v) => v.vault_id === h.vaultId)!;
  assert.equal(row.up_to_date, false, '旁路漂移立即可见（stale 是可观测状态）');
  assert.notEqual(row.live_commit, row.head_commit);
});

test('失败告警可见：派生失败注入 → 端点暴露 consecutive_failures/last_error', async () => {
  // 通过新一份 app 注入失败派生（既有 app 的索引器不可注入——buildApp 接缝在构造期）
  const dataDir = await mkdtemp(path.join(tmpdir(), 'notegit-t3-fail-'));
  const dbFile = path.join(dataDir, 'db', 'notegit.sqlite');
  await mkdir(path.dirname(dbFile), { recursive: true });
  const db = openDatabase(dbFile);
  migrate(db, MIGRATIONS);
  for (const ddl of FIXTURE_DDL) db.exec(ddl);
  const admin = addEmployee(db, { username: 'admin', is_instance_admin: 1 });
  const vaultId = addVault(db, 'docs', admin);
  addMember(db, vaultId, admin, 'editor', admin);
  await initBareVaultRepo(dataDir, vaultId);

  const pepper = { active: { version: 1, key: randomBytes(32) }, retired: [] as never[] };
  const service = new CredentialsService({ db, pepper });
  const token = service
    .createCredential(admin, { name: 'a', expires_at: new Date(Date.now() + 86_400_000).toISOString() })
    .token;
  const app = buildApp({
    db,
    pepper,
    bootstrapTokenFile: path.join(dataDir, 'config', 'admin-bootstrap.token'),
    dataDir,
    searchIndex: {
      pollMs: 40,
      derive: () => Promise.reject(new Error('boom: injected')),
    },
  });
  await app.ready();
  try {
    // 空库无漂移（state 缺失 = null 与实际头 null 相等）——启动对账不触发重索引；
    // 插入 settle 形态的发布审计行驱动索引（经注入的失败派生 → 告警路径）
    recordAuditEvent(db, {
      occurredAt: new Date().toISOString(),
      actorKind: 'employee',
      subject: { employeeId: admin, carrierRef: 'session:1', entry: 'web' },
      eventKind: 'vault.web_submit',
      vaultId,
      refName: 'refs/heads/main',
      oldCommit: '0'.repeat(40),
      newCommit: 'a'.repeat(40),
      status: 'succeeded',
      detail: { pushId: 'push-fail-inject' },
    });
    const deadline = Date.now() + 10_000;
    let row: VaultStatusRow | undefined;
    for (;;) {
      const res = await app.inject({ method: 'GET', url: '/api/v1/admin/search-index', headers: bearer(token) });
      assert.equal(res.statusCode, 200);
      row = (res.json() as { vaults: VaultStatusRow[] }).vaults.find((v) => v.vault_id === vaultId);
      if (row !== undefined && row.consecutive_failures !== null && row.consecutive_failures > 0) break;
      if (Date.now() > deadline) throw new Error('等待失败告警可见超时');
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.ok(row!.last_error !== null && row!.last_error.includes('boom'), '最近错误经端点可见');
    assert.ok(row!.last_error_at !== null);
    assert.ok(row!.indexed_at !== null, '失败尝试留有时间戳（NOT NULL 列——首失败即有可查时刻）');
  } finally {
    await app.close();
    db.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
