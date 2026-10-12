import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../src/app.ts';
import { createSession, DEFAULT_SESSION_TIMEOUTS } from '../src/auth/sessions.ts';
import { ApiError } from '../src/credentials/service.ts';
import { VaultService } from '../src/vaults/service.ts';
import {
  createVaultRepoOps,
  initBareVaultRepo,
  listVaultRepoIds,
  reconcileOrphanRepos,
  removeVaultRepo,
  verifyVaultStoreConsistency,
} from '../src/gitrepo/lifecycle.ts';
import { parseVaultRepoDirName, vaultRepoPath } from '../src/vaults/repo-path.ts';
import { addEmployee, newDb } from './credentials-fixtures.ts';

const run = promisify(execFile);

// S3-T1 bare 仓库生命周期（implementation-breakdown §2.2 任务行；架构 §3.2/§9；
// backup-recovery §5 不变量 3）：建库 = `git init --bare` 于 DB 稳定 ID 映射路径
// （vaultRepoPath，不拼接用户输入），HEAD 指向 main、新库空初始化；删除 = 目录与
// 映射行同灭。路径测试全部用 tmp 数据目录；标准 Git 客户端行为（clone/首推）用
// 真实 git 经 file 传输验证（HTTP 接入是 S3-T2 的范围）。

