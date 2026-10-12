import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db/connection.ts';
import { migrate } from '../src/db/migrate.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { initBareVaultRepo } from '../src/gitrepo/lifecycle.ts';
import { vaultRepoPath } from '../src/vaults/repo-path.ts';
import { createMaintenanceGate } from '../src/maintenance/gate.ts';
import { FIXTURE_DDL, addEmployee, addMember, addVault } from './credentials-fixtures.ts';
import { publishWebSubmit, type PublishResult, type WebSubmitChange } from '../src/publish/index.ts';

// S3-T8 T7 honest-gap 收口 1/2：发布组件的维护模式复查（backup-recovery §3——
// 「维护模式覆盖网页/API/Git 写入」；T5/T6/T7 三度挂账的同一执行点叠加位）。
// 锚点裁决：execution-point 阶段（identity §5.1 第 3 层落点）——与在途撤权同位
// 叠加：检查后、update-ref 前开启维护 → 拒绝（HTTP 层闸门是第一道，管线复查
// 是执行点最后一道；与 git 入口「HTTP 403 → update hook」双层同构）。
// 生产接线：S4 的提交路由持有 app 的 gate 实例传入（publishWebSubmit 目前无
// 生产调用方——本测试即接线证明）；缺省不检查（既有测试形态不变）。

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

const WHEN = '2026-10-13T12:00:00.000Z';
const IDENTITY = { name: 'alice', email: 'alice@notegit.test' };
const VALID_DOC = '---\ntitle: New\nowner: alice\ndescription: 摘要\nsource: web\n---\n\n正文。\n';

interface Fixture {
  db: DatabaseSync;
  dataDir: string;
  vaultId: number;
  repoPath: string;
  seedMain: string;
  alice: number;
  close(): Promise<void>;
}

let f: Fixture;

async function setup(): Promise<Fixture> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'notegit-t8-maint-'));
  const dbFile = path.join(dataDir, 'db', 'notegit.sqlite');
  await mkdir(path.dirname(dbFile), { recursive: true });
  const db = openDatabase(dbFile);
  migrate(db, MIGRATIONS);
  for (const ddl of FIXTURE_DDL) db.exec(ddl);

  const alice = addEmployee(db, { username: 'alice' });
  const vaultId = addVault(db, 'docs', alice);
  addMember(db, vaultId, alice, 'editor', alice);

  await initBareVaultRepo(dataDir, vaultId);
  const repoPath = vaultRepoPath(dataDir, vaultId);
  const seed = path.join(dataDir, 'seed');
  await git(['init', '-b', 'main', seed]);
  await writeMd(seed, 'README.md', '# nav\n');
  await writeMd(seed, 'notes/first.md', '---\ntitle: First\n---\nbody\n');
  await git(['-C', seed, 'add', '.']);
  await git(['-C', seed, '-c', 'user.email=seed@notegit.test', '-c', 'user.name=seed', 'commit', '-m', 'seed']);
  await git(['-C', seed, 'push', repoPath, 'main']);
  const seedMain = (await git(['--git-dir', repoPath, 'rev-parse', 'main'])).trim();

  return {
    db, dataDir, vaultId, repoPath, seedMain, alice,
    close: async () => {
      db.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

before(async () => {
  f = await setup();
});

after(async () => {
  await f.close();
});

beforeEach(async () => {
  await git(['--git-dir', f.repoPath, 'update-ref', 'refs/heads/main', f.seedMain]);
});

function submit(gateEnabled: boolean): Promise<PublishResult> {
  return publishWebSubmit({
    db: f.db,
    dataDir: f.dataDir,
    subject: { employeeId: f.alice, carrierRef: 'session:1' },
    vaultSlug: 'docs',
    branch: 'main',
    baseCommit: f.seedMain,
    changes: [{ kind: 'upsert', path: 'docs/new.md', mode: '100644', content: VALID_DOC }] as readonly WebSubmitChange[],
    message: 'web 提交',
    identity: IDENTITY,
    committedAt: WHEN,
    occurredAt: WHEN,
    maintenanceGate: maintenanceGateOf(gateEnabled),
  });
}

/** 每次新 gate 实例（隔离；管线只消费 MaintenanceGate 接口面） */
function maintenanceGateOf(enabled: boolean) {
  const gate = createMaintenanceGate();
  if (enabled) gate.enable();
  return gate;
}

function submitRow(submitId: string): { status: string; detail: string } | undefined {
  const rows = f.db
    .prepare(`SELECT status, detail FROM audit_events WHERE event_kind = 'vault.web_submit' ORDER BY id`)
    .all() as unknown as { status: string; detail: string }[];
  return rows.find((r) => {
    try {
      return (JSON.parse(r.detail) as { pushId?: string }).pushId === submitId;
    } catch {
      return false;
    }
  });
}

test('维护模式开启：发布链在 execution-point 拒绝（不 update-ref），审计 settle rejected(reason=maintenance)，草稿保留', async () => {
  const r = await submit(true);
  assert.equal(r.kind, 'rejected');
  assert.equal(r.stage, 'execution-point', '拒绝锚点=执行点复查（与在途撤权同位叠加）');
  assert.ok(r.reason.includes('维护'), '可读拒绝理由');
  assert.ok(r.draft.preserved, '拒绝保留草稿（draft.ts 语义）');
  // 链先行步骤已执行、update-ref/settle 未执行
  assert.ok(r.executedSteps.includes('validation'), '内容校验先于维护复查（链序不变）');
  assert.ok(!r.executedSteps.includes('update-ref'), '未执行引用更新');

  const ref = (await git(['--git-dir', f.repoPath, 'rev-parse', 'main'])).trim();
  assert.equal(ref, f.seedMain, 'ref 未动');

  if (r.kind === 'rejected') {
    const row = submitRow(r.submitId);
    assert.ok(row, '审计行存在（预记录先行）');
    assert.equal(row!.status, 'rejected');
    assert.ok(JSON.parse(row!.detail).reason === 'maintenance', '审计 detail.reason=maintenance');
  }
});

test('维护模式关闭（缺省 gate 关闭态）：同一提交正常发布', async () => {
  const r = await submit(false);
  assert.equal(r.kind, 'published');
  if (r.kind === 'published') {
    const ref = (await git(['--git-dir', f.repoPath, 'rev-parse', 'main'])).trim();
    assert.equal(ref, r.newOid, 'ref 已更新');
  }
});

test('在途开启：校验后、执行点前开启维护 → 拒绝（观察缝注入时序）', async () => {
  const gate = createMaintenanceGate();
  const r = await publishWebSubmit({
    db: f.db,
    dataDir: f.dataDir,
    subject: { employeeId: f.alice, carrierRef: 'session:1' },
    vaultSlug: 'docs',
    branch: 'main',
    baseCommit: f.seedMain,
    changes: [{ kind: 'upsert', path: 'docs/new.md', mode: '100644', content: VALID_DOC }],
    message: 'web 提交',
    identity: IDENTITY,
    committedAt: WHEN,
    occurredAt: WHEN,
    maintenanceGate: gate,
    hooks: {
      afterStep(stage) {
        if (stage === 'base-commit') gate.enable(); // 校验已过、执行点未到
      },
    },
  });
  assert.equal(r.kind, 'rejected');
  assert.equal(r.stage, 'execution-point');
});
