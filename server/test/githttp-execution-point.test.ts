import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
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

// S3-T5 写路径执行点复查行为测试（implementation-breakdown §2.2 S3-T5 行；identity
// §5.1 第 3 层 / §5.2 行 4；架构 §4.3）。
//
// 被测物 = 真实产品 update hook（git 在每个 ref 实际更新前以 argv 逐 ref 调用：
// update <refname> <old> <new>，exit 非 0 只拒该 ref）。「检查后、执行点前」的
// 在途窗口无法在一次 HTTP push 内确定性注入撤权时点，故按 git 的调用契约直接
// 以相同 argv + 环境变量（REMOTE_USER/NOTEGIT_*，由 CGI 层组装——http-backend.ts）
// 调起 hook 子进程：前置的认证与 pre-receive 通过由同库的真实 HTTP push 先行证明，
// 随后落撤权/降级/改配置，再触发执行点——序列与真实在途窗口一致且完全确定。
//
// 原生配置语义边界（denyNonFastForwards 全分支 / denyDeleteCurrent 护 HEAD 目标 /
// denyDeletes 不设）同文件验证。全路径三态（main_admin_only 关→开→管理员）走真实
// HTTP push。审计断言全部派生自测试内实际值（D6：禁全等硬编码）。

const run = promisify(execFile);

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
};

async function git(args: string[], opts: { cwd?: string } = {}): Promise<{ stdout: string; stderr: string }> {
  return run('git', args, { ...opts, env: GIT_ENV });
}

async function writeMd(dir: string, file: string, body: string): Promise<void> {
  const abs = path.join(dir, file);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, body);
}

const updateTsPath = fileURLToPath(new URL('../src/githttp/update.ts', import.meta.url));

interface HookRun {
  code: number;
  stderr: string;
}

/** 按 git 的调用契约直接调起产品 update hook（argv + CGI 层组装的环境变量） */
async function runUpdateHook(
  env: NodeJS.ProcessEnv,
  refname: string,
  oldOid: string,
  newOid: string,
): Promise<HookRun> {
  return new Promise((resolve) => {
    const child = execFile(
      'node',
      [updateTsPath, refname, oldOid, newOid],
      { env: { ...process.env, ...env }, timeout: 15_000 },
      (err, _stdout, stderr) => {
        const code = err === null ? 0 : typeof (err as { code?: number }).code === 'number' ? (err as { code: number }).code : -1;
        resolve({ code, stderr: String(stderr ?? '') });
      },
    );
    child.stdin?.end(); // git 不向 update hook 提供 stdin 且立即关闭——占位直通实现依赖 EOF 退出
  });
}

interface ExecHarness {
  app: FastifyInstance;
  db: DatabaseSync;
  dbFile: string;
  dataDir: string;
  docsRepo: string;
  vaultId: number;
  /** bob 的稳定 ref 命令素材（真实克隆上的真实提交） */
  bobClone: string;
  bobChildOid: string;
  mainOid: string;
  alice: { employeeId: number; credentialId: number };
  bob: { employeeId: number; credentialId: number };
  /** 带 Basic 凭据的 /git URL */
  urlFor: (who: 'alice' | 'bob') => string;
  close(): Promise<void>;
}

let x: ExecHarness;

