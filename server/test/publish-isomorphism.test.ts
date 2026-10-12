import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../src/app.ts';
import { CredentialsService } from '../src/credentials/service.ts';
import { VaultService } from '../src/vaults/service.ts';
import { createVaultRepoOps } from '../src/gitrepo/lifecycle.ts';
import { vaultRepoPath } from '../src/vaults/repo-path.ts';
import { openDatabase } from '../src/db/connection.ts';
import { migrate } from '../src/db/migrate.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { FIXTURE_DDL, addEmployee, addMember } from './credentials-fixtures.ts';
import { rulesVersion, type Report } from 'notegit-validation';
import { publishWebSubmit, type WebSubmitChange } from '../src/publish/index.ts';

// S3-T7 同构性测试（implementation-breakdown §2.2 S3-T7 完成标准；验收场景 S4：
// Web 发布与 Git receive 同构）：**同一违规样本**分别经 pre-receive（真实
// HTTP git push，T4 产品链）与发布组件（publishWebSubmit，T7 产品链），输出
// 同一 rulesVersion 与同一错误集。
//
// 样本覆盖三类判定路径：frontmatter（E-FM-001）、危险 tree 条目（E-PATH-002
// symlink）、大小写冲突基线（E-PATH-004——新文件 vs 库内存量路径，pre-receive
// 的 CommitDelta.treePaths 全 tree 基线语义，web 侧须同构拦截）。
//
// D6：两入口的输出互为期望（runtime 对 runtime），rulesVersion 另与运行时
// manifest 核对——零硬编码。

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
};

const run = promisify(execFile);

