import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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

// S3-T4 pre-receive 逐提交校验（implementation-breakdown §2.2 S3-T4 行完成标准：
// 防绕过清单逐条测试——validation.md §1 防绕过表的代码化验证）。
//
// 被测形态与 githttp-behavior.test.ts 同构：真实 Fastify 应用 + 文件 SQLite +
// tmp dataDir 真实 bare 仓库 + 标准 git 客户端。docs 库预置种子内容
// （notes/first.md 为 E-PATH-004 全 tree 基线用例的存量路径），roots 库留空供
// 根提交用例。断言依据 validation.md §6.3 报告协议：拒绝时 stderr 携带可解析
// 报告 JSON（含 rulesVersion/refs）。
//
// D6：断言禁全等硬编码——rulesVersion 自运行时 manifest 派生，报告按字段定位。

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
  stdout?: string;
  stderr?: string;
}

/** 断言推送被拒并返回 stderr（报告 JSON 的提取源） */
async function rejectPush(args: string[], cwd: string, pattern: RegExp): Promise<string> {
  const err = await git(args, { cwd }).then(
    () => assert.fail('推送应被拒绝'),
    (e: PushError) => e,
  );
  assert.match(String(err.stderr), pattern, `应含 ${pattern}（stderr 尾部：${String(err.stderr).slice(-800)}）`);
  return String(err.stderr);
}

async function writeMd(dir: string, file: string, body: string | Uint8Array): Promise<void> {
  const abs = path.join(dir, file);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, body);
}

/** 经 plumbing 向 index 注入条目（绕过工作区——大小写不敏感文件系统上无法共存的
 *  两路径、以及带特殊 mode 的 tree 条目夹带，都不能经普通文件写入构造） */
function pipeBlob(args: string[], cwd: string, content: string | Uint8Array): Promise<string> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = execFile('git', args, { cwd, env: GIT_ENV }, (err, stdout) =>
      err ? reject(err) : resolve(String(stdout).trim()),
    );
    child.stdin?.end(content instanceof Uint8Array ? Buffer.from(content) : content);
  });
}

async function addCacheInfo(cwd: string, mode: string, file: string, content: string | Uint8Array): Promise<void> {
  const oid = await pipeBlob(['hash-object', '-w', '--stdin'], cwd, content);
  await git(['update-index', '--add', '--cacheinfo', `${mode},${oid},${file}`], { cwd });
}

/** 服务端裸库读 blob 的原始字节（encoding:buffer 保二进制精确） */
function serverBlob(repo: string, oid: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile('git', ['--git-dir', repo, 'cat-file', 'blob', oid], { encoding: 'buffer' }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    );
  });
}

/** 从 push stderr 提取 pre-receive 输出的报告 JSON（`report:` 标记行） */
function reportFromStderr(stderr: string): Report {
  const marker = '[notegit pre-receive] report: ';
  const line = stderr
    .split('\n')
    .map((l) => l.replace(/^remote: /, ''))
    .find((l) => l.includes(marker));
  assert.ok(line, `stderr 应含报告标记行（实际尾部：${stderr.slice(-800)}）`);
  return JSON.parse(line.slice(line.indexOf(marker) + marker.length)) as Report;
}

interface Harness {
  app: FastifyInstance;
  db: DatabaseSync;
  dataDir: string;
  docsRepo: string;
  rootsRepo: string;
  port: number;
  tokens: Record<'alice' | 'bob', string>;
  urlFor(slug: string, who: 'alice' | 'bob'): string;
  close(): Promise<void>;
}

let h: Harness;

