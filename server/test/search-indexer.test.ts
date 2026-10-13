import { test, before, after } from 'node:test';
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
import { recordAuditEvent } from '../src/audit/audit.ts';
import { SearchIndexer } from '../src/search/indexer.ts';
import type { DerivedIndex } from '../src/search/derive.ts';
import { FIXTURE_DDL, addEmployee, addMember, addVault } from './credentials-fixtures.ts';
import { publishWebSubmit } from '../src/publish/index.ts';

// S5-T3 索引器（server/src/search/indexer.ts）单元面——三条完成标准的机制侧：
// 1) 最终一致：settle 后的审计行（vault.push / vault.web_submit succeeded 且
//    ref=默认分支）驱动异步重索引；全量替换语义（旧路径消失）。
// 2) 失败不阻断（D7）：派生/写表失败只记 state 告警字段 + 日志，发布结果不受
//    影响（真实 publishWebSubmit 同场景仍 published）。
// 3) 延迟可观测：lag_ms = indexed_at − 触发审计行 occurred_at；duration_ms 与
//    时间戳入 state（管理端点消费面）。
// 另：启动对账（crash 兜底：无审计行的漂移被 reconcile 追上；孤儿行清理）。

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

async function commitAll(dir: string, message: string): Promise<void> {
  await git(['-C', dir, 'add', '.']);
  await git(['-C', dir, '-c', 'user.email=seed@notegit.test', '-c', 'user.name=seed', 'commit', '-m', message]);
}

const T0 = '2026-10-13T12:00:00.000Z';
const T1 = '2026-10-13T12:00:01.500Z'; // +1500ms
const DOC_A = '---\ntitle: 文档A\ntags:\n  - x\n---\n\nA 首段。\n';
const DOC_B = '---\ntitle: 文档B\n---\n\nB 首段。\n';
const DOC_NEW = '---\ntitle: 新文档\ntags: [y]\n---\n\n新首段。\n';

interface Fixture {
  db: DatabaseSync;
  dataDir: string;
  vaultId: number;
  repoPath: string;
  seed: string;
  head(): Promise<string>;
  close(): Promise<void>;
}

let f: Fixture;

/** 成功发布审计行（settle 后形态——索引器的触发输入） */
function settledPublishRow(db: DatabaseSync, vaultId: number, ref: string, newCommit: string, occurredAt: string): void {
  recordAuditEvent(db, {
    occurredAt,
    actorKind: 'employee',
    subject: { employeeId: 1, carrierRef: 'session:1', entry: 'web' },
    eventKind: 'vault.web_submit',
    vaultId,
    refName: ref,
    oldCommit: '0'.repeat(40),
    newCommit,
    status: 'succeeded',
    detail: { pushId: 'push-fixture' },
  });
}

function stateRow(db: DatabaseSync, vaultId: number) {
  return db.prepare('SELECT * FROM search_index_state WHERE vault_id = ?').get(vaultId) as
    | {
        vault_id: number;
        branch: string;
        head_commit: string | null;
        triggered_by: string;
        triggered_at: string | null;
        indexed_at: string;
        duration_ms: number;
        lag_ms: number | null;
        updates: number;
        consecutive_failures: number;
        last_error: string | null;
        last_error_at: string | null;
      }
    | undefined;
}

function indexRows(db: DatabaseSync, vaultId: number): { path: string; commit_oid: string; title: string | null; tags: string; summary: string }[] {
  return db
    .prepare('SELECT path, commit_oid, title, tags, summary FROM search_index WHERE vault_id = ? ORDER BY path')
    .all(vaultId) as never[];
}