async function git(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<{ stdout: string; stderr: string }> {
  return run('git', args, { cwd: opts.cwd, env: opts.env ?? GIT_ENV });
}

interface Harness {
  app: FastifyInstance;
  db: DatabaseSync;
  dataDir: string;
  vaultId: number;
  aliceId: number;
  token: string;
  url: string; // git HTTP URL（含认证）
  seedMain: string;
  close(): Promise<void>;
}

let h: Harness;

async function startE2E(): Promise<Harness> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'notegit-t7-iso-'));
  const dbFile = path.join(dataDir, 'db', 'notegit.sqlite');
  await mkdir(path.dirname(dbFile), { recursive: true });
  const db = openDatabase(dbFile);
  migrate(db, MIGRATIONS);
  for (const ddl of FIXTURE_DDL) db.exec(ddl);

  const pepper = { active: { version: 1, key: randomBytes(32) }, retired: [] as never[] };
  const alice = addEmployee(db, { username: 'alice' });
  const vaultService = new VaultService({ db, repoOps: createVaultRepoOps(dataDir) });
  const docs = await vaultService.createVaultWithRepo(
    { name: 'Docs', slug: 'docs' },
    { employeeId: alice, entry: 'web', carrierRef: 'session:fixture' },
  );

  const credentials = new CredentialsService({ db, pepper });
  const cred = credentials.createCredential(alice, {
    name: 'git-alice',
    expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  });

  // 种子内容（HTTP 请求前的直连 push——hooks 尚未安装，与 T4/T6 夹具同构）
  const repoPath = vaultRepoPath(dataDir, docs.id);
  const seed = path.join(dataDir, 'seed');
  await git(['init', '-b', 'main', seed]);
  for (const [file, body] of [
    ['README.md', '# nav\n'],
    ['notes/first.md', '---\ntitle: First\n---\nbody\n'],
  ] as const) {
    const abs = path.join(seed, file);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, body);
  }
  await git(['-C', seed, 'add', '.']);
  await git(['-C', seed, '-c', 'user.email=seed@notegit.test', '-c', 'user.name=seed', 'commit', '-m', 'seed']);
  await git(['-C', seed, 'push', repoPath, 'main']);
  const seedMain = (await git(['--git-dir', repoPath, 'rev-parse', 'main'])).stdout.trim();

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
    vaultId: docs.id,
    aliceId: alice,
    token: cred.token,
    url: `http://alice:${cred.token}@127.0.0.1:${port}/git/docs.git`,
    seedMain,
    close: async () => {
      await app.close();
      db.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

before(async () => {
  h = await startE2E();
});

after(async () => {
  await h.close();
});

// ── 同一违规样本（两入口共享的字节级输入）──────────────────────────────────

const NEW_POLICY = '# 新政策\n无 frontmarker\n'; // E-FM-001
const NOTES_FIRST = '---\ntitle: First Case\nowner: alice\ndescription: 摘要\nsource: web\n---\n\n正文，见 [导航](README.md)。\n'; // E-PATH-004（与存量 notes/first.md 仅大小写不同）
const SYMLINK_TARGET = '/etc/passwd'; // E-PATH-002

/** push 侧：以 plumbing 构造违规提交（混合 OS 协作的真实形态——大小写冲突
 *  在大小写不敏感客户端的工作区造不出来，index 操作不折叠）；symlink 以
 *  mode 120000 记录（blob 内容=目标路径）。不 checkout，直接推 commit OID。 */
async function buildViolationCommit(workDir: string): Promise<string> {
  const entries = [
    { mode: '100644', path: 'docs/finance/new-policy.md', content: NEW_POLICY },
    { mode: '100644', path: 'Notes/First.md', content: NOTES_FIRST },
    { mode: '120000', path: 'evil-link', content: SYMLINK_TARGET },
  ];
  const head = (await git(['-C', workDir, 'rev-parse', 'origin/main'])).stdout.trim();
  const idx = path.join(h.dataDir, `pusher-index-${process.pid.toString()}`);
  const IDX_ENV = { ...GIT_ENV, GIT_INDEX_FILE: idx };
  await git(['-C', workDir, 'read-tree', head], { env: IDX_ENV });
  for (const e of entries) {
    const blob = (await new Promise<string>((resolve, reject) => {
      const child = spawn('git', ['-C', workDir, 'hash-object', '-w', '--stdin'], { env: IDX_ENV });
      let out = '';
      let err = '';
      child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
      child.stderr.on('data', (c: Buffer) => (err += c.toString('utf8')));
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err))));
      child.stdin.end(Buffer.from(e.content, 'utf8'));
    })) as string;
    const record = `${e.mode} ${blob}\t${e.path}`;
    await new Promise<void>((resolve, reject) => {
      const child = spawn('git', ['-C', workDir, 'update-index', '-z', '--index-info'], { env: IDX_ENV });
      let err = '';
      child.stderr.on('data', (c: Buffer) => (err += c.toString('utf8')));
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err))));
      child.stdin.end(Buffer.concat([Buffer.from(record, 'utf8'), Buffer.alloc(1)]));
    });
  }
  const tree = (await git(['-C', workDir, 'write-tree'], { env: IDX_ENV })).stdout.trim();
  const commit = (
    await new Promise<string>((resolve, reject) => {
      const child = spawn('git', ['-C', workDir, 'commit-tree', tree, '-p', head, '-F', '-'], {
        env: {
          ...IDX_ENV,
          GIT_AUTHOR_NAME: 'alice', GIT_AUTHOR_EMAIL: 'alice@notegit.test',
          GIT_COMMITTER_NAME: 'alice', GIT_COMMITTER_EMAIL: 'alice@notegit.test',
          GIT_AUTHOR_DATE: '1760366400 +0000', GIT_COMMITTER_DATE: '1760366400 +0000',
        },
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
      child.stderr.on('data', (c: Buffer) => (err += c.toString('utf8')));
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err))));
      child.stdin.end(Buffer.from('violation sample\n', 'utf8'));
    })
  ) as string;
  await rm(idx, { force: true });
  return commit;
}

