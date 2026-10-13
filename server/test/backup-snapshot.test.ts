import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync, type DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { openDatabase } from '../src/db/connection.ts';
import { migrate } from '../src/db/migrate.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { initBareVaultRepo } from '../src/gitrepo/lifecycle.ts';
import { vaultRepoPath } from '../src/vaults/repo-path.ts';
import { FIXTURE_DDL, addEmployee, addVault } from './credentials-fixtures.ts';
import { loadOrCreatePepper } from '../src/bootstrap/pepper.ts';
import {
  runBackupSnapshot,
  BACKUP_TOOL_VERSION,
  type BackupManifest,
} from '../src/backup/snapshot.ts';

// S8-T4 一致备份快照核（breakdown §2.7 S8-T4 行；backup-recovery §4 步骤 3–6）：
// - 步骤 3：VACUUM INTO 一致快照（单事务一致、不依赖停库——selection §4 实测语义）；
// - 步骤 4：/data/git 目录复制 + 复制件上抽样 git fsck（损坏 → 中止）；
// - 步骤 5：config 复制 + keys **分置两件**（独立顶层件目录，keys 文件 0600 / 件根 0700）；
// - 步骤 6：manifest 全字段（每库默认分支 HEAD OID、双版本 schema/引擎、t0 与完成
//   时间、维护时长、库数、各件字节数、备份工具版本 + 主机标识），逐项与实际一致。
// 形态：文件 SQLite + 真实 bare 仓库（标准 git 客户端播种）+ tmp dataDir。

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

async function sha256(file: string): Promise<string> {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function treeSize(root: string): Promise<number> {
  let total = 0;
  for (const e of await readdir(root, { withFileTypes: true })) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) total += await treeSize(p);
    else total += (await stat(p)).size;
  }
  return total;
}

interface Fixture {
  db: DatabaseSyncType;
  dataDir: string;
  vaultIds: [number, number];
  seedHead: string;
  close(): Promise<void>;
}

