import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db/connection.ts';
import { migrate } from '../src/db/migrate.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { initBareVaultRepo } from '../src/gitrepo/lifecycle.ts';
import { vaultRepoPath } from '../src/vaults/repo-path.ts';
import { loadOrCreatePepper } from '../src/bootstrap/pepper.ts';
import { FIXTURE_DDL, addEmployee, addVault } from './credentials-fixtures.ts';
import { runBackupSnapshot } from '../src/backup/snapshot.ts';
import { verifyBackupSet, type BackupManifest } from '../src/backup/verify.ts';

// S8-T4 离线验证（backup §4 步骤 8：「manifest 在、件数齐、抽样哈希核对」；
// 契约校验命令随 T4 固化——§10 待定项收口）：
// - 不起服务：全部核对只落在备份产物（文件 + 快照库只读打开 + git 复制件）；
// - manifest 必填字段清单逐项在；两件齐备（数据件 + 密钥件，缺一即败）；
// - 文件清单逐个复算字节数与 SHA-256；HEAD OID 与复制件 rev-parse 互证；
//   快照库 integrity_check + 库行与 manifest 互证；可选 --fsck 全量复核复制件。
// 演练（D5）与恢复前置（T5 恢复前核验）消费同一命令。

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

async function backupFixture(fx: Fixture, outRoot: string, fsckMode: 'sample' | 'none' = 'sample') {
  return runBackupSnapshot({
    db: fx.db,
    dataDir: fx.dataDir,
    outRoot,
    maintenanceEnabledAt: '2026-10-14T09:00:00.000Z',
    drain: { outcome: 'drained', waited_ms: 0 },
    ...(fsckMode === 'none' ? { fsck: { mode: 'none' as const } } : {}),
  });
}

interface Fixture {
  db: DatabaseSync;
  dataDir: string;
  vaultIds: [number, number];
  seedHead: string;
  close(): Promise<void>;
}

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
  await writeFile(path.join(seed, 'README.md'), '# verify\n');
  await git(['-C', seed, 'add', '.']);
  await git(['-C', seed, '-c', 'user.email=t@notegit.test', '-c', 'user.name=t', 'commit', '-m', 'seed']);
  await git(['-C', seed, 'push', vaultRepoPath(dataDir, v1), 'main']);
  const seedHead = (await git(['--git-dir', vaultRepoPath(dataDir, v1), 'rev-parse', 'refs/heads/main'])).trim();

  await loadOrCreatePepper(path.join(dataDir, 'keys', 'token-pepper.key'));
  await mkdir(path.join(dataDir, 'config'), { recursive: true });
  await writeFile(path.join(dataDir, 'config', 'admin-bootstrap.token'), 'stub\n', { mode: 0o600 });

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

let fx: Fixture;
let set: { dataItemDir: string; keysItemDir: string; manifest: BackupManifest };
let outRoot: string;

before(async () => {
  fx = await makeFixture('notegit-s8t4-verify');
  outRoot = await mkdtemp(path.join(tmpdir(), 'notegit-s8t4-verifyout-'));
  const r = await backupFixture(fx, outRoot);
  set = { dataItemDir: r.dataItemDir, keysItemDir: r.keysItemDir, manifest: r.manifest };
});
after(async () => {
  await fx.close();
  await rm(outRoot, { recursive: true, force: true });
});

function checkOk(res: { checks: readonly { name: string; ok: boolean; detail?: string }[] }, name: string): void {
  const c = res.checks.find((x) => x.name === name);
  assert.ok(c !== undefined, `应有「${name}」核对项`);
  assert.equal(c.ok, true, `「${name}」应通过：${c.detail ?? ''}`);
}

test('绿路径：完整备份集全项通过（manifest/件数/哈希/HEAD 互证/快照库完整性/权限）', async () => {
  const res = await verifyBackupSet({ dataItemDir: set.dataItemDir });
  assert.equal(res.ok, true, `应全绿：${JSON.stringify(res.checks.filter((c) => !c.ok))}`);
  for (const name of [
    'manifest-present',
    'manifest-fields',
    'items-present',
    'key-item-perms',
    'file-count',
    'file-hashes',
    'item-bytes',
    'db-integrity',
    'vault-match',
    'head-oid',
  ]) {
    checkOk(res, name);
  }
});

test('manifest 缺失 → 失败（「manifest 在」是第一核对项）', async () => {
  const bare = await mkdtemp(path.join(tmpdir(), 'notegit-s8t4-nomanifest-'));
  try {
    const res = await verifyBackupSet({ dataItemDir: bare });
    assert.equal(res.ok, false);
    const present = res.checks.find((c) => c.name === 'manifest-present');
    assert.equal(present?.ok, false, '无 manifest 必败');
  } finally {
    await rm(bare, { recursive: true, force: true });
  }
});

