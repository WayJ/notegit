import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, constants as fsConstants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

// S3-T2 Git Smart HTTP 行为测试（implementation-breakdown §2.2 S3-T2 行；D5：
// route-b 7 项行为测试产品级复刻——被测物是产品代码本身，spike 仅测试结构参照）。
//
// 被测形态 = 真实 Fastify 应用（listen 于 127.0.0.1 随机端口）+ 文件 SQLite
// （pre-receive hook 子进程须能直连同一库文件）+ tmp dataDir 真实 bare 仓库 +
// 标准 git 客户端（D10 路线 B：Node 包装 git http-backend CGI）。
//
// 成员矩阵（vault docs，main_admin_only=1）：alice=admin（创建者）、bob=editor、
// carol=reader、dave=非成员；maint=实例管理员（维护模式切换用）。
// 认证 = HTTP Basic（用户名任意 + ngt_ token 作口令，identity §3.1）。

const run = promisify(execFile);

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0', // 凭据提示一律快速失败，不挂起
  GIT_CONFIG_NOSYSTEM: '1', // 隔离系统级 gitconfig（macOS keychain helper 等）
  GIT_CONFIG_GLOBAL: '/dev/null', // 隔离用户级 gitconfig
};

async function git(args: string[], opts: { cwd?: string } = {}): Promise<{ stdout: string; stderr: string }> {
  return run('git', args, { ...opts, env: GIT_ENV });
}

async function writeMd(dir: string, file: string, body: string): Promise<void> {
  const abs = path.join(dir, file);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, body);
}

interface GitHarness {
  app: FastifyInstance;
  db: DatabaseSync;
  dataDir: string;
  pepper: { active: { version: number; key: Buffer }; retired: never[] };
  /** vault docs 的 bare 仓库映射路径（vaultRepoPath，稳定 ID） */
  docsRepo: string;
  vaultId: number;
  port: number;
  tokens: Record<'alice' | 'bob' | 'carol' | 'dave' | 'maint', string>;
  /** 带 Basic 凭据的 /git URL（用户名任意——identity §3.1 token 为唯一凭据） */
  urlFor(slug: string, who: keyof GitHarness['tokens']): string;
  close(): Promise<void>;
}

let h: GitHarness;

