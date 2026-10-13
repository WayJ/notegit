import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
import { preRecordPendingPush, settlePushByRefState, newPushId } from '../src/githttp/receive-audit.ts';
import { runBackupSnapshot } from '../src/backup/snapshot.ts';
import type { BackupManifest } from '../src/backup/manifest.ts';
import { verifyBackupSet } from '../src/backup/verify.ts';
import {
  restoreOffline,
  restoreReconcile,
  restoreFinalize,
  postLoadIntegrity,
  BackupError,
} from '../src/backup/restore.ts';
import { parseBackupArgs } from '../src/backup/cli.ts';

// S8-T5 全新环境恢复（backup-recovery §7 十步的离线/在线两相位 + §5 不变量核对）：
// - 离线相位（restoreOffline，§7 步骤 2–6）：恢复前先复用 T4 离线验证复算产物
//   （篡改必拒——负路径复用），版本兼容核对（降级必拒，D-BR-05），再按 §7 顺序
//   装载 config→keys（0600/0700 强制）→db→git，装载后逐文件复算完整性；
// - 对账相位（restoreReconcile，§7 步骤 7 的 S8-T5 落地面）：消费 S3-T6 消费接口
//   （listPendingReconciliation/auditChain）做只读核对——残留 pending/待核对行与
//   「审计成功但 ref 未更新」类半应用写必被点名（§5 不变量 1–2）；异常态的处置
//   （标终态）属 S8-T6 恢复对账任务，本模块报告并拒绝放行（衔接缝）；
// - finalize 相位（restoreFinalize，§7 步骤 7/9 的实例侧触发）：必须在维护模式内
//   执行（NOTEGIT_MAINTENANCE_ON_START=1 启动形态），经实例端点触发 S5-T5 全量
//   重建并等待完成；结构性不退出维护（§7 步骤 10 属 §8 清单全绿后的显式操作）。

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

const CURRENT_SCHEMA = Math.max(...MIGRATIONS.map((m) => m.version));

interface SourceFixture {
  db: DatabaseSync;
  dataDir: string;
  adminToken: string;
  vaultId: number;
  emptyVaultId: number;
  editorId: number;
  seedHead: string;
  close(): Promise<void>;
}

