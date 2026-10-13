import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
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
import { createSession, DEFAULT_SESSION_TIMEOUTS } from '../src/auth/sessions.ts';
import { hashPassword } from '../src/auth/password.ts';
import { drainCount } from '../src/audit/audit.ts';
import { FIXTURE_DDL, addEmployee, addMember } from './credentials-fixtures.ts';

// S8-T3 维护模式全矩阵集成（backup-recovery §3 唯一语义源，逐行对账）：
//
// | §3 行 | 写入口 | 行为 | 本文件断言点 |
// |---|---|---|---|
// | 1 | 网页正式提交（发布组件） | 拒绝 503 +「维护中」；草稿保留不丢失 | POST submissions 503；草稿仍在 |
// | 2 | 网页草稿保存/删除 | 拒绝 503（草稿属权威管理数据） | PUT/DELETE drafts 503 |
// | 3 | API 写操作（草稿/提交/上传类） | 拒绝 503，结构化错误含 maintenance 标志 | Bearer 全组 503 + 标志 |
// | 4 | Git receive（push） | receive 请求 403/「维护中」文案；refs 发现即鉴权语义不变 | 见 matrix-行 4 测试 |
// | 5 | 管理操作（成员/角色/库配置/凭据/停用） | 拒绝 503 | 全组 503 |
// | 6 | 登录/会话创建 | 允许（会话属运行态） | login 200 |
// | 7 | 一切读（网页/API/Git clone·fetch） | 允许 | browse/GET/克隆/拉取 |
//
// 运行态放行面（§3 写分类）与 S2 闸门 allowlist、S5 rebuild allowlist 逐项复核。
// 被测形态 = 真实应用（listen）+ 文件 SQLite + 真实 bare 仓库 + 标准 git 客户端
// （githttp-behavior.test.ts 同构）；HTTP 断言走 inject（/api 与页面）与 fetch（/git）。

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

const ORIGIN = { origin: 'http://localhost' }; // inject 的 Host 同源（csrf.test.ts 同款）

interface MatrixHarness {
  app: FastifyInstance;
  db: DatabaseSync;
  dataDir: string;
  repoPath: string;
  port: number;
  ids: Record<'alice' | 'bob' | 'carol' | 'dave' | 'maint', number>;
  tokens: Record<'alice' | 'bob' | 'dave' | 'maint', string>;
  /** alice 会话 Cookie 头（web 行）；logout 复核用后需重新换发 */
  aliceSession(): Record<string, string>;
  maintBearer(): Record<string, string>;
  aliceBearer(): Record<string, string>;
  basic(who: 'alice' | 'bob' | 'dave'): string;
  gitUrl(who: 'alice' | 'bob' | 'dave', slug?: string): string;
  httpUrl(slug: string, suffix: string): string;
  close(): Promise<void>;
}

let h: MatrixHarness;

