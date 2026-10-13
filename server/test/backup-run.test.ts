import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
import { loadOrCreatePepper } from '../src/bootstrap/pepper.ts';
import { FIXTURE_DDL, addEmployee, addVault } from './credentials-fixtures.ts';
import { preRecordPendingPush, settlePushRejected } from '../src/githttp/receive-audit.ts';
import { httpMaintenanceControl, runBackup, BackupError } from '../src/backup/run.ts';

// S8-T4 备份编排（backup-recovery §4 步骤 1–2、7——快照核之外的两段协调）：
// - 步骤 1：经运行实例的维护端点开启（闸门是应用进程内标志——脚本侧不得自设假闸门，
//   backup §3 生效机制），t0 入 manifest；
// - 步骤 2：消费 T3 排空原语 waitForDrain（备份开始前 drain 完成断言）；超时默认
//   **中止本次备份并保持维护模式**（不半退出）；管理员显式继续 → manifest.drain
//   如实记 timeout（§5 异常态，由恢复对账处置）；
// - 步骤 7：关闭维护（端点）→ 健康检查通过 → 记「备份完成时间」指标与审计事件
//   （backup.completed 注册表 kind，运行态写入不入备份；指标面消费最新行）。
// 形态：真实应用（listen 127.0.0.1:0）+ HTTP 维护控制（生产脚本同一条缝）+
// 文件 SQLite + 真实 bare 仓库；排空在途写 = preRecordPendingPush（真实 hook 同 API）。

const run = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
};
async function git(args: string[], opts: { cwd?: string } = {}): Promise<string> {
  return (await run('git', args, { ...opts, env: GIT_ENV })).stdout;
}

interface Harness {
  app: FastifyInstance;
  db: DatabaseSync;
  dataDir: string;
  baseUrl: string;
  adminToken: string;
  readerToken: string;
  employeeId: number;
  vaultId: number;
  emptyVaultId: number;
  close(): Promise<void>;
}

async function startInstance(): Promise<Harness> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'notegit-s8t4-run-'));
  const dbFile = path.join(dataDir, 'db', 'notegit.sqlite');
  await mkdir(path.dirname(dbFile), { recursive: true });
  const db = openDatabase(dbFile);
  migrate(db, MIGRATIONS);
  for (const ddl of FIXTURE_DDL) db.exec(ddl);

  const admin = addEmployee(db, { username: 'root', is_instance_admin: 1 });
  const editor = addEmployee(db, { username: 'alice' });
  const vaultId = addVault(db, 'docs', editor);
  const emptyVaultId = addVault(db, 'empty', editor);
  await initBareVaultRepo(dataDir, vaultId);
  await initBareVaultRepo(dataDir, emptyVaultId);

  const seed = path.join(dataDir, 'seed');
  await git(['init', '-b', 'main', seed]);
  await writeFile(path.join(seed, 'README.md'), '# run\n');
  await git(['-C', seed, 'add', '.']);
  await git(['-C', seed, '-c', 'user.email=t@notegit.test', '-c', 'user.name=t', 'commit', '-m', 'seed']);
  await git(['-C', seed, 'push', vaultRepoPath(dataDir, vaultId), 'main']);

  const pepper = await loadOrCreatePepper(path.join(dataDir, 'keys', 'token-pepper.key'));
  const credentials = new CredentialsService({ db, pepper });
  const mkToken = (employeeId: number, name: string): string =>
    credentials.createCredential(employeeId, {
      name,
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    }).token;
  const adminToken = mkToken(admin, 'admin-carrier');
  const readerToken = mkToken(editor, 'reader-carrier');

  await mkdir(path.join(dataDir, 'config'), { recursive: true });
  await writeFile(path.join(dataDir, 'config', 'admin-bootstrap.token'), 'stub\n', { mode: 0o600 });

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
    baseUrl: `http://127.0.0.1:${port}`,
    adminToken,
    readerToken,
    employeeId: editor,
    vaultId,
    emptyVaultId,
    close: async () => {
      await app.close();
      db.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

let h: Harness;
let outRoot: string;

before(async () => {
  h = await startInstance();
  outRoot = await mkdtemp(path.join(tmpdir(), 'notegit-s8t4-runout-'));
});
after(async () => {
  await h.close();
  await rm(outRoot, { recursive: true, force: true });
});

function control(token: string = h.adminToken) {
  return httpMaintenanceControl({ baseUrl: h.baseUrl, token });
}

function runOpts(overrides: Partial<Parameters<typeof runBackup>[0]> = {}): Parameters<typeof runBackup>[0] {
  return {
    db: h.db,
    dataDir: h.dataDir,
    outRoot,
    control: control(),
    now: (() => {
      let seq = 0;
      const base = Date.parse('2026-10-14T08:00:00.000Z');
      return () => new Date(base + 1_000 * seq++);
    })(),
    drainTimeoutMs: 5_000,
    drainPollMs: 20,
    ...overrides,
  };
}

async function maintenanceFace(token: string = h.adminToken): Promise<{ enabled: boolean; drain: { pending: number } }> {
  const res = await fetch(`${h.baseUrl}/api/v1/admin/maintenance`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  return (await res.json()) as { enabled: boolean; drain: { pending: number } };
}

function freshOutRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'notegit-s8t4-runout-'));
}

