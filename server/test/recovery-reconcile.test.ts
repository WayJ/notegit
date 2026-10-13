import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db/connection.ts';
import { migrate } from '../src/db/migrate.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { initBareVaultRepo, verifyVaultStoreConsistency } from '../src/gitrepo/lifecycle.ts';
import { FIXTURE_DDL, addEmployee, addVault } from './credentials-fixtures.ts';
import { drainCount, recordAuditEvent } from '../src/audit/audit.ts';
import { sweepOrphanedPending } from '../src/audit/reconciliation.ts';
import { newPushId, preRecordPendingPush } from '../src/githttp/receive-audit.ts';
import {
  runRecoveryReconciliation,
  readVaultRefs,
  ReconciliationError,
} from '../src/audit/reconciliation.ts';

// S8-T6 恢复对账（implementation-breakdown §2.7 S8-T6 行；backup-recovery §5 不变量
// 1–3、§7 步骤 7）：
// - 异常注入（模拟半应用写）：pending/unresolved 行 + refs 实际态不一致 → 对账按
//   「行 new_commit vs ref 实际 OID」定终态（相等 succeeded、不等 rejected——绝不虚报
//   成功），注入先 RED；
// - old→new 成链核对：成功终态序列相邻成链（链首出生全零、相邻 old==前 new、链尾
//   == ref 实际 OID、实际 ref 无未记录者）——§5 不变量 1–2 的复核面；
// - 孤儿检查：consume verifyVaultStoreConsistency（不变量 3）；
// - 维护约束：维护未开 → 对账拒绝动手（fail-closed）；完成前维护被退 → 报告判
//   不通过；对账器结构性不动闸门（只断言不切换）；
// - 对账后不变量 1–3 复核通过（异常态被正确处置的前提下）。
//
// 形态与 receive-audit.test.ts 单元面同构：文件 SQLite + tmp dataDir 真实 bare 仓库
// + 真实 git（plumbing 直写 bare——update-ref 非 receive-pack，不触发 hook；D6：
// 期望值一律自运行时派生）。

const run = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@notegit.test',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@notegit.test',
};

async function git(args: string[], opts: { cwd?: string } = {}): Promise<string> {
  const { stdout } = await run('git', args, { ...opts, env: GIT_ENV });
  return stdout.trim();
}

/** stdin 需要输入的 plumbing（hash-object --stdin / mktree）——spawn 手写喂入 */
function gitIn(args: string[], cwd: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env: GIT_ENV });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(`git ${args.join(' ')} (code=${code}): ${err}`));
    });
    child.stdin.end(input);
  });
}

let seq = 0;

/** 在 bare 仓库内以 plumbing 造真提交（不经 receive-pack，不触发 hook） */
async function commitInBare(repo: string, parents: readonly string[] = []): Promise<string> {
  seq += 1;
  const blob = await gitIn(['hash-object', '-w', '--stdin'], repo, `# doc ${seq}\n`);
  const tree = await gitIn(['mktree'], repo, `100644 blob ${blob}\tdoc.md\n`);
  const args = ['commit-tree', tree, '-m', `c${seq}`];
  for (const p of parents) args.push('-p', p);
  return await gitIn(args, repo, '');
}

const ZERO = '0'.repeat(40);

interface World {
  readonly db: DatabaseSync;
  readonly dataDir: string;
  readonly emp: number;
  repoOf(vaultId: number): string;
  dispose(): Promise<void>;
}