async function startMatrixHarness(): Promise<MatrixHarness> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'notegit-s8t3-'));
  const dbFile = path.join(dataDir, 'db', 'notegit.sqlite');
  await mkdir(path.dirname(dbFile), { recursive: true });
  const db = openDatabase(dbFile);
  migrate(db, MIGRATIONS);
  for (const ddl of FIXTURE_DDL) db.exec(ddl);

  const pepper = { active: { version: 1, key: randomBytes(32) }, retired: [] as never[] };
  const ids = {
    alice: addEmployee(db, { username: 'alice' }),
    bob: addEmployee(db, { username: 'bob' }),
    carol: addEmployee(db, { username: 'carol' }),
    dave: addEmployee(db, { username: 'dave' }),
    maint: addEmployee(db, { username: 'maint', is_instance_admin: 1 }),
  };
  // 登录行（§3 第 6 行）需要真实口令哈希
  db.prepare('UPDATE employees SET password_hash = ? WHERE id = ?').run(await hashPassword('password-alice-1'), ids.alice);

  // 库 docs：真实 init bare + 成员矩阵（alice=admin、bob=editor、carol=reader、dave=非成员）
  const vaultService = new VaultService({ db, repoOps: createVaultRepoOps(dataDir) });
  const docs = await vaultService.createVaultWithRepo(
    { name: 'Docs', slug: 'docs' },
    { employeeId: ids.alice, entry: 'web', carrierRef: 'session:fixture' },
  );
  addMember(db, docs.id, ids.bob, 'editor', ids.alice);
  addMember(db, docs.id, ids.carol, 'reader', ids.alice);

  // 凭据（git Basic 与 API Bearer 同源签发）
  const credentials = new CredentialsService({ db, pepper });
  const expires = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const tokens = {} as MatrixHarness['tokens'];
  for (const who of ['alice', 'bob', 'dave', 'maint'] as const) {
    tokens[who] = credentials.createCredential(ids[who], { name: `matrix-${who}`, expires_at: expires }).token;
  }

  // 种子提交（file 传输直推——HTTP 接入前的既有内容，githttp 夹具同款）
  const repoPath = vaultRepoPath(dataDir, docs.id);
  const seed = path.join(dataDir, 'seed');
  await git(['init', '-b', 'main', seed]);
  const readme = path.join(seed, 'README.md');
  await writeFile(readme, '# matrix\n', 'utf8');
  const noteDir = path.join(seed, 'notes');
  await mkdir(noteDir);
  await writeFile(path.join(noteDir, 'first.md'), '---\ntitle: First\n---\n正文\n', 'utf8');
  await git(['-C', seed, 'add', '.']);
  await git(['-C', seed, '-c', 'user.email=seed@notegit.test', '-c', 'user.name=seed', 'commit', '-m', 'seed']);
  await git(['-C', seed, 'push', repoPath, 'main']);
  await rm(seed, { recursive: true, force: true });

  const app = buildApp({
    db,
    pepper,
    bootstrapTokenFile: path.join(dataDir, 'config', 'admin-bootstrap.token'),
    dataDir,
    dbFile, // /git 入口与 pre-receive hook 直连同一库文件
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = app.addresses()[0]!.port;
  const sessionNow = new Date();

  return {
    app,
    db,
    dataDir,
    repoPath,
    port,
    ids,
    tokens,
    aliceSession: () => ({
      cookie: `ngt_sid=${createSession(db, ids.alice, pepper.active.key, sessionNow, DEFAULT_SESSION_TIMEOUTS).sid}`,
    }),
    maintBearer: () => ({ authorization: `Bearer ${tokens.maint}` }),
    aliceBearer: () => ({ authorization: `Bearer ${tokens.alice}` }),
    basic: (who) => 'Basic ' + Buffer.from(`${who}:${tokens[who]}`).toString('base64'),
    gitUrl: (who, slug = 'docs') => `http://${who}:${h.tokens[who]}@127.0.0.1:${port}/git/${slug}.git`,
    httpUrl: (slug, suffix) => `http://127.0.0.1:${port}/git/${slug}.git${suffix}`,
    close: async () => {
      await app.close();
      db.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

before(async () => {
  h = await startMatrixHarness();
});

after(async () => {
  await h.close();
});

async function maintenance(method: 'POST' | 'DELETE') {
  const res = await h.app.inject({
    method,
    url: '/api/v1/admin/maintenance',
    headers: h.maintBearer(),
    payload: method === 'POST' ? {} : undefined,
  });
  assert.equal(res.statusCode, 204, `${method} 维护切换应 204：${res.body}`);
}

interface ErrBody {
  error: { code: string; message: string; details?: { maintenance?: boolean } };
}

function assertMaintenance503(name: string, res: { statusCode: number; body: string }): ErrBody {
  assert.equal(res.statusCode, 503, `${name} 应 503（backup §3）`);
  const body = JSON.parse(res.body) as ErrBody;
  assert.equal(body.error.code, 'E-MAINT-001', `${name} 错误码`);
  assert.equal(body.error.details?.maintenance, true, `${name} 结构化错误含 maintenance 标志（api.md §2.3）`);
  assert.match(body.error.message, /维护中/, `${name}「维护中」提示`);
  return body;
}

async function mainHead(): Promise<string> {
  return (await git(['--git-dir', h.repoPath, 'rev-parse', 'refs/heads/main'])).stdout.trim();
}

test('§3 行 1+2：网页正式提交拒绝（503+维护中，草稿保留不丢失）；网页草稿保存/删除拒绝', async () => {
  const session = { ...h.aliceSession(), ...ORIGIN };
  // 开启前草稿已存在（真实 PUT——同时证明草稿端点在关闭态可用）
  const seedDraft = await h.app.inject({
    method: 'PUT',
    url: '/api/v1/vaults/docs/drafts/notes/matrix.md',
    headers: session,
    payload: { content: '---\ntitle: 矩阵\n---\n草稿正文\n', base_commit: null },
  });
  assert.equal(seedDraft.statusCode, 200, seedDraft.body);
  const before = await mainHead();

  await maintenance('POST');
  try {
    // 行 1：网页正式提交（发布组件，§5.4 第三入口）
    const submit = await h.app.inject({
      method: 'POST',
      url: '/api/v1/vaults/docs/submissions',
      headers: session,
      payload: { base_commit: null, changes: [{ path: 'notes/matrix.md', content: '---\ntitle: 矩阵\n---\n提交正文\n' }] },
    });
    assertMaintenance503('网页正式提交', submit);

    // 草稿保留不丢失（拒绝不动草稿）
    const draft = await h.app.inject({ method: 'GET', url: '/api/v1/vaults/docs/drafts/notes/matrix.md', headers: h.aliceSession() });
    assert.equal(draft.statusCode, 200, '草稿仍在');
    assert.match((draft.json() as { content: string }).content, /草稿正文/, '草稿内容未被维护拒绝破坏');

    // 行 2：网页草稿保存/删除（草稿存数据库，属权威管理数据）
    const save = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/vaults/docs/drafts/notes/matrix.md',
      headers: session,
      payload: { content: 'x', base_commit: null },
    });
    assertMaintenance503('网页草稿保存', save);
    const del = await h.app.inject({ method: 'DELETE', url: '/api/v1/vaults/docs/drafts/notes/matrix.md', headers: session });
    assertMaintenance503('网页草稿删除', del);

    assert.equal(await mainHead(), before, '维护期间默认分支无新提交');
  } finally {
    await maintenance('DELETE');
  }
  // 关闭后写恢复（草稿保存回到 200）
  const saveAfter = await h.app.inject({
    method: 'PUT',
    url: '/api/v1/vaults/docs/drafts/notes/matrix.md',
    headers: { ...h.aliceSession(), ...ORIGIN },
    payload: { content: '---\ntitle: 矩阵\n---\n恢复后正文\n', base_commit: null },
  });
  assert.equal(saveAfter.statusCode, 200, saveAfter.body);
});

test('§3 行 3：API 写操作（草稿/提交/上传类）Bearer 全组 503 结构化拒绝；API 读放行', async () => {
  const bearer = h.aliceBearer();
  await maintenance('POST');
  try {
    const draft = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/vaults/docs/drafts/api-write.md',
      headers: bearer,
      payload: { content: '---\ntitle: A\n---\nb\n', base_commit: null },
    });
    assertMaintenance503('API 草稿保存', draft);

    const submit = await h.app.inject({
      method: 'POST',
      url: '/api/v1/vaults/docs/submissions',
      headers: bearer,
      payload: { base_commit: null, changes: [{ path: 'api-write.md', content: '---\ntitle: A\n---\nb\n' }] },
    });
    assertMaintenance503('API 正式提交', submit);

    const createVault = await h.app.inject({
      method: 'POST',
      url: '/api/v1/vaults',
      headers: bearer,
      payload: { slug: 'new-vault', name: 'New' },
    });
    assertMaintenance503('API 建库', createVault);

    // 上传类：程序化端点（octet-stream）JSON 结构化错误（web 域维护缝——web-maintenance 同款）
    const upload = await h.app.inject({
      method: 'POST',
      url: '/vaults/docs/upload/assets/api.bin',
      headers: { 'content-type': 'application/octet-stream', ...h.aliceSession(), ...ORIGIN },
      payload: Buffer.from('bin'),
    });
    assert.equal(upload.statusCode, 503, upload.body);
    const upBody = upload.json() as { ok: boolean; error: { code: string; details?: { maintenance?: boolean } } };
    assert.equal(upBody.ok, false);
    assert.equal(upBody.error.code, 'E-MAINT-001');
    assert.equal(upBody.error.details?.maintenance, true, '上传端点结构化错误含 maintenance 标志');

    // 对照：API 读同域放行（行 7 的 API 面）
    const list = await h.app.inject({ method: 'GET', url: '/api/v1/vaults', headers: bearer });
    assert.equal(list.statusCode, 200, 'API 读放行');
  } finally {
    await maintenance('DELETE');
  }
});

