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
import { auditChain } from '../src/audit/reconciliation.ts';
import { FIXTURE_DDL, addEmployee, addMember, addVault } from './credentials-fixtures.ts';
import { rulesVersion } from 'notegit-validation';
import { publishWebSubmit, PUBLISH_STAGES, type PublishResult, type PublishStage, type WebSubmitChange } from '../src/publish/index.ts';

// S3-T7 发布管线（implementation-breakdown §2.2 S3-T7 行第 2/4/5 项）：
// 权限/分支检查（S2 authorize + S3 ref-rules 唯一判定源）→ 内容校验
// （packages/validation，scope=web-submit）→ 预期旧 commit 比对（不符拒绝不覆盖）
// → update-ref（原子 CAS）→ 审计（vault.web_submit 事件链：pending 预记录/终态
// settle 与 push 同构——消费 T6 导出面）。草稿保留语义：校验拒绝时草稿不丢
// （对齐 examples/report-web-submit-draft-rejected.json；存储本体属 S4）。
//
// 被测形态：真实文件 SQLite + 真实 bare 仓库（initBareVaultRepo 产品路径）+
// 候选提交经真实 git plumbing。D6：断言禁全等硬编码——期望 OID/规则版本/链尾
// 一律自 git 与运行时 manifest 派生。

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

const ZERO_OID = '0'.repeat(40);
const WHEN = '2026-10-13T12:00:00.000Z';
const VALID_FM = 'title: New\nowner: alice\ndescription: 摘要\nsource: web\n';
const VALID_DOC = `---\n${VALID_FM}---\n\n正文。\n`;
const IDENTITY = { name: 'alice', email: 'alice@notegit.test' };

interface Fixture {
  db: DatabaseSync;
  dataDir: string;
  vaultId: number;
  repoPath: string;
  seedMain: string;
  alice: number;
  bob: number;
  carol: number;
  dave: number;
  erin: number;
  close(): Promise<void>;
}

let f: Fixture;

async function setup(): Promise<Fixture> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'notegit-t7-pipe-'));
  const dbFile = path.join(dataDir, 'db', 'notegit.sqlite');
  await mkdir(path.dirname(dbFile), { recursive: true });
  const db = openDatabase(dbFile);
  migrate(db, MIGRATIONS);
  for (const ddl of FIXTURE_DDL) db.exec(ddl);

  const alice = addEmployee(db, { username: 'alice' });
  const bob = addEmployee(db, { username: 'bob' });
  const carol = addEmployee(db, { username: 'carol' });
  const dave = addEmployee(db, { username: 'dave' });
  const erin = addEmployee(db, { username: 'erin' });
  const vaultId = addVault(db, 'docs', alice);
  addMember(db, vaultId, alice, 'editor', alice);
  addMember(db, vaultId, bob, 'editor', alice);
  addMember(db, vaultId, dave, 'reader', alice);
  addMember(db, vaultId, erin, 'admin', alice);

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
    db, dataDir, vaultId, repoPath, seedMain,
    alice, bob, carol, dave, erin,
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

/** 每用例回基线：main 回 seed、测试分支删除（审计行按 submitId 定域，不受影响） */
beforeEach(async () => {
  await git(['--git-dir', f.repoPath, 'update-ref', 'refs/heads/main', f.seedMain]);
  await run('git', ['--git-dir', f.repoPath, 'update-ref', '-d', 'refs/heads/fresh'], { env: GIT_ENV }).catch(() => {});
});

interface SubmitOverrides {
  subject?: { employeeId: number; carrierRef: string };
  branch?: string;
  baseCommit?: string | null;
  changes?: readonly WebSubmitChange[];
  hooks?: { afterStep?(stage: PublishStage): void | Promise<void> };
}

function submit(over: SubmitOverrides = {}): Promise<PublishResult> {
  return publishWebSubmit({
    db: f.db,
    dataDir: f.dataDir,
    subject: over.subject ?? { employeeId: f.alice, carrierRef: 'session:1' },
    vaultSlug: 'docs',
    branch: over.branch ?? 'main',
    baseCommit: over.baseCommit === undefined ? f.seedMain : over.baseCommit,
    changes: over.changes ?? [{ kind: 'upsert', path: 'docs/new.md', mode: '100644', content: VALID_DOC }],
    message: 'web 提交',
    identity: IDENTITY,
    committedAt: WHEN,
    occurredAt: WHEN,
    hooks: over.hooks,
  });
}