async function newWorld(): Promise<World> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'notegit-s8t6-rec-'));
  const dbFile = path.join(dataDir, 'db', 'notegit.sqlite');
  await mkdir(path.dirname(dbFile), { recursive: true });
  const db = openDatabase(dbFile);
  migrate(db, MIGRATIONS);
  for (const ddl of FIXTURE_DDL) db.exec(ddl);
  const emp = addEmployee(db, { username: 'root', is_instance_admin: 1 });
  return {
    db,
    dataDir,
    emp,
    repoOf: (vaultId) => path.join(dataDir, 'git', `${vaultId}.git`),
    dispose: async () => {
      db.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

async function newVault(w: World, slug: string): Promise<number> {
  const id = addVault(w.db, slug, w.emp);
  await initBareVaultRepo(w.dataDir, id);
  return id;
}

/** 真实 pending 预记录（与 HTTP receive 同 API；单 ref 单行） */
function pendingRow(w: World, vaultId: number, ref: string, oldOid: string, newOid: string): number {
  const [id] = preRecordPendingPush(w.db, {
    subject: { employeeId: w.emp, carrierRef: 'credential:1', entry: 'git' },
    vaultId,
    commands: [{ ref, oldOid, newOid }],
    pushId: newPushId(),
    occurredAt: new Date().toISOString(),
  });
  return id;
}

/** 直接终态 succeeded 行（注入「审计记成功」的异常态用） */
function succeededRow(w: World, vaultId: number, ref: string, oldOid: string, newOid: string): void {
  recordAuditEvent(w.db, {
    occurredAt: new Date().toISOString(),
    actorKind: 'employee',
    subject: { employeeId: w.emp, carrierRef: 'credential:1', entry: 'git' },
    eventKind: 'vault.push',
    vaultId,
    refName: ref,
    oldCommit: oldOid,
    newCommit: newOid,
    status: 'succeeded',
  });
}

function rowStatus(db: DatabaseSync, id: number): string {
  return (db.prepare('SELECT status FROM audit_events WHERE id = ?').get(id) as { status: string }).status;
}

const always = (v: boolean) => ({ isEnabled: async () => v });

function reconcile(w: World, control: { isEnabled(): Promise<boolean> } = always(true)) {
  return runRecoveryReconciliation({ db: w.db, dataDir: w.dataDir, control });
}

// ── 异常注入：半应用写两形态 → 终态处置 ────────────────────────────────────

test('半应用写 A（崩溃于引用更新后、终态核对前）：pending 行 new == ref 实际 → succeeded；不变量 1–3 复核通过', async () => {
  const w = await newWorld();
  try {
    const vaultId = await newVault(w, 'docs');
    const repo = w.repoOf(vaultId);
    const x = await commitInBare(repo);
    await git(['update-ref', 'refs/heads/main', x], { cwd: repo }); // 引用已实际到达 new
    const id = pendingRow(w, vaultId, 'refs/heads/main', ZERO, x);

    const report = await reconcile(w);

    assert.equal(rowStatus(w.db, id), 'succeeded', '引用实达 new → 定 succeeded');
    assert.equal(report.settled.length, 1);
    assert.equal(report.settled[0]!.to, 'succeeded');
    assert.equal(report.settled[0]!.from, 'pending');
    assert.equal(report.settled[0]!.actualOid, x);
    // 不变量 1：无 pending/unresolved 残留，且 ref 实际 OID 有成功终态成链
    assert.equal(drainCount(w.db), 0);
    assert.equal(report.summary.pendingResidue, 0);
    assert.equal(report.chains.length, 1);
    assert.equal(report.chains[0]!.ok, true, '链首出生（old=全零）、链尾==实际 OID');
    // 不变量 2：无「记成功但 ref 未更新」或反向（chain ok 即复核）
    // 不变量 3：无孤儿仓库 / 无孤儿配置行
    assert.deepEqual(verifyVaultStoreConsistency(w.dataDir, [vaultId]), {
      orphanRepoIds: [],
      missingRepoIds: [],
    });
    assert.deepEqual(report.orphanRepoIds, []);
    assert.deepEqual(report.missingRepoIds, []);
    assert.equal(report.maintenance.stillEnabledAtEnd, true);
    assert.equal(report.summary.ok, true);
  } finally {
    await w.dispose();
  }
});

test('半应用写 B（崩溃于引用更新前）：pending 行 new ≠ ref 实际（引用停 old）→ rejected 不虚报；链尾仍与实际一致', async () => {
  const w = await newWorld();
  try {
    const vaultId = await newVault(w, 'docs');
    const repo = w.repoOf(vaultId);
    const x = await commitInBare(repo);
    const y = await commitInBare(repo, [x]);
    await git(['update-ref', 'refs/heads/main', x], { cwd: repo }); // 引用停在 old
    succeededRow(w, vaultId, 'refs/heads/main', ZERO, x); // 已成链的既往成功
    const id = pendingRow(w, vaultId, 'refs/heads/main', x, y); // 崩溃残留：对象未落、引用未动

    const report = await reconcile(w);

    assert.equal(rowStatus(w.db, id), 'rejected', '引用未达 new → rejected（绝不虚报成功）');
    assert.equal(report.settled[0]!.to, 'rejected');
    assert.equal(report.settled[0]!.actualOid, x);
    assert.equal(report.summary.rejected, 1);
    assert.equal(report.chains[0]!.ok, true, '链尾（X）== 实际 OID（X）——半应用写被如实剔除出链');
    assert.equal(report.summary.ok, true, '正确的拒绝处置本身满足不变量（无残留、成链、无孤儿）');
  } finally {
    await w.dispose();
  }
});

test('unresolved（待核对）行同样被定终态：ref 实达 new → succeeded（清扫→对账交接）', async () => {
  const w = await newWorld();
  try {
    const vaultId = await newVault(w, 'docs');
    const repo = w.repoOf(vaultId);
    const x = await commitInBare(repo);
    await git(['update-ref', 'refs/heads/main', x], { cwd: repo });
    const id = pendingRow(w, vaultId, 'refs/heads/main', ZERO, x);
    const swept = sweepOrphanedPending(w.db, { reason: 'startup-orphan' });
    assert.equal(swept, 1);
    assert.equal(rowStatus(w.db, id), 'unresolved');

    const report = await reconcile(w);

    assert.equal(report.settled[0]!.from, 'unresolved');
    assert.equal(rowStatus(w.db, id), 'succeeded');
    assert.equal(report.summary.ok, true);
  } finally {
    await w.dispose();
  }
});

test('删除命令（new=全零）：ref 已实际不在 → succeeded', async () => {
  const w = await newWorld();
  try {
    const vaultId = await newVault(w, 'docs');
    const repo = w.repoOf(vaultId);
    const x = await commitInBare(repo);
    await git(['update-ref', 'refs/heads/main', x], { cwd: repo });
    succeededRow(w, vaultId, 'refs/heads/main', ZERO, x);
    const id = pendingRow(w, vaultId, 'refs/heads/main', x, ZERO); // 删除命令
    await git(['update-ref', '-d', 'refs/heads/main'], { cwd: repo }); // 引用已实际删除

    const report = await reconcile(w);

    assert.equal(rowStatus(w.db, id), 'succeeded', '删除成功（ref 不在 == 全零 new）');
    const refCheck = report.chains[0]!.refs.find((r) => r.ref === 'refs/heads/main');
    assert.ok(refCheck, '已记录引用（含已删除）进核对面');
    assert.deepEqual(refCheck!.problems, [], '记录删除（末条 new=全零）与实际一致');
    assert.equal(report.summary.ok, true);
  } finally {
    await w.dispose();
  }
});

test('库已删（行 vault_id 解除挂靠）：无法证成 → rejected，不误伤其余库核对', async () => {
  const w = await newWorld();
  try {
    const goneId = await newVault(w, 'gone');
    const keepId = await newVault(w, 'keep');
    const keepRepo = w.repoOf(keepId);
    const x = await commitInBare(keepRepo);
    await git(['update-ref', 'refs/heads/main', x], { cwd: keepRepo });
    const goneRowId = pendingRow(w, goneId, 'refs/heads/main', ZERO, 'f'.repeat(40));
    pendingRow(w, keepId, 'refs/heads/main', ZERO, x);
    // 模拟 deleteVault 语义：行 vault_id 置 NULL + 库行删除 + 目录删除
    w.db.prepare('UPDATE audit_events SET vault_id = NULL WHERE id = ?').run(goneRowId);
    w.db.prepare('DELETE FROM vaults WHERE id = ?').run(goneId);
    await rm(w.repoOf(goneId), { recursive: true, force: true });

    const report = await reconcile(w);

    const gone = report.settled.find((s) => s.id === goneRowId);
    assert.equal(gone?.to, 'rejected', '库不在 → 引用无从证成 → rejected');
    assert.equal(rowStatus(w.db, goneRowId), 'rejected');
    const keepChain = report.chains.find((c) => c.vaultId === keepId);
    assert.equal(keepChain?.ok, true);
    assert.equal(report.summary.ok, true);
  } finally {
    await w.dispose();
  }
});

// ── 成链核对（§5 不变量 1–2 的复核面）──────────────────────────────────────

test('漂移检测（不变量 2 正向违例：审计记成功但 ref 未更新）→ final-link-mismatch、判不通过、维护仍开', async () => {
  const w = await newWorld();
  try {
    const vaultId = await newVault(w, 'docs');
    const repo = w.repoOf(vaultId);
    const x = await commitInBare(repo);
    const z = await commitInBare(repo, [x]);
    await git(['update-ref', 'refs/heads/main', x], { cwd: repo }); // 实际停在 X
    succeededRow(w, vaultId, 'refs/heads/main', ZERO, z); // 谎报/漂移：记 Z 成功

    const report = await reconcile(w);

    const refCheck = report.chains[0]!.refs.find((r) => r.ref === 'refs/heads/main');
    assert.ok(refCheck!.problems.includes('final-link-mismatch'), '末条成功 new ≠ ref 实际 OID');
    assert.equal(report.chains[0]!.ok, false);
    assert.equal(report.summary.ok, false, '不变量 2 违例 → 对账不通过');
    assert.equal(report.maintenance.stillEnabledAtEnd, true, '判不通过也不退维护（人工裁决）');
  } finally {
    await w.dispose();
  }
});

test('相邻断链检测：第 n 条 old ≠ 第 n-1 条 new → gap', async () => {
  const w = await newWorld();
  try {
    const vaultId = await newVault(w, 'docs');
    const repo = w.repoOf(vaultId);
    const x = await commitInBare(repo);
    const y = await commitInBare(repo, [x]);
    const z = await commitInBare(repo, [y]);
    await git(['update-ref', 'refs/heads/main', z], { cwd: repo });
    succeededRow(w, vaultId, 'refs/heads/main', ZERO, x);
    succeededRow(w, vaultId, 'refs/heads/main', y, z); // old=Y ≠ 前条 new=X —— 断链

    const report = await reconcile(w);

    const refCheck = report.chains[0]!.refs.find((r) => r.ref === 'refs/heads/main');
    assert.ok(refCheck!.problems.includes('gap'));
    assert.equal(report.summary.ok, false);
  } finally {
    await w.dispose();
  }
});

test('链首非全零（记录不从出生开始）→ first-old-not-zero', async () => {
  const w = await newWorld();
  try {
    const vaultId = await newVault(w, 'docs');
    const repo = w.repoOf(vaultId);
    const x = await commitInBare(repo);
    const y = await commitInBare(repo, [x]);
    await git(['update-ref', 'refs/heads/main', y], { cwd: repo });
    succeededRow(w, vaultId, 'refs/heads/main', x, y); // 链首 old=X 非全零

    const report = await reconcile(w);

    const refCheck = report.chains[0]!.refs.find((r) => r.ref === 'refs/heads/main');
    assert.ok(refCheck!.problems.includes('first-old-not-zero'));
    assert.equal(report.summary.ok, false);
  } finally {
    await w.dispose();
  }
});

test('未记录引用（ref 实际存在但无成功终态记录）→ unrecorded-ref（不变量 1 反向）', async () => {
  const w = await newWorld();
  try {
    const vaultId = await newVault(w, 'docs');
    const repo = w.repoOf(vaultId);
    const x = await commitInBare(repo);
    const f = await commitInBare(repo, [x]);
    await git(['update-ref', 'refs/heads/main', x], { cwd: repo });
    succeededRow(w, vaultId, 'refs/heads/main', ZERO, x);
    await git(['update-ref', 'refs/heads/feature', f], { cwd: repo }); // 无任何审计行

    const report = await reconcile(w);

    const feature = report.chains[0]!.refs.find((r) => r.ref === 'refs/heads/feature');
    assert.ok(feature!.problems.includes('unrecorded-ref'));
    assert.equal(feature!.lastRecordedNew, null);
    assert.equal(report.summary.ok, false);
  } finally {
    await w.dispose();
  }
});

// ── 孤儿检查（不变量 3；consume verifyVaultStoreConsistency）────────────────

test('孤儿仓库与孤儿配置行（库行无目录）：双向报告、判不通过', async () => {
  const w = await newWorld();
  try {
    const vaultId = await newVault(w, 'docs');
    await mkdir(path.join(w.dataDir, 'git', '99.git')); // 磁盘有、DB 无
    const noDirId = addVault(w.db, 'no-dir', w.emp); // DB 有、磁盘无

    const report = await reconcile(w);

    assert.deepEqual(report.orphanRepoIds, [99]);
    assert.ok(report.missingRepoIds.includes(noDirId));
    assert.equal(report.summary.orphanRepos, 1);
    assert.ok(report.summary.missingRepos >= 1);
    assert.equal(report.summary.ok, false);
    assert.deepEqual(
      verifyVaultStoreConsistency(w.dataDir, [vaultId, noDirId]).orphanRepoIds,
      [99],
      '与既有核对面同判（consume 不重写）',
    );
  } finally {
    await w.dispose();
  }
});

// ── 维护模式约束（backup §7 步骤 7：对账在维护下执行、完成前不得退出）───────

test('维护未开启 → 对账拒绝动手（fail-closed）：抛错、零行被改', async () => {
  const w = await newWorld();
  try {
    const vaultId = await newVault(w, 'docs');
    const repo = w.repoOf(vaultId);
    const x = await commitInBare(repo);
    await git(['update-ref', 'refs/heads/main', x], { cwd: repo });
    const id = pendingRow(w, vaultId, 'refs/heads/main', ZERO, x);

    await assert.rejects(
      reconcile(w, always(false)),
      (err: unknown) => err instanceof ReconciliationError && /维护/.test(err.message),
    );
    assert.equal(rowStatus(w.db, id), 'pending', '对账未动任何行');
    assert.equal(drainCount(w.db), 1);
  } finally {
    await w.dispose();
  }
});

test('完成前维护被退（中途退出）→ stillEnabledAtEnd=false、判不通过', async () => {
  const w = await newWorld();
  try {
    const vaultId = await newVault(w, 'docs');
    const repo = w.repoOf(vaultId);
    const x = await commitInBare(repo);
    await git(['update-ref', 'refs/heads/main', x], { cwd: repo });
    pendingRow(w, vaultId, 'refs/heads/main', ZERO, x);
    let calls = 0;
    const flipped = { isEnabled: async () => (calls += 1) === 1 }; // 首查 true、末查 false

    const report = await reconcile(w, flipped);

    assert.equal(report.maintenance.assertedAtStart, true);
    assert.equal(report.maintenance.stillEnabledAtEnd, false);
    assert.equal(report.summary.ok, false, '对账结论在无维护保障下不可信 → 判不通过');
  } finally {
    await w.dispose();
  }
});

test('结构性断言：对账器不动维护闸门（只断言不切换——enable/disable 均不出现）', async () => {
  const reconcileSrc = await readFile(path.join(import.meta.dirname, '../src/audit/reconciliation.ts'), 'utf8');
  const cliSrc = await readFile(path.join(import.meta.dirname, '../src/audit/reconcile-cli.ts'), 'utf8');
  const gateToggle = /\.(enable|disable)\s*\(/;
  assert.match(reconcileSrc, /isEnabled/, '对账编排经控制缝断言维护态');
  assert.doesNotMatch(reconcileSrc, gateToggle, '编排层不得切换闸门');
  assert.doesNotMatch(cliSrc, gateToggle, 'CLI 层不得切换闸门（完成前不得退出维护的结构保证）');
});

// ── 多库隔离与汇总面 ───────────────────────────────────────────────────────

test('多库多引用：逐库独立核对互不串；汇总数字与实例一致', async () => {
  const w = await newWorld();
  try {
    const a = await newVault(w, 'a');
    const b = await newVault(w, 'b');
    const repoA = w.repoOf(a);
    const repoB = w.repoOf(b);
    const ax = await commitInBare(repoA);
    const af = await commitInBare(repoA, [ax]);
    await git(['update-ref', 'refs/heads/main', ax], { cwd: repoA });
    await git(['update-ref', 'refs/heads/feature', af], { cwd: repoA });
    succeededRow(w, a, 'refs/heads/main', ZERO, ax);
    succeededRow(w, a, 'refs/heads/feature', ZERO, af);
    const by = await commitInBare(repoB);
    const bz = await commitInBare(repoB, [by]);
    await git(['update-ref', 'refs/heads/main', by], { cwd: repoB });
    succeededRow(w, b, 'refs/heads/main', ZERO, by);
    pendingRow(w, b, 'refs/heads/main', by, bz); // B 库半应用写 B 形态

    const report = await reconcile(w);

    assert.equal(report.chains.length, 2);
    const chainA = report.chains.find((c) => c.vaultId === a);
    const chainB = report.chains.find((c) => c.vaultId === b);
    assert.equal(chainA!.ok, true);
    assert.equal(chainA!.refs.length, 2, 'A 库两引用各自核对');
    assert.equal(chainB!.ok, true, 'B 库 rejected 处置后链尾==实际');
    assert.deepEqual(
      report.summary,
      {
        settled: 1,
        succeeded: 0,
        rejected: 1,
        pendingResidue: 0,
        chainViolationRefs: 0,
        orphanRepos: 0,
        missingRepos: 0,
        ok: true,
      },
      '汇总 = 逐项聚合',
    );
  } finally {
    await w.dispose();
  }
});

test('readVaultRefs：空库空集；引用全集随 update-ref 如实呈现', async () => {
  const w = await newWorld();
  try {
    const vaultId = await newVault(w, 'docs');
    const repo = w.repoOf(vaultId);
    assert.equal((await readVaultRefs(repo)).size, 0, '空初始化库无引用');
    const x = await commitInBare(repo);
    await git(['update-ref', 'refs/heads/main', x], { cwd: repo });
    const refs = await readVaultRefs(repo);
    assert.equal(refs.size, 1);
    assert.equal(refs.get('refs/heads/main'), x, 'OID 自运行时派生（rev-parse 同源）');
  } finally {
    await w.dispose();
  }
});