/** web 侧：同一批文件的变更清单（mode 与 push 侧 tree 条目一致） */
function sampleChanges(): WebSubmitChange[] {
  return [
    { kind: 'upsert', path: 'docs/finance/new-policy.md', mode: '100644', content: NEW_POLICY },
    { kind: 'upsert', path: 'Notes/First.md', mode: '100644', content: NOTES_FIRST },
    { kind: 'upsert', path: 'evil-link', mode: '120000', content: SYMLINK_TARGET },
  ];
}

/** pre-receive stderr 中的报告 JSON（T4 协议：`report: {...}` 行） */
function reportFromStderr(stderr: string): Report {
  const marker = 'report: ';
  const idx = stderr.lastIndexOf(marker);
  assert.notEqual(idx, -1, `stderr 须含报告协议行（尾部：${stderr.slice(-400)}）`);
  const start = stderr.indexOf('{', idx);
  assert.notEqual(start, -1, '报告 JSON 起点');
  // 行尾为止（报告后无更多输出；保守截取到最后一行）
  const lineEnd = stderr.indexOf('\n', start);
  const jsonText = lineEnd === -1 ? stderr.slice(start) : stderr.slice(start, lineEnd);
  return JSON.parse(jsonText) as Report;
}

/** 规范形：错误集比较口径——按路径聚合 issue（剥 commit 归因——push 侧特有） */
interface NormFile {
  path: string;
  status: 'pass' | 'fail';
  exempt?: boolean;
  issues: { severity: string; code: string; rule: string; message: string; line?: number; field?: string; actual?: unknown }[];
}

function normalizeFiles(report: Report): Map<string, NormFile> {
  const out = new Map<string, NormFile>();
  for (const file of report.files) {
    out.set(file.path, {
      path: file.path,
      status: file.status,
      ...(file.exempt === undefined ? {} : { exempt: file.exempt }),
      issues: file.issues.map(({ severity, code, rule, message, ...rest }) => ({
        severity, code, rule, message,
        ...(('line' in rest && rest.line !== undefined) ? { line: rest.line } : {}),
        ...(('field' in rest && rest.field !== undefined) ? { field: rest.field } : {}),
        ...(('actual' in rest && rest.actual !== undefined) ? { actual: rest.actual } : {}),
      })),
    });
  }
  return out;
}