interface SubmitRow {
  id: number;
  employee_id: number | null;
  credential_ref: string | null;
  entry: string;
  ref_name: string | null;
  old_commit: string | null;
  new_commit: string | null;
  status: string;
  detail: string;
}

/** 本 submitId 的 vault.web_submit 行（唯一） */
function rowOf(submitId: string): SubmitRow {
  const rows = f.db
    .prepare(`SELECT * FROM audit_events WHERE event_kind = 'vault.web_submit' ORDER BY id`)
    .all() as unknown as SubmitRow[];
  const mine = rows.filter((r) => {
    try {
      return (JSON.parse(r.detail) as { pushId?: string }).pushId === submitId;
    } catch {
      return false;
    }
  });
  assert.equal(mine.length, 1, '一次 web 提交一行审计（pushId 关联）');
  return mine[0]!;
}

async function refOid(ref: string): Promise<string> {
  return (await git(['--git-dir', f.repoPath, 'rev-parse', '--verify', '--quiet', ref], { cwd: f.repoPath })).trim();
}

function assertPrefix(result: PublishResult, stage: PublishStage): void {
  const idx = PUBLISH_STAGES.indexOf(stage);
  assert.ok(idx >= 0, `未知阶段 ${stage}`);
  assert.deepEqual(
    result.executedSteps,
    PUBLISH_STAGES.slice(0, idx + 1),
    `${result.kind}@${stage}：executedSteps 必须是指定阶段为止的有序前缀（结构性禁跳步）`,
  );
}

// ── 成功路径 ─────────────────────────────────────────────────────────────────

test('发布成功：ref 前进 old→new、候选内容落库、审计成链、全步骤按序执行', async () => {
  const r = await submit();
  assert.equal(r.kind, 'published');
  if (r.kind !== 'published') return;
  assert.equal(r.ref, 'refs/heads/main');
  assert.equal(r.oldOid, f.seedMain, 'CAS 保证实际旧值=预期旧 commit');
  assert.match(r.newOid, /^[0-9a-f]{40}$/);
  assert.notEqual(r.newOid, f.seedMain);

  // ref 实际前进且内容到达（git 派生）
  assert.equal(await refOid('refs/heads/main'), r.newOid);
  const got = await git(['show', `${r.newOid}:docs/new.md`], { cwd: f.repoPath });
  assert.equal(got, VALID_DOC);

  // 审计：vault.web_submit 一行、pending→succeeded、主体=认证员工+session 载体+web 入口
  const row = rowOf(r.submitId);
  assert.equal(row.status, 'succeeded');
  assert.equal(row.employee_id, f.alice, '主体=认证员工（不信 commit author——identity §8）');
  assert.equal(row.credential_ref, 'session:1');
  assert.equal(row.entry, 'web', 'identity §8 入口=web');
  assert.equal(row.ref_name, 'refs/heads/main');
  assert.equal(row.old_commit, f.seedMain);
  assert.equal(row.new_commit, r.newOid);

  // 链核对（backup §5 不变量 1 的消费面）：succeeded 序列尾=ref 实际 OID
  const chain = auditChain(f.db, f.vaultId);
  const tail = chain.filter((c) => c.ref_name === 'refs/heads/main').at(-1)!;
  assert.equal(tail.old_commit, f.seedMain);
  assert.equal(tail.new_commit, r.newOid);
  assert.equal(tail.new_commit, await refOid('refs/heads/main'), '链尾=ref 实际值');

  assert.equal(r.report.scope, 'web-submit');
  assert.equal(r.report.result, 'pass');
  assert.equal(r.report.commit, r.newOid, '报告内嵌候选提交 ID');
  assert.equal(r.report.rulesVersion, rulesVersion(), 'rulesVersion=运行时 manifest');
  assertPrefix(r, 'settle');
});