/** 源实例：真实迁移库 + 两库（一播种一空）+ 真实审计成链（pre-record → settle） */
async function makeSource(prefix: string): Promise<SourceFixture> {
  const dataDir = await mkdtemp(path.join(tmpdir(), `${prefix}-`));
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

  // 播种（两次推送 → 真实 old→new 链：unborn→c1→c2）
  const seed = path.join(dataDir, 'seed');
  await git(['init', '-b', 'main', seed]);
  const pushOne = async (file: string, body: string): Promise<string> => {
    await writeFile(path.join(seed, file), body);
    await git(['-C', seed, 'add', '.']);
    await git(['-C', seed, '-c', 'user.email=t@notegit.test', '-c', 'user.name=t', 'commit', '-m', `seed ${file}`]);
    await git(['-C', seed, 'push', vaultRepoPath(dataDir, vaultId), 'main']);
    return (await git(['--git-dir', vaultRepoPath(dataDir, vaultId), 'rev-parse', 'refs/heads/main'])).trim();
  };
  const ZERO = '0'.repeat(40);
  const c1 = await pushOne('a.md', '# a\n');
  const c2 = await pushOne('b.md', '# b\n');

  // 审计成链（receive hook 同 API：pre-record pending → post-receive 按 ref 实际值定终态）
  const recordChain = async (oldOid: string, newOid: string): Promise<void> => {
    const pushId = newPushId();
    preRecordPendingPush(db, {
      subject: { employeeId: editor, carrierRef: 'credential:1', entry: 'git' },
      vaultId,
      commands: [{ ref: 'refs/heads/main', oldOid, newOid }],
      pushId,
      occurredAt: new Date().toISOString(),
    });
    await settlePushByRefState(db, {
      pushId,
      actualOf: async (ref) =>
        (await git(['--git-dir', vaultRepoPath(dataDir, vaultId), 'rev-parse', ref])).trim() ?? null,
      detail: {},
    });
  };
  await recordChain(ZERO, c1);
  await recordChain(c1, c2);

  const pepper = await loadOrCreatePepper(path.join(dataDir, 'keys', 'token-pepper.key'));
  const credentials = new CredentialsService({ db, pepper });
  const adminToken = credentials.createCredential(admin, {
    name: 'restore-admin',
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
  }).token;

  await mkdir(path.join(dataDir, 'config'), { recursive: true });
  await writeFile(path.join(dataDir, 'config', 'admin-bootstrap.token'), 'consumed\n', { mode: 0o600 });

  return {
    db,
    dataDir,
    adminToken,
    vaultId,
    emptyVaultId,
    editorId: editor,
    seedHead: c2,
    close: async () => {
      db.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

async function backupOf(fx: SourceFixture, outRoot: string) {
  return runBackupSnapshot({
    db: fx.db,
    dataDir: fx.dataDir,
    outRoot,
    maintenanceEnabledAt: '2026-10-14T09:00:00.000Z',
    drain: { outcome: 'drained', waited_ms: 0 },
  });
}

let fx: SourceFixture;
let items: { dataItemDir: string; keysItemDir: string; manifest: BackupManifest };

before(async () => {
  fx = await makeSource('notegit-s8t5-src');
  const outRoot = await mkdtemp(path.join(tmpdir(), 'notegit-s8t5-items-'));
  const r = await backupOf(fx, outRoot);
  items = { dataItemDir: r.dataItemDir, keysItemDir: r.keysItemDir, manifest: r.manifest };
});
after(async () => {
  await fx.close();
  await rm(path.dirname(items.dataItemDir), { recursive: true, force: true });
});

function freshTarget(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'notegit-s8t5-target-'));
}

function expectStep(err: unknown, step: string): void {
  assert.ok(err instanceof BackupError, `应为 BackupError，得到 ${String(err)}`);
  assert.equal(err.step, step, `失败步骤应为 ${step}，实际 ${(err as BackupError).step}：${(err as Error).message}`);
}

// ───────────────────────── restoreOffline（§7 步骤 2–6） ─────────────────────────

test('绿路径：全新目标装载 config→keys→db→git；装载后逐项核对全过', async () => {
  const target = await freshTarget();
  try {
    const res = await restoreOffline({
      dataItemDir: items.dataItemDir,
      keysItemDir: items.keysItemDir,
      dataDir: target,
    });
    assert.equal(res.manifest.backup_id, items.manifest.backup_id);
    for (const c of res.checks) {
      assert.equal(c.ok, true, `核对项 ${c.name} 应通过：${c.detail ?? ''}`);
    }
    const names = res.checks.map((c) => c.name);
    for (const expected of [
      'pre-verify',
      'target-fresh',
      'version-compat',
      'config-restored',
      'keys-restored',
      'db-restored',
      'git-restored',
      'post-load-hashes',
      'post-load-head-oid',
      'post-load-db-integrity',
    ]) {
      assert.ok(names.includes(expected), `核对单应含 ${expected}（实际：${names.join(',')}）`);
    }

    // db：可开、完整性 ok、库行与 manifest 互证
    const db = openDatabase(path.join(target, 'db', 'notegit.sqlite'));
    try {
      const integrity = (db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
      assert.equal(integrity, 'ok');
      const rows = db.prepare('SELECT id, slug FROM vaults ORDER BY id').all() as { id: number; slug: string }[];
      assert.deepEqual(
        rows.map((r) => r.slug),
        items.manifest.vaults.map((v) => v.slug),
      );
    } finally {
      db.close();
    }
    // git：每库 HEAD == manifest（空库 unborn）
    const head = (
      await git(['--git-dir', path.join(target, 'git', `${fx.vaultId}.git`), 'rev-parse', 'refs/heads/main'])
    ).trim();
    assert.equal(head, items.manifest.vaults.find((v) => v.id === fx.vaultId)!.head_oid);
    // config：字节等
    const cfg = await readFile(path.join(target, 'config', 'admin-bootstrap.token'), 'utf8');
    assert.equal(cfg, 'consumed\n');
    // keys：0600/0700 强制（不信任来源权限）
    const keysDir = path.join(target, 'keys');
    assert.equal((await stat(keysDir)).mode & 0o777, 0o700, 'keys 目录应 0700');
    for (const f of ['token-pepper.key']) {
      assert.equal((await stat(path.join(keysDir, f))).mode & 0o777, 0o600, `${f} 应 0600`);
    }
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});

test('恢复前核验（T4 离线验证复用）：产物篡改 → 拒绝装载且目标不被触碰', async () => {
  const tamperedRoot = await mkdtemp(path.join(tmpdir(), 'notegit-s8t5-tamper-'));
  const target = await freshTarget();
  try {
    const dataItem = path.join(tamperedRoot, path.basename(items.dataItemDir));
    await cp(items.dataItemDir, dataItem, { recursive: true });
    await cp(items.keysItemDir, path.join(tamperedRoot, path.basename(items.keysItemDir)), { recursive: true });
    await writeFile(path.join(dataItem, 'config', 'admin-bootstrap.token'), 'tampered\n');

    await assert.rejects(
      restoreOffline({ dataItemDir: dataItem, keysItemDir: items.keysItemDir, dataDir: target }),
      (err: unknown) => {
        expectStep(err, 'pre-verify');
        return true;
      },
    );
    // 目标不被触碰：无 db 文件、无 git/config/keys 域
    const db = openDatabase;
    void db;
    const { readdir } = await import('node:fs/promises');
    const left = await readdir(target);
    assert.equal(left.length, 0, `目标应保持全新（实际：${left.join(',')}）`);
  } finally {
    await rm(tamperedRoot, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

test('密钥件缺位 → 拒绝（两件齐备是 §7 前置；缺件恢复 = token/会话全断）', async () => {
  const target = await freshTarget();
  try {
    const solo = await mkdtemp(path.join(tmpdir(), 'notegit-s8t5-solo-'));
    const dataItem = path.join(solo, path.basename(items.dataItemDir));
    await cp(items.dataItemDir, dataItem, { recursive: true });
    await assert.rejects(
      restoreOffline({ dataItemDir: dataItem, keysItemDir: path.join(solo, 'no-keys'), dataDir: target }),
      (err: unknown) => {
        expectStep(err, 'pre-verify');
        return true;
      },
    );
    await rm(solo, { recursive: true, force: true });
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});

test('目标非全新（已有 db）→ 拒绝且既有内容原样（恢复不得覆盖既有实例）', async () => {
  const target = await freshTarget();
  try {
    await mkdir(path.join(target, 'db'), { recursive: true });
    await writeFile(path.join(target, 'db', 'notegit.sqlite'), 'existing-instance');
    await assert.rejects(
      restoreOffline({ dataItemDir: items.dataItemDir, keysItemDir: items.keysItemDir, dataDir: target }),
      (err: unknown) => {
        expectStep(err, 'target-fresh');
        return true;
      },
    );
    assert.equal(await readFile(path.join(target, 'db', 'notegit.sqlite'), 'utf8'), 'existing-instance');
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});

test('版本兼容（§7 步骤 6）：manifest schema 版本高于当前 → 拒绝（不支持降级，D-BR-05）', async () => {
  const craftedRoot = await mkdtemp(path.join(tmpdir(), 'notegit-s8t5-compat-'));
  const target = await freshTarget();
  try {
    const dataItem = path.join(craftedRoot, path.basename(items.dataItemDir));
    await cp(items.dataItemDir, dataItem, { recursive: true });
    await cp(items.keysItemDir, path.join(craftedRoot, path.basename(items.keysItemDir)), { recursive: true });
    // schema 版本对齐当前（manifest.db.schema_version 不在文件哈希清单内——manifest
    // 自身不入清单，改写合法）；> 当前版本 → 降级场景必拒
    const manifestPath = path.join(dataItem, 'manifest.json');
    const crafted = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    (crafted.db as Record<string, unknown>).schema_version = CURRENT_SCHEMA + 3;
    await writeFile(manifestPath, JSON.stringify(crafted, null, 2));
    await assert.rejects(
      restoreOffline({ dataItemDir: dataItem, keysItemDir: items.keysItemDir, dataDir: target }),
      (err: unknown) => {
        expectStep(err, 'version-compat');
        assert.match((err as Error).message, /降级|schema/i);
        return true;
      },
    );
  } finally {
    await rm(craftedRoot, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

test('版本兼容：app 版本不同 → 放行并注记 §9 升级路径（数据面恢复不因 app 版本阻断）', async () => {
  const craftedRoot = await mkdtemp(path.join(tmpdir(), 'notegit-s8t5-appver-'));
  const target = await freshTarget();
  try {
    const dataItem = path.join(craftedRoot, path.basename(items.dataItemDir));
    await cp(items.dataItemDir, dataItem, { recursive: true });
    const manifestPath = path.join(dataItem, 'manifest.json');
    const crafted = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    crafted.app_version = '999.0.0';
    await writeFile(manifestPath, JSON.stringify(crafted, null, 2));
    const res = await restoreOffline({
      dataItemDir: dataItem,
      keysItemDir: items.keysItemDir,
      dataDir: target,
      appVersion: '0.0.0',
    });
    const compat = res.checks.find((c) => c.name === 'version-compat');
    assert.equal(compat?.ok, true);
    assert.match(compat?.detail ?? '', /999\.0\.0/);
  } finally {
    await rm(craftedRoot, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

test('装载后完整性复核可检目标侧损坏（postLoadIntegrity 独立面）', async () => {
  const target = await freshTarget();
  try {
    await restoreOffline({ dataItemDir: items.dataItemDir, keysItemDir: items.keysItemDir, dataDir: target });
    await writeFile(path.join(target, 'git', `${fx.vaultId}.git`, 'HEAD'), 'ref: refs/heads/other\n');
    const checks = await postLoadIntegrity(target, items.manifest);
    const hashes = checks.find((c) => c.name === 'post-load-hashes');
    assert.equal(hashes?.ok, false, '目标侧损坏必被复核算出');
    assert.match(hashes?.detail ?? '', /HEAD/);
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});

// ───────────────────── restoreReconcile（§7 步骤 7 只读对账） ─────────────────────

test('对账绿路径：无残留、成链一致（含空库 unborn 无审计行形态）', async () => {
  const r = await restoreReconcile(fx.db, path.join(fx.dataDir, 'git'));
  assert.equal(r.ok, true, `应全绿：residue=${JSON.stringify(r.residue)} diffs=${JSON.stringify(r.chainDiffs)}`);
  assert.equal(r.residue.length, 0);
  assert.equal(r.chainDiffs.length, 0);
  assert.ok(r.refsChecked >= 1, '至少核对了播种库的 ref');
});

test('对账点名残留 pending/待核对行（异常态交接 S8-T6 处置，恢复侧拒绝放行）', async () => {
  // 注入异常态：pre-record 后不 settle（模拟「备份横切在途写」/崩溃残留）
  const pushId = newPushId();
  const ids = preRecordPendingPush(fx.db, {
    subject: { employeeId: fx.editorId, carrierRef: 'credential:1', entry: 'git' },
    vaultId: fx.vaultId,
    commands: [{ ref: 'refs/heads/main', oldOid: fx.seedHead, newOid: 'f'.repeat(40) }],
    pushId,
    occurredAt: new Date().toISOString(),
  });
  try {
    const r = await restoreReconcile(fx.db, path.join(fx.dataDir, 'git'));
    assert.equal(r.ok, false, '存在残留行时对账不得放行');
    assert.equal(r.residue.length, ids.length);
    assert.equal(r.residue[0]?.status, 'pending');
  } finally {
    // 还原现场（标 rejected = 该命令实际未发生）
    const db = fx.db;
    db.prepare('UPDATE audit_events SET status = ? WHERE id = ?').run('rejected', ids[0]!);
  }
});

test('对账点名半应用写：ref 越过审计链（审计成功但 ref 更新 / ref 无成功记录）必败', async () => {
  // 直接推 bare（绕过 receive 管线 → 无审计行）：ref 前移，链尾落后 → 不变量 2 破
  const seed = path.join(fx.dataDir, 'seed');
  await writeFile(path.join(seed, 'c.md'), '# c\n');
  await git(['-C', seed, 'add', '.']);
  await git(['-C', seed, '-c', 'user.email=t@notegit.test', '-c', 'user.name=t', 'commit', '-m', 'orphan push']);
  await git(['-C', seed, 'push', vaultRepoPath(fx.dataDir, fx.vaultId), 'main']);
  try {
    const r = await restoreReconcile(fx.db, path.join(fx.dataDir, 'git'));
    assert.equal(r.ok, false, 'ref 越过审计链必须点名');
    assert.ok(r.chainDiffs.some((d) => d.includes('main')), `差异应点名 ref：${JSON.stringify(r.chainDiffs)}`);
  } finally {
    // 还原现场：回退到播种 HEAD（fixture 供后续测试继续消费）
    await git(['--git-dir', vaultRepoPath(fx.dataDir, fx.vaultId), 'update-ref', 'refs/heads/main', fx.seedHead]);
  }
});

// ───────────────── restoreFinalize（§7 步骤 7/9 实例侧触发相位） ─────────────────

test('finalize 全链：维护态启动 → 对账 → 触发 S5-T5 重建至完成；结构性不退出维护', async () => {
  const target = await freshTarget();
  let app: FastifyInstance | null = null;
  let db2: DatabaseSync | null = null;
  const prev = process.env.NOTEGIT_MAINTENANCE_ON_START;
  process.env.NOTEGIT_MAINTENANCE_ON_START = '1';
  try {
    await restoreOffline({ dataItemDir: items.dataItemDir, keysItemDir: items.keysItemDir, dataDir: target });
    const dbFile = path.join(target, 'db', 'notegit.sqlite');
    db2 = openDatabase(dbFile);
    const pepper = await loadOrCreatePepper(path.join(target, 'keys', 'token-pepper.key'));
    app = buildApp({
      db: db2,
      pepper,
      bootstrapTokenFile: path.join(target, 'config', 'admin-bootstrap.token'),
      dataDir: target,
      dbFile,
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const baseUrl = `http://127.0.0.1:${app.addresses()[0]!.port}`;

    const res = await restoreFinalize({ baseUrl, token: fx.adminToken, dataDir: target, pollMs: 100 });
    assert.equal(res.reconcile.ok, true, `恢复实例对账应全绿：${JSON.stringify(res.reconcile)}`);
    assert.equal(res.rebuild.state, 'completed', `重建应完成：${JSON.stringify(res.rebuild)}`);
    assert.ok(res.rebuild.total >= 2, `重建应覆盖全部库（含空库）：${JSON.stringify(res.rebuild)}`);

    // 结构性不退出维护（§7 步骤 10 属 §8 清单全绿后的显式操作）
    const face = await fetch(`${baseUrl}/api/v1/admin/maintenance`, {
      headers: { authorization: `Bearer ${fx.adminToken}` },
    });
    assert.equal((await face.json() as { enabled?: boolean }).enabled, true, 'finalize 后仍处维护态');
  } finally {
    if (prev === undefined) delete process.env.NOTEGIT_MAINTENANCE_ON_START;
    else process.env.NOTEGIT_MAINTENANCE_ON_START = prev;
    await app?.close();
    db2?.close();
    await rm(target, { recursive: true, force: true });
  }
});

test('finalize 拒绝非维护态执行（§7：恢复核对应在维护模式内完成）', async () => {
  const target = await freshTarget();
  let app: FastifyInstance | null = null;
  let db2: DatabaseSync | null = null;
  try {
    await restoreOffline({ dataItemDir: items.dataItemDir, keysItemDir: items.keysItemDir, dataDir: target });
    const dbFile = path.join(target, 'db', 'notegit.sqlite');
    db2 = openDatabase(dbFile);
    const pepper = await loadOrCreatePepper(path.join(target, 'keys', 'token-pepper.key'));
    app = buildApp({
      db: db2,
      pepper,
      bootstrapTokenFile: path.join(target, 'config', 'admin-bootstrap.token'),
      dataDir: target,
      dbFile,
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const baseUrl = `http://127.0.0.1:${app.addresses()[0]!.port}`;
    await assert.rejects(
      restoreFinalize({ baseUrl, token: fx.adminToken, dataDir: target }),
      (err: unknown) => {
        expectStep(err, 'maintenance');
        return true;
      },
    );
  } finally {
    await app?.close();
    db2?.close();
    await rm(target, { recursive: true, force: true });
  }
});

// ───────────────────────── CLI 参数面（restore / finalize） ─────────────────────────

test('CLI 解析：restore 必需参数与拒绝未知参数', () => {
  const a = parseBackupArgs([
    'restore', '--data-item', '/b/x-data', '--keys-item', '/k/x-keys', '--data-dir', '/data',
  ]);
  assert.equal(a.command, 'restore');
  assert.equal(a.dataItem, '/b/x-data');
  assert.equal(a.keysItem, '/k/x-keys');
  assert.equal(a.dataDir, '/data');
  assert.throws(() => parseBackupArgs(['restore', '--data-item', '/b/x-data', '--data-dir', '/data']), /keys-item/);
  assert.throws(() => parseBackupArgs(['restore', '--data-item', '/b/x-data', '--keys-item', '/k']), /data-dir/);
  assert.throws(() => parseBackupArgs(['restore', '--data-item', '/b/x-data', '--keys-item', '/k', '--data-dir', '/d', '--wat']), /未知参数/);
});

test('CLI 解析：finalize 必需参数与令牌卫生（不接受 argv 明文令牌）', () => {
  const prev = process.env.NOTEGIT_ADMIN_TOKEN;
  delete process.env.NOTEGIT_ADMIN_TOKEN;
  try {
    const a = parseBackupArgs([
      'finalize', '--data-dir', '/data', '--url', 'http://127.0.0.1:3000', '--token-file', '/run/secrets/t',
    ]);
    assert.equal(a.command, 'finalize');
    assert.equal(a.url, 'http://127.0.0.1:3000');
    assert.equal(a.tokenFile, '/run/secrets/t');
    assert.throws(() => parseBackupArgs(['finalize', '--data-dir', '/data', '--url', 'http://x']), /令牌/);
    assert.throws(() => parseBackupArgs(['finalize', '--url', 'http://x', '--token-file', '/t']), /data-dir/);
    assert.throws(() => parseBackupArgs(['finalize', '--data-dir', '/d', '--token-file', '/t']), /--url/);
  } finally {
    if (prev !== undefined) process.env.NOTEGIT_ADMIN_TOKEN = prev;
  }
});

// 演练脚注：verify 的幂等性已被 backup-verify.test.ts 覆盖；restoreOffline 的
// pre-verify 与之同一实现（本文件以篡改负路径复用断言——「恢复侧复用」的实证）。