test('§3 行 4：Git receive 403+「维护中」文案（refs 发现与 pack 双向）；refs 发现鉴权语义不变；读放行', async () => {
  // 真实克隆先行（关闭态），维护中用于推送对照
  const clone = path.join(h.dataDir, 'matrix-clone-r4');
  await git(['clone', h.gitUrl('alice'), clone]);
  await git(['-C', clone, 'config', 'user.email', 'alice@notegit.test']);
  await git(['-C', clone, 'config', 'user.name', 'alice']);
  await writeFile(path.join(clone, 'notes/r4.md'), '---\ntitle: R4\n---\n维护矩阵\n', 'utf8');
  await git(['-C', clone, 'add', '.']);
  await git(['-C', clone, 'commit', '-m', 'r4']);
  const before = await mainHead();

  await maintenance('POST');
  try {
    // refs 发现（GET info/refs?service=git-receive-pack）：action=write → 403「维护中」
    const refs = await fetch(h.httpUrl('docs', '/info/refs?service=git-receive-pack'), {
      headers: { authorization: h.basic('alice') },
    });
    assert.equal(refs.status, 403, '维护中 receive refs 发现应 403（api.md §8.4）');
    const refsBody = (await refs.json()) as ErrBody;
    assert.equal(refsBody.error.code, 'E-MAINT-001');
    assert.match(refsBody.error.message, /维护中/, 'receive 403 明确「维护中」文案（backup §3 行 4）');
    assert.equal(refsBody.error.details?.maintenance, true);

    // pack 端点（POST git-receive-pack）：同样 403
    const pack = await fetch(h.httpUrl('docs', '/git-receive-pack'), {
      method: 'POST',
      headers: { authorization: h.basic('alice'), 'content-type': 'application/x-git-receive-pack-request' },
      body: Buffer.alloc(0),
    });
    assert.equal(pack.status, 403);
    assert.equal(((await pack.json()) as ErrBody).error.code, 'E-MAINT-001');

    // 非成员的 receive refs 发现：统一 403 E-MAINT-001（维护判定先于授权——对所有
    // receive 请求同体，不泄露库存在性；§3.2 refs 发现鉴权语义对读面保持不变，见下）
    const daveRefs = await fetch(h.httpUrl('docs', '/info/refs?service=git-receive-pack'), {
      headers: { authorization: h.basic('dave') },
    });
    assert.equal(daveRefs.status, 403);
    assert.equal(((await daveRefs.json()) as ErrBody).error.code, 'E-MAINT-001', '维护 403 对成员/非成员同体');

    // refs 发现鉴权语义不变（§3.2）：upload-pack 读面——成员 200 广告、非成员 404 不泄露存在性
    const upRefs = await fetch(h.httpUrl('docs', '/info/refs?service=git-upload-pack'), {
      headers: { authorization: h.basic('alice') },
    });
    assert.equal(upRefs.status, 200, '维护中 upload-pack refs 发现放行（行 7）');
    assert.match(upRefs.headers.get('content-type') ?? '', /application\/x-git-upload-pack-advertisement/);
    await upRefs.arrayBuffer();
    const daveUp = await fetch(h.httpUrl('docs', '/info/refs?service=git-upload-pack'), {
      headers: { authorization: h.basic('dave') },
    });
    assert.equal(daveUp.status, 404, '非成员读面仍 404（鉴权语义不变，D-IC-06）');
    assert.equal(((await daveUp.json()) as ErrBody).error.code, 'E-RES-001');
    // 未知库读面同 404（不因维护改变存在性语义）
    const ghostUp = await fetch(h.httpUrl('ghost', '/info/refs?service=git-upload-pack'), {
      headers: { authorization: h.basic('alice') },
    });
    assert.equal(ghostUp.status, 404, '未知库读面 404 语义不变');

    // 标准 git 客户端推送：被拒于 refs 发现（HTTP 403）；分支不动
    await assert.rejects(
      () => git(['-C', clone, 'push', 'origin', 'main']),
      (err: { stderr?: string }) => /403/.test(err.stderr ?? ''),
      'git push 应因 403 失败',
    );
    assert.equal(await mainHead(), before, '维护中未产生引用更新');

    // 维护中真实 fetch（行 7 的 Git 读面）：成功
    await git(['-C', clone, 'fetch', 'origin']);
  } finally {
    await maintenance('DELETE');
  }
  // 关闭后同一推送恢复成功（B2 同款快进），且审计到终态（排空判据归零）
  await git(['-C', clone, 'push', 'origin', 'main']);
  const pushed = (await git(['-C', clone, 'rev-parse', 'HEAD'])).stdout.trim();
  assert.equal(await mainHead(), pushed, '关闭后推送恢复');
  assert.equal(drainCount(h.db), 0, '推送审计全部到达终态（pending 清零）');
});