/** 一员工 + 两库（一库播种 1 commit、一库空库 unborn——manifest 两形态都要覆盖） */
async function makeFixture(prefix: string): Promise<Fixture> {
  const dataDir = await mkdtemp(path.join(tmpdir(), `${prefix}-`));
  const dbFile = path.join(dataDir, 'db', 'notegit.sqlite');
  await mkdir(path.dirname(dbFile), { recursive: true });
  const db = openDatabase(dbFile);
  migrate(db, MIGRATIONS);
  for (const ddl of FIXTURE_DDL) db.exec(ddl);

  const alice = addEmployee(db, { username: 'alice' });
  const v1 = addVault(db, 'docs', alice);
  const v2 = addVault(db, 'empty', alice);
  await initBareVaultRepo(dataDir, v1);
  await initBareVaultRepo(dataDir, v2);

  const seed = path.join(dataDir, 'seed');
  await git(['init', '-b', 'main', seed]);
  await writeFile(path.join(seed, 'README.md'), '# 备份演练\n');
  await git(['-C', seed, 'add', '.']);
  await git(['-C', seed, '-c', 'user.email=t@notegit.test', '-c', 'user.name=t', 'commit', '-m', 'seed']);
  await git(['-C', seed, 'push', vaultRepoPath(dataDir, v1), 'main']);
  const seedHead = (await git(['--git-dir', vaultRepoPath(dataDir, v1), 'rev-parse', 'refs/heads/main'])).trim();

  await loadOrCreatePepper(path.join(dataDir, 'keys', 'token-pepper.key'));
  await mkdir(path.join(dataDir, 'config'), { recursive: true });
  await writeFile(path.join(dataDir, 'config', 'admin-bootstrap.token'), 'one-time-token-stub\n', { mode: 0o600 });

  return {
    db,
    dataDir,
    vaultIds: [v1, v2],
    seedHead,
    close: async () => {
      db.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

/** 就绪的快照选项（每测试独立 outRoot） */
function snapshotOpts(fx: Fixture, outRoot: string) {
  return {
    db: fx.db,
    dataDir: fx.dataDir,
    outRoot,
    maintenanceEnabledAt: '2026-10-14T00:00:00.000Z',
    drain: { outcome: 'drained' as const, waited_ms: 7 },
    now: () => new Date('2026-10-14T00:05:00.000Z'),
    host: () => 'drill-host.test',
    appVersion: '0.0.0',
  };
}

let fx: Fixture;

before(async () => {
  fx = await makeFixture('notegit-s8t4-snap');
});
after(async () => {
  await fx.close();
});

test('步骤 3：VACUUM INTO 快照——独立 SQLite 文件、integrity_check ok、内容可读且与活库一致', async () => {
  const outRoot = await mkdtemp(path.join(tmpdir(), 'notegit-s8t4-out-'));
  try {
    const { dataItemDir } = await runBackupSnapshot(snapshotOpts(fx, outRoot));
    const snapFile = path.join(dataItemDir, 'db', 'notegit.sqlite');
    assert.ok(existsSync(snapFile), '快照库文件在 data 件内');
    const snap = new DatabaseSync(snapFile, { readOnly: true });
    const integrity = (snap.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
    assert.equal(integrity, 'ok', 'integrity_check ok');
    const vaults = snap.prepare('SELECT COUNT(*) AS n FROM vaults').get() as { n: number };
    assert.equal(vaults.n, 2, '快照内容与活库一致');
    snap.close();
  } finally {
    await rm(outRoot, { recursive: true, force: true });
  }
});

test('步骤 4：git 目录复制——两库目录原样在复制件内，已播种库对象文件存在', async () => {
  const outRoot = await mkdtemp(path.join(tmpdir(), 'notegit-s8t4-out-'));
  try {
    const { dataItemDir } = await runBackupSnapshot(snapshotOpts(fx, outRoot));
    for (const id of fx.vaultIds) {
      assert.ok(existsSync(path.join(dataItemDir, 'git', `${id}.git`, 'HEAD')), `库 ${id} 复制件 HEAD 在`);
    }
    const copiedHead = (
      await git(['--git-dir', path.join(dataItemDir, 'git', `${fx.vaultIds[0]}.git`), 'rev-parse', 'refs/heads/main'])
    ).trim();
    assert.equal(copiedHead, fx.seedHead, '复制件 ref 与活库一致');
    assert.ok(existsSync(path.join(dataItemDir, 'git', `${fx.vaultIds[0]}.git`, 'objects')), '对象目录在');
  } finally {
    await rm(outRoot, { recursive: true, force: true });
  }
});

test('步骤 4：抽样 fsck 记入 manifest（两库 ≤ 样本窗 → 全查）；损坏库 → 快照中止、两件目录清扫、维护不涉及', async () => {
  const outRoot = await mkdtemp(path.join(tmpdir(), 'notegit-s8t4-out-'));
  try {
    const { manifest } = await runBackupSnapshot(snapshotOpts(fx, outRoot));
    assert.deepEqual(
      [...manifest.fsck.checked].sort(),
      [...fx.vaultIds].sort(),
      '样本窗覆盖全部库',
    );
    assert.deepEqual(manifest.fsck.failures, []);
    assert.equal(manifest.fsck.mode, 'sample');
  } finally {
    await rm(outRoot, { recursive: true, force: true });
  }

  // 损坏路径（独立夹具，避免污染共享夹具的对象域）：向活库对象写入垃圾 →
  // 复制件 fsck 必败 → 中止 + 清扫
  const outBad = await mkdtemp(path.join(tmpdir(), 'notegit-s8t4-bad-'));
  const bad = await makeFixture('notegit-s8t4-corrupt');
  const looseDir = path.join(bad.dataDir, 'git', `${bad.vaultIds[0]}.git`, 'objects');
  const entries = (await readdir(looseDir, { withFileTypes: true })).filter((e) => e.isDirectory() && e.name.length === 2);
  const corrupted: string[] = [];
  for (const dir of entries) {
    for (const obj of await readdir(path.join(looseDir, dir.name))) {
      const target = path.join(looseDir, dir.name, obj);
      await chmod(target, 0o644); // 松对象默认 0444——先放开写位再破坏
      await writeFile(target, Buffer.from('corrupted-by-test'));
      corrupted.push(target);
    }
  }
  assert.ok(corrupted.length > 0, '前置：至少一个松对象被破坏');
  try {
    await assert.rejects(
      () => runBackupSnapshot(snapshotOpts(bad, outBad)),
      (err: Error) => /fsck/i.test(err.message),
      'fsck 失败必须中止快照',
    );
    const leftovers = (await readdir(outBad)).filter((n) => n.includes('-data') || n.includes('-keys'));
    assert.deepEqual(leftovers, [], '中止后不遗留半成品件目录');
  } finally {
    await bad.close();
    await rm(outBad, { recursive: true, force: true });
  }
});

test('步骤 5：分置两件——data 与 keys 是两个独立顶层件目录；keys 文件 0600、件根与 keys 目录 0700', async () => {
  const outRoot = await mkdtemp(path.join(tmpdir(), 'notegit-s8t4-out-'));
  try {
    const { dataItemDir, keysItemDir, manifest } = await runBackupSnapshot(snapshotOpts(fx, outRoot));
    assert.notEqual(path.resolve(dataItemDir), path.resolve(keysItemDir), '两件分置（不同目录）');
    assert.deepEqual(path.basename(dataItemDir), `${manifest.backup_id}-data`);
    assert.deepEqual(path.basename(keysItemDir), `${manifest.backup_id}-keys`);
    assert.ok(existsSync(path.join(keysItemDir, 'keys', 'token-pepper.key')), 'pepper 在密钥件内');

    const keyFileMode = (await stat(path.join(keysItemDir, 'keys', 'token-pepper.key'))).mode & 0o777;
    assert.equal(keyFileMode, 0o600, 'keys 文件 0600（backup §6）');
    const keysDirMode = (await stat(path.join(keysItemDir, 'keys'))).mode & 0o777;
    assert.equal(keysDirMode, 0o700, 'keys 目录 0700（deploy 布局同款）');
    const itemRootMode = (await stat(keysItemDir)).mode & 0o777;
    assert.equal(itemRootMode, 0o700, '密钥件根 0700');

    assert.ok(existsSync(path.join(dataItemDir, 'config', 'admin-bootstrap.token')), 'config 在数据件内');
    assert.ok(!existsSync(path.join(dataItemDir, 'keys')), '数据件内不得出现 keys（分置栅栏）');
    assert.ok(!existsSync(path.join(keysItemDir, 'db')), '密钥件内不得出现数据域');
  } finally {
    await rm(outRoot, { recursive: true, force: true });
  }
});

test('步骤 5：迁移窗口（pepper 轮换中）备份含 retired 条目（R12 前置）', async () => {
  const outRoot = await mkdtemp(path.join(tmpdir(), 'notegit-s8t4-out-'));
  try {
    // 模拟轮换后文件：active v2 + retired v1
    const pepperFile = path.join(fx.dataDir, 'keys', 'token-pepper.key');
    const rotated = {
      active: { version: 2, key: randomBytes(32).toString('hex') },
      retired: [{ version: 1, key: randomBytes(32).toString('hex') }],
    };
    await writeFile(pepperFile, JSON.stringify(rotated), { mode: 0o600 });
    const { keysItemDir } = await runBackupSnapshot(snapshotOpts(fx, outRoot));
    const copied = JSON.parse(await readFile(path.join(keysItemDir, 'keys', 'token-pepper.key'), 'utf8')) as {
      active: { version: number };
      retired: { version: number }[];
    };
    assert.equal(copied.active.version, 2);
    assert.deepEqual(
      copied.retired.map((r) => r.version),
      [1],
      '密钥件完整包含 retired 条目（identity §6.2 / backup §6）',
    );
  } finally {
    await rm(outRoot, { recursive: true, force: true });
  }
});

test('步骤 6：manifest 全字段逐项与实际一致（库数/每库 HEAD OID/双版本/时间/字节数/哈希/主机/工具版本）', async () => {
  const outRoot = await mkdtemp(path.join(tmpdir(), 'notegit-s8t4-out-'));
  try {
    const { manifest, dataItemDir, keysItemDir } = await runBackupSnapshot(snapshotOpts(fx, outRoot));

    // —— 库清单：数量、slug、默认分支、HEAD OID（逐库与复制件 rev-parse 对照）
    const expectedVaults = (
      fx.db.prepare('SELECT id, slug, default_branch FROM vaults ORDER BY id').all() as {
        id: number;
        slug: string;
        default_branch: string;
      }[]
    ).map((v) => v);
    assert.equal(manifest.vault_count, expectedVaults.length);
    assert.equal(manifest.vaults.length, expectedVaults.length);
    for (const [i, v] of expectedVaults.entries()) {
      const m = manifest.vaults[i]!;
      assert.equal(m.id, v.id);
      assert.equal(m.slug, v.slug);
      assert.equal(m.default_branch, v.default_branch);
      if (v.id === fx.vaultIds[0]) {
        const actual = (
          await git(['--git-dir', path.join(dataItemDir, 'git', `${v.id}.git`), 'rev-parse', 'refs/heads/main'])
        ).trim();
        assert.equal(m.head_oid, actual, '已播种库 HEAD OID = manifest 记录');
        assert.equal(m.head_oid, fx.seedHead);
      } else {
        assert.equal(m.head_oid, null, '空库 unborn → null');
      }
    }

    // —— 双版本：schema（活库 max(schema_version)）与引擎（sqlite_version()）
    const schemaVersion = Number(
      (fx.db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v,
    );
    const engineVersion = (fx.db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v;
    assert.equal(manifest.db.engine, 'sqlite');
    assert.equal(manifest.db.schema_version, schemaVersion, 'manifest schema 版本与库内一致');
    assert.equal(manifest.db.engine_version, engineVersion, 'manifest 引擎版本与库内一致');

    // —— 时间：t0 / 完成时间 / 维护时长（注入时钟下确定）
    assert.equal(manifest.time.maintenance_enabled_at, '2026-10-14T00:00:00.000Z');
    assert.equal(manifest.time.completed_at, '2026-10-14T00:05:00.000Z');
    assert.equal(manifest.time.maintenance_duration_ms, 300_000);

    // —— 各件字节数：data 件（除 manifest 外内容合计）与 keys 件逐域合计
    const gitBytes = await treeSize(path.join(dataItemDir, 'git'));
    const dbBytes = await treeSize(path.join(dataItemDir, 'db'));
    const configBytes = await treeSize(path.join(dataItemDir, 'config'));
    assert.equal(manifest.items.data.domains.git, gitBytes);
    assert.equal(manifest.items.data.domains.db, dbBytes);
    assert.equal(manifest.items.data.domains.config, configBytes);
    assert.equal(manifest.items.data.bytes, gitBytes + dbBytes + configBytes, 'data 件字节数 = 内容合计（manifest 自身不计）');
    assert.equal(manifest.items.keys.bytes, await treeSize(path.join(keysItemDir, 'keys')));
    assert.ok(manifest.items.data.files.length > 0);
    assert.equal(manifest.items.data.files.some((f) => f.path === 'manifest.json'), false, 'manifest 不自列');

    // —— 文件清单哈希逐个复算一致（两件全量）
    for (const entry of manifest.items.data.files) {
      const abs = path.join(dataItemDir, entry.path);
      assert.equal((await stat(abs)).size, entry.bytes, `${entry.path} 字节一致`);
      assert.equal(await sha256(abs), entry.sha256, `${entry.path} sha256 一致`);
    }
    for (const entry of manifest.items.keys.files) {
      const abs = path.join(keysItemDir, entry.path);
      assert.equal(await sha256(abs), entry.sha256, `${entry.path} sha256 一致`);
    }

    // —— 其余全字段
    assert.equal(manifest.app_version, '0.0.0');
    assert.equal(manifest.backup_tool_version, BACKUP_TOOL_VERSION);
    assert.equal(manifest.host, 'drill-host.test');
    assert.equal(manifest.drain.outcome, 'drained');
    assert.equal(manifest.drain.waited_ms, 7);
    assert.match(manifest.backup_id, /^\d{8}T\d{6}Z$/);
  } finally {
    await rm(outRoot, { recursive: true, force: true });
  }
});

test('缺省注入：app_version 取 server 包版本、host 取 os.hostname()（生产形态如实取值）', async () => {
  const outRoot = await mkdtemp(path.join(tmpdir(), 'notegit-s8t4-out-'));
  try {
    const opts = { ...snapshotOpts(fx, outRoot) } as Partial<ReturnType<typeof snapshotOpts>> & Record<string, unknown>;
    delete opts.appVersion;
    delete opts.host;
    const { manifest } = await runBackupSnapshot(
      opts as unknown as Parameters<typeof runBackupSnapshot>[0],
    );
    const pkg = JSON.parse(
      await readFile(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'),
    ) as { version: string };
    assert.equal(manifest.app_version, pkg.version);
    assert.equal(manifest.host, (await import('node:os')).hostname());
  } finally {
    await rm(outRoot, { recursive: true, force: true });
  }
});

test('拒绝覆盖：目标件目录已存在 → 报错不落任何产物（备份不可静默覆盖）', async () => {
  const outRoot = await mkdtemp(path.join(tmpdir(), 'notegit-s8t4-out-'));
  try {
    const first = await runBackupSnapshot(snapshotOpts(fx, outRoot));
    const stamp = path.basename(first.dataItemDir).replace(/-data$/, '');
    await assert.rejects(
      () => runBackupSnapshot({ ...snapshotOpts(fx, outRoot), now: () => new Date('2026-10-14T00:05:00.000Z') }),
      (err: Error) => /已存在|exists/i.test(err.message),
      '同 stamp 重跑必须拒绝',
    );
    assert.ok(existsSync(first.dataItemDir), '首份产物完好');
    assert.ok(stamp.length > 0);
  } finally {
    await rm(outRoot, { recursive: true, force: true });
  }
});

test('--keys-out：密钥件可直写另一根目录（分置介质形态）；manifest 如实记录件名', async () => {
  const outRoot = await mkdtemp(path.join(tmpdir(), 'notegit-s8t4-out-'));
  const keysOut = await mkdtemp(path.join(tmpdir(), 'notegit-s8t4-keys-'));
  try {
    const { dataItemDir, keysItemDir, manifest } = await runBackupSnapshot({
      ...snapshotOpts(fx, outRoot),
      keysOutRoot: keysOut,
    });
    assert.equal(path.dirname(keysItemDir), path.resolve(keysOut), '密钥件落在独立根');
    assert.equal(path.dirname(dataItemDir), path.resolve(outRoot));
    assert.equal(manifest.items.keys.dir_name, path.basename(keysItemDir));
  } finally {
    await rm(outRoot, { recursive: true, force: true });
    await rm(keysOut, { recursive: true, force: true });
  }
});

test('空实例（无库）备份：vault_count 0、fsck 空checked、两件与 manifest 仍齐备', async () => {
  const outRoot = await mkdtemp(path.join(tmpdir(), 'notegit-s8t4-out-'));
  let empty: Fixture | null = null;
  try {
    empty = await makeFixture('notegit-s8t4-empty');
    // 摘掉两库与播种痕迹 → 纯净空实例
    empty.db.exec('DELETE FROM vaults');
    for (const id of empty.vaultIds) {
      await rm(path.join(empty.dataDir, 'git', `${id}.git`), { recursive: true, force: true });
      await rm(path.join(empty.dataDir, 'seed'), { recursive: true, force: true });
    }
    const { manifest } = await runBackupSnapshot(snapshotOpts(empty, outRoot));
    assert.equal(manifest.vault_count, 0);
    assert.deepEqual(manifest.vaults, []);
    assert.deepEqual(manifest.fsck.checked, []);
  } finally {
    await empty?.close();
    await rm(outRoot, { recursive: true, force: true });
  }
});