test('空库根提交：base=null → 候选成根、CAS 全零旧值、审计 old=全零', async () => {
  const emp = addEmployee(f.db, { username: 'rootmaker' });
  const vault2 = addVault(f.db, 'roots', f.alice);
  addMember(f.db, vault2, emp, 'editor', f.alice);
  await initBareVaultRepo(f.dataDir, vault2);
  const r = await publishWebSubmit({
    db: f.db,
    dataDir: f.dataDir,
    subject: { employeeId: emp, carrierRef: 'session:9' },
    vaultSlug: 'roots',
    branch: 'main',
    baseCommit: null,
    changes: [{ kind: 'upsert', path: 'README.md', mode: '100644', content: '# root\n' }],
    message: 'root',
    identity: IDENTITY,
    committedAt: WHEN,
    occurredAt: WHEN,
  });
  assert.equal(r.kind, 'published');
  if (r.kind !== 'published') return;
  assert.equal(r.oldOid, null, '创建态实际旧值=不存在');
  const repo2 = vaultRepoPath(f.dataDir, vault2);
  assert.equal((await git(['--git-dir', repo2, 'rev-parse', 'refs/heads/main'])).trim(), r.newOid);
  const commitText = await git(['--git-dir', repo2, 'cat-file', 'commit', r.newOid]);
  assert.doesNotMatch(commitText, /\nparent /, '根提交无 parent');
  const row = rowOf(r.submitId);
  assert.equal(row.old_commit, ZERO_OID, '创建命令 old=全零 OID（与 push 创建态同构）');
  assert.equal(row.status, 'succeeded');
});

// ── 校验拒绝：草稿保留（对齐示例 6/7）──────────────────────────────────────

test('校验拒绝：不发布、草稿保留、报告=web-submit 形（README exempt、E-FM-001）', async () => {
  const changes: WebSubmitChange[] = [
    { kind: 'upsert', path: 'README.md', mode: '100644', content: '# 知识库导航\n' },
    { kind: 'upsert', path: 'docs/finance/new-policy.md', mode: '100644', content: '# 新政策\n无 frontmarker\n' },
  ];
  const r = await submit({ changes });
  assert.equal(r.kind, 'rejected');
  if (r.kind !== 'rejected') return;
  assert.equal(r.stage, 'validation');

  // 报告形状对齐 examples/report-web-submit-draft-rejected.json（运行时派生断言）
  const report = r.report!;
  assert.equal(report.scope, 'web-submit');
  assert.equal(report.result, 'fail');
  assert.equal(report.exitCode, 1);
  assert.match(report.commit!, /^[0-9a-f]{40}$/, '报告内嵌候选提交 ID');
  assert.equal(report.rulesVersion, rulesVersion());
  const byPath = new Map(report.files.map((x) => [x.path, x]));
  assert.equal(byPath.get('README.md')!.status, 'pass');
  assert.equal(byPath.get('README.md')!.exempt, true, 'README 豁免 frontmatter（仍受路径/类型/容量）');
  const policy = byPath.get('docs/finance/new-policy.md')!;
  assert.equal(policy.status, 'fail');
  assert.deepEqual(
    policy.issues.filter((i) => i.severity === 'error').map((i) => i.code),
    ['E-FM-001'],
  );
  // summary 与 files 派生一致（非硬编码）
  assert.equal(report.summary.filesTotal, report.files.length);
  assert.equal(report.summary.filesFailed, report.files.filter((x) => x.status === 'fail').length);

  // 草稿保留语义（S4 存储本体之前的接口契约）：不发布 ⇒ 原样回传
  assert.equal(r.draft.preserved, true);
  assert.deepEqual(r.draft.changes, changes, '变更清单原样回传（不吞没）');
  assert.equal(r.draft.baseCommit, f.seedMain);
  assert.equal(r.draft.branch, 'main');
  assert.equal(r.draft.report, report);

  // 不发布：ref 不动；审计 rejected + rulesVersion
  assert.equal(await refOid('refs/heads/main'), f.seedMain, 'ref 不变（不发布）');
  const row = rowOf(r.submitId);
  assert.equal(row.status, 'rejected');
  const detail = JSON.parse(row.detail) as { reason: string; rulesVersion: string };
  assert.equal(detail.reason, 'validation');
  assert.equal(detail.rulesVersion, report.rulesVersion);
  assertPrefix(r, 'validation');
});

// ── 预期旧 commit 比对：不符拒绝、不覆盖（DOD-07 冲突保护）─────────────────