test('§3 行 5：管理操作（成员/角色/库配置/凭据创建撤销/账号停用/邀请）全组 503', async () => {
  // 凭据撤销对象先备好（关闭态创建）
  const seeded = await h.app.inject({
    method: 'POST',
    url: '/api/v1/credentials',
    headers: h.aliceBearer(),
    payload: { name: 'to-revoke', expires_at: new Date(Date.now() + 86_400_000).toISOString() },
  });
  assert.equal(seeded.statusCode, 201, seeded.body);
  const credId = (seeded.json() as { id: number }).id; // 201 {token, ...record}（record 平铺）

  await maintenance('POST');
  try {
    const admin = h.maintBearer();
    const invite = await h.app.inject({
      method: 'POST', url: '/api/v1/admin/employees', headers: admin,
      payload: { username: 'invitee-matrix', display_name: 'Invitee' },
    });
    assertMaintenance503('邀请创建员工', invite);
    const disable = await h.app.inject({
      method: 'PATCH', url: '/api/v1/admin/employees/bob', headers: admin, payload: { active: false },
    });
    assertMaintenance503('账号停用', disable);

    // 库配置与成员/角色（库管理员 alice）
    const alice = h.aliceBearer();
    const patchVault = await h.app.inject({ method: 'PATCH', url: '/api/v1/vaults/docs', headers: alice, payload: { name: 'Docs2' } });
    assertMaintenance503('库配置修改', patchVault);
    const grant = await h.app.inject({
      method: 'PUT', url: '/api/v1/vaults/docs/members/dave', headers: alice, payload: { role: 'reader' },
    });
    assertMaintenance503('成员授权', grant);
    const revoke = await h.app.inject({ method: 'DELETE', url: '/api/v1/vaults/docs/members/carol', headers: alice });
    assertMaintenance503('成员撤权', revoke);

    // 凭据创建/撤销（自助）
    const create = await h.app.inject({
      method: 'POST', url: '/api/v1/credentials', headers: alice,
      payload: { name: 'during-maint', expires_at: new Date(Date.now() + 86_400_000).toISOString() },
    });
    assertMaintenance503('凭据创建', create);
    const revokeCred = await h.app.inject({ method: 'DELETE', url: `/api/v1/credentials/${credId}`, headers: h.aliceBearer() });
    assertMaintenance503('凭据撤销', revokeCred);
  } finally {
    await maintenance('DELETE');
  }
  // 对照：dave 未被授权（上面 503 未产生成员行）
  const members = await h.app.inject({ method: 'GET', url: '/api/v1/vaults/docs/members', headers: h.aliceBearer() });
  assert.equal(members.statusCode, 200);
  assert.ok(!(members.json() as { members: { username: string }[] }).members.some((m) => m.username === 'dave'), '维护拒绝未落成员行');
});

