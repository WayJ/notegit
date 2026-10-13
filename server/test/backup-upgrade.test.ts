import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
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
import { httpMaintenanceControl } from '../src/backup/run.ts';
import { verifyBackupSet } from '../src/backup/verify.ts';
import { parseBackupArgs, main } from '../src/backup/cli.ts';
import { currentSchemaVersion } from '../src/backup/restore.ts';
import {
  preUpgradeBackup,
  enforcePreUpgradeBackupGate,
  verifyUpgradeMigration,
  UpgradeError,
} from '../src/backup/upgrade.ts';

// S8-T7 升级编排（backup-recovery §9 升级迁移与回退框架的应用侧落地面）：
// - preUpgradeBackup：§9 升级前一致备份——T4 全链（开闸→排空→快照）复用，但
//   **维护不关闭**（升级随后进入换镜像/启动迁移相位；关闸属升级末步的显式操作，
//   与 T4 备份完成即关闸的 §4 步骤 7 不同——§9 升级全程处于维护模式）；
// - enforcePreUpgradeBackupGate：D-BR-08「升级前备份强制、未完成不得升级」的
//   机器可断言面——跳过被拒、无证据被拒、证据不可信（离线验证复算）被拒；
// - verifyUpgradeMigration：§9「随新版本启动自动执行、有序、可重入」的启动后
//   核对面——schema_version 恰为 1..N 连续无缺（N = 当前迁移链终点）。
// 形态：真实应用（listen 127.0.0.1:0）+ HTTP 维护控制（生产脚本同一条缝）+
// 文件 SQLite + 真实 bare 仓库（backup-run.test.ts 同款 harness）。

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
  employeeId: number;
  vaultId: number;
  close(): Promise<void>;
}