before(async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'notegit-t3-ix-'));
  const dbFile = path.join(dataDir, 'db', 'notegit.sqlite');
  await mkdir(path.dirname(dbFile), { recursive: true });
  const db = openDatabase(dbFile);
  migrate(db, MIGRATIONS);
  for (const ddl of FIXTURE_DDL) db.exec(ddl);

  addEmployee(db, { username: 'alice' });
  const vaultId = addVault(db, 'docs', 1);
  addMember(db, vaultId, 1, 'editor', 1);

  await initBareVaultRepo(dataDir, vaultId);
  const repoPath = vaultRepoPath(dataDir, vaultId);
  const seed = path.join(dataDir, 'seed');
  await git(['init', '-b', 'main', seed]);
  await writeMd(seed, 'README.md', '# nav\n');
  await writeMd(seed, 'a.md', DOC_A);
  await writeMd(seed, 'b.md', DOC_B);
  await commitAll(seed, 'seed');
  await git(['-C', seed, 'push', repoPath, 'main']);

  f = {
    db,
    dataDir,
    vaultId,
    repoPath,
    seed,
    head: () => git(['--git-dir', repoPath, 'rev-parse', 'main']).then((s) => s.trim()),
    close: async () => {
      db.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
});

after(async () => {
  await f.close();
});

function newIndexer(overrides?: { derive?: (repoPath: string, branch: string) => Promise<DerivedIndex>; pollMs?: number }) {
  const errors: string[] = [];
  const log = { error: (...args: unknown[]) => void errors.push(args.map(String).join(' ')) };
  const ix = new SearchIndexer({
    db: f.db,
    dataDir: f.dataDir,
    now: () => new Date(T1),
    log,
    ...(overrides ?? {}),
  });
  return { ix, errors };
}

test('审计行驱动：默认分支 succeeded 发布行触发索引，行+state 落库且延迟可观测', async () => {
  const head = await f.head();
  const { ix } = newIndexer();
  settledPublishRow(f.db, f.vaultId, 'refs/heads/main', head, T0);
  await ix.pollOnce();

  const rows = indexRows(f.db, f.vaultId);
  assert.deepEqual(
    rows.map((r) => r.path),
    ['README.md', 'a.md', 'b.md'],
  );
  const a = rows.find((r) => r.path === 'a.md')!;
  assert.equal(a.title, '文档A');
  assert.deepEqual(JSON.parse(a.tags), ['x']);
  assert.equal(a.summary, 'A 首段。');
  assert.equal(a.commit_oid, head, '行 commit = 派生时的默认分支头');

  const st = stateRow(f.db, f.vaultId)!;
  assert.equal(st.head_commit, head);
  assert.equal(st.branch, 'main');
  assert.equal(st.triggered_by, 'vault.web_submit');
  assert.equal(st.triggered_at, T0, '触发时间 = 发布审计行 occurred_at（延迟分母）');
  assert.equal(st.indexed_at, T1);
  assert.equal(st.lag_ms, 1500, '延迟指标 = indexed_at − occurred_at（1500ms）');
  assert.ok(st.duration_ms >= 0, '派生耗时记录');
  assert.equal(st.updates, 1);
  assert.equal(st.consecutive_failures, 0);
  assert.equal(st.last_error, null);
});

test('watermark 消费：无新行时重复 poll 不重写（updates 不变）', async () => {
  const before = stateRow(f.db, f.vaultId)!.updates;
  const { ix } = newIndexer();
  await ix.pollOnce();
  await ix.pollOnce();
  assert.equal(stateRow(f.db, f.vaultId)!.updates, before, '无新 succeeded 行 → 不触发');
});

test('非默认分支与 rejected 行不触发索引', async () => {
  const { ix } = newIndexer();
  // topic 分支 succeeded 行（不合默认分支过滤）
  settledPublishRow(f.db, f.vaultId, 'refs/heads/topic', 'f'.repeat(40), T0);
  // 默认分支 rejected 行（发布未成立——不该触发索引）
  recordAuditEvent(f.db, {
    occurredAt: T0,
    actorKind: 'employee',
    subject: { employeeId: 1, carrierRef: 'session:1', entry: 'web' },
    eventKind: 'vault.push',
    vaultId: f.vaultId,
    refName: 'refs/heads/main',
    oldCommit: '0'.repeat(40),
    newCommit: 'e'.repeat(40),
    status: 'rejected',
    detail: {},
  });
  const updatesBefore = stateRow(f.db, f.vaultId)!.updates;
  await ix.pollOnce();
  assert.equal(stateRow(f.db, f.vaultId)!.updates, updatesBefore, 'topic/rejected 不触发');
});