test('§3 行 6+7：登录/会话创建放行；一切读放行（网页浏览/API 读/健康检查/Git 克隆）', async () => {
  await maintenance('POST');
  try {
    // 行 6：登录（会话是临时运行态——备份多含陈旧会话无害，D-BR-06）
    const login = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'alice', password: 'password-alice-1' },
    });
    assert.equal(login.statusCode, 200, '登录/会话创建放行');
    assert.match(String(login.headers['set-cookie'] ?? ''), /ngt_sid=/);

    // 行 7：网页浏览与预览
    const browse = await h.app.inject({ method: 'GET', url: '/vaults/docs/browse', headers: h.aliceSession() });
    assert.equal(browse.statusCode, 200, '网页目录浏览放行');
    assert.match(browse.body, /notes/, '目录内容如实可见');
    const view = await h.app.inject({
      method: 'GET',
      url: `/vaults/docs/view/${encodeURIComponent('notes')}/${encodeURIComponent('first.md')}`,
      headers: h.aliceSession(),
    });
    assert.equal(view.statusCode, 200, '网页预览放行');

    // 行 7：API 读 + 健康检查
    const me = await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: h.aliceBearer() });
    assert.equal(me.statusCode, 200);
    const healthz = await h.app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(healthz.statusCode, 200, '健康检查放行');

    // 行 7：Git clone（全新克隆走 upload-pack）
    const fresh = path.join(h.dataDir, 'matrix-clone-r7');
    await git(['clone', h.gitUrl('alice'), fresh]);
    assert.ok(existsSync(path.join(fresh, 'README.md')), '维护中克隆成功且内容完整');
  } finally {
    await maintenance('DELETE');
  }
});