test('哈希核对：篡改任一内容文件字节 → file-hashes 失败且点名文件', async () => {
  const out = await mkdtemp(path.join(tmpdir(), 'notegit-s8t4-tamper-'));
  try {
    const r = await backupFixture(fx, out);
    await writeFile(path.join(r.dataItemDir, 'config', 'admin-bootstrap.token'), 'tampered\n');
    const res = await verifyBackupSet({ dataItemDir: r.dataItemDir });
    assert.equal(res.ok, false);
    const hashes = res.checks.find((c) => c.name === 'file-hashes');
    assert.equal(hashes?.ok, false, '复算哈希不一致必败');
    assert.match(hashes?.detail ?? '', /admin-bootstrap\.token/);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test('件数齐：密钥件缺位 → 失败；keysItemDir 显式路径支持跨介质核对', async () => {
  // 数据件单独存放（模拟分置后密钥件不在同级）：拷贝数据件到隔离目录
  const solo = await mkdtemp(path.join(tmpdir(), 'notegit-s8t4-solo-'));
  try {
    const soloData = path.join(solo, path.basename(set.dataItemDir));
    await cp(set.dataItemDir, soloData, { recursive: true });
    const res = await verifyBackupSet({ dataItemDir: soloData });
    assert.equal(res.ok, false);
    const items = res.checks.find((c) => c.name === 'items-present');
    assert.equal(items?.ok, false, '密钥件缺位必败（件数齐）');
    assert.match(items?.detail ?? '', /keys/);

    // 显式传入真实位置（分置介质形态）→ 过
    const okRes = await verifyBackupSet({ dataItemDir: soloData, keysItemDir: set.keysItemDir });
    assert.equal(okRes.ok, true, `显式密钥件路径应过：${JSON.stringify(okRes.checks.filter((c) => !c.ok))}`);
  } finally {
    await rm(solo, { recursive: true, force: true });
  }
});

test('HEAD OID 互证：manifest 记录与复制件实际 ref 不符 → 失败（含 unborn 形态核对）', async () => {
  const out = await mkdtemp(path.join(tmpdir(), 'notegit-s8t4-head-'));
  try {
    const r = await backupFixture(fx, out);
    const manifestPath = path.join(r.dataItemDir, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as BackupManifest;
    const seeded = manifest.vaults.find((v) => v.id === fx.vaultIds[0])!;
    assert.ok(seeded.head_oid && /^[0-9a-f]{40}$/.test(seeded.head_oid), '前置：已播种库记录了 HEAD OID');
    const unborn = manifest.vaults.find((v) => v.id === fx.vaultIds[1])!;
    assert.equal(unborn.head_oid, null, '前置：空库 unborn 记 null');
    const mutated = {
      ...manifest,
      vaults: manifest.vaults.map((v) => (v.id === seeded.id ? { ...v, head_oid: 'f'.repeat(40) } : v)),
    };
    await writeFile(manifestPath, JSON.stringify(mutated, null, 2));
    const res = await verifyBackupSet({ dataItemDir: r.dataItemDir });
    assert.equal(res.ok, false);
    const heads = res.checks.find((c) => c.name === 'head-oid');
    assert.equal(heads?.ok, false, 'HEAD 互证不一致必败');
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test('快照库核对：库行（库数/slug/默认分支）与 manifest 互证失败可检', async () => {
  const out = await mkdtemp(path.join(tmpdir(), 'notegit-s8t4-db-'));
  try {
    const r = await backupFixture(fx, out);
    const manifestPath = path.join(r.dataItemDir, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as BackupManifest;
    const mutated = {
      ...manifest,
      vault_count: manifest.vault_count + 1,
      vaults: [...manifest.vaults, { id: 999, slug: 'ghost', default_branch: 'main', head_oid: null }],
    };
    await writeFile(manifestPath, JSON.stringify(mutated, null, 2));
    const res = await verifyBackupSet({ dataItemDir: r.dataItemDir });
    assert.equal(res.ok, false);
    const match = res.checks.find((c) => c.name === 'vault-match');
    assert.equal(match?.ok, false, '库行互证不一致必败');
    assert.ok(
      (match?.detail ?? '').includes('999') || (match?.detail ?? '').includes('ghost'),
      `互证失败应点名差异：${match?.detail}`,
    );
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test('--fsck 全量复核复制件：损坏的复制件库 → git-fsck 核对失败', async () => {
  const out = await mkdtemp(path.join(tmpdir(), 'notegit-s8t4-vfsck-'));
  try {
    const r = await backupFixture(fx, out, 'none'); // 快照时不查——离线验证时查（职责分离形态）
    const looseDir = path.join(r.dataItemDir, 'git', `${fx.vaultIds[0]}.git`, 'objects');
    const dirs = (await readdir(looseDir, { withFileTypes: true })).filter(
      (e) => e.isDirectory() && e.name.length === 2,
    );
    const first = dirs[0]!;
    const obj = (await readdir(path.join(looseDir, first.name)))[0]!;
    const target = path.join(looseDir, first.name, obj);
    await chmod(target, 0o644);
    await writeFile(target, Buffer.from('offline-corruption'));
    const res = await verifyBackupSet({ dataItemDir: r.dataItemDir, fsck: true });
    assert.equal(res.ok, false);
    const fsck = res.checks.find((c) => c.name === 'git-fsck');
    assert.equal(fsck?.ok, false, '复制件损坏必被离线 fsck 捕获');
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test('verify 幂等无副作用、不触服务（本文件 harness 从未 listen——全部调用即离线形态）', async () => {
  const a = await verifyBackupSet({ dataItemDir: set.dataItemDir, keysItemDir: set.keysItemDir });
  const b = await verifyBackupSet({ dataItemDir: set.dataItemDir, keysItemDir: set.keysItemDir });
  assert.equal(a.ok, true);
  assert.deepEqual(
    a.checks.map((c) => [c.name, c.ok]),
    b.checks.map((c) => [c.name, c.ok]),
    'verify 幂等无副作用',
  );
});