test('base commit 不符：拒绝发布不覆盖，冲突提交的草稿保留', async () => {
  const first = await submit({ subject: { employeeId: f.bob, carrierRef: 'session:2' } });
  assert.equal(first.kind, 'published');
  if (first.kind !== 'published') return;

  // alice 仍以过期基线 seedMain 提交 → 冲突拒绝
  const stale = await submit({ changes: [{ kind: 'upsert', path: 'docs/mine.md', mode: '100644', content: VALID_DOC }] });
  assert.equal(stale.kind, 'rejected');
  if (stale.kind !== 'rejected') return;
  assert.equal(stale.stage, 'base-commit');
  assert.match(stale.reason, /预期旧 commit|基线/);
  assert.equal(await refOid('refs/heads/main'), first.newOid, '不覆盖——ref 停留他人提交');
  assert.equal(stale.draft.preserved, true, '冲突草稿保留（DOD-07）');
  const row = rowOf(stale.submitId);
  assert.equal(row.status, 'rejected');
  assert.equal((JSON.parse(row.detail) as { reason: string }).reason, 'base-commit');
  assertPrefix(stale, 'base-commit');
});

test('分支已存在但按创建提交（base=null）：拒绝不覆盖', async () => {
  const made = await submit({ branch: 'fresh', baseCommit: null });
  assert.equal(made.kind, 'published');
  const dup = await submit({
    branch: 'fresh',
    baseCommit: null,
    changes: [{ kind: 'upsert', path: 'docs/other.md', mode: '100644', content: VALID_DOC }],
  });
  assert.equal(dup.kind, 'rejected');
  if (dup.kind !== 'rejected') return;
  assert.equal(dup.stage, 'base-commit');
  if (made.kind !== 'published') return;
  assert.equal(await refOid('refs/heads/fresh'), made.newOid, '既有分支不被创建命令覆盖');
});

// ── 授权与分支规则（与 push 同一判定源）─────────────────────────────────────

test('非成员：authorization 阶段拒绝（撤权/无权与 push 同语义）', async () => {
  const r = await submit({ subject: { employeeId: f.carol, carrierRef: 'session:3' } });
  assert.equal(r.kind, 'rejected');
  if (r.kind !== 'rejected') return;
  assert.equal(r.stage, 'authorization');
  assert.match(r.reason, /成员/);
  assert.equal(await refOid('refs/heads/main'), f.seedMain);
  const row = rowOf(r.submitId);
  assert.equal((JSON.parse(row.detail) as { reason: string }).reason, 'authorization');
  assertPrefix(r, 'authorization');
});

test('只读成员：branch-rules 阶段拒绝（refCommandRejection 唯一判定源）', async () => {
  const r = await submit({ subject: { employeeId: f.dave, carrierRef: 'session:4' } });
  assert.equal(r.kind, 'rejected');
  if (r.kind !== 'rejected') return;
  assert.equal(r.stage, 'branch-rules');
  assert.match(r.reason, /只读/);
  assert.equal(await refOid('refs/heads/main'), f.seedMain);
  assertPrefix(r, 'branch-rules');
});

test('main_admin_only 开启：编辑者默认分支被拒、库管理员放行（配置实时生效）', async () => {
  f.db.prepare(`UPDATE vaults SET main_admin_only = 1 WHERE id = ?`).run(f.vaultId);
  try {
    const ed = await submit();
    assert.equal(ed.kind, 'rejected');
    if (ed.kind !== 'rejected') return;
    assert.equal(ed.stage, 'branch-rules');
    assert.match(ed.reason, /main_admin_only/);
    assert.equal(await refOid('refs/heads/main'), f.seedMain);

    const admin = await submit({ subject: { employeeId: f.erin, carrierRef: 'session:5' } });
    assert.equal(admin.kind, 'published');
  } finally {
    f.db.prepare(`UPDATE vaults SET main_admin_only = 0 WHERE id = ?`).run(f.vaultId);
  }
});

// ── 执行点复查（identity §5.1 第 3 层：update-ref 前实时复查）──────────────