test('写分类与 allowlist 复核（§3 + S2/S4/S5）：登录/登出/维护自身/索引重建放行；运维审计行不入排空口径', async () => {
  await maintenance('POST');
  try {
    // 登出（会话运行态写入——S2-T7 allowlist）
    const session = { ...h.aliceSession(), ...ORIGIN };
    const logout = await h.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: session });
    assert.equal(logout.statusCode, 204, '登出（会话运行态）放行');

    // 幂等再开启（维护生命周期自身放行——不重复记审计）
    const reOn = await h.app.inject({ method: 'POST', url: '/api/v1/admin/maintenance', headers: h.maintBearer(), payload: {} });
    assert.equal(reOn.statusCode, 204);

    // S5-T5 索引全量重建：派生数据不入备份一致性集合——维护中放行（backup §7 步骤 9）
    const rebuild = await h.app.inject({ method: 'POST', url: '/api/v1/admin/search-index/rebuild', headers: h.maintBearer() });
    assert.ok([202, 409].includes(rebuild.statusCode), `rebuild 不被维护闸门拦（202/409，实得 ${rebuild.statusCode}）：${rebuild.body}`);
    const searchStatus = await h.app.inject({ method: 'GET', url: '/api/v1/admin/search-index', headers: h.maintBearer() });
    assert.equal(searchStatus.statusCode, 200, '索引状态面（读）放行');

    // 运行态审计行（maintenance.*、search.rebuild）= 直接终态——不入排空在途集合
    const runtimeRows = h.db
      .prepare(`SELECT event_kind, status FROM audit_events WHERE event_kind LIKE 'maintenance.%' OR event_kind = 'search.rebuild'`)
      .all() as { event_kind: string; status: string }[];
    assert.ok(runtimeRows.length >= 2, `运维审计行已产生（enable/disable/rebuild）：${JSON.stringify(runtimeRows)}`);
    for (const row of runtimeRows) {
      assert.equal(row.status, 'succeeded', `${row.event_kind} 直接终态（storage-model §5 运行态写入）`);
    }
    assert.equal(drainCount(h.db), 0, '运行态写入不阻塞排空（backup §3 写分类）');
  } finally {
    await maintenance('DELETE');
  }
});

test('收口对账：矩阵轮转后无残留 pending/unresolved；维护行成对（enable/disable 各有审计）', async () => {
  const pending = h.db
    .prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE status IN ('pending','unresolved')`)
    .get() as { n: number };
  assert.equal(pending.n, 0, '全部在途写到达终态（§4 步骤 2 排空判据）');
  const maintRows = h.db
    .prepare(`SELECT event_kind FROM audit_events WHERE event_kind LIKE 'maintenance.%' ORDER BY id`)
    .all() as { event_kind: string }[];
  const enables = maintRows.filter((r) => r.event_kind === 'maintenance.enable').length;
  const disables = maintRows.filter((r) => r.event_kind === 'maintenance.disable').length;
  assert.ok(enables >= 5 && disables >= 5, `每次开启/关闭均有审计（enable=${enables}, disable=${disables}）`);
});