async function startHarness(): Promise<Harness> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'notegit-t4-'));
  const dbFile = path.join(dataDir, 'db', 'notegit.sqlite');
  await mkdir(path.dirname(dbFile), { recursive: true });
  const db = openDatabase(dbFile);
  migrate(db, MIGRATIONS);
  for (const ddl of FIXTURE_DDL) db.exec(ddl);

  const pepper = { active: { version: 1, key: randomBytes(32) }, retired: [] as never[] };
  const alice = addEmployee(db, { username: 'alice' });
  const bob = addEmployee(db, { username: 'bob' });

  const vaultService = new VaultService({ db, repoOps: createVaultRepoOps(dataDir) });
  // docs：种子内容（notes/first.md 为 E-PATH-004 全 tree 基线用例的存量路径）
  const docs = await vaultService.createVaultWithRepo(
    { name: 'Docs', slug: 'docs' },
    { employeeId: alice, entry: 'web', carrierRef: 'session:fixture' },
  );
  addMember(db, docs.id, bob, 'editor', alice);
  const roots = await vaultService.createVaultWithRepo(
    { name: 'Roots', slug: 'roots' },
    { employeeId: alice, entry: 'web', carrierRef: 'session:fixture' },
  );

  const credentials = new CredentialsService({ db, pepper });
  const expires = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const tokens = {} as Harness['tokens'];
  for (const [who, id] of [['alice', alice], ['bob', bob]] as const) {
    tokens[who] = credentials.createCredential(id, { name: `git-${who}`, expires_at: expires }).token;
  }

  const seed = path.join(dataDir, 'seed');
  await git(['init', '-b', 'main', seed]);
  await writeMd(seed, 'README.md', '# nav\n');
  await writeMd(seed, 'notes/first.md', '---\ntitle: First\n---\nbody\n');
  await git(['-C', seed, 'add', '.']);
  await git(['-C', seed, '-c', 'user.email=seed@notegit.test', '-c', 'user.name=seed', 'commit', '-m', 'seed']);
  const docsRepo = vaultRepoPath(dataDir, docs.id);
  await git(['-C', seed, 'push', docsRepo, 'main']);

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
    docsRepo,
    rootsRepo: vaultRepoPath(dataDir, roots.id),
    port,
    tokens,
    urlFor: (slug, who) => `http://${who}:${h.tokens[who]}@127.0.0.1:${port}/git/${slug}.git`,
    close: async () => {
      await app.close();
      db.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

before(async () => {
  h = await startHarness();
});

after(async () => {
  await h.close();
});

async function cloneDocs(who: 'alice' | 'bob', name: string): Promise<string> {
  const dir = path.join(h.dataDir, name);
  await git(['clone', h.urlFor('docs', who), dir]);
  await git(['-C', dir, 'config', 'user.email', `${who}@notegit.test`]);
  await git(['-C', dir, 'config', 'user.name', who]);
  return dir;
}

async function cloneRoots(): Promise<string> {
  const dir = path.join(h.dataDir, 'clone-roots');
  await git(['clone', h.urlFor('roots', 'alice'), dir]);
  await git(['-C', dir, 'config', 'user.email', 'alice@notegit.test']);
  await git(['-C', dir, 'config', 'user.name', 'alice']);
  return dir;
}

async function commitAll(cwd: string, message: string): Promise<string> {
  await git(['-C', cwd, 'add', '.']);
  await git(['-C', cwd, 'commit', '-m', message]);
  return (await git(['-C', cwd, 'rev-parse', 'HEAD'])).stdout.trim();
}

async function serverRef(repo: string, ref: string): Promise<string> {
  return (await git(['--git-dir', repo, 'rev-parse', ref])).stdout.trim();
}

/** 审计挂接点文件（T6 消费）：pre-receive 每次运行原子写入的校验报告落盘 */
const auditReportPath = (repo: string) => path.join(repo, 'notegit-validation.json');

// ── 防绕过清单逐条（validation.md §1；breakdown S3-T4 完成标准） ──────────────

test('防绕过①：无 hook 客户端 + --no-verify 推违规内容被拒——服务端是最终防线（E-FM-001 进报告）', async () => {
  const clone = await cloneDocs('alice', 'clone-bypass1');
  // 克隆不携带任何生效 hook（无 hook 客户端形态：hook 不随 clone 分发）
  const hooks = await readdir(path.join(clone, '.git', 'hooks'));
  assert.deepEqual(
    hooks.filter((f) => !f.endsWith('.sample')),
    [],
    '克隆应无任何生效 hook',
  );
  await writeMd(clone, 'notes/no-fm.md', 'no frontmatter at all\n');
  const bad = await commitAll(clone, 'bad content');
  const stderr = await rejectPush(['push', '--no-verify', 'origin', 'main'], clone, /no-fm\.md/);
  const report = reportFromStderr(stderr);
  assert.equal(report.rulesVersion, rulesVersion(), '报告须标规则版本（validation.md §6.3）');
  assert.equal(report.scope, 'pre-receive');
  assert.equal(report.result, 'fail');
  const f = report.files.find((x) => x.path === 'notes/no-fm.md');
  assert.equal(f?.status, 'fail');
  assert.equal(f?.commit, bad, 'files[].commit 归因到引入提交');
  assert.ok(f?.issues.some((i) => i.code === 'E-FM-001'));
  assert.equal(report.refs?.every((r) => r.outcome === 'rejected'), true);
  await git(['-C', clone, 'reset', '--hard', 'origin/main']);
});

test('防绕过②：先写坏后删被拒且 ref 不变——违规内容先进历史即拦截（逐提交归因）', async () => {
  const clone = await cloneDocs('bob', 'clone-write-del');
  const before = await serverRef(h.docsRepo, 'refs/heads/main');
  await writeMd(clone, 'notes/bad.md', 'no frontmatter at all\n');
  const badCommit = await commitAll(clone, 'add bad');
  await git(['-C', clone, 'rm', '-q', 'notes/bad.md']);
  await commitAll(clone, 'remove bad');
  const stderr = await rejectPush(['push', 'origin', 'main'], clone, /bad\.md/);
  const report = reportFromStderr(stderr);
  const f = report.files.find((x) => x.path === 'notes/bad.md');
  assert.equal(f?.commit, badCommit, '归因到引入坏内容的提交（非删除提交）');
  assert.ok(f?.issues.some((i) => i.code === 'E-FM-001'));
  assert.equal(await serverRef(h.docsRepo, 'refs/heads/main'), before, '被拒推送后服务端 ref 不变');
  await git(['-C', clone, 'reset', '--hard', 'origin/main']);
});

test('防绕过③：合并夹带被拒——evil merge 中两父皆无的违规文件进校验（E-FM-001）', async () => {
  const clone = await cloneDocs('alice', 'clone-merge');
  await writeMd(clone, 'notes/base.md', '---\ntitle: Base\n---\nbody\n');
  await commitAll(clone, 'base');
  await git(['-C', clone, 'push', 'origin', 'main']);
  await git(['-C', clone, 'checkout', '-q', '-b', 'feat']);
  await writeMd(clone, 'notes/feat.md', '---\ntitle: Feat\n---\nbody\n');
  await commitAll(clone, 'feat work');
  await git(['-C', clone, 'checkout', '-q', 'main']);
  // evil merge：--no-commit 合并后手工塞入两父皆不存在的违规文件
  await git(['-C', clone, 'merge', '--no-ff', '--no-commit', 'feat']);
  await writeMd(clone, 'notes/smuggled.md', 'smuggled without frontmatter\n');
  await git(['-C', clone, 'add', '.']);
  await git(['-C', clone, 'commit', '-m', 'evil merge']);
  const stderr = await rejectPush(['push', 'origin', 'main'], clone, /smuggled\.md/);
  const report = reportFromStderr(stderr);
  const f = report.files.find((x) => x.path === 'notes/smuggled.md');
  assert.ok(f?.issues.some((i) => i.code === 'E-FM-001'), '合并夹带文件按父比较后被抓出');
  await git(['-C', clone, 'reset', '--hard', 'origin/main']);
});

test('良性合并不误拒：合并已在服务端的分支（文件内容等于一父）→ 接受', async () => {
  const clone = await cloneDocs('bob', 'clone-merge-ok');
  await git(['-C', clone, 'checkout', '-q', '-b', 'topic']);
  await writeMd(clone, 'notes/topic.md', '---\ntitle: Topic\n---\nbody\n');
  await commitAll(clone, 'topic work');
  await git(['-C', clone, 'push', 'origin', 'topic']);
  await git(['-C', clone, 'checkout', '-q', 'main']);
  await git(['-C', clone, 'merge', '--no-ff', '-m', 'merge topic', 'origin/topic']);
  await git(['-C', clone, 'push', 'origin', 'main']);
  const audit = JSON.parse(await readFile(auditReportPath(h.docsRepo), 'utf8')) as Report;
  assert.equal(audit.result, 'pass', '等于某一父版本的文件不重判（合并不因存量内容被拒）');
});

test('根提交全检：空库首推含违规文件被拒；合规根提交被接受（README 豁免生效）', async () => {
  const clone = await cloneRoots();
  await writeMd(clone, 'README.md', '# nav\n无 frontmatter 的导航文档\n');
  await writeMd(clone, 'notes/root-bad.md', 'no frontmatter\n');
  await commitAll(clone, 'root with bad');
  const stderr = await rejectPush(['push', 'origin', 'main'], clone, /root-bad\.md/);
  const report = reportFromStderr(stderr);
  assert.ok(report.files.some((f) => f.path === 'notes/root-bad.md' && f.issues.some((i) => i.code === 'E-FM-001')));
  // 违规历史已进本地——原克隆删除后重推仍应被拒（逐提交语义；防绕过② 同源）
  await git(['-C', clone, 'rm', '-q', 'notes/root-bad.md']);
  await commitAll(clone, 'remove bad');
  await rejectPush(['push', 'origin', 'main'], clone, /root-bad\.md/);
  // 合规根提交：新克隆全新首推（坏历史不在其历史中）
  const fresh = path.join(h.dataDir, 'clone-roots-fresh');
  await git(['clone', h.urlFor('roots', 'alice'), fresh]);
  await git(['-C', fresh, 'config', 'user.email', 'alice@notegit.test']);
  await git(['-C', fresh, 'config', 'user.name', 'alice']);
  await writeMd(fresh, 'README.md', '# nav\n无 frontmatter 的导航文档\n');
  await writeMd(fresh, 'notes/root-ok.md', '---\ntitle: Root\n---\nbody\n');
  await commitAll(fresh, 'root ok');
  await git(['-C', fresh, 'push', 'origin', 'main']);
  const audit = JSON.parse(await readFile(auditReportPath(h.rootsRepo), 'utf8')) as Report;
  assert.equal(audit.result, 'pass');
  const readme = audit.files.find((f) => f.path === 'README.md');
  assert.equal(readme?.exempt, true, 'README 在报告中标注豁免');
});

test('防绕过⑤：一次 push 多 ref 含一个违规 → 全部 rejected（报告 refs 断言；服务端零 ref 更新）', async () => {
  const clone = await cloneDocs('alice', 'clone-multiref');
  const mainBefore = await serverRef(h.docsRepo, 'refs/heads/main');
  await writeMd(clone, 'notes/multi-good.md', '---\ntitle: MultiGood\n---\nbody\n');
  await commitAll(clone, 'good on main');
  await git(['-C', clone, 'branch', 'bad-branch']);
  await git(['-C', clone, 'checkout', '-q', 'bad-branch']);
  await writeMd(clone, 'notes/multi-evil.md', 'missing title here\n');
  await commitAll(clone, 'evil on bad-branch');
  await git(['-C', clone, 'checkout', '-q', 'main']);
  const stderr = await rejectPush(['push', 'origin', 'main', 'bad-branch'], clone, /multi-evil\.md/);
  const report = reportFromStderr(stderr);
  // 报告 refs 断言：两个 ref 全部 rejected（全有或全无，架构 §5.4）
  const refNames = (report.refs ?? []).map((r) => r.ref).sort();
  assert.deepEqual(refNames, ['refs/heads/bad-branch', 'refs/heads/main']);
  assert.equal(report.refs?.every((r) => r.outcome === 'rejected'), true);
  assert.equal(report.result, 'fail');
  // 服务端侧：合规 ref 也不得更新（pre-receive 拒绝即整包回滚的原生语义）
  assert.equal(await serverRef(h.docsRepo, 'refs/heads/main'), mainBefore, '合规 ref 不得被更新');
  const refs = (await git(['--git-dir', h.docsRepo, 'for-each-ref', '--format=%(refname)'])).stdout;
  assert.doesNotMatch(refs, /bad-branch/);
  await git(['-C', clone, 'branch', '-D', 'bad-branch']);
  await git(['-C', clone, 'reset', '--hard', 'origin/main']);
});

test('防绕过⑥：tag 写入被拒——轻量与附注 tag 均不接受（第一版不提供 tag 写入）', async () => {
  const clone = await cloneDocs('alice', 'clone-tags');
  await writeMd(clone, 'notes/tagged.md', '---\ntitle: Tagged\n---\nbody\n');
  await commitAll(clone, 'to tag');
  await git(['-C', clone, 'tag', 'v-light']);
  await git(['-C', clone, 'tag', '-a', 'v-annot', '-m', 'annotated']);
  await rejectPush(['push', 'origin', 'v-light'], clone, /tag/i);
  await rejectPush(['push', 'origin', 'v-annot'], clone, /tag/i);
  const refs = (await git(['--git-dir', h.docsRepo, 'for-each-ref', '--format=%(refname)'])).stdout;
  assert.doesNotMatch(refs, /refs\/tags\//, '服务端不得出现任何 tag ref');
  await git(['-C', clone, 'reset', '--hard', 'origin/main']);
});

test('E-PATH-004 全 tree 基线：新增路径与库内存量路径大小写冲突被拒（actual=存量路径）', async () => {
  const clone = await cloneDocs('alice', 'clone-case');
  // 种子已有 notes/first.md；经 plumbing 加入 Notes/First.md（大小写不敏感文件系统上两者无法在工作区共存）
  await addCacheInfo(clone, '100644', 'Notes/First.md', '---\ntitle: Collision\n---\nbody\n');
  await git(['-C', clone, 'commit', '-m', 'add case-variant']);
  const stderr = await rejectPush(['push', 'origin', 'main'], clone, /First\.md/);
  const report = reportFromStderr(stderr);
  const f = report.files.find((x) => x.path === 'Notes/First.md');
  const conflict = f?.issues.find((i) => i.code === 'E-PATH-004');
  assert.equal(conflict?.actual, 'notes/first.md', '冲突对端应为库内存量路径');
  await git(['-C', clone, 'reset', '--hard', 'origin/main']);
});

test('危险 tree 条目经 index 夹带被拒：symlink（mode 120000）→ E-PATH-002', async () => {
  const clone = await cloneDocs('alice', 'clone-tree');
  await addCacheInfo(clone, '120000', 'notes/evil-link', '/etc/passwd');
  await git(['-C', clone, 'commit', '-m', 'smuggle symlink']);
  const stderr = await rejectPush(['push', 'origin', 'main'], clone, /evil-link/);
  const report = reportFromStderr(stderr);
  const f = report.files.find((x) => x.path === 'notes/evil-link');
  assert.ok(f?.issues.some((i) => i.code === 'E-PATH-002'), 'symlink 条目被拒（架构 §9）');
  await git(['-C', clone, 'reset', '--hard', 'origin/main']);
});

test('附件类型清单制：.png 二进制附件字节精确接受；清单外 .svg 被拒（E-LIMIT-002）', async () => {
  const clone = await cloneDocs('alice', 'clone-attach');
  const png = randomBytes(64);
  await writeMd(clone, 'assets/logo.png', png);
  await commitAll(clone, 'add png');
  await git(['-C', clone, 'push', 'origin', 'main']);
  // 服务端 blob 字节与推送内容一致（校验路径不破坏二进制）
  const oid = (await git(['-C', clone, 'rev-parse', 'HEAD:assets/logo.png'])).stdout.trim();
  const serverBytes = await serverBlob(h.docsRepo, oid);
  assert.ok(serverBytes.equals(Buffer.from(png)), '服务端 blob 应与推送字节全等');
  // svg 默认排除（validation.md §5.1：可内嵌脚本属安全边界）
  await writeMd(clone, 'assets/evil.svg', Buffer.from('<svg onload="x"/>'));
  await commitAll(clone, 'add svg');
  const stderr = await rejectPush(['push', 'origin', 'main'], clone, /evil\.svg/);
  const report = reportFromStderr(stderr);
  const f = report.files.find((x) => x.path === 'assets/evil.svg');
  assert.ok(f?.issues.some((i) => i.code === 'E-LIMIT-002'));
  await git(['-C', clone, 'reset', '--hard', 'origin/main']);
});

test('审计挂接点：每次 receive 校验报告原子落盘（T6 消费；含 rulesVersion 与 refs）', async () => {
  const clone = await cloneDocs('bob', 'clone-audit');
  await writeMd(clone, 'notes/audit-ok.md', '---\ntitle: Audit\n---\nbody\n');
  await commitAll(clone, 'audit pass');
  await git(['-C', clone, 'push', 'origin', 'main']);
  const mainAfterGood = await serverRef(h.docsRepo, 'refs/heads/main');
  const auditPass = JSON.parse(await readFile(auditReportPath(h.docsRepo), 'utf8')) as Report;
  assert.equal(auditPass.result, 'pass');
  assert.equal(auditPass.scope, 'pre-receive');
  assert.equal(auditPass.rulesVersion, rulesVersion());
  assert.ok(
    auditPass.refs?.some((r) => r.ref === 'refs/heads/main' && r.outcome === 'accepted' && r.headNew === mainAfterGood),
    '通过报告记录 ref 终值',
  );

  await writeMd(clone, 'notes/audit-bad.md', 'no fm\n');
  await commitAll(clone, 'audit fail');
  await rejectPush(['push', 'origin', 'main'], clone, /audit-bad\.md/);
  const auditFail = JSON.parse(await readFile(auditReportPath(h.docsRepo), 'utf8')) as Report;
  assert.equal(auditFail.result, 'fail', '拒绝后挂接点文件更新为失败报告');
  assert.ok(auditFail.files.some((f) => f.path === 'notes/audit-bad.md'));
  assert.equal(await serverRef(h.docsRepo, 'refs/heads/main'), mainAfterGood, '拒绝推送不移动 ref');
  await git(['-C', clone, 'reset', '--hard', 'origin/main']);
});
