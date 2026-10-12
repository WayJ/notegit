import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, type ChildProcess } from 'node:child_process';
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
import { measureVaultBytes } from '../src/githttp/receive-audit.ts';
import { setAppSetting } from '../src/limits/engine.ts';
import { rulesVersion, type Report } from 'notegit-validation';
import { publishWebSubmit, type PublishResult, type WebSubmitChange } from '../src/publish/index.ts';

// S3-T8 E-LIMIT-001~005 逐码触发测试 + 全键配置生效（implementation-breakdown
// §2.2 S3-T8 完成标准：「每个限制键各至少一触发测试（超限给可理解错误含
// limit/limitKey）」）。判定型键经真实 Git 推送（HTTP → http-backend →
// pre-receive hook 子进程——app_settings 行跨进程热生效的实证）与真实 web
// 提交（publishWebSubmit）两入口触发；豁免清单键经接受集变化触发。
//
// D6：断言禁全等硬编码——limit 断言用测试注入的配置值，rulesVersion 对运行时
// manifest，库容量基线自 measureVaultBytes 派生。

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
};

async function git(args: string[], opts: { cwd?: string } = {}): Promise<{ stdout: string; stderr: string }> {
  return promisify(execFile)('git', args, { ...opts, env: GIT_ENV });
}

interface PushError extends Error {
  stderr?: string;
}

async function rejectPush(args: string[], cwd: string): Promise<string> {
  const err = await git(args, { cwd }).then(
    () => assert.fail('推送应被拒绝'),
    (e: PushError) => e,
  );
  return String(err.stderr);
}

function reportFromStderr(stderr: string): Report {
  const marker = '[notegit pre-receive] report: ';
  const line = stderr
    .split('\n')
    .map((l) => l.replace(/^remote: /, ''))
    .find((l) => l.includes(marker));
  assert.ok(line, `stderr 应含报告标记行（实际尾部：${stderr.slice(-600)}）`);
  return JSON.parse(line.slice(line.indexOf(marker) + marker.length)) as Report;
}

async function writeMd(dir: string, file: string, body: string | Uint8Array): Promise<void> {
  const abs = path.join(dir, file);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, body);
}

const WHEN = '2026-10-13T12:00:00.000Z';
const IDENTITY = { name: 'alice', email: 'alice@notegit.test' };
const VALID_DOC = '---\ntitle: New\nowner: alice\ndescription: 摘要\nsource: web\n---\n\n正文。\n';

interface Harness {
  app: FastifyInstance;
  db: DatabaseSync;
  dataDir: string;
  docsRepo: string;
  vaultId: number;
  alice: number;
  port: number;
  token: string;
  url: string;
  setLimit(key: Parameters<typeof setAppSetting>[1]['key'], value: number | string[]): void;
  clearLimits(): void;
  close(): Promise<void>;
}

let h: Harness;