test('全量替换：新提交触发后旧路径消失、新路径入表且 commit_oid 跟随新头', async () => {
  await rm(path.join(f.seed, 'b.md'));
  await writeMd(f.seed, 'new.md', DOC_NEW);
  await commitAll(f.seed, 'rewrite');
  await git(['-C', f.seed, 'push', f.repoPath, 'main']);
  const head2 = await f.head();

  const { ix } = newIndexer();
  settledPublishRow(f.db, f.vaultId, 'refs/heads/main', head2, T0);
  await ix.pollOnce();

  const rows = indexRows(f.db, f.vaultId);
  assert.deepEqual(
    rows.map((r) => r.path),
    ['README.md', 'a.md', 'new.md'],
    'b.md 已删 → 派生集不含；new.md 入表',
  );
  assert.ok(rows.every((r) => r.commit_oid === head2));
  assert.equal(stateRow(f.db, f.vaultId)!.head_commit, head2);
});

test('失败路径：派生抛错 → state 告警字段可见、旧索引保留、日志可查', async () => {
  const headBefore = stateRow(f.db, f.vaultId)!.head_commit;
  const rowsBefore = indexRows(f.db, f.vaultId);

  // 直接 push 漂移（不经发布管线——制造新头）+ succeeded 行，但派生面注入失败
  await writeMd(f.seed, 'again.md', DOC_NEW);
  await commitAll(f.seed, 'again');
  await git(['-C', f.seed, 'push', f.repoPath, 'main']);
  const head3 = await f.head();

  const failing: (repoPath: string, branch: string) => Promise<DerivedIndex> = () =>
    Promise.reject(new Error('boom: derive failed'));
  const { ix, errors } = newIndexer({ derive: failing });
  settledPublishRow(f.db, f.vaultId, 'refs/heads/main', head3, T0);
  await ix.pollOnce();

  const st = stateRow(f.db, f.vaultId)!;
  assert.equal(st.consecutive_failures, 1, '连续失败计数');
  assert.ok(st.last_error !== null && st.last_error.includes('boom'), '最近错误摘要入 state（告警数据面）');
  assert.equal(st.last_error_at, T1);
  assert.equal(st.head_commit, headBefore, '失败不写半截——索引仍指旧头（stale 可观测）');
  assert.deepEqual(indexRows(f.db, f.vaultId), rowsBefore, '旧索引行原样保留');

  assert.equal(errors.length, 1, '告警日志恰一条');
  assert.ok(errors[0]!.includes('[notegit search]'), '日志带统一前缀可检索');
  assert.ok(errors[0]!.includes('boom'), '日志含失败原因');
});

test('D7：索引失败不阻断发布——真实 publishWebSubmit 仍 published', async () => {
  const base = await f.head();
  const failing: (repoPath: string, branch: string) => Promise<DerivedIndex> = () =>
    Promise.reject(new Error('boom: derive failed'));
  const { ix, errors } = newIndexer({ derive: failing });
  const failuresBefore = stateRow(f.db, f.vaultId)!.consecutive_failures;
  const publish = await publishWebSubmit({
    db: f.db,
    dataDir: f.dataDir,
    subject: { employeeId: 1, carrierRef: 'session:1' },
    vaultSlug: 'docs',
    branch: 'main',
    baseCommit: base,
    changes: [{ kind: 'upsert', path: 'd7.md', mode: '100644', content: '---\ntitle: D7\n---\n\n正文。\n' }],
    message: 'd7',
    identity: { name: 'alice', email: 'alice@notegit.test' },
    occurredAt: T0,
  });
  assert.equal(publish.kind, 'published', '发布成功与索引成败解耦（D7）');
  await ix.pollOnce();
  assert.equal(
    stateRow(f.db, f.vaultId)!.consecutive_failures,
    failuresBefore + 1,
    '失败仅在索引侧可见（计数递增，发布不受影响）',
  );
  assert.ok(errors.length >= 1, '告警日志不缺席');
});