test('全流程（§4 步骤 1→7）：HTTP 控制、排空、快照、关闸、健康检查、backup.completed 审计与指标接线', async () => {
  const out = await freshOutRoot();
  try {
    const result = await runBackup(runOpts({ outRoot: out }));

    // manifest：t0/完成时间与排空实况
    assert.match(result.manifest.time.maintenance_enabled_at, /^2026-10-14T08:00:00/);
    assert.equal(result.manifest.drain.outcome, 'drained');
    assert.ok(result.manifest.drain.waited_ms >= 0);
    assert.equal(result.manifest.vault_count, 2);

    // 步骤 7：维护已关（经运行实例端点核实——不是脚本侧的假闸门）
    const face = await maintenanceFace();
    assert.equal(face.enabled, false, '备份完成后维护模式已关闭');

    // 步骤 1/7 审计链：enable → backup.completed（运行态写入）
    const rows = h.db
      .prepare(
        `SELECT event_kind, status, detail FROM audit_events
         WHERE event_kind IN ('maintenance.enable','maintenance.disable','backup.completed')
         ORDER BY id`,
      )
      .all() as { event_kind: string; status: string; detail: string }[];
    const kinds = rows.map((r) => r.event_kind);
    assert.deepEqual(kinds, ['maintenance.enable', 'maintenance.disable', 'backup.completed']);
    const completed = rows.find((r) => r.event_kind === 'backup.completed')!;
    assert.equal(completed.status, 'succeeded');
    const detail = JSON.parse(completed.detail) as Record<string, unknown>;
    assert.equal(detail.vault_count, 2);
    assert.ok(typeof detail.data_item === 'string' && detail.data_item.length > 0);

    // 备份完成时间写 T2 预留字段（R14：指标面可查最新完成时间）
    const metricsRes = await fetch(`${h.baseUrl}/api/v1/admin/metrics`, {
      headers: { authorization: `Bearer ${h.adminToken}` },
    });
    assert.equal(metricsRes.status, 200);
    const metrics = (await metricsRes.json()) as { backup: { wired: boolean; last_completed_at: string | null } };
    assert.equal(metrics.backup.wired, true, 'T4 接线后 wired=true');
    assert.equal(metrics.backup.last_completed_at, completedOccurredAt(h.db), '指标面 = 最新 backup.completed 行');
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

function completedOccurredAt(db: DatabaseSync): string {
  return (
    db.prepare(
      `SELECT occurred_at FROM audit_events WHERE event_kind = 'backup.completed' AND status = 'succeeded' ORDER BY id DESC LIMIT 1`,
    ).get() as { occurred_at: string }
  ).occurred_at;
}

test('排空消费（步骤 2）：在途写存在 → 有界等待；清算后 drained，等待窗口如实入 manifest', async () => {
  const out = await freshOutRoot();
  const settleAt = 80;
  try {
    preRecordPendingPush(h.db, {
      subject: { employeeId: h.employeeId, carrierRef: 'credential:1', entry: 'git' },
      vaultId: h.vaultId,
      commands: [{ ref: 'refs/heads/br-wait', oldOid: '1'.repeat(40), newOid: '2'.repeat(40) }],
      pushId: 'push-s8t4-wait',
      occurredAt: new Date().toISOString(),
    });
    const timer = setTimeout(
      () => settlePushRejected(h.db, { pushId: 'push-s8t4-wait', reason: 'settled-before-snapshot' }),
      settleAt,
    );
    const result = await runBackup(runOpts({ outRoot: out, drainPollMs: 15 }));
    clearTimeout(timer);
    assert.equal(result.manifest.drain.outcome, 'drained');
    assert.ok(
      result.manifest.drain.waited_ms >= settleAt - 20,
      `排空等待窗口被如实观测（waited_ms=${result.manifest.drain.waited_ms}）`,
    );
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test('排空超时默认中止：pending 不清零 → 中止、维护模式保持开启（不半退出）、无产物遗留', async () => {
  const out = await freshOutRoot();
  try {
    preRecordPendingPush(h.db, {
      subject: { employeeId: h.employeeId, carrierRef: 'credential:1', entry: 'git' },
      vaultId: h.vaultId,
      commands: [{ ref: 'refs/heads/br-stuck', oldOid: '1'.repeat(40), newOid: '2'.repeat(40) }],
      pushId: 'push-s8t4-stuck',
      occurredAt: new Date().toISOString(),
    });
    try {
      await assert.rejects(
        () => runBackup(runOpts({ outRoot: out, drainTimeoutMs: 150, drainPollMs: 20 })),
        (err: Error) => /排空|中止/.test(err.message),
        '排空超时必须中止本次备份',
      );
    } finally {
      settlePushRejected(h.db, { pushId: 'push-s8t4-stuck', reason: 'cleanup-after-abort-test' });
    }
    assert.equal((await maintenanceFace()).enabled, true, '中止后维护模式保持开启（backup §4 步骤 2）');
    assert.deepEqual(await readdir(out), [], '中止不落产物');
    // 排空后重试 → 成功（中止无残留副作用）
    const result = await runBackup(runOpts({ outRoot: out, drainTimeoutMs: 2_000, drainPollMs: 20 }));
    assert.equal(result.manifest.drain.outcome, 'drained');
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test('管理员显式继续（异常态，backup §4 步骤 2/§5）：manifest.drain 如实记 timeout，审计可追', async () => {
  const out = await freshOutRoot();
  try {
    preRecordPendingPush(h.db, {
      subject: { employeeId: h.employeeId, carrierRef: 'credential:1', entry: 'git' },
      vaultId: h.vaultId,
      commands: [{ ref: 'refs/heads/br-force', oldOid: '1'.repeat(40), newOid: '2'.repeat(40) }],
      pushId: 'push-s8t4-force',
      occurredAt: new Date().toISOString(),
    });
    try {
      const result = await runBackup(
        runOpts({ outRoot: out, drainTimeoutMs: 120, drainPollMs: 15, forceAfterDrainTimeout: true }),
      );
      assert.equal(result.manifest.drain.outcome, 'timeout', '显式继续时 manifest 如实记录');
      assert.ok(result.manifest.drain.waited_ms >= 100);
      const detail = JSON.parse(
        (
          h.db
            .prepare(`SELECT detail FROM audit_events WHERE event_kind = 'backup.completed' ORDER BY id DESC LIMIT 1`)
            .get() as { detail: string }
        ).detail,
      ) as { drain_outcome: string };
      assert.equal(detail.drain_outcome, 'timeout', '异常态备份在审计行可追');
    } finally {
      settlePushRejected(h.db, { pushId: 'push-s8t4-force', reason: 'cleanup-after-force-test' });
    }
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test('非实例管理员：控制端 enable 被拒（403）→ 备份不开始、无产物、维护态未被脚本触碰', async () => {
  const out = await freshOutRoot();
  try {
    await assert.rejects(
      () => runBackup(runOpts({ outRoot: out, control: control(h.readerToken) })),
      (err: Error) => err instanceof BackupError && /403|E-AUTHZ/.test(err.message),
      '非管理员触发必须被端点拒绝并上抛',
    );
    assert.deepEqual(await readdir(out), [], '无产物');
    assert.equal((await maintenanceFace()).enabled, false, '维护态未被改动');
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test('httpMaintenanceControl：enable 幂等（已开启仍继续）、isEnabled 如实反映、disable 后 false', async () => {
  const c = control();
  try {
    await c.enable();
    assert.equal(await c.isEnabled(), true);
    await c.enable(); // 幂等：已开启不报错（POST 204 无迁移）
    assert.equal(await c.isEnabled(), true);
  } finally {
    await c.disable();
  }
  assert.equal(await c.isEnabled(), false);
  await c.healthCheck(); // /healthz 200
});