async function startGitHarness(): Promise<GitHarness> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'notegit-githttp-'));
  const dbFile = path.join(dataDir, 'db', 'notegit.sqlite');
  await mkdir(path.dirname(dbFile), { recursive: true });
  const db = openDatabase(dbFile); // WAL + busy_timeout + foreign_keys（与生产同构）
  migrate(db, MIGRATIONS);
  for (const ddl of FIXTURE_DDL) db.exec(ddl);

  const pepper = { active: { version: 1, key: randomBytes(32) }, retired: [] as never[] };
  const alice = addEmployee(db, { username: 'alice' });
  const bob = addEmployee(db, { username: 'bob' });
  const carol = addEmployee(db, { username: 'carol' });
  const dave = addEmployee(db, { username: 'dave' });
  const maint = addEmployee(db, { username: 'maint', is_instance_admin: 1 });

  // 建库（真实 init bare 于 <dataDir>/git/<id>.git）+ 成员矩阵 + main_admin_only=1
  const vaultService = new VaultService({ db, repoOps: createVaultRepoOps(dataDir) });
  const docs = await vaultService.createVaultWithRepo(
    { name: 'Docs', slug: 'docs' },
    { employeeId: alice, entry: 'web', carrierRef: 'session:fixture' },
  );
  db.prepare('UPDATE vaults SET main_admin_only = 1 WHERE id = ?').run(docs.id);
  addMember(db, docs.id, bob, 'editor', alice);
  addMember(db, docs.id, carol, 'reader', alice);
  const scratch = await vaultService.createVaultWithRepo(
    { name: 'Scratch', slug: 'scratch' },
    { employeeId: alice, entry: 'web', carrierRef: 'session:fixture' },
  );
  void scratch;

  // 凭据（真实签发路径：明文 token 只在此出现一次）
  const credentials = new CredentialsService({ db, pepper });
  const expires = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const tokens = {} as GitHarness['tokens'];
  for (const [who, id] of [['alice', alice], ['bob', bob], ['carol', carol], ['dave', dave], ['maint', maint]] as const) {
    tokens[who] = credentials.createCredential(id, { name: `git-${who}`, expires_at: expires }).token;
  }

  // 种子提交：file 传输直推 bare 库（HTTP 接入前的既有内容）
  const docsRepo = vaultRepoPath(dataDir, docs.id);
  const seed = path.join(dataDir, 'seed');
  await git(['init', '-b', 'main', seed]);
  await writeMd(seed, 'README.md', '# nav\n');
  await writeMd(seed, 'notes/first.md', '---\ntitle: First\n---\nbody\n');
  await git(['-C', seed, 'add', '.']);
  await git(['-C', seed, '-c', 'user.email=seed@notegit.test', '-c', 'user.name=seed', 'commit', '-m', 'seed']);
  await git(['-C', seed, 'push', docsRepo, 'main']);

  const app = buildApp({
    db,
    pepper,
    bootstrapTokenFile: path.join(dataDir, 'config', 'admin-bootstrap.token'),
    dataDir,
    dbFile, // S3-T2：/git 入口与 pre-receive hook 直连同一库文件
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = app.addresses()[0]!.port;

  return {
    app,
    db,
    dataDir,
    pepper,
    docsRepo,
    vaultId: docs.id,
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
  h = await startGitHarness();
});

after(async () => {
  await h.close();
});

const basic = (user: string, token: string) => 'Basic ' + Buffer.from(`${user}:${token}`).toString('base64');
const httpUrl = (slug: string, suffix: string) => `http://127.0.0.1:${h.port}/git/${slug}.git${suffix}`;

/** 排干响应体：undici 未读体会占住 keep-alive 连接，拖慢收尾 app.close() */
async function drain(res: Response): Promise<void> {
  await res.arrayBuffer();
}

let aliceClone: string; // B1 建立后被 B2/B3/B5/B6 复用（与 spike route-b 同结构）

// ── route-b 7 项行为测试的产品级复刻（D5 验收基准）──────────────────────────

test('B1: 认证后标准 git 客户端可经 /git/<slug>.git clone（CGI 包装 http-backend 流式转发）', async () => {
  aliceClone = path.join(h.dataDir, 'clone-b1');
  await git(['clone', h.urlFor('docs', 'alice'), aliceClone]);
  assert.ok(existsSync(path.join(aliceClone, 'README.md')), '克隆应包含种子 README.md');
  assert.ok(existsSync(path.join(aliceClone, 'notes', 'first.md')), '克隆应包含种子笔记');
});

test('B2: 认证的快进推送被接受，服务端 ref 与客户端 HEAD 一致', async () => {
  await git(['-C', aliceClone, 'config', 'user.email', 'alice@notegit.test']);
  await git(['-C', aliceClone, 'config', 'user.name', 'alice']);
  await writeMd(aliceClone, 'notes/a.md', '---\ntitle: A\n---\nbody\n');
  await git(['-C', aliceClone, 'add', '.']);
  await git(['-C', aliceClone, 'commit', '-m', 'add a']);
  await git(['-C', aliceClone, 'push', 'origin', 'main']);
  const head = (await git(['-C', aliceClone, 'rev-parse', 'HEAD'])).stdout.trim();
  const remote = (await git(['--git-dir', h.docsRepo, 'rev-parse', 'main'])).stdout.trim();
  assert.equal(head, remote);
});

test('挂接点暴露：首次 HTTP push 后 bare 仓库具备 pre-receive/update/post-receive 可执行 shim（T4/T5/T6 消费）', async () => {
  const hooksDir = path.join(h.docsRepo, 'hooks');
  for (const name of ['pre-receive', 'update', 'post-receive']) {
    const hookPath = path.join(hooksDir, name);
    assert.ok(existsSync(hookPath), `${name} 应已安装`);
    await access(hookPath, fsConstants.X_OK); // git 只执行可执行 hook
    const body = await readFile(hookPath, 'utf8');
    assert.match(body, /node/, `${name} shim 应 exec node 挂服务端脚本`);
  }
});

test('B7: 未认证/错误凭据的 refs 发现被 401 拒绝并要求 Basic（架构 §3.2 引用发现必须鉴权）', async () => {
  const res = await fetch(httpUrl('docs', '/info/refs?service=git-upload-pack'));
  assert.equal(res.status, 401);
  assert.match(res.headers.get('www-authenticate') ?? '', /^Basic/i, '须携带 WWW-Authenticate: Basic');
  await drain(res);

  const wrong = await fetch(httpUrl('docs', '/info/refs?service=git-upload-pack'), {
    headers: { authorization: basic('alice', 'ngt_' + 'x'.repeat(43)) },
  });
  assert.equal(wrong.status, 401);
  await drain(wrong);

  // Git 入口只认 Basic（identity §3.1）；Bearer 不在此入口受理
  const bearer = await fetch(httpUrl('docs', '/info/refs?service=git-upload-pack'), {
    headers: { authorization: `Bearer ${h.tokens.alice}` },
  });
  assert.equal(bearer.status, 401);
  await drain(bearer);
});

test('B3: 非快进推送被拒（receive.denyNonFastForwards 原生拦截）且服务端 ref 不变', async () => {
  const before = (await git(['--git-dir', h.docsRepo, 'rev-parse', 'main'])).stdout.trim();
  await git(['-C', aliceClone, 'reset', '--hard', 'HEAD~1']);
  await writeMd(aliceClone, 'notes/b.md', '---\ntitle: B\n---\nbody\n');
  await git(['-C', aliceClone, 'add', '.']);
  await git(['-C', aliceClone, 'commit', '-m', 'diverged']);
  await assert.rejects(
    git(['-C', aliceClone, 'push', '--force', 'origin', 'main']),
    (e: Error & { stderr?: string }) => /non-fast-forward|fetch first|rejected/i.test(String(e.stderr)),
  );
  const after = (await git(['--git-dir', h.docsRepo, 'rev-parse', 'main'])).stdout.trim();
  assert.equal(after, before, '被拒推送后服务端 ref 必须保持不变');
});

test('B4: 逐 ref 授权——main_admin_only 下编辑者拒写默认分支、可写 feature/*；默认分支删除保护；非默认分支删除允许', async () => {
  const bobClone = path.join(h.dataDir, 'clone-bob');
  await git(['clone', h.urlFor('docs', 'bob'), bobClone]);
  await git(['-C', bobClone, 'config', 'user.email', 'bob@notegit.test']);
  await git(['-C', bobClone, 'config', 'user.name', 'bob']);
  await writeMd(bobClone, 'notes/by-bob.md', '---\ntitle: ByBob\n---\nbody\n');
  await git(['-C', bobClone, 'add', '.']);
  await git(['-C', bobClone, 'commit', '-m', 'bob change']);
  // 编辑者 → main：被逐 ref 授权拒绝（main_admin_only=1）
  await assert.rejects(
    git(['-C', bobClone, 'push', 'origin', 'main']),
    (e: Error & { stderr?: string }) => /main_admin_only|仅库管理员|仅管理员/.test(String(e.stderr)),
  );
  // 编辑者 → feature/*：允许
  await git(['-C', bobClone, 'push', 'origin', 'HEAD:refs/heads/feature/x']);
  const refs = (await git(['--git-dir', h.docsRepo, 'for-each-ref', '--format=%(refname)'])).stdout;
  assert.match(refs, /refs\/heads\/feature\/x/);
  // 默认分支删除：即使库管理员（alice）也被拒（架构 §4.3）
  await assert.rejects(
    git(['-C', aliceClone, 'push', 'origin', ':main']),
    (e: Error & { stderr?: string }) => /删除默认分支|deleting main|delete.*main/i.test(String(e.stderr)),
  );
  // 非默认分支删除：编辑者允许（架构 §4.3）
  await git(['-C', bobClone, 'push', 'origin', ':refs/heads/feature/x']);
  const refs2 = (await git(['--git-dir', h.docsRepo, 'for-each-ref', '--format=%(refname)'])).stdout;
  assert.doesNotMatch(refs2, /refs\/heads\/feature\/x/);
});

test('B5: 先写坏后删的推送被拒且 ref 不变（逐提交校验——S3-T4 真实校验器）', async () => {
  // B3 留下本地分叉：先与服务器对齐
  await git(['-C', aliceClone, 'fetch', '-q', 'origin']);
  await git(['-C', aliceClone, 'reset', '--hard', 'origin/main']);
  const before = (await git(['--git-dir', h.docsRepo, 'rev-parse', 'main'])).stdout.trim();
  await writeMd(aliceClone, 'notes/bad.md', 'no frontmatter at all\n');
  await git(['-C', aliceClone, 'add', '.']);
  await git(['-C', aliceClone, 'commit', '-m', 'add bad']);
  await git(['-C', aliceClone, 'rm', '-q', 'notes/bad.md']);
  await git(['-C', aliceClone, 'commit', '-m', 'remove bad']);
  await assert.rejects(
    git(['-C', aliceClone, 'push', 'origin', 'main']),
    (e: Error & { stderr?: string }) => /bad\.md/.test(String(e.stderr)),
  );
  const after = (await git(['--git-dir', h.docsRepo, 'rev-parse', 'main'])).stdout.trim();
  assert.equal(after, before);
  await git(['-C', aliceClone, 'reset', '--hard', 'origin/main']);
});

test('B6: 同一次 push 携带合规 ref 与违规 ref 被整体原子拒绝——无任何 ref 被更新', async () => {
  const mainBefore = (await git(['--git-dir', h.docsRepo, 'rev-parse', 'main'])).stdout.trim();
  await writeMd(aliceClone, 'notes/good.md', '---\ntitle: Good\n---\nbody\n');
  await git(['-C', aliceClone, 'add', '.']);
  await git(['-C', aliceClone, 'commit', '-m', 'good on main']);
  await git(['-C', aliceClone, 'branch', 'bad-branch']);
  await git(['-C', aliceClone, 'checkout', '-q', 'bad-branch']);
  await writeMd(aliceClone, 'notes/evil.md', 'missing title here\n');
  await git(['-C', aliceClone, 'add', '.']);
  await git(['-C', aliceClone, 'commit', '-m', 'evil on bad-branch']);
  await git(['-C', aliceClone, 'checkout', '-q', 'main']);
  await assert.rejects(
    git(['-C', aliceClone, 'push', 'origin', 'main', 'bad-branch']),
    (e: Error & { stderr?: string }) => /evil\.md/.test(String(e.stderr)),
  );
  const mainAfter = (await git(['--git-dir', h.docsRepo, 'rev-parse', 'main'])).stdout.trim();
  assert.equal(mainAfter, mainBefore, '同一 push 的合规 ref 也不得被更新（全有或全无）');
  const refs = (await git(['--git-dir', h.docsRepo, 'for-each-ref', '--format=%(refname)'])).stdout;
  assert.doesNotMatch(refs, /bad-branch/);
  await git(['-C', aliceClone, 'branch', '-D', 'bad-branch']);
});

// ── 产品附加场景（S3-T2 完成标准：无权 404、角色/scope 矩阵、四状态、维护模式）──

test('HTTP 空库全闭环：clone 空库 → 首推 → 二次 clone（sprint 场景 S1 的产品级形态）', async () => {
  const work = path.join(h.dataDir, 'empty-loop');
  await git(['clone', h.urlFor('scratch', 'alice'), work]); // 空库克隆成功
  assert.equal((await git(['-C', work, 'symbolic-ref', 'HEAD'])).stdout.trim(), 'refs/heads/main');
  await writeMd(work, 'notes/first.md', '---\ntitle: First\n---\nbody\n');
  await git(['-C', work, 'add', '.']);
  await git(['-C', work, '-c', 'user.email=alice@notegit.test', '-c', 'user.name=alice', 'commit', '-m', 'init']);
  await git(['-C', work, 'push', 'origin', 'main']);
  const again = path.join(h.dataDir, 'empty-loop-2');
  await git(['clone', h.urlFor('scratch', 'alice'), again]);
  assert.ok(existsSync(path.join(again, 'notes', 'first.md')), '二次克隆应包含首推内容');
  const a = (await git(['-C', work, 'rev-parse', 'HEAD'])).stdout.trim();
  const b = (await git(['-C', again, 'rev-parse', 'HEAD'])).stdout.trim();
  assert.equal(a, b);
});

test('无权库 refs 发现 404 不泄露存在性（D-IC-06）：非成员对已知库、成员对未知库、哑协议端点', async () => {
  const daveUpload = await fetch(httpUrl('docs', '/info/refs?service=git-upload-pack'), {
    headers: { authorization: basic('dave', h.tokens.dave) },
  });
  assert.equal(daveUpload.status, 404, '非成员不得区分「无权」与「不存在」');
  assert.equal((await daveUpload.json() as { error?: { code?: string } }).error?.code, 'E-RES-001');
  const daveReceive = await fetch(httpUrl('docs', '/info/refs?service=git-receive-pack'), {
    headers: { authorization: basic('dave', h.tokens.dave) },
  });
  assert.equal(daveReceive.status, 404);
  await drain(daveReceive);
  const unknown = await fetch(httpUrl('nope', '/info/refs?service=git-upload-pack'), {
    headers: { authorization: basic('alice', h.tokens.alice) },
  });
  assert.equal(unknown.status, 404, '未知 slug 同 404（与无权不可区分）');
  await drain(unknown);
  // 哑协议端点不在白名单：不提供未鉴权对象读取
  const dumb = await fetch(httpUrl('docs', '/objects/info/packs'), {
    headers: { authorization: basic('alice', h.tokens.alice) },
  });
  assert.equal(dumb.status, 404);
  await drain(dumb);
});

test('角色与 scope 矩阵：reader 可读不可写（403 E-AUTHZ-001）；read-scope 凭据写被拒；Basic 用户名任意', async () => {
  // reader：upload-pack 引用发现 200（smart 广告）
  const up = await fetch(httpUrl('docs', '/info/refs?service=git-upload-pack'), {
    headers: { authorization: basic('carol', h.tokens.carol) },
  });
  assert.equal(up.status, 200);
  assert.match(up.headers.get('content-type') ?? '', /x-git-upload-pack-advertisement/);
  await drain(up);
  // reader：receive-pack 引用发现 403（成员、库存在已知，但角色不足写）
  const down = await fetch(httpUrl('docs', '/info/refs?service=git-receive-pack'), {
    headers: { authorization: basic('carol', h.tokens.carol) },
  });
  assert.equal(down.status, 403);
  assert.equal((await down.json() as { error?: { code?: string } }).error?.code, 'E-AUTHZ-001');
  // Basic 用户名任意（identity §3.1：token 是唯一凭据）
  const anyUser = await fetch(httpUrl('docs', '/info/refs?service=git-upload-pack'), {
    headers: { authorization: basic('ignored-username', h.tokens.carol) },
  });
  assert.equal(anyUser.status, 200);
  await drain(anyUser);
  // read-scope 凭据（身份是 editor）：收窄为只读 → 写入口 403（identity §3.4）
  const { hashToken, generateToken } = await import('../src/credentials/token.ts');
  const bobId = (h.db.prepare(`SELECT id FROM employees WHERE username = 'bob'`).get() as { id: number }).id;
  const readToken = generateToken();
  h.db
    .prepare(
      `INSERT INTO credentials (employee_id, name, token_hash, display_hint, scope_access, scope_vaults, created_at, expires_at)
       VALUES (?, 'read-scope', ?, 'ngt_xx…xxxx', 'read', '[]', ?, ?)`,
    )
    .run(
      bobId,
      hashToken(h.pepper.active, readToken),
      new Date(Date.now() - 60_000).toISOString(),
      new Date(Date.now() + 86_400_000).toISOString(),
    );
  const scoped = await fetch(httpUrl('docs', '/info/refs?service=git-receive-pack'), {
    headers: { authorization: basic('bob', readToken) },
  });
  assert.equal(scoped.status, 403, 'scope.access=read 的凭据不可写（只能收窄，identity §3.4）');
  await drain(scoped);
});

test('已撤销/已过期 token 的 refs 发现 401（四状态精确映射 E-AUTH-003/E-AUTH-002）', async () => {
  const { hashToken, generateToken } = await import('../src/credentials/token.ts');
  const daveId = (h.db.prepare(`SELECT id FROM employees WHERE username = 'dave'`).get() as { id: number }).id;
  const past = new Date(Date.now() - 86_400_000).toISOString();
  const expiredToken = generateToken();
  h.db
    .prepare(
      `INSERT INTO credentials (employee_id, name, token_hash, display_hint, scope_access, scope_vaults, created_at, expires_at)
       VALUES (?, 'expired', ?, 'ngt_xx…xxxx', 'read_write', '[]', ?, ?)`,
    )
    .run(daveId, hashToken(h.pepper.active, expiredToken), past, past);
  const expired = await fetch(httpUrl('docs', '/info/refs?service=git-upload-pack'), {
    headers: { authorization: basic('dave', expiredToken) },
  });
  assert.equal(expired.status, 401);
  assert.equal((await expired.json() as { error?: { code?: string } }).error?.code, 'E-AUTH-002');

  // 撤销走真实服务路径（createCredential → revokeCredential；与应用同一 pepper）
  const credentials = new CredentialsService({ db: h.db, pepper: h.pepper });
  const created = credentials.createCredential(daveId, {
    name: 'to-revoke',
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  });
  credentials.revokeCredential(created.record.id, daveId, { actorEmployeeId: daveId });
  const revoked = await fetch(httpUrl('docs', '/info/refs?service=git-upload-pack'), {
    headers: { authorization: basic('dave', created.token) },
  });
  assert.equal(revoked.status, 401);
  assert.equal((await revoked.json() as { error?: { code?: string } }).error?.code, 'E-AUTH-003');
});

test('维护模式：receive-pack 403（E-MAINT-001），upload-pack 读放行；关闭后恢复', async () => {
  const on = await h.app.inject({
    method: 'POST',
    url: '/api/v1/admin/maintenance',
    headers: { authorization: `Bearer ${h.tokens.maint}` },
  });
  assert.equal(on.statusCode, 204, on.body);
  try {
    const recv = await fetch(httpUrl('docs', '/info/refs?service=git-receive-pack'), {
      headers: { authorization: basic('alice', h.tokens.alice) },
    });
    assert.equal(recv.status, 403, '维护中 receive-pack 应 403（api.md §8.4）');
    assert.equal((await recv.json() as { error?: { code?: string } }).error?.code, 'E-MAINT-001');
    const up = await fetch(httpUrl('docs', '/info/refs?service=git-upload-pack'), {
      headers: { authorization: basic('alice', h.tokens.alice) },
    });
    assert.equal(up.status, 200, '维护中读路径放行（backup-recovery §3）');
    await drain(up);
  } finally {
    const off = await h.app.inject({
      method: 'DELETE',
      url: '/api/v1/admin/maintenance',
      headers: { authorization: `Bearer ${h.tokens.maint}` },
    });
    assert.equal(off.statusCode, 204, off.body);
  }
  const recv2 = await fetch(httpUrl('docs', '/info/refs?service=git-receive-pack'), {
    headers: { authorization: basic('alice', h.tokens.alice) },
  });
  assert.equal(recv2.status, 200, '关闭维护后 receive-pack 恢复');
  await drain(recv2);
});