async function startInstance(): Promise<Harness> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'notegit-s8t7-upg-'));
  const dbFile = path.join(dataDir, 'db', 'notegit.sqlite');
  await mkdir(path.dirname(dbFile), { recursive: true });
  const db = openDatabase(dbFile);
  migrate(db, MIGRATIONS);
  for (const ddl of FIXTURE_DDL) db.exec(ddl);

  const admin = addEmployee(db, { username: 'root', is_instance_admin: 1 });
  const editor = addEmployee(db, { username: 'alice' });
  const vaultId = addVault(db, 'docs', editor);
  await initBareVaultRepo(dataDir, vaultId);

  const seed = path.join(dataDir, 'seed');
  await git(['init', '-b', 'main', seed]);
  await writeFile(path.join(seed, 'README.md'), '# upgrade\n');
  await git(['-C', seed, 'add', '.']);
  await git(['-C', seed, '-c', 'user.email=t@notegit.test', '-c', 'user.name=t', 'commit', '-m', 'seed']);
  await git(['-C', seed, 'push', vaultRepoPath(dataDir, vaultId), 'main']);

  const pepper = await loadOrCreatePepper(path.join(dataDir, 'keys', 'token-pepper.key'));
  const credentials = new CredentialsService({ db, pepper });
  const adminToken = credentials
    .createCredential(admin, { name: 'upgrade-admin', expires_at: new Date(Date.now() + 3600_000).toISOString() })
    .token;

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
    employeeId: editor,
    vaultId,
    close: async () => {
      await app.close();
      db.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

let h: Harness;

before(async () => {
  h = await startInstance();
});
after(async () => {
  await h.close();
});

function control() {
  return httpMaintenanceControl({ baseUrl: h.baseUrl, token: h.adminToken });
}

async function maintenanceFace(): Promise<{ enabled: boolean }> {
  const res = await fetch(`${h.baseUrl}/api/v1/admin/maintenance`, {
    headers: { authorization: `Bearer ${h.adminToken}` },
  });
  assert.equal(res.status, 200);
  return (await res.json()) as { enabled: boolean };
}

// ─────────────────────── preUpgradeBackup（§9 升级前备份） ───────────────────────

test('升级前备份：成功后维护保持开启（§9 全程维护），审计链 enable→backup.completed（无 disable），产物可离线验证', async () => {
  const outRoot = await mkdtemp(path.join(tmpdir(), 'notegit-s8t7-keep-'));
  try {
    const result = await preUpgradeBackup({
      db: h.db,
      dataDir: h.dataDir,
      outRoot,
      control: control(),
      drainTimeoutMs: 5_000,
      drainPollMs: 20,
    });

    // §9：升级前备份完成 ≠ 退出维护——闸门保持开启（换镜像/迁移/冒烟仍在维护内）
    assert.equal((await maintenanceFace()).enabled, true, '升级前备份后维护模式必须保持开启');

    // 审计链：enable → backup.completed（升级语义注记）；不出现 maintenance.disable
    const rows = h.db
      .prepare(
        `SELECT event_kind, detail FROM audit_events
         WHERE event_kind IN ('maintenance.enable','maintenance.disable','backup.completed')
         ORDER BY id`,
      )
      .all() as { event_kind: string; detail: string }[];
    assert.deepEqual(rows.map((r) => r.event_kind), ['maintenance.enable', 'backup.completed']);
    const detail = JSON.parse(rows[1]!.detail) as Record<string, unknown>;
    assert.equal(detail.upgrade_pre_backup, true, '升级前备份的完成行带 upgrade 注记（回退丢弃口径可辨）');

    // 产物经 T4 离线验证全绿（gate 可消费）
    const v = await verifyBackupSet({ dataItemDir: result.dataItemDir, keysItemDir: result.keysItemDir });
    assert.equal(v.ok, true, `离线验证应全绿：${v.checks.filter((c) => !c.ok).map((c) => c.name).join(',')}`);
    assert.equal(result.manifest.vault_count, 1);
  } finally {
    await control().disable();
    await rm(outRoot, { recursive: true, force: true });
  }
});

test('升级前备份：实例已在维护态 → 开闸幂等继续；备份后仍保持维护', async () => {
  const outRoot = await mkdtemp(path.join(tmpdir(), 'notegit-s8t7-idem-'));
  try {
    await control().enable(); // 操作员先开闸（§9 步骤序：读说明→开维护→备份）
    const result = await preUpgradeBackup({
      db: h.db,
      dataDir: h.dataDir,
      outRoot,
      control: control(),
      drainTimeoutMs: 5_000,
      drainPollMs: 20,
    });
    assert.equal(result.manifest.drain.outcome, 'drained');
    assert.equal((await maintenanceFace()).enabled, true, '幂等开闸后备份完成，维护保持');
  } finally {
    await control().disable();
    await rm(outRoot, { recursive: true, force: true });
  }
});

test('升级前备份：排空超时 → 中止、维护保持、无产物（T4 同款保守姿态）', async () => {
  const { preRecordPendingPush, settlePushRejected } = await import('../src/githttp/receive-audit.ts');
  const outRoot = await mkdtemp(path.join(tmpdir(), 'notegit-s8t7-timeout-'));
  try {
    preRecordPendingPush(h.db, {
      subject: { employeeId: h.employeeId, carrierRef: 'credential:1', entry: 'git' },
      vaultId: h.vaultId,
      commands: [{ ref: 'refs/heads/br-stuck', oldOid: '1'.repeat(40), newOid: '2'.repeat(40) }],
      pushId: 'push-s8t7-stuck',
      occurredAt: new Date().toISOString(),
    });
    try {
      await assert.rejects(
        () =>
          preUpgradeBackup({
            db: h.db,
            dataDir: h.dataDir,
            outRoot,
            control: control(),
            drainTimeoutMs: 120,
            drainPollMs: 15,
          }),
        (err: Error) => err instanceof UpgradeError && /排空|中止/.test(err.message),
        '排空超时必须中止升级前备份',
      );
    } finally {
      settlePushRejected(h.db, { pushId: 'push-s8t7-stuck', reason: 'cleanup-after-upgrade-test' });
    }
    assert.equal((await maintenanceFace()).enabled, true, '中止后维护保持开启');
    const { readdir } = await import('node:fs/promises');
    assert.deepEqual(await readdir(outRoot), [], '中止不落产物');
  } finally {
    await control().disable();
    await rm(outRoot, { recursive: true, force: true });
  }
});

// ───────────────── enforcePreUpgradeBackupGate（D-BR-08 强制面） ─────────────────

test('gate：--skip 形态被拒（D-BR-08 升级前备份强制——跳过无门）', async () => {
  await assert.rejects(
    () => enforcePreUpgradeBackupGate({ skipBackup: true }),
    (err: Error) => err instanceof UpgradeError && err.stage === 'skip-pre-backup' && /D-BR-08|强制/.test(err.message),
  );
});

test('gate：无备份证据（未提供数据件）被拒；不存在路径被拒', async () => {
  await assert.rejects(
    () => enforcePreUpgradeBackupGate({}),
    (err: Error) => err instanceof UpgradeError && err.stage === 'missing-evidence',
  );
  await assert.rejects(
    () => enforcePreUpgradeBackupGate({ dataItemDir: '/nonexistent/notegit-item' }),
    (err: Error) => err instanceof UpgradeError,
  );
});

test('gate：证据不可信（产物被篡改 → T4 离线验证复算失败）被拒且目标不受伤', async () => {
  const outRoot = await mkdtemp(path.join(tmpdir(), 'notegit-s8t7-tamper-'));
  try {
    const result = await preUpgradeBackup({
      db: h.db,
      dataDir: h.dataDir,
      outRoot,
      control: control(),
      drainTimeoutMs: 5_000,
      drainPollMs: 20,
    });
    await appendFile(path.join(result.dataItemDir, 'db', 'notegit.sqlite'), 'tampered-by-upgrade-gate-test');
    await assert.rejects(
      () => enforcePreUpgradeBackupGate({ dataItemDir: result.dataItemDir }),
      (err: Error) => err instanceof UpgradeError && err.stage === 'evidence-invalid' && /恢复前|验证|不可信/.test(err.message),
    );
  } finally {
    await control().disable();
    await rm(outRoot, { recursive: true, force: true });
  }
});

test('gate：可信证据放行并返回 manifest；schema 高于当前镜像的备份被拒（回退失据——D-BR-05 方向核对）', async () => {
  const outRoot = await mkdtemp(path.join(tmpdir(), 'notegit-s8t7-good-'));
  try {
    const result = await preUpgradeBackup({
      db: h.db,
      dataDir: h.dataDir,
      outRoot,
      control: control(),
      drainTimeoutMs: 5_000,
      drainPollMs: 20,
    });
    const gate = await enforcePreUpgradeBackupGate({ dataItemDir: result.dataItemDir });
    assert.equal(gate.manifest.backup_id, result.manifest.backup_id);
    assert.equal(gate.manifest.vault_count, 1);

    // manifest 声称的 schema 高于当前镜像 → 该备份无法作为回退依据（当前二进制读不懂）
    const { readFile, writeFile } = await import('node:fs/promises');
    const manifestFile = path.join(result.dataItemDir, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as { db: { schema_version: number } };
    manifest.db.schema_version = currentSchemaVersion() + 1;
    await writeFile(manifestFile, JSON.stringify(manifest));
    await assert.rejects(
      () => enforcePreUpgradeBackupGate({ dataItemDir: result.dataItemDir }),
      (err: Error) => err instanceof UpgradeError && err.stage === 'evidence-invalid',
      '篡改 manifest（哈希复算失败）即拒——此处主要断言拒路径本身',
    );
  } finally {
    await control().disable();
    await rm(outRoot, { recursive: true, force: true });
  }
});

// ─────────────────── verifyUpgradeMigration（§9 启动后核对面） ───────────────────

test('迁移核对面：当前实例 schema_version 恰为 1..N 连续（N=迁移链终点），有序可重入形态成立', async () => {
  const state = await verifyUpgradeMigration(h.dataDir);
  assert.equal(state.currentVersion, currentSchemaVersion());
  assert.equal(state.maxApplied, currentSchemaVersion());
  assert.deepEqual(state.versions, Array.from({ length: currentSchemaVersion() }, (_, i) => i + 1));
  assert.ok(state.rows.every((r) => /^\d{4}-\d{2}-\d{2}T/.test(r.applied_at)), '每行带 applied_at');
});

test('迁移核对面：旧 schema 库（缺末版迁移）→ 点名缺版本，拒绝放行', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'notegit-s8t7-old-'));
  try {
    await mkdir(path.join(dir, 'db'), { recursive: true });
    const db = openDatabase(path.join(dir, 'db', 'notegit.sqlite'));
    migrate(db, MIGRATIONS.slice(0, -1)); // N-1：模拟旧版本实例的库
    db.close();
    await assert.rejects(
      () => verifyUpgradeMigration(dir),
      (err: Error) =>
        err instanceof UpgradeError && err.stage === 'migration-incomplete' && err.message.includes(String(currentSchemaVersion())),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('迁移核对面：schema_version 行有缺口（1,2,4 形态）→ 拒绝并点名缺口', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'notegit-s8t7-gap-'));
  try {
    await mkdir(path.join(dir, 'db'), { recursive: true });
    const db = openDatabase(path.join(dir, 'db', 'notegit.sqlite'));
    db.exec(
      `CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER NOT NULL PRIMARY KEY,
        applied_at TEXT NOT NULL,
        description TEXT NOT NULL
      ) STRICT`,
    );
    for (const v of [1, 2, 4]) {
      db.prepare('INSERT INTO schema_version (version, applied_at, description) VALUES (?, ?, ?)').run(
        v,
        new Date().toISOString(),
        `synthetic-${v}`,
      );
    }
    db.close();
    await assert.rejects(
      () => verifyUpgradeMigration(dir),
      (err: Error) => err instanceof UpgradeError && /3/.test(err.message) && /缺|缺口|missing/i.test(err.message),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ───────────────────────── CLI 面（upgrade 子命令） ─────────────────────────

test('CLI 解析：upgrade pre-backup 最小合法参数齐全（含默认排空/fsck）；未知相位拒绝', () => {
  const a = parseBackupArgs([
    'upgrade', 'pre-backup',
    '--data-dir', '/data',
    '--out', '/backup',
    '--url', 'http://127.0.0.1:3000',
    '--token-file', '/run/secrets/admin.token',
  ]);
  assert.equal(a.command, 'upgrade');
  assert.equal(a.phase, 'pre-backup');
  assert.equal(a.dataDir, '/data');
  assert.equal(a.out, '/backup');
  assert.equal(a.url, 'http://127.0.0.1:3000');
  assert.equal(a.drainTimeoutMs, 300_000);
  assert.deepEqual(a.fsck, { mode: 'sample', sampleSize: 3 });
  assert.throws(() => parseBackupArgs(['upgrade', 'frobnicate', '--data-dir', '/data']), /相位|phase|用法/i);
  assert.throws(() => parseBackupArgs(['upgrade']), /相位|phase|用法/i);
});

test('CLI 解析：upgrade gate——--data-item/--keys-item/--skip-pre-upgrade-backup；post 必填三件', () => {
  const g = parseBackupArgs(['upgrade', 'gate', '--data-item', '/bk/item-data', '--keys-item', '/bk/item-keys']);
  assert.equal(g.phase, 'gate');
  assert.equal(g.dataItem, '/bk/item-data');
  assert.equal(g.keysItem, '/bk/item-keys');
  assert.equal(g.skipPreBackup, false);
  const skip = parseBackupArgs(['upgrade', 'gate', '--skip-pre-upgrade-backup']);
  assert.equal(skip.skipPreBackup, true, '显式跳过形态可解析——执行面必须拒（D-BR-08 断言位）');
  const p = parseBackupArgs(['upgrade', 'post', '--data-dir', '/data', '--url', 'http://127.0.0.1:3000', '--token-file', '/f']);
  assert.equal(p.phase, 'post');
  assert.equal(p.dataDir, '/data');
  assert.throws(() => parseBackupArgs(['upgrade', 'post', '--data-dir', '/data']), /--url/);
  assert.throws(() => parseBackupArgs(['upgrade', 'pre-backup', '--data-dir', '/data']), /--out/);
});

test('CLI 执行：upgrade pre-backup 全链（维护保持开启、产物落盘、退出码 0）', async () => {
  const outRoot = await mkdtemp(path.join(tmpdir(), 'notegit-s8t7-cli-'));
  const tokenFile = path.join(outRoot, 'admin.token');
  await writeFile(tokenFile, `${h.adminToken}\n`, { mode: 0o600 });
  try {
    const code = await main([
      'upgrade', 'pre-backup',
      '--data-dir', h.dataDir,
      '--out', path.join(outRoot, 'items'),
      '--url', h.baseUrl,
      '--token-file', tokenFile,
      '--drain-timeout-ms', '5000',
    ]);
    assert.equal(code, 0, 'pre-backup 应退出 0');
    assert.equal((await maintenanceFace()).enabled, true, 'CLI 形态同样保持维护开启');
    const { readdir } = await import('node:fs/promises');
    const items = await readdir(path.join(outRoot, 'items'));
    assert.equal(items.length, 2, `两件分置，实际 ${items.join(',')}`);
  } finally {
    await control().disable();
    await rm(outRoot, { recursive: true, force: true });
  }
});

test('CLI 执行：upgrade gate——跳过被拒（退出码 1 + D-BR-08 文案）；无证据被拒；可信证据放行 0', async () => {
  const outRoot = await mkdtemp(path.join(tmpdir(), 'notegit-s8t7-gate-'));
  const tokenFile = path.join(outRoot, 'admin.token');
  await writeFile(tokenFile, `${h.adminToken}\n`, { mode: 0o600 });
  const errors: string[] = [];
  const origErr = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  };
  try {
    // 跳过被拒（D-BR-08——breakdown「跳过升级前备份被流程拒绝」断言位）
    const skipCode = await main(['upgrade', 'gate', '--skip-pre-upgrade-backup']);
    assert.equal(skipCode, 1, '跳过形态必须非零退出');
    assert.ok(errors.some((e) => /D-BR-08/.test(e)), `拒绝文案应点名 D-BR-08：${errors.join(' | ')}`);
    // 无证据被拒
    errors.length = 0;
    assert.equal(await main(['upgrade', 'gate']), 1);
    assert.ok(errors.some((e) => /--data-item|证据/.test(e)));
    // 可信证据放行
    const result = await preUpgradeBackup({
      db: h.db,
      dataDir: h.dataDir,
      outRoot,
      control: control(),
      drainTimeoutMs: 5_000,
      drainPollMs: 20,
    });
    errors.length = 0;
    assert.equal(await main(['upgrade', 'gate', '--data-item', result.dataItemDir]), 0);
  } finally {
    console.error = origErr;
    await control().disable();
    await rm(outRoot, { recursive: true, force: true });
  }
});

test('CLI 执行：upgrade post——维护内迁移核对通过 0；维护外（违序）拒绝非零', async () => {
  const outRoot = await mkdtemp(path.join(tmpdir(), 'notegit-s8t7-post-'));
  const tokenFile = path.join(outRoot, 'admin.token');
  await writeFile(tokenFile, `${h.adminToken}\n`, { mode: 0o600 });
  const errors: string[] = [];
  const origErr = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  };
  try {
    // 维护外执行 → 违序拒绝（§9 顺序：迁移/冒烟/对账都在维护内）
    await control().disable();
    assert.equal((await maintenanceFace()).enabled, false);
    const badCode = await main(['upgrade', 'post', '--data-dir', h.dataDir, '--url', h.baseUrl, '--token-file', tokenFile]);
    assert.notEqual(badCode, 0, '维护外执行 post 必须非零');
    assert.ok(errors.some((e) => /维护/.test(e)));
    // 维护内 → 迁移核对通过
    errors.length = 0;
    await control().enable();
    const code = await main(['upgrade', 'post', '--data-dir', h.dataDir, '--url', h.baseUrl, '--token-file', tokenFile]);
    assert.equal(code, 0, '维护内 + 迁移到位 → 0');
  } finally {
    console.error = origErr;
    await control().disable();
    await rm(outRoot, { recursive: true, force: true });
  }
});