async function startExecHarness(): Promise<ExecHarness> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'notegit-execpoint-'));
  const dbFile = path.join(dataDir, 'db', 'notegit.sqlite');
  await mkdir(path.dirname(dbFile), { recursive: true });
  const db = openDatabase(dbFile);
  migrate(db, MIGRATIONS);
  for (const ddl of FIXTURE_DDL) db.exec(ddl);

  const pepper = { active: { version: 1, key: randomBytes(32) }, retired: [] as never[] };
  const aliceId = addEmployee(db, { username: 'alice' });
  const bobId = addEmployee(db, { username: 'bob' });

  // 建库（main_admin_only=0 起步——三态测试从「关」开始）+ alice=admin、bob=editor
  const vaultService = new VaultService({ db, repoOps: createVaultRepoOps(dataDir) });
  const docs = await vaultService.createVaultWithRepo(
    { name: 'Docs', slug: 'docs' },
    { employeeId: aliceId, entry: 'web', carrierRef: 'session:fixture' },
  );
  addMember(db, docs.id, bobId, 'editor', aliceId);

  const credentials = new CredentialsService({ db, pepper });
  const expires = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const aliceCred = credentials.createCredential(aliceId, { name: 'git-alice', expires_at: expires });
  const bobCred = credentials.createCredential(bobId, { name: 'git-bob', expires_at: expires });

  // 种子 main（file 传输直推 bare 库）+ bob 经 HTTP 克隆并造一个真实子提交
  const docsRepo = vaultRepoPath(dataDir, docs.id);
  const seed = path.join(dataDir, 'seed');
  await git(['init', '-b', 'main', seed]);
  await writeMd(seed, 'README.md', '# nav\n');
  await writeMd(seed, 'notes/first.md', '---\ntitle: First\n---\nbody\n');
  await git(['-C', seed, 'add', '.']);
  await git(['-C', seed, '-c', 'user.email=seed@notegit.test', '-c', 'user.name=seed', 'commit', '-m', 'seed']);
  await git(['-C', seed, 'push', docsRepo, 'main']);
  const mainOid = (await git(['--git-dir', docsRepo, 'rev-parse', 'main'])).stdout.trim();

  const app = buildApp({
    db,
    pepper,
    bootstrapTokenFile: path.join(dataDir, 'config', 'admin-bootstrap.token'),
    dataDir,
    dbFile,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = app.addresses()[0]!.port;

  const tokens = { alice: aliceCred.token, bob: bobCred.token };
  const urlFor = (who: 'alice' | 'bob') => `http://${who}:${tokens[who]}@127.0.0.1:${port}/git/docs.git`;

  const bobClone = path.join(dataDir, 'bob-clone');
  await git(['clone', urlFor('bob'), bobClone]);
  await git(['-C', bobClone, 'config', 'user.email', 'bob@notegit.test']);
  await git(['-C', bobClone, 'config', 'user.name', 'bob']);
  await writeMd(bobClone, 'notes/by-bob.md', '---\ntitle: ByBob\n---\nbody\n');
  await git(['-C', bobClone, 'add', '.']);
  await git(['-C', bobClone, 'commit', '-m', 'bob child']);
  const bobChildOid = (await git(['-C', bobClone, 'rev-parse', 'HEAD'])).stdout.trim();

  return {
    app,
    db,
    dbFile,
    dataDir,
    docsRepo,
    vaultId: docs.id,
    bobClone,
    bobChildOid,
    mainOid,
    alice: { employeeId: aliceId, credentialId: aliceCred.record.id },
    bob: { employeeId: bobId, credentialId: bobCred.record.id },
    urlFor,
    close: async () => {
      await app.close();
      db.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

before(async () => {
  x = await startExecHarness();
});

after(async () => {
  await x.close();
});

// ── 测试内状态手术（真实 SQL，与应用同库） ────────────────────────────────────

function setBobRole(role: 'editor' | 'reader' | 'admin'): void {
  x.db.prepare('UPDATE vault_members SET role = ? WHERE vault_id = ? AND employee_id = ?').run(
    role,
    x.vaultId,
    x.bob.employeeId,
  );
}

function removeBobMembership(): void {
  x.db
    .prepare('DELETE FROM vault_members WHERE vault_id = ? AND employee_id = ?')
    .run(x.vaultId, x.bob.employeeId);
}

function restoreBob(role: 'editor' | 'reader' | 'admin' = 'editor'): void {
  removeBobMembership();
  addMember(x.db, x.vaultId, x.bob.employeeId, role, x.alice.employeeId);
}

function setMainAdminOnly(on: boolean): void {
  x.db.prepare('UPDATE vaults SET main_admin_only = ? WHERE id = ?').run(on ? 1 : 0, x.vaultId);
}

/** hook 环境变量（与 http-backend.ts CGI 组装一致——REMOTE_USER/NOTEGIT_*） */
function hookEnv(who: 'alice' | 'bob'): NodeJS.ProcessEnv {
  const subject = who === 'bob' ? x.bob : x.alice;
  return {
    REMOTE_USER: `${subject.employeeId}:${subject.credentialId}`,
    NOTEGIT_DB: x.dbFile,
    NOTEGIT_VAULT_ID: String(x.vaultId),
    NOTEGIT_VAULT_SLUG: 'docs',
    GIT_DIR: x.docsRepo,
  };
}

interface AuditRow {
  id: number;
  actor_kind: string;
  employee_id: number | null;
  credential_ref: string | null;
  entry: string;
  event_kind: string;
  vault_id: number | null;
  ref_name: string | null;
  old_commit: string | null;
  new_commit: string | null;
  status: string;
  detail: string;
}

function latestPushAudit(): AuditRow | undefined {
  return x.db
    .prepare(`SELECT * FROM audit_events WHERE event_kind = 'vault.push' ORDER BY id DESC LIMIT 1`)
    .get() as AuditRow | undefined;
}

function pushAuditCount(): number {
  return (x.db.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE event_kind = 'vault.push'`).get() as { n: number }).n;
}

const ZERO_OID = '0'.repeat(40);
const FEATURE_REF = 'refs/heads/feature/in-flight';

// ── 写路径执行点复查（identity §5.1 第 3 层 / §5.2 行 4） ────────────────────

test('前置事实：bob（编辑者）经完整 HTTP push 通过认证、pre-receive 与执行点（main_admin_only=0）', async () => {
  await git(['-C', x.bobClone, 'push', x.urlFor('bob'), `HEAD:refs/heads/feature/base`]);
  const remote = (await git(['--git-dir', x.docsRepo, 'rev-parse', 'refs/heads/feature/base'])).stdout.trim();
  assert.equal(remote, x.bobChildOid, '服务端 ref 应等于 bob 客户端 HEAD');
});

test('在途撤权：检查后、执行点前移除成员关系 → update hook 拒绝并记审计（rejected）', async () => {
  // 此时认证与 pre-receive 均已按通过时刻放行（上一测试的完整 push 已证明），
  // 撤权落在 pre-receive 之后、本次 ref 的执行点之前——identity §5.2 行 4 在途窗口。
  removeBobMembership();
  try {
    const r = await runUpdateHook(hookEnv('bob'), FEATURE_REF, ZERO_OID, x.bobChildOid);
    assert.notEqual(r.code, 0, '执行点复查发现撤权必须拒绝（exit 非 0）');
    assert.match(r.stderr, /无成员关系|撤权/, '拒绝原因应指明成员关系已不存在（在途撤权）');

    const row = latestPushAudit();
    assert.ok(row, '拒绝必须落审计行（vault.push）');
    assert.equal(row.event_kind, 'vault.push');
    assert.equal(row.status, 'rejected');
    assert.equal(row.entry, 'git');
    assert.equal(row.employee_id, x.bob.employeeId, '主体 = 认证员工（架构 §4.4，不信任 commit author）');
    assert.equal(row.credential_ref, `credential:${x.bob.credentialId}`, '凭据载体标识随认证透传（identity §8）');
    assert.equal(row.vault_id, x.vaultId);
    assert.equal(row.ref_name, FEATURE_REF);
    assert.equal(row.old_commit, ZERO_OID);
    assert.equal(row.new_commit, x.bobChildOid);
    const detail = JSON.parse(row.detail) as Record<string, unknown>;
    assert.match(String(detail['reason'] ?? ''), /无成员关系|撤权/, 'detail.reason 记录拒绝原因');
  } finally {
    restoreBob('editor');
  }
});

test('在途降级为只读：执行点复查按当前角色判定 → 只读成员任何 push 被拒', async () => {
  setBobRole('reader');
  try {
    const r = await runUpdateHook(hookEnv('bob'), FEATURE_REF, ZERO_OID, x.bobChildOid);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /只读成员/, '拒绝原因应指明只读成员不可推送');
    const row = latestPushAudit();
    assert.ok(row, '拒绝必须落审计行');
    assert.equal(row.status, 'rejected');
    assert.equal(row.employee_id, x.bob.employeeId);
  } finally {
    restoreBob('editor');
  }
});

test('在途开 main_admin_only：编辑者对默认分支的快进在执行点被拒；管理员放行且不产生拒绝审计', async () => {
  setMainAdminOnly(true);
  try {
    // 编辑者：pre-receive 通过时刻 flag 尚未开启的对称命令，在执行点按当前配置复查
    const denied = await runUpdateHook(hookEnv('bob'), 'refs/heads/main', x.mainOid, x.bobChildOid);
    assert.notEqual(denied.code, 0);
    assert.match(denied.stderr, /main_admin_only|仅库管理员/, '拒绝原因应指明 main_admin_only 已开启');

    const rejectedRow = latestPushAudit();
    assert.ok(rejectedRow, '编辑者被拒须落审计');
    assert.equal(rejectedRow.status, 'rejected');
    assert.equal(rejectedRow.employee_id, x.bob.employeeId);
    assert.equal(rejectedRow.ref_name, 'refs/heads/main');

    // 管理员：同命令在执行点放行（库管理员不受 main_admin_only 约束）
    const before = pushAuditCount();
    const allowed = await runUpdateHook(hookEnv('alice'), 'refs/heads/main', x.mainOid, x.bobChildOid);
    assert.equal(allowed.code, 0, '管理员写默认分支应放行');
    assert.equal(pushAuditCount(), before, '放行不产生拒绝审计（成功审计预记录属 S3-T6）');
  } finally {
    setMainAdminOnly(false);
  }
});

test('配置关闭态：编辑者对默认分支快进在执行点放行（三态之「关→编辑者放行」）', async () => {
  setMainAdminOnly(false);
  const before = pushAuditCount();
  const r = await runUpdateHook(hookEnv('bob'), 'refs/heads/main', x.mainOid, x.bobChildOid);
  assert.equal(r.code, 0, 'main_admin_only 关闭时编辑者快进默认分支应放行（架构 §4.3 默认）');
  assert.equal(pushAuditCount(), before, '放行不写拒绝审计');
});

test('环境缺失 fail-closed：NOTEGIT_DB 缺失时执行点拒绝（不误放行）', async () => {
  const env = { ...hookEnv('bob') };
  delete env['NOTEGIT_DB'];
  const r = await runUpdateHook(env, FEATURE_REF, ZERO_OID, x.bobChildOid);
  assert.notEqual(r.code, 0, '环境缺失必须 fail-closed 拒绝');
  assert.match(r.stderr, /环境缺失|fail-closed/);
});

// ── 原生配置语义边界（receive.* 补全与验证） ─────────────────────────────────

test('原生配置：receive.denyDeleteCurrent=true 落库（删除默认分支的原生防线），denyDeletes 不设', async () => {
  // 触发 ensureReceiveSetup（幂等——任一 receive-pack 请求即完成仓库服务侧准备）
  const probe = x.bobClone;
  await writeMd(probe, 'notes/probe.md', '---\ntitle: Probe\n---\nbody\n');
  await git(['-C', probe, 'add', '.']);
  await git(['-C', probe, 'commit', '-m', 'probe']);
  await git(['-C', probe, 'push', x.urlFor('bob'), 'HEAD:refs/heads/feature/probe']);

  const denyDeleteCurrent = (
    await git(['--git-dir', x.docsRepo, 'config', '--default', '', 'receive.denyDeleteCurrent'])
  ).stdout.trim();
  assert.equal(denyDeleteCurrent, 'true', 'T5 补全：bare 库 HEAD 目标分支删除的原生拒绝');

  // denyDeletes 必须不设：非默认分支删除是编辑者的合法操作（架构 §4.3）
  const denyDeletes = (
    await git(['--git-dir', x.docsRepo, 'config', '--default', '', 'receive.denyDeletes'])
  ).stdout.trim();
  assert.equal(denyDeletes, '', 'denyDeletes 全局禁删会误伤非默认分支删除——不得设置');
});

test('原生防线行为：管理员经 HTTP 删除默认分支被拒且 ref 不变（native + hook 双层）', async () => {
  const before = (await git(['--git-dir', x.docsRepo, 'rev-parse', 'main'])).stdout.trim();
  const aliceClone = path.join(x.dataDir, 'alice-clone');
  await git(['clone', x.urlFor('alice'), aliceClone]);
  await assert.rejects(
    git(['-C', aliceClone, 'push', 'origin', ':main']),
    (e: Error & { stderr?: string }) =>
      /deletion of the current branch|删除默认分支|delete.*main/i.test(String(e.stderr)),
    '默认分支删除应被拒（原生 denyDeleteCurrent 或 hook 规则任一层）',
  );
  const after = (await git(['--git-dir', x.docsRepo, 'rev-parse', 'main'])).stdout.trim();
  assert.equal(after, before, '被拒后服务端 ref 必须保持不变');
});

test('denyNonFastForwards 语义边界：force push 对非默认分支同样被拒且 ref 不变（全分支生效）', async () => {
  // 自 origin/main（种子）分叉——不包含 feature/base 的头（bobChild），强推才构成非快进
  await git(['-C', x.bobClone, 'fetch', '-q', 'origin']);
  await git(['-C', x.bobClone, 'checkout', '-q', '-B', 'diverge', 'origin/main']);
  await writeMd(x.bobClone, 'notes/diverge.md', '---\ntitle: Diverge\n---\nbody\n');
  await git(['-C', x.bobClone, 'add', '.']);
  await git(['-C', x.bobClone, 'commit', '-m', 'diverged']);
  const baseBefore = (await git(['--git-dir', x.docsRepo, 'rev-parse', 'refs/heads/feature/base'])).stdout.trim();
  await assert.rejects(
    git(['-C', x.bobClone, 'push', '--force', x.urlFor('bob'), 'diverge:refs/heads/feature/base']),
    (e: Error & { stderr?: string }) => /non-fast-forward|fetch first|rejected/i.test(String(e.stderr)),
    'denyNonFastForwards 对全部分支生效（架构 §4.3：非默认分支也仅允许快进更新）',
  );
  const baseAfter = (await git(['--git-dir', x.docsRepo, 'rev-parse', 'refs/heads/feature/base'])).stdout.trim();
  assert.equal(baseAfter, baseBefore, '被拒后服务端 ref 必须保持不变');
});

test('非默认分支删除：编辑者经 HTTP 删除成功（denyDeletes 不设的行为证明）', async () => {
  await git(['-C', x.bobClone, 'push', x.urlFor('bob'), ':refs/heads/feature/probe']);
  const refs = (await git(['--git-dir', x.docsRepo, 'for-each-ref', '--format=%(refname)'])).stdout;
  assert.doesNotMatch(refs, /refs\/heads\/feature\/probe/, '非默认分支应已被编辑者删除');
});

// ── main_admin_only 三态全路径（真实 HTTP push；配置生效测试） ────────────────

test('main_admin_only 配置生效三态（HTTP 全路径）：关→编辑者快进 main 成功；开→编辑者被拒且 ref 不变；开→管理员成功', async () => {
  // 态一：关——编辑者快进 main（先回到 bobChild——本地 main 已被 probe/diverge 提交前移，
  // bobChild 即 main 的快进子提交：seed main → bobChild）
  setMainAdminOnly(false);
  await git(['-C', x.bobClone, 'checkout', '-q', '-B', 'to-main', x.bobChildOid]);
  await git(['-C', x.bobClone, 'push', x.urlFor('bob'), 'HEAD:main']);
  const afterEditor = (await git(['--git-dir', x.docsRepo, 'rev-parse', 'main'])).stdout.trim();
  assert.equal(afterEditor, x.bobChildOid, '关闭态编辑者快进 main 应成功');
  x.mainOid = x.bobChildOid; // main 已前移，后续场景以新值为基线

  // bob 的下一个子提交（三态之二的被拒对象）
  await writeMd(x.bobClone, 'notes/next.md', '---\ntitle: Next\n---\nbody\n');
  await git(['-C', x.bobClone, 'add', '.']);
  await git(['-C', x.bobClone, 'commit', '-m', 'next']);
  const bobNextOid = (await git(['-C', x.bobClone, 'rev-parse', 'HEAD'])).stdout.trim();
  assert.notEqual(bobNextOid, x.mainOid);

  // 态二：开——编辑者被拒，ref 不变
  setMainAdminOnly(true);
  await assert.rejects(
    git(['-C', x.bobClone, 'push', x.urlFor('bob'), 'HEAD:main']),
    (e: Error & { stderr?: string }) => /main_admin_only|仅库管理员|仅管理员/.test(String(e.stderr)),
    '开启态编辑者写默认分支应被拒',
  );
  const unchanged = (await git(['--git-dir', x.docsRepo, 'rev-parse', 'main'])).stdout.trim();
  assert.equal(unchanged, x.mainOid, '被拒后服务端 ref 必须保持不变');

  // 态三：开——管理员不受限
  const aliceClone = path.join(x.dataDir, 'alice-clone-3state');
  await git(['clone', x.urlFor('alice'), aliceClone]);
  await writeMd(aliceClone, 'notes/by-alice.md', '---\ntitle: ByAlice\n---\nbody\n');
  await git(['-C', aliceClone, 'add', '.']);
  await git(['-C', aliceClone, '-c', 'user.email=alice@notegit.test', '-c', 'user.name=alice', 'commit', '-m', 'by alice']);
  await git(['-C', aliceClone, 'push', 'origin', 'main']);
  const afterAdmin = (await git(['--git-dir', x.docsRepo, 'rev-parse', 'main'])).stdout.trim();
  const aliceHead = (await git(['-C', aliceClone, 'rev-parse', 'HEAD'])).stdout.trim();
  assert.equal(afterAdmin, aliceHead, '开启态管理员快进 main 应成功');
  x.mainOid = afterAdmin;
  setMainAdminOnly(false);
});