test('initBareVaultRepo：映射路径建成 bare 仓库、HEAD 指向 main、无任何分支（新库空初始化）', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'notegit-gitrepo-'));
  try {
    await initBareVaultRepo(dataDir, 42);
    const repo = vaultRepoPath(dataDir, 42);
    assert.ok(existsSync(path.join(repo, 'HEAD')), 'bare 仓库 HEAD 存在');
    assert.equal(await readFile(path.join(repo, 'HEAD'), 'utf8'), 'ref: refs/heads/main\n');
    // bare 形态：refs/ + config 在库根（无 .git 子目录、无工作区文件）
    assert.ok(existsSync(path.join(repo, 'refs')), 'refs/ 存在于库根');
    assert.ok(existsSync(path.join(repo, 'config')), 'config 存在于库根');
    assert.ok(!existsSync(path.join(repo, '.git')), '库根下无 .git（bare 形态）');
    // 空初始化：refs/heads 下无文件（未出生任何分支）
    const heads = await readdir(path.join(repo, 'refs', 'heads'));
    assert.deepEqual(heads, []);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('initBareVaultRepo：注入形态的 id 一律拒绝且不产生任何目录', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'notegit-gitrepo-'));
  try {
    const evil = [
      0,
      -1,
      1.5,
      NaN,
      Infinity,
      2 ** 53,
      '7',
      '7/../../etc',
      '../evil',
      '../../etc/passwd',
      null,
      undefined,
      {},
      true,
    ];
    for (const bad of evil) {
      await assert.rejects(
        () => initBareVaultRepo(dataDir, bad as unknown as number),
        RangeError,
        `id=${String(bad)} 应被拒绝`,
      );
    }
    // 全部拒绝后：数据目录下不应有任何创建（含 git/ 本身）
    assert.ok(!existsSync(path.join(dataDir, 'git')), '注入尝试不应创建 git/ 目录');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('removeVaultRepo：删除映射目录；目录不存在时幂等成功；注入 id 同防线', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'notegit-gitrepo-'));
  try {
    await initBareVaultRepo(dataDir, 7);
    assert.ok(existsSync(vaultRepoPath(dataDir, 7)));
    await removeVaultRepo(dataDir, 7);
    assert.ok(!existsSync(vaultRepoPath(dataDir, 7)), '删除后目录消失');
    await removeVaultRepo(dataDir, 7); // 幂等：不存在的目录不报错
    await assert.rejects(() => removeVaultRepo(dataDir, '../evil' as unknown as number), RangeError);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

// ── 一致性核对与孤儿处置（backup-recovery §5 不变量 3）──────────────────────
// 无孤儿仓库（目录必有 DB 行）、无孤儿配置行（行必有目录）。目录侧孤儿可安全
// 清除（无行引用它）；行侧缺失只报告不发明（自动重建空库会静默丢内容——须人工裁决）。

test('verifyVaultStoreConsistency：双向报告孤儿目录与缺失目录；一致时两者皆空', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'notegit-gitrepo-'));
  try {
    await initBareVaultRepo(dataDir, 1);
    await initBareVaultRepo(dataDir, 2);
    await initBareVaultRepo(dataDir, 999); // 目录侧孤儿（DB 无行 999）
    const report = verifyVaultStoreConsistency(dataDir, [1, 2, 5]); // 行 5 无目录
    assert.deepEqual(report.orphanRepoIds, [999]);
    assert.deepEqual(report.missingRepoIds, [5]);
    assert.deepEqual(verifyVaultStoreConsistency(dataDir, [1, 2, 999]), {
      orphanRepoIds: [],
      missingRepoIds: [],
    });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('listVaultRepoIds：仅收录 <id>.git 形态的目录，忽略其余名字', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'notegit-gitrepo-'));
  try {
    await initBareVaultRepo(dataDir, 3);
    await mkdir(path.join(dataDir, 'git', 'not-a-repo.txt'), { recursive: true }); // 非 <id>.git
    assert.deepEqual(listVaultRepoIds(dataDir), [3]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

// ── 命名约定反向解析（磁盘命名约定唯一来源 repo-path.ts 的逆函数）──────────────

test('parseVaultRepoDirName：`<id>.git` → id；其余名字一律 undefined', () => {
  assert.equal(parseVaultRepoDirName('42.git'), 42);
  assert.equal(parseVaultRepoDirName('0.git'), undefined); // 0 不是合法 vault id
  assert.equal(parseVaultRepoDirName('-1.git'), undefined);
  assert.equal(parseVaultRepoDirName('x.git'), undefined);
  assert.equal(parseVaultRepoDirName('..git'), undefined);
  assert.equal(parseVaultRepoDirName('42.GIT'), undefined); // 大写不认
  assert.equal(parseVaultRepoDirName('42.git2'), undefined);
  assert.equal(parseVaultRepoDirName('42'), undefined);
  assert.equal(parseVaultRepoDirName('a/../..git'), undefined);
  assert.equal(parseVaultRepoDirName('9007199254740992.git'), undefined); // 超 MAX_SAFE_INTEGER
});

test('reconcileOrphanRepos：清除目录侧孤儿（无行引用）并报告；缺失目录只报告不动手', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'notegit-gitrepo-'));
  try {
    await initBareVaultRepo(dataDir, 8);
    await initBareVaultRepo(dataDir, 404); // 孤儿目录
    const result = await reconcileOrphanRepos(dataDir, [8, 50]); // 50 = 行在目录缺
    assert.deepEqual(result.removedOrphanRepoIds, [404]);
    assert.deepEqual(result.missingRepoIds, [50]);
    assert.ok(!existsSync(vaultRepoPath(dataDir, 404)), '孤儿目录被清除');
    assert.ok(existsSync(vaultRepoPath(dataDir, 8)), '有行目录保留');
    assert.ok(!existsSync(vaultRepoPath(dataDir, 50)), '缺失目录不被发明');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

// ── 建库端点挂接（S3-T1：POST /api/v1/vaults 建库即真实 init bare）────────────

interface Harness {
  app: ReturnType<typeof buildApp>;
  db: DatabaseSync;
  dataDir: string;
  sid: string;
  close(): Promise<void>;
}

/** 带 tmp 数据目录的应用夹具：dataDir 注入后建库路径真实 init bare */
async function harness(withDataDir: boolean): Promise<Harness> {
  const db = newDb();
  const pepper = { active: { version: 1, key: randomBytes(32) }, retired: [] as never[] };
  const dataDir = await mkdtemp(path.join(tmpdir(), 'notegit-gitrepo-app-'));
  const now = new Date();
  const employeeId = addEmployee(db, { username: 'creator' });
  const sid = createSession(db, employeeId, pepper.active.key, now, DEFAULT_SESSION_TIMEOUTS).sid;
  const app = buildApp({
    db,
    pepper,
    bootstrapTokenFile: path.join(dataDir, 'admin-bootstrap.token'),
    ...(withDataDir ? { dataDir } : {}),
  });
  return {
    app,
    db,
    dataDir,
    sid,
    close: async () => {
      await app.close();
      db.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

async function createVault(h: Harness, slug: string): Promise<{ id: number }> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/v1/vaults',
    headers: { cookie: `ngt_sid=${h.sid}`, origin: 'http://localhost' },
    payload: { name: 'Vault', slug },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json() as { id: number };
}

test('建库端点（dataDir 注入）：201 即真实建成 bare 仓库，目录与 DB 行一致', async () => {
  const h = await harness(true);
  try {
    const { id } = await createVault(h, 'docs');
    const repo = vaultRepoPath(h.dataDir, id);
    assert.ok(existsSync(path.join(repo, 'HEAD')), '建库响应后映射目录已是 bare 仓库');
    assert.equal(await readFile(path.join(repo, 'HEAD'), 'utf8'), 'ref: refs/heads/main\n');
    // 目录与 DB 行双向一致（backup §5 不变量 3）
    const rowIds = (h.db.prepare('SELECT id FROM vaults').all() as { id: number }[]).map((r) => r.id);
    assert.deepEqual(verifyVaultStoreConsistency(h.dataDir, rowIds), { orphanRepoIds: [], missingRepoIds: [] });
  } finally {
    await h.close();
  }
});

test('建库端点：标准 Git 客户端可 clone 空 main 并首推（完成标准第一条）', async () => {
  const h = await harness(true);
  try {
    const { id } = await createVault(h, 'gitloop');
    const repo = vaultRepoPath(h.dataDir, id);
    const work = path.join(h.dataDir, 'work'); // clone 目标（测试 tmp 内）
    // 1. clone 空库：退出 0；克隆 HEAD 对称引用 = main（继承 bare 库 HEAD）
    await run('git', ['clone', repo, work]);
    assert.equal((await run('git', ['-C', work, 'symbolic-ref', 'HEAD'])).stdout.trim(), 'refs/heads/main');
    // 2. 提交一个文件后首推：file 传输直推 bare 库
    await writeFile(path.join(work, 'note.md'), '# hello\n');
    await run('git', ['-C', work, 'add', 'note.md']);
    await run('git', ['-C', work, '-c', 'user.email=creator@notegit.test', '-c', 'user.name=creator', 'commit', '-m', 'init']);
    await run('git', ['-C', work, 'push', 'origin', 'main']);
    // 3. bare 库 refs/heads/main 出生且与客户端 HEAD 同 OID
    const pushed = (await readFile(path.join(repo, 'refs', 'heads', 'main'), 'utf8')).trim();
    const local = (await run('git', ['-C', work, 'rev-parse', 'HEAD'])).stdout.trim();
    assert.equal(pushed, local);
  } finally {
    await h.close();
  }
});

test('建库补偿：bare init 失败时回滚全部行（无孤儿配置行）并放大错误', async () => {
  const db = newDb();
  const employeeId = addEmployee(db, { username: 'creator' });
  const boom = {
    initBare: async () => {
      throw new Error('git not available (simulated)');
    },
    remove: async () => {},
  };
  const svc = new VaultService({ db, repoOps: boom });
  const actor = { employeeId, entry: 'web' as const, carrierRef: 'session:fixture' };
  await assert.rejects(
    () => svc.createVaultWithRepo({ name: 'X', slug: 'boom' }, actor),
    /git not available/,
  );
  // 三张表全部回净：无孤儿配置行（vaults/vault_members/audit_events）
  for (const table of ['vaults', 'vault_members', 'audit_events']) {
    const count = (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
    assert.equal(count, 0, `${table} 应无残留行`);
  }
  db.close();
});

test('建库补偿：init 半途失败留下残目录时，补偿一并清除（无孤儿仓库）', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'notegit-gitrepo-'));
  const db = newDb();
  try {
    const employeeId = addEmployee(db, { username: 'creator' });
    const actor = { employeeId, entry: 'web' as const, carrierRef: 'session:fixture' };
    // 模拟 git 起了但失败：目录已建、init 未完成
    const halfBroken = {
      initBare: async (vaultId: number) => {
        await mkdir(vaultRepoPath(dataDir, vaultId), { recursive: true });
        throw new Error('git init died (simulated)');
      },
      remove: (vaultId: number) => removeVaultRepo(dataDir, vaultId),
    };
    const svc = new VaultService({ db, repoOps: halfBroken });
    await assert.rejects(() => svc.createVaultWithRepo({ name: 'X', slug: 'half' }, actor), /git init died/);
    // 行与目录双侧回净：backup §5 不变量 3 两方向都不留孤儿
    assert.equal((db.prepare(`SELECT COUNT(*) AS c FROM vaults`).get() as { c: number }).c, 0);
    assert.deepEqual(listVaultRepoIds(dataDir), []);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    db.close();
  }
});

test('建库端点（未注入 dataDir）：保持 S2 形态（仅建行不建目录），不触碰文件系统', async () => {
  const h = await harness(false);
  try {
    const { id } = await createVault(h, 'legacy');
    const rowIds = (h.db.prepare('SELECT id FROM vaults').all() as { id: number }[]).map((r) => r.id);
    // 无目录生成：行表现为「缺失目录」而非错误（核对视角可观测）
    assert.deepEqual(verifyVaultStoreConsistency(h.dataDir, rowIds).missingRepoIds, [id]);
  } finally {
    await h.close();
  }
});

// ── 删除与 DB 映射一致性（完成标准第三条：目录与映射行同灭）──────────────────

test('deleteVault：目录与映射行同灭；成员行同灭；历史审计行保留且挂靠解除', async () => {
  const h = await harness(true);
  try {
    const { id } = await createVault(h, 'doomed');
    // 造一条历史审计痕迹（vault.create 已记；再记一条成员事件经审计缝）
    const repo = vaultRepoPath(h.dataDir, id);
    assert.ok(existsSync(repo), '删除前目录存在');

    const svc = new VaultService({ db: h.db, repoOps: createVaultRepoOps(h.dataDir), now: () => '2026-10-13T00:00:00Z' });
    await svc.deleteVault('doomed');

    assert.ok(!existsSync(repo), '库目录同灭');
    assert.equal((h.db.prepare('SELECT COUNT(*) AS c FROM vaults WHERE id = ?').get(id) as { c: number }).c, 0, '映射行同灭');
    assert.equal((h.db.prepare('SELECT COUNT(*) AS c FROM vault_members WHERE vault_id = ?').get(id) as { c: number }).c, 0, '成员行同灭');
    // 历史审计保留（storage-model §7「v1 不清理」），vault_id 解除挂靠（FK 完整）
    const audits = h.db.prepare(`SELECT vault_id, event_kind FROM audit_events WHERE event_kind LIKE 'vault.%' ORDER BY id`).all();
    assert.ok(audits.length >= 1, 'vault.create 历史审计行保留');
    for (const a of audits) assert.equal(a.vault_id, null, '审计行 vault_id 已解除挂靠');
    // 不变量 3 双向核对干净
    assert.deepEqual(verifyVaultStoreConsistency(h.dataDir, []), { orphanRepoIds: [], missingRepoIds: [] });
  } finally {
    await h.close();
  }
});

test('deleteVault：不存在的 slug → 404（与不存在库同响应语义）', async () => {
  const h = await harness(true);
  try {
    const svc = new VaultService({ db: h.db, repoOps: createVaultRepoOps(h.dataDir) });
    await assert.rejects(() => svc.deleteVault('ghost'), (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 404);
      assert.equal(err.code, 'E-RES-001');
      return true;
    });
    // 再删一次已删除的库同样 404
    const { id } = await createVault(h, 'once');
    const svc2 = new VaultService({ db: h.db, repoOps: createVaultRepoOps(h.dataDir) });
    await svc2.deleteVault('once');
    await assert.rejects(
      () => svc2.deleteVault('once'),
      (err: unknown) => err instanceof ApiError && err.status === 404,
    );
    assert.ok(!existsSync(vaultRepoPath(h.dataDir, id)));
  } finally {
    await h.close();
  }
});

test('deleteVault 补偿：目录删除失败时行已同灭、错误放大，孤儿目录由 reconcile 处置', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'notegit-gitrepo-'));
  const db = newDb();
  try {
    const employeeId = addEmployee(db, { username: 'creator' });
    // 真实建库（目录在），随后换成 remove 失败的实现模拟 rm 故障（如权限/磁盘错误）
    const real = createVaultRepoOps(dataDir);
    const svc = new VaultService({ db, repoOps: real });
    const vault = await svc.createVaultWithRepo({ name: 'X', slug: 'stuck' }, { employeeId, entry: 'web', carrierRef: 'session:f' });
    assert.ok(existsSync(vaultRepoPath(dataDir, vault.id)));

    const broken = { initBare: real.initBare, remove: async () => { throw new Error('rm failed (simulated)'); } };
    const svc2 = new VaultService({ db, repoOps: broken });
    await assert.rejects(() => svc2.deleteVault('stuck'), /rm failed/);
    // 行侧已同灭（先提交），目录残留为孤儿——核对可观测、reconcile 可处置
    assert.equal((db.prepare('SELECT COUNT(*) AS c FROM vaults').get() as { c: number }).c, 0, '映射行已灭');
    assert.ok(existsSync(vaultRepoPath(dataDir, vault.id)), '故障下目录残留');
    assert.deepEqual(verifyVaultStoreConsistency(dataDir, []).orphanRepoIds, [vault.id]);
    const result = await reconcileOrphanRepos(dataDir, []);
    assert.deepEqual(result.removedOrphanRepoIds, [vault.id]);
    assert.ok(!existsSync(vaultRepoPath(dataDir, vault.id)), '补偿处置后孤儿清除');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    db.close();
  }
});