async function startHarness(): Promise<Harness> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'notegit-t8-trig-'));
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
  const token = credentials.createCredential(alice, {
    name: 'git-alice',
    expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  }).token;

  const seed = path.join(dataDir, 'seed');
  await git(['init', '-b', 'main', seed]);
  await writeMd(seed, 'README.md', '# nav\n');
  await writeMd(seed, 'notes/first.md', '---\ntitle: First\n---\nbody\n');
  await git(['-C', seed, 'add', '.']);
  await git(['-C', seed, '-c', 'user.email=seed@notegit.test', '-c', 'user.name=seed', 'commit', '-m', 'seed']);
  await git(['-C', seed, 'push', vaultRepoPath(dataDir, docs.id), 'main']);

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
    docsRepo: vaultRepoPath(dataDir, docs.id),
    vaultId: docs.id,
    alice,
    port,
    token,
    url: '',
    setLimit: (key, value) => setAppSetting(db, { key, value, updatedBy: alice }),
    clearLimits: () => db.exec('DELETE FROM app_settings'),
    close: async () => {
      await app.close();
      db.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

before(async () => {
  h = await startHarness();
  h.url = `http://alice:${h.token}@127.0.0.1:${h.port}/git/docs.git`;
});

after(async () => {
  await h.close();
});

/** 唯一克隆 → 写一个合规文档并提交推送（返回克隆目录） */
async function cloneWithDoc(name: string, file: string, body: string | Uint8Array): Promise<string> {
  const dir = path.join(h.dataDir, name);
  await git(['clone', h.url, dir]);
  await git(['-C', dir, 'config', 'user.email', 'alice@notegit.test']);
  await git(['-C', dir, 'config', 'user.name', 'alice']);
  await writeMd(dir, file, body);
  await git(['-C', dir, 'add', '.']);
  await git(['-C', dir, 'commit', '-m', 't']);
  return dir;
}

function topError(report: Report, code: string) {
  const issue = report.issues?.find((i) => i.code === code);
  assert.ok(issue, `顶层 issues 应含 ${code}（实际：${JSON.stringify(report.issues?.map((i) => i.code))}）`);
  return issue!;
}

// ── E-LIMIT-001 文档大小（maxDocumentBytes）────────────────────────────────

test('E-LIMIT-001：maxDocumentBytes=64 → 100 字节文档推送被拒（limit/limitKey/actual 齐）；删行热恢复默认放行', async () => {
  h.setLimit('validation.limits.maxDocumentBytes', 64);
  const dir = await cloneWithDoc('t001', 'docs/big.md', '---\ntitle: Big\n---\n' + 'x'.repeat(80));
  const stderr = await rejectPush(['push', 'origin', 'main'], dir);
  const report = reportFromStderr(stderr);
  assert.equal(report.result, 'fail');
  const issue = report.files.flatMap((f) => f.issues).find((i) => i.code === 'E-LIMIT-001');
  assert.ok(issue, 'files 应含 E-LIMIT-001');
  assert.equal(issue!.limit, 64);
  assert.equal(issue!.limitKey, 'validation.limits.maxDocumentBytes');
  assert.equal(issue!.actual, Buffer.byteLength('---\ntitle: Big\n---\n' + 'x'.repeat(80), 'utf8'));
  assert.ok(issue!.message.includes('超上限'), '可理解错误文案');

  // 热生效：删行后同一内容按默认上限（1 MiB）放行——hook 子进程每次推送重读配置
  h.clearLimits();
  const dir2 = await cloneWithDoc('t001b', 'docs/big2.md', '---\ntitle: Big\n---\n' + 'x'.repeat(80));
  await git(['push', 'origin', 'main'], { cwd: dir2 });
});

// ── E-LIMIT-002 附件扩展名清单（attachmentAllowedExtensions）───────────────

test('E-LIMIT-002：attachmentAllowedExtensions=[".png"] → .jpg 附件被拒（expected 含生效清单）', async () => {
  h.setLimit('validation.limits.attachmentAllowedExtensions', ['.png']);
  const dir = await cloneWithDoc('t002', 'assets/photo.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]));
  const stderr = await rejectPush(['push', 'origin', 'main'], dir);
  const report = reportFromStderr(stderr);
  const issue = report.files.flatMap((f) => f.issues).find((i) => i.code === 'E-LIMIT-002');
  assert.ok(issue);
  assert.ok(String(issue!.expected).includes('.png'), 'expected 应含配置生效清单');
  h.clearLimits();
});

// ── E-LIMIT-003 附件大小（maxAttachmentBytes）──────────────────────────────

test('E-LIMIT-003：maxAttachmentBytes=64 → 100 字节 .png 被拒（limit=配置值）', async () => {
  h.setLimit('validation.limits.maxAttachmentBytes', 64);
  const dir = await cloneWithDoc('t003', 'assets/logo.png', Buffer.alloc(100, 7));
  const stderr = await rejectPush(['push', 'origin', 'main'], dir);
  const report = reportFromStderr(stderr);
  const issue = report.files.flatMap((f) => f.issues).find((i) => i.code === 'E-LIMIT-003');
  assert.ok(issue);
  assert.equal(issue!.limit, 64);
  assert.equal(issue!.limitKey, 'validation.limits.maxAttachmentBytes');
  h.clearLimits();
});

// ── E-LIMIT-004 push 总量（maxPushBytes；T6 计量阈值生效）────────────────

test('E-LIMIT-004：maxPushBytes=64 → 正常小提交的 pack 即超限（ref 级 issue + limitKey）', async () => {
  h.setLimit('validation.limits.maxPushBytes', 64);
  const dir = await cloneWithDoc('t004', 'docs/small.md', '---\ntitle: S\n---\n');
  const stderr = await rejectPush(['push', 'origin', 'main'], dir);
  const report = reportFromStderr(stderr);
  assert.equal(report.result, 'fail');
  const issue = topError(report, 'E-LIMIT-004');
  assert.equal(issue.limit, 64);
  assert.equal(issue.limitKey, 'validation.limits.maxPushBytes');
  assert.equal(issue.ref, 'refs/heads/main');
  assert.ok((issue.actual as number) > 64, 'actual=本次推送计量字节（> 上限）');
  assert.ok(report.refs?.every((r) => r.outcome === 'rejected'), '全有或全无');
  h.clearLimits();
});

// ── E-LIMIT-005 库容量（vaultCapacityBytes；T6 计量阈值生效）──────────────

test('E-LIMIT-005：vaultCapacityBytes=存量+20 → 推送被拒（limit 派生自实测基线）', async () => {
  const current = await measureVaultBytes(h.docsRepo);
  h.setLimit('validation.limits.vaultCapacityBytes', current + 20);
  const dir = await cloneWithDoc('t005', 'docs/one-more.md', '---\ntitle: M\n---\n');
  const stderr = await rejectPush(['push', 'origin', 'main'], dir);
  const report = reportFromStderr(stderr);
  const issue = topError(report, 'E-LIMIT-005');
  assert.equal(issue.limit, current + 20);
  assert.equal(issue.limitKey, 'validation.limits.vaultCapacityBytes');
  assert.ok((issue.actual as number) > current + 20);
  h.clearLimits();
});

// ── 豁免清单键（additionalNavPatterns / specialFilePatterns 接受集变化）────

test('additionalNavPatterns=["nav/*.md"] → nav/menu.md 无 frontmatter 放行（默认则 E-FM-001 拒）', async () => {
  const dir = await cloneWithDoc('t-nav', 'nav/menu.md', '# 菜单\n（无 frontmatter）\n');
  const stderr = await rejectPush(['push', 'origin', 'main'], dir);
  const reportNoExempt = reportFromStderr(stderr);
  assert.ok(reportNoExempt.files.some((f) => f.issues.some((i) => i.code === 'E-FM-001')), '默认：nav/menu.md 需 frontmatter');

  h.setLimit('validation.exemptions.additionalNavPatterns', ['nav/*.md']);
  const dir2 = await cloneWithDoc('t-nav2', 'nav/menu2.md', '# 菜单2\n（无 frontmatter，豁免后放行）\n');
  await git(['push', 'origin', 'main'], { cwd: dir2 });
  h.clearLimits();
});

test('specialFilePatterns=[] → .gitignore 不再豁免，按非附件 E-LIMIT-002 拒', async () => {
  h.setLimit('validation.exemptions.specialFilePatterns', []);
  const dir = await cloneWithDoc('t-sfp', '.gitignore', 'node_modules/\n');
  const stderr = await rejectPush(['push', 'origin', 'main'], dir);
  const report = reportFromStderr(stderr);
  const issue = report.files.flatMap((f) => f.issues).find((i) => i.code === 'E-LIMIT-002');
  assert.ok(issue, '空清单下 .gitignore 按类型规则拒');
  h.clearLimits();

  // 默认清单放行 .gitignore 本体；字面清单制——.gitignore2 不命中默认清单
  const dirOk = await cloneWithDoc('t-sfp-ok', '.gitignore', 'x\n');
  await git(['push', 'origin', 'main'], { cwd: dirOk });
  const dir2 = await cloneWithDoc('t-sfp2', '.gitignore2', 'x\n');
  const stderr2 = await rejectPush(['push', 'origin', 'main'], dir2);
  assert.ok(stderr2.includes('E-LIMIT-002'), '.gitignore2 不在默认特殊清单（字面清单制）');
});

// ── 环境通道与 DB 优先（跨 hook 子进程继承）────────────────────────────────

test('fail-closed：app_settings 行非法 JSON → 推送整体拒绝（不静默回退默认值），错误指名配置键', async () => {
  h.db
    .prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES ('validation.limits.maxPushBytes', '{bad', '2026-10-13T00:00:00.000Z')`)
    .run();
  try {
    const dir = await cloneWithDoc('t-badcfg', 'docs/badcfg.md', '---\ntitle: B\n---\n');
    const stderr = await rejectPush(['push', 'origin', 'main'], dir);
    assert.ok(
      stderr.includes('validation.limits.maxPushBytes'),
      `异常拒绝消息应指名配置键（实际尾部：${stderr.slice(-400)}）`,
    );
  } finally {
    h.clearLimits();
  }
});

test('环境变量经 http-backend 透传 hook：env maxDocumentBytes=64 触发 E-LIMIT-001；DB 行同键胜环境放行', async () => {
  const envName = 'NOTEGIT_VALIDATION_LIMITS_MAX_DOCUMENT_BYTES';
  process.env[envName] = '64';
  try {
    const dir = await cloneWithDoc('t-env', 'docs/envdoc.md', '---\ntitle: E\n---\n' + 'y'.repeat(80));
    const stderr = await rejectPush(['push', 'origin', 'main'], dir);
    const report = reportFromStderr(stderr);
    const issue = report.files.flatMap((f) => f.issues).find((i) => i.code === 'E-LIMIT-001');
    assert.ok(issue);
    assert.equal(issue!.limit, 64, '环境值生效（hook 子进程继承 app 进程环境）');

    h.setLimit('validation.limits.maxDocumentBytes', 1_000_000); // DB 行胜环境
    const dir2 = await cloneWithDoc('t-env2', 'docs/envdoc2.md', '---\ntitle: E\n---\n' + 'y'.repeat(80));
    await git(['push', 'origin', 'main'], { cwd: dir2 });
  } finally {
    delete process.env[envName];
    h.clearLimits();
  }
});

// ── web 入口同构触发（publishWebSubmit：E-LIMIT-001/003/004/005）──────────

function submit(changes: readonly WebSubmitChange[], baseCommit: string | null): Promise<PublishResult> {
  return publishWebSubmit({
    db: h.db,
    dataDir: h.dataDir,
    subject: { employeeId: h.alice, carrierRef: 'session:1' },
    vaultSlug: 'docs',
    branch: 'main',
    baseCommit,
    changes,
    message: 'web 提交',
    identity: IDENTITY,
    committedAt: WHEN,
    occurredAt: WHEN,
  });
}

async function currentMain(): Promise<string> {
  return (await git(['--git-dir', h.docsRepo, 'rev-parse', 'main'])).stdout.trim();
}

test('web E-LIMIT-001/003：文档与附件逐文件限额经发布链生效（草稿保留）', async () => {
  h.setLimit('validation.limits.maxDocumentBytes', 64);
  const base = await currentMain();
  const r = await submit([{ kind: 'upsert', path: 'docs/web-big.md', mode: '100644', content: '---\ntitle: W\n---\n' + 'z'.repeat(80) }], base);
  assert.equal(r.kind, 'rejected');
  assert.equal(r.stage, 'validation');
  assert.ok(r.report?.files.some((f) => f.issues.some((i) => i.code === 'E-LIMIT-001' && i.limit === 64)));
  assert.ok(r.draft.preserved, '拒绝保留草稿');

  h.setLimit('validation.limits.maxDocumentBytes', 1_000_000);
  h.setLimit('validation.limits.maxAttachmentBytes', 32);
  const r2 = await submit([{ kind: 'upsert', path: 'assets/tiny.png', mode: '100644', content: Buffer.alloc(64, 9) }], base);
  assert.equal(r2.kind, 'rejected');
  assert.ok(r2.report?.files.some((f) => f.issues.some((i) => i.code === 'E-LIMIT-003' && i.limit === 32)));
  h.clearLimits();
});

test('web E-LIMIT-004：maxPushBytes=64 → 变更字节合计即超限（T8 口径：web 以变更字节计）', async () => {
  h.setLimit('validation.limits.maxPushBytes', 64);
  const base = await currentMain();
  const r = await submit([{ kind: 'upsert', path: 'docs/w4.md', mode: '100644', content: VALID_DOC }], base);
  assert.equal(r.kind, 'rejected');
  const issue = r.report?.issues?.find((i) => i.code === 'E-LIMIT-004');
  assert.ok(issue, '顶层 issues 应含 E-LIMIT-004');
  assert.equal(issue!.limit, 64);
  assert.equal(issue!.limitKey, 'validation.limits.maxPushBytes');
  assert.equal(issue!.ref, 'refs/heads/main');
  h.clearLimits();
});

test('web E-LIMIT-005：vaultCapacityBytes=存量+20 → 发布被拒（库占用计量接线）', async () => {
  const current = await measureVaultBytes(h.docsRepo);
  h.setLimit('validation.limits.vaultCapacityBytes', current + 20);
  const base = await currentMain();
  const r = await submit([{ kind: 'upsert', path: 'docs/w5.md', mode: '100644', content: VALID_DOC }], base);
  assert.equal(r.kind, 'rejected');
  const issue = r.report?.issues?.find((i) => i.code === 'E-LIMIT-005');
  assert.ok(issue, 'E-LIMIT-005 web 侧判定（T7 honest-gap 移交项收口）');
  assert.equal(issue!.limit, current + 20);
  assert.equal(issue!.limitKey, 'validation.limits.vaultCapacityBytes');
  assert.equal(issue!.ref, 'refs/heads/main');
  h.clearLimits();
});