test('同一违规样本两入口：同一 rulesVersion、同一错误集（S4 验收场景核心）', async () => {
  // ── 入口 1：git push（真实 pre-receive，T4 链）───────────────────────────
  const work = path.join(h.dataDir, 'pusher');
  await git(['clone', h.url, work]);
  const violationOid = await buildViolationCommit(work);
  const pushErr = await git(['-C', work, 'push', 'origin', `${violationOid}:refs/heads/main`]).then(
    () => assert.fail('违规 push 应被拒绝'),
    (e: Error & { stderr?: string }) => e,
  );
  const pushReport = reportFromStderr(String(pushErr.stderr));
  assert.equal(pushReport.scope, 'pre-receive');
  assert.equal(pushReport.result, 'fail');

  // ref 不动（拒绝后基线保持 seed——web 侧同基线）
  const repoPath = vaultRepoPath(h.dataDir, h.vaultId);
  assert.equal((await git(['--git-dir', repoPath, 'rev-parse', 'main'])).stdout.trim(), h.seedMain);

  // ── 入口 2：发布组件（publishWebSubmit，T7 链）──────────────────────────
  const web = await publishWebSubmit({
    db: h.db,
    dataDir: h.dataDir,
    subject: { employeeId: h.aliceId, carrierRef: 'session:1' },
    vaultSlug: 'docs',
    branch: 'main',
    baseCommit: h.seedMain,
    changes: sampleChanges(),
    message: 'violation sample',
    identity: { name: 'alice', email: 'alice@notegit.test' },
    committedAt: '2026-10-13T12:00:00.000Z',
    occurredAt: '2026-10-13T12:00:00.000Z',
  });
  assert.equal(web.kind, 'rejected', '同一违规样本 web 侧同样拒绝');
  assert.equal((web as { stage?: string }).stage, 'validation');
  const webReport = (web as { report: Report }).report;
  assert.equal(webReport.scope, 'web-submit');
  assert.equal(webReport.result, 'fail');

  // ── 同构断言 1：rulesVersion 同一（且=运行时 manifest）──────────────────
  assert.equal(webReport.rulesVersion, pushReport.rulesVersion, '两入口 rulesVersion 同一');
  assert.equal(pushReport.rulesVersion, rulesVersion(), 'push 侧=运行时 manifest');
  assert.equal(webReport.rulesVersion, rulesVersion(), 'web 侧=运行时 manifest');

  // ── 同构断言 2：同一错误集（逐路径 issue 全集；剥 push 侧 commit 归因）──
  const pushFiles = normalizeFiles(pushReport);
  const webFiles = normalizeFiles(webReport);
  assert.deepEqual(
    [...webFiles.keys()].sort(),
    [...pushFiles.keys()].sort(),
    '两入口覆盖同一文件集',
  );
  for (const [p, pushFile] of pushFiles) {
    assert.deepEqual(webFiles.get(p), pushFile, `文件 ${p} 的错误集两入口同一（码/严重度/消息/定位/actual）`);
  }
  assert.equal(webReport.summary.errorCount, pushReport.summary.errorCount, '错误计数同一');
  assert.equal(webReport.summary.warningCount, pushReport.summary.warningCount, '警告计数同一');

  // 样本判定面：三类违规路径确实各就各位（对契约码的定向断言——码是注册表常量）
  const policy = webFiles.get('docs/finance/new-policy.md')!;
  assert.ok(policy.issues.some((i) => i.code === 'E-FM-001'), 'E-FM-001 在列');
  const link = webFiles.get('evil-link')!;
  assert.ok(link.issues.some((i) => i.code === 'E-PATH-002'), 'E-PATH-002 在列');
  const caseFile = webFiles.get('Notes/First.md')!;
  assert.ok(caseFile.issues.some((i) => i.code === 'E-PATH-004'), 'E-PATH-004 在列（web 侧对库内存量路径的大小写冲突同构拦截）');

  // ref 仍不动（web 侧拒绝不发布）
  assert.equal((await git(['--git-dir', repoPath, 'rev-parse', 'main'])).stdout.trim(), h.seedMain);
});

test('同构性前提：两入口的合法样本都放行（同一基线下 web 发布 = 快进 push 等价）', async () => {
  const VALID = '---\ntitle: Good\nowner: alice\ndescription: 摘要\nsource: web\n---\n\n正文。\n';
  const web = await publishWebSubmit({
    db: h.db,
    dataDir: h.dataDir,
    subject: { employeeId: h.aliceId, carrierRef: 'session:2' },
    vaultSlug: 'docs',
    branch: 'main',
    baseCommit: h.seedMain,
    changes: [{ kind: 'upsert', path: 'docs/good.md', mode: '100644', content: VALID }],
    message: 'good',
    identity: { name: 'alice', email: 'alice@notegit.test' },
    committedAt: '2026-10-13T12:00:00.000Z',
    occurredAt: '2026-10-13T12:00:00.000Z',
  });
  assert.equal(web.kind, 'published', '合法样本 web 侧放行');
  assert.equal((web as { report?: Report }).report?.result, 'pass');
  const repoPath = vaultRepoPath(h.dataDir, h.vaultId);
  assert.equal(
    (await git(['--git-dir', repoPath, 'rev-parse', 'main'])).stdout.trim(),
    (web as { newOid: string }).newOid,
    'ref 前进到候选 commit',
  );
  // 回基线供其他用例（本文件内顺序执行）
  await git(['--git-dir', repoPath, 'update-ref', 'refs/heads/main', h.seedMain]);
});