test('启动对账：无审计行的漂移被 reconcile 追上；新鲜时不重写；孤儿行清理', async () => {
  // 种子与 bare 头重新同步（D7 测试的发布已推进 bare main，seed 落后会 non-fast-forward）
  await git(['-C', f.seed, 'fetch', f.repoPath, 'main']);
  await git(['-C', f.seed, 'reset', '--hard', 'FETCH_HEAD']);
  // 漂移：直接 push（无审计行——崩溃/旁路形态）
  await writeMd(f.seed, 'drift.md', DOC_NEW);
  await commitAll(f.seed, 'drift');
  await git(['-C', f.seed, 'push', f.repoPath, 'main']);
  const headDrift = await f.head();

  const { ix } = newIndexer();
  await ix.reconcile();
  assert.equal(stateRow(f.db, f.vaultId)!.head_commit, headDrift, '对账追上实际头');
  const updatesAfterReconcile = stateRow(f.db, f.vaultId)!.updates;

  await ix.reconcile();
  assert.equal(stateRow(f.db, f.vaultId)!.updates, updatesAfterReconcile, '已新鲜 → 不重复重写');

  // 孤儿：库行删除后残留的派生行由对账清理（行侧同灭次序与 deleteVault 同构：
  // 审计行解除挂靠 → 成员行 → 库行）
  f.db.prepare('UPDATE audit_events SET vault_id = NULL WHERE vault_id = ?').run(f.vaultId);
  f.db.prepare('DELETE FROM vault_members WHERE vault_id = ?').run(f.vaultId);
  f.db.prepare('DELETE FROM vaults WHERE id = ?').run(f.vaultId);
  await ix.reconcile();
  assert.equal(indexRows(f.db, f.vaultId).length, 0, '孤儿索引行清理');
  assert.equal(stateRow(f.db, f.vaultId), undefined, '孤儿 state 行清理');
});

test('stop() 后不再消费新审计行（生命周期可关停）', async () => {
  // 重建库（上一测试已删）
  const vaultId2 = addVault(f.db, 'docs2', 1);
  addMember(f.db, vaultId2, 1, 'editor', 1);
  await initBareVaultRepo(f.dataDir, vaultId2);
  const repo2 = vaultRepoPath(f.dataDir, vaultId2);
  await git(['-C', f.seed, 'push', repo2, 'main']);
  const head = (await git(['--git-dir', repo2, 'rev-parse', 'main'])).trim();

  const { ix } = newIndexer({ pollMs: 20 });
  ix.start();
  await ix.stop(); // 等待启动对账排空（stop 语义：不留后台未决工作）
  const updatesAtStop = stateRow(f.db, vaultId2)!.updates; // 启动对账已索引（无审计行的漂移面）
  settledPublishRow(f.db, vaultId2, 'refs/heads/main', head, T0);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(stateRow(f.db, vaultId2)!.updates, updatesAtStop, 'stop 后定时器不再消费新行');
  // 恢复：显式 pollOnce 仍可处理（进程内组件可复活——重建入口的基础）
  await ix.pollOnce();
  assert.equal(stateRow(f.db, vaultId2)!.updates, updatesAtStop + 1, '显式 pollOnce 消费新行');
  assert.equal(stateRow(f.db, vaultId2)!.head_commit, head);
});