test('在途撤权（校验通过后、update-ref 前）：execution-point 拒绝并审计', async () => {
  const r = await submit({
    hooks: {
      afterStep: async (stage) => {
        if (stage !== 'validation') return;
        f.db.prepare(`DELETE FROM vault_members WHERE vault_id = ? AND employee_id = ?`).run(f.vaultId, f.alice);
      },
    },
  });
  assert.equal(r.kind, 'rejected');
  if (r.kind !== 'rejected') return;
  assert.equal(r.stage, 'execution-point');
  assert.equal(await refOid('refs/heads/main'), f.seedMain, '检查后撤权不继续发布（§5.4）');
  const row = rowOf(r.submitId);
  assert.equal(row.status, 'rejected');
  const detail = JSON.parse(row.detail) as { reason: string; checkpoint?: string };
  assert.equal(detail.reason, 'authorization');
  assert.equal(detail.checkpoint, 'execution-point');
  assertPrefix(r, 'execution-point');
  // 恢复成员关系供后续用例
  addMember(f.db, f.vaultId, f.alice, 'editor', f.alice);
});

test('在途配置翻转（校验通过后 main_admin_only 置 1）：execution-point 拒绝', async () => {
  const r = await submit({
    hooks: {
      afterStep: async (stage) => {
        if (stage !== 'validation') return;
        f.db.prepare(`UPDATE vaults SET main_admin_only = 1 WHERE id = ?`).run(f.vaultId);
      },
    },
  });
  f.db.prepare(`UPDATE vaults SET main_admin_only = 0 WHERE id = ?`).run(f.vaultId);
  assert.equal(r.kind, 'rejected');
  if (r.kind !== 'rejected') return;
  assert.equal(r.stage, 'execution-point');
  assert.match(r.reason, /main_admin_only|成员/);
  assert.equal(await refOid('refs/heads/main'), f.seedMain);
  assertPrefix(r, 'execution-point');
});

// ── 审计链锚点语义（与 push 同构）──────────────────────────────────────────

test('审计预记录失败：fail-closed 拒绝（不产生无审计的引用更新）', async () => {
  f.db.exec('DROP TABLE audit_events');
  try {
    const r = await submit();
    assert.equal(r.kind, 'rejected');
    if (r.kind !== 'rejected') return;
    assert.equal(r.stage, 'audit');
    assert.equal(await refOid('refs/heads/main'), f.seedMain, 'fail-closed：宁可拒发布');
    assert.equal(r.draft.preserved, true);
    assertPrefix(r, 'audit');
  } finally {
    for (const ddl of FIXTURE_DDL) f.db.exec(ddl); // 重建空表（IF NOT EXISTS 幂等）
  }
});

test('update-ref 后 ref 被并发移动：settle 核对实际值拒绝，不虚报成功', async () => {
  const r = await submit({
    hooks: {
      afterStep: async (stage) => {
        if (stage !== 'update-ref') return;
        // 模拟并发写入方立即移动 ref（update-ref 后、终态核对前）
        await git(['--git-dir', f.repoPath, 'update-ref', 'refs/heads/main', f.seedMain]);
      },
    },
  });
  assert.equal(r.kind, 'rejected');
  if (r.kind !== 'rejected') return;
  assert.equal(r.stage, 'settle');
  assert.equal(await refOid('refs/heads/main'), f.seedMain, '并发方生效');
  const row = rowOf(r.submitId);
  assert.equal(row.status, 'rejected', '行 new_commit ≠ ref 实际值 → rejected（不虚报成功）');
  assertPrefix(r, 'settle');
});

// ── 候选构造失败（先于审计：无行、草稿保留）────────────────────────────────

test('候选构造失败：stage=candidate、无审计行、草稿保留', async () => {
  const before = (f.db.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE event_kind = 'vault.web_submit'`).get() as { n: number }).n;
  const r = await submit({ baseCommit: 'f'.repeat(40) });
  assert.equal(r.kind, 'rejected');
  if (r.kind !== 'rejected') return;
  assert.equal(r.stage, 'candidate');
  assert.equal(r.draft.preserved, true);
  const after = (f.db.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE event_kind = 'vault.web_submit'`).get() as { n: number }).n;
  assert.equal(after, before, '候选失败先于预记录——零审计行');
  assert.equal(await refOid('refs/heads/main'), f.seedMain);
  assertPrefix(r, 'candidate');
});
