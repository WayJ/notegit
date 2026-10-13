import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, constants as fsConstants } from 'node:fs/promises';
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
import { createSession, DEFAULT_SESSION_TIMEOUTS } from '../src/auth/sessions.ts';
import { auditChain } from '../src/audit/reconciliation.ts';
import { drainCount } from '../src/audit/audit.ts';
import { FIXTURE_DDL, addEmployee, addMember } from './credentials-fixtures.ts';
import { rulesVersion, type Report } from 'notegit-validation';

// S9-T2 端到端并发与绕过终回归（implementation-breakdown §2.8 S9-T2 行——DOD-02/03/
// 05/07/11 的终回归背书面；S9 plan D4/D5）。
//
// 性质：回归聚合——把各 sprint 分散的证据面（S2 vaults-matrix、S3-T2/T4/T5/T6、
// S4-T6/T7、S5 search-authz）聚成**单一可复跑终面**，全部跑在 sprint/S9 最新合并态
// 的同一真实世界：真实 Fastify 应用（listen 随机端口）+ 文件 SQLite（hook 子进程
// 直连）+ dataDir 真实 bare 仓库 + 标准 git 客户端经真实 /git HTTP 通道 + Web 会话
// /API Bearer 双载体 + 搜索索引器。断言不重写既有逻辑，按各面既有契约复刻。
//
// validation.md §1 防绕过清单 11 项的终核覆盖映射（全量清单索引，供 T8 终核）：
//   ① 跳过本地 hook（--no-verify/克隆无 hook）→ 本文件 C1（服务端最终防线）
//   ② 先写坏后删 → C2；③ 合并夹带 → C3（+ C4 良性合并不误拒）
//   ④ 新库根提交全检 → C5；⑤ 多 ref 原子拒 → C6；⑥ tag 写入拒 → C7
//   ⑦ 网页直改引用 → 行为面 B1/B3（base commit CAS 拒）+ 结构面 C10（update-ref
//      唯一执行点=发布组件原子 CAS）
//   ⑧ 部分暂存校验错对象 → 本地 hook 面（cli 套件，S6）；⑨ 库内脚本攻击 hook →
//      cli hooks-sandbox/setup 套件（S6）——两項非服务端面，不由本文件复测
//   ⑩ 历史存量违规导入 → 管理员显式迁移流程（架构 §5.4，非常规校验范围）
//   ⑪ 解析资源攻击 → packages/validation 套件（YAML 安全子集 + 进程限制，S1）
//
// 新增组合场景（本文件首创的组合，区别于既有分面证据）按约束先行独立运行
// （2026-10-14 实测：直跑即绿——合并态产品满足组合行为，无产品缺陷；各场景
// 内建正/反两极控制保真——阳性前置 + 全拒断言，任一极失守即测试失败）：
//   E1 三入口同世界实时撤权终核；B1 网页编辑中他人经**真实 HTTP Git 通道** push
//   （S4-T7 为 file 传输形态）；B2 反向（网页先发布→原生过时 push 拒+恢复）；
//   D1 两入口交错审计成链（git push 与 web submit 相邻衔接）。

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

interface PushError extends Error {
  code?: number | string;
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

async function writeMd(dir: string, file: string, body: string | Uint8Array): Promise<void> {
  const abs = path.join(dir, file);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, body);
}

/** 经 plumbing 向 index 注入条目（大小写不敏感文件系统无法共存的路径/特殊 mode） */
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

// ── 终回归世界：两员工 × 两不同成员集库 + 面 fixture 员工 ───────────────────────
//
// 核心矩阵（DOD-02「两员工×两不同成员集库」）：alpha={alice:admin, bob:reader,
// carol:editor}、beta={bob:admin, erin:editor}——成员集互不相同。dave=双库非成员；
// root=实例管理员且非任何库成员（高权陷阱：实例管理员不自动获得库权限）。
// 两库均 main_admin_only=0（编辑者可快进写默认分支——并发/审计场景所需）。

interface World {
  app: FastifyInstance;
  db: DatabaseSync;
  dataDir: string;
  alphaRepo: string;
  betaRepo: string;
  alphaId: number;
  betaId: number;
  port: number;
  ids: Record<'alice' | 'bob' | 'carol' | 'dave' | 'erin' | 'root', number>;
  credIds: Record<'alice' | 'bob' | 'carol' | 'dave' | 'erin' | 'root', number>;
  tokens: Record<'alice' | 'bob' | 'carol' | 'dave' | 'erin' | 'root', string>;
  sids: Record<'alice' | 'bob' | 'carol' | 'dave' | 'erin' | 'root', string>;
  /** 带 Basic 凭据的 /git URL（用户名任意——identity §3.1 token 为唯一凭据） */
  urlFor(slug: string, who: keyof World['tokens']): string;
  close(): Promise<void>;
}

/** 搜索命中关键词（alpha/beta 各一份标题命中——成员过滤的判定样本） */
const KEYWORD = 'orion';
const ALPHA_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...randomBytes(32)]);

let w: World;

async function startWorld(): Promise<World> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'notegit-s9t2-'));
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
    erin: addEmployee(db, { username: 'erin' }),
    root: addEmployee(db, { username: 'root', is_instance_admin: 1 }),
  };

  const vaultService = new VaultService({ db, repoOps: createVaultRepoOps(dataDir) });
  const alpha = await vaultService.createVaultWithRepo(
    { name: 'Alpha', slug: 'alpha' },
    { employeeId: ids.alice, entry: 'web', carrierRef: 'session:fixture' },
  );
  addMember(db, alpha.id, ids.bob, 'reader', ids.alice);
  addMember(db, alpha.id, ids.carol, 'editor', ids.alice);
  const beta = await vaultService.createVaultWithRepo(
    { name: 'Beta', slug: 'beta' },
    { employeeId: ids.bob, entry: 'web', carrierRef: 'session:fixture' },
  );
  addMember(db, beta.id, ids.erin, 'editor', ids.bob);

  // 种子提交（file 传输直推——HTTP 面开启前的既有内容；审计链自首个 HTTP push 起）
  const seedInto = async (vaultId: number, files: Record<string, string | Uint8Array>) => {
    const repo = vaultRepoPath(dataDir, vaultId);
    const work = path.join(dataDir, `seed-${vaultId}`);
    await git(['init', '-b', 'main', work]);
    for (const [rel, body] of Object.entries(files)) await writeMd(work, rel, body);
    await git(['-C', work, 'add', '.']);
    await git(['-C', work, '-c', 'user.email=seed@notegit.test', '-c', 'user.name=seed', 'commit', '-m', 'seed']);
    await git(['-C', work, 'push', repo, 'main']);
    await rm(work, { recursive: true, force: true });
  };
  await seedInto(alpha.id, {
    'README.md': '# alpha 导航\n',
    'notes/first.md': '---\ntitle: First\n---\nbody\n', // E-PATH-004 全 tree 基线存量路径
    'notes/orion-alpha.md': `---\ntitle: ${KEYWORD} 手册\n---\nalpha 命中样本。\n`,
    'assets/logo.png': ALPHA_PNG,
  });
  await seedInto(beta.id, {
    'README.md': '# beta 导航\n',
    [`secret/${KEYWORD}-beta.md`]: `---\ntitle: ${KEYWORD} 机密\n---\nbeta 命中样本（alice 无权不得见）。\n`,
    'assets/secret.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, ...randomBytes(16)]),
  });

  // 凭据（真实签发路径）+ 会话（真实 sessions 表行）
  const credentials = new CredentialsService({ db, pepper });
  const expires = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const tokens = {} as World['tokens'];
  const credIds = {} as World['credIds'];
  for (const who of Object.keys(ids) as Array<keyof World['ids']>) {
    const cred = credentials.createCredential(ids[who], { name: `s9t2-${who}`, expires_at: expires });
    tokens[who] = cred.token;
    credIds[who] = cred.record.id;
  }
  const now = new Date();
  const sids = {} as World['sids'];
  for (const who of Object.keys(ids) as Array<keyof World['ids']>) {
    sids[who] = createSession(db, ids[who], pepper.active.key, now, DEFAULT_SESSION_TIMEOUTS).sid;
  }

  const app = buildApp({
    db,
    pepper,
    bootstrapTokenFile: path.join(dataDir, 'config', 'admin-bootstrap.token'),
    dataDir,
    dbFile, // /git 入口与 pre-receive hook 子进程直连同一库文件
    searchIndex: { pollMs: 50 }, // 搜索面（DOD-02「搜索结果不可访问」）
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = app.addresses()[0]!.port;

  return {
    app,
    db,
    dataDir,
    alphaRepo: vaultRepoPath(dataDir, alpha.id),
    betaRepo: vaultRepoPath(dataDir, beta.id),
    alphaId: alpha.id,
    betaId: beta.id,
    port,
    ids,
    credIds,
    tokens,
    sids,
    urlFor: (slug, who) => `http://${who}:${w.tokens[who]}@127.0.0.1:${port}/git/${slug}.git`,
    close: async () => {
      await app.close();
      db.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

before(async () => {
  w = await startWorld();
  // 等启动对账把两库索引到位（搜索矩阵的前置；root 为实例管理员）
  const deadline = Date.now() + 15_000;
  for (;;) {
    const res = await w.app.inject({
      method: 'GET',
      url: '/api/v1/admin/search-index',
      headers: { authorization: `Bearer ${w.tokens.root}` },
    });
    const status = res.json() as { vaults: { up_to_date: boolean; rows: number }[] };
    if (status.vaults.length === 2 && status.vaults.every((v) => v.up_to_date && v.rows > 0)) break;
    if (Date.now() > deadline) throw new Error('等待启动对账索引超时');
    await new Promise((r) => setTimeout(r, 25));
  }
});

after(async () => {
  await w.close();
});

// ── 请求助手（Web 会话 / API Bearer 双载体；写方法带同源 Origin 过 CSRF） ──────

type Who = keyof World['tokens'];

const SID = (who: Who): Record<string, string> => ({ cookie: `ngt_sid=${w.sids[who]}` });
const SID_WRITE = (who: Who): Record<string, string> => ({ ...SID(who), origin: 'http://localhost' });
const BEARER = (who: Who): Record<string, string> => ({ authorization: `Bearer ${w.tokens[who]}` });
const basic = (who: Who): string => 'Basic ' + Buffer.from(`${who}:${w.tokens[who]}`).toString('base64');
const httpUrl = (slug: string, suffix: string): string => `http://127.0.0.1:${w.port}/git/${slug}.git${suffix}`;

/** 排干响应体：undici 未读体会占住 keep-alive 连接，拖慢收尾 app.close() */
async function drain(res: Response): Promise<void> {
  await res.arrayBuffer();
}

async function headOf(repo: string, ref = 'refs/heads/main'): Promise<string> {
  return (await git(['--git-dir', repo, 'rev-parse', ref])).stdout.trim();
}

async function commitCount(repo: string, ref = 'refs/heads/main'): Promise<number> {
  return Number((await git(['--git-dir', repo, 'rev-list', '--count', ref])).stdout.trim());
}

async function cloneOf(slug: string, who: Who, name: string): Promise<string> {
  const dir = path.join(w.dataDir, name);
  await git(['clone', w.urlFor(slug, who), dir]);
  await git(['-C', dir, 'config', 'user.email', `${who}@notegit.test`]);
  await git(['-C', dir, 'config', 'user.name', who]);
  return dir;
}

async function commitAll(cwd: string, message: string, author?: string): Promise<string> {
  await git(['-C', cwd, 'add', '.']);
  const id = author === undefined ? [] : ['-c', `user.email=${author}@evil.test`, '-c', `user.name=${author}`];
  await git(['-C', cwd, ...id, 'commit', '-m', message]);
  return (await git(['-C', cwd, 'rev-parse', 'HEAD'])).stdout.trim();
}

/** §8.2 POST submissions（与编辑页提交按钮同一形状——S4-T7 面） */
function submitPost(who: Who, baseCommit: string, changes: readonly unknown[], message?: string) {
  const body: Record<string, unknown> = { base_commit: baseCommit, changes: [...changes] };
  if (message !== undefined) body['message'] = message;
  return w.app.inject({
    method: 'POST',
    url: '/api/v1/vaults/alpha/submissions',
    headers: { 'content-type': 'application/json', ...SID_WRITE(who) },
    payload: body,
  });
}

const textChange = (p: string, content: string) => ({ path: p, content });

/** 直查 drafts 行（测试对照——不经生产读面） */
function draftRow(vaultId: number, employeeId: number, p: string): { status: string; content: string } | undefined {
  return w.db
    .prepare('SELECT status, content FROM drafts WHERE vault_id = ? AND employee_id = ? AND path = ?')
    .get(vaultId, employeeId, p) as { status: string; content: string } | undefined;
}

interface AuditRow {
  id: number;
  employee_id: number | null;
  credential_ref: string | null;
  entry: string;
  event_kind: string;
  vault_id: number | null;
  ref_name: string | null;
  old_commit: string | null;
  new_commit: string | null;
  status: string;
  occurred_at: string;
  detail: string;
}

function auditRows(eventKind: string, status?: string): AuditRow[] {
  const rows = w.db
    .prepare(`SELECT * FROM audit_events WHERE event_kind = ? ORDER BY id`)
    .all(eventKind) as unknown as AuditRow[];
  return status === undefined ? rows : rows.filter((r) => r.status === status);
}

// ══════════════════════════════════════════════════════════════════════════════
// A. DOD-02 越权矩阵：两员工 × 两不同成员集库，Web/API/Git 三入口全谱终核
//（整合 S2 vaults-matrix / S3 githttp 行为与 policy / S4 附件与提交 / S5 搜索
//  的分散矩阵为同一世界单一终面；矩阵世界见 startWorld 注释）
// ══════════════════════════════════════════════════════════════════════════════

// ── A1 Web 入口可见性（页面域：未认证 302；成员 200；非成员 404 与不存在同体） ──

function vaultSlugsInPage(body: string): string[] {
  const out: string[] = [];
  const re = /class="vault-slug">([^<]+)</g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) out.push(m[1]!);
  return out;
}

test('A1 Web 可见性矩阵：列表只含有成员关系的库；库根/浏览/预览/编辑/历史页非成员 404 与不存在同体', async () => {
  // 列表页：成员集互不相同的两库在各自列表中精确呈现
  const lists: Array<[Who, string[]]> = [
    ['alice', ['alpha']],
    ['bob', ['alpha', 'beta']],
    ['carol', ['alpha']],
    ['erin', ['beta']],
    ['dave', []],
    ['root', []], // 实例管理员不自动获得库权限（高权陷阱）
  ];
  for (const [who, expected] of lists) {
    const res = await w.app.inject({ method: 'GET', url: '/vaults', headers: SID(who) });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(vaultSlugsInPage(res.body), expected, `${who} 的库列表`);
  }
  // 未认证 → 302 /login（页面域统一守卫）
  const anon = await w.app.inject({ method: 'GET', url: '/vaults' });
  assert.equal(anon.statusCode, 302);

  // 库根/浏览/预览/编辑表单：非成员（alice×beta）与不存在（ghost）同 404 同体
  const faces = [
    '/vaults/beta',
    '/vaults/beta/browse',
    '/vaults/beta/browse/secret',
    `/vaults/beta/view/secret/${KEYWORD}-beta.md`,
    `/vaults/beta/edit/secret/${KEYWORD}-beta.md`,
    '/vaults/beta/history',
  ];
  for (const url of faces) {
    const noMember = await w.app.inject({ method: 'GET', url, headers: SID('alice') });
    const ghost = await w.app.inject({ method: 'GET', url: url.replace('/beta/', '/ghost/'), headers: SID('alice') });
    assert.equal(noMember.statusCode, 404, `${url} 非成员应 404`);
    assert.equal(ghost.statusCode, 404);
    assert.deepEqual(noMember.body, ghost.body, `${url}：无权与不存在同体（D-IC-06）`);
  }
  // dave（双库非成员）对两库一律 404
  for (const url of ['/vaults/alpha/browse', '/vaults/beta/browse']) {
    const res = await w.app.inject({ method: 'GET', url, headers: SID('dave') });
    assert.equal(res.statusCode, 404, `dave ${url}`);
  }
  // 成员阳性对照：bob 浏览 beta 200（可见性矩阵的另一极）
  const ok = await w.app.inject({ method: 'GET', url: '/vaults/beta/browse', headers: SID('bob') });
  assert.equal(ok.statusCode, 200, ok.body);
});

// ── A2 Web 写面矩阵（页面域写端点：reader 403；非成员 404 与不存在同体） ────────

test('A2 Web 写面矩阵：上传/重命名/删除/还原/草稿/提交——非成员 404 同体、只读成员 403', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]);

  // 非成员（alice×beta）与不存在（ghost）同体：上传/重命名/删除/草稿保存
  const posts: Array<[string, string, Record<string, unknown> | Buffer, string]> = [
    ['POST', '/vaults/beta/upload/assets/x.png', png, 'upload'],
    ['POST', '/vaults/beta/rename/secret/x.md', { to: 'y.md' }, 'rename'],
    ['POST', '/vaults/beta/delete/secret/x.md', {}, 'delete'],
    ['PUT', '/api/v1/vaults/beta/drafts/notes/x.md', { content: 'x', base_commit: null }, 'draft'],
    ['POST', '/api/v1/vaults/beta/submissions', { base_commit: null, changes: [textChange('a.md', 'x')] }, 'submit'],
  ];
  for (const [method, url, payload, label] of posts) {
    const noMember = await w.app.inject({
      method: method as 'POST' | 'PUT',
      url,
      headers: { 'content-type': payload instanceof Buffer ? 'application/octet-stream' : 'application/json', ...SID_WRITE('alice') },
      payload,
    });
    const ghost = await w.app.inject({
      method: method as 'POST' | 'PUT',
      url: url.replace('/beta/', '/ghost/'),
      headers: { 'content-type': payload instanceof Buffer ? 'application/octet-stream' : 'application/json', ...SID_WRITE('alice') },
      payload,
    });
    assert.equal(noMember.statusCode, 404, `${label}：非成员应 404`);
    assert.equal(ghost.statusCode, 404, `${label}：不存在应 404`);
    if (label === 'submit') assert.deepEqual(noMember.body, ghost.body, 'submissions：无权与不存在同体（D-IC-06）');
  }
  // 还原（写）：非成员 404
  const betaHead = await headOf(w.betaRepo);
  const restore = await w.app.inject({
    method: 'POST',
    url: `/vaults/beta/restore/${betaHead}/secret/x.md`,
    headers: SID_WRITE('alice'),
    payload: {},
  });
  assert.equal(restore.statusCode, 404, 'restore：非成员 404');

  // 只读成员（bob×alpha）：写类端点 403（只读成员不能写入——DOD-02）
  const readerFaces: Array<[string, string, Record<string, unknown> | Buffer, string]> = [
    ['POST', '/vaults/alpha/upload/assets/x.png', png, 'upload'],
    ['POST', '/vaults/alpha/rename/notes/first.md', { to: 'notes/renamed.md' }, 'rename'],
    ['POST', '/vaults/alpha/delete/notes/first.md', {}, 'delete'],
    ['PUT', '/api/v1/vaults/alpha/drafts/notes/x.md', { content: 'x', base_commit: null }, 'draft'],
    ['POST', '/api/v1/vaults/alpha/submissions', { base_commit: null, changes: [textChange('a.md', 'x')] }, 'submit'],
  ];
  for (const [method, url, payload, label] of readerFaces) {
    const res = await w.app.inject({
      method: method as 'POST' | 'PUT',
      url,
      headers: { 'content-type': payload instanceof Buffer ? 'application/octet-stream' : 'application/json', ...SID_WRITE('bob') },
      payload,
    });
    assert.equal(res.statusCode, 403, `${label}：只读成员应 403`);
    if (label === 'submit') assert.equal((res.json() as { error: { code: string } }).error.code, 'E-AUTHZ-001');
  }
  // 编辑者阳性对照（erin×beta 草稿保存 200）——写面拒绝是授权所致而非端点坏
  const okDraft = await w.app.inject({
    method: 'PUT',
    url: '/api/v1/vaults/beta/drafts/notes/erin.md',
    headers: { 'content-type': 'application/json', ...SID_WRITE('erin') },
    payload: { content: '---\ntitle: Erin\n---\nbody\n', base_commit: await headOf(w.betaRepo) },
  });
  assert.equal(okDraft.statusCode, 200, okDraft.body);
});

// ── A3 API 入口矩阵（Bearer：可见性/读写与 Web 会话判定一致） ───────────────────

test('A3 API 矩阵：列表与单库跨单元全谱；非成员 404 与不存在同体；reader 管理写 403', async () => {
  // 列表（Bearer 与 Web 会话同判定）
  const listCases: Array<[Who, string[]]> = [
    ['alice', ['alpha']],
    ['bob', ['alpha', 'beta']],
    ['dave', []],
    ['root', []],
  ];
  for (const [who, expected] of listCases) {
    const res = await w.app.inject({ method: 'GET', url: '/api/v1/vaults', headers: BEARER(who) });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(
      ((res.json() as { vaults: Array<{ slug: string }> }).vaults).map((v) => v.slug),
      expected,
      `${who} 的 API 库列表`,
    );
  }
  // 会话载体同判定（Web 与 API 一致授权——DOD-02）
  const viaSid = await w.app.inject({ method: 'GET', url: '/api/v1/vaults', headers: SID('bob') });
  assert.deepEqual(
    ((viaSid.json() as { vaults: Array<{ slug: string }> }).vaults).map((v) => v.slug),
    ['alpha', 'beta'],
  );

  // 单库矩阵：成员 200（角色正确标注）；非成员与不存在同 404 同体
  const cells: Array<[Who, string, number]> = [
    ['alice', 'alpha', 200],
    ['bob', 'alpha', 200],
    ['carol', 'alpha', 200],
    ['bob', 'beta', 200],
    ['erin', 'beta', 200],
    ['alice', 'beta', 404],
    ['dave', 'alpha', 404],
    ['dave', 'beta', 404],
    ['root', 'alpha', 404], // 实例管理员非成员同样 404
  ];
  for (const [who, slug, expected] of cells) {
    const res = await w.app.inject({ method: 'GET', url: `/api/v1/vaults/${slug}`, headers: BEARER(who) });
    assert.equal(res.statusCode, expected, `${who}×${slug}`);
  }
  const roleOf = await w.app.inject({ method: 'GET', url: '/api/v1/vaults/alpha', headers: BEARER('bob') });
  assert.equal((roleOf.json() as { role: string }).role, 'reader', '角色按成员关系标注');
  const noMember = await w.app.inject({ method: 'GET', url: '/api/v1/vaults/beta', headers: BEARER('alice') });
  const ghost = await w.app.inject({ method: 'GET', url: '/api/v1/vaults/ghost', headers: BEARER('alice') });
  assert.deepEqual(noMember.body, ghost.body, '无权与不存在响应体一致');

  // 成员管理写：非成员 404（与不存在同体）；reader 403
  const mgmtNoMember = await w.app.inject({
    method: 'PUT', url: '/api/v1/vaults/beta/members/dave',
    headers: BEARER('alice'), payload: { role: 'editor' },
  });
  const mgmtGhost = await w.app.inject({
    method: 'PUT', url: '/api/v1/vaults/ghost/members/dave',
    headers: BEARER('alice'), payload: { role: 'editor' },
  });
  assert.equal(mgmtNoMember.statusCode, 404);
  assert.equal(mgmtGhost.statusCode, 404);
  assert.deepEqual(mgmtNoMember.body, mgmtGhost.body);
  const mgmtReader = await w.app.inject({
    method: 'PUT', url: '/api/v1/vaults/alpha/members/dave',
    headers: BEARER('bob'), payload: { role: 'editor' },
  });
  assert.equal(mgmtReader.statusCode, 403);
  assert.equal((mgmtReader.json() as { error: { code: string } }).error.code, 'E-AUTHZ-001');
});

// ── A4 Git 入口矩阵（refs 发现/克隆/推送——与 Web/API 同一成员判定源） ──────────

test('A4 Git 矩阵：refs 发现跨单元全谱（200/403/404）；非成员克隆拒；reader 推送拒；成员推送成', async () => {
  // refs 发现矩阵：upload-pack（读）× receive-pack（写）× 员工×库
  const ads: Array<[Who, string, 'git-upload-pack' | 'git-receive-pack', number]> = [
    ['alice', 'alpha', 'git-upload-pack', 200],
    ['alice', 'alpha', 'git-receive-pack', 200],
    ['bob', 'alpha', 'git-upload-pack', 200],   // reader：读放行
    ['bob', 'alpha', 'git-receive-pack', 403],  // reader：写拒（成员已知、角色不足）
    ['carol', 'alpha', 'git-receive-pack', 200],
    ['bob', 'beta', 'git-upload-pack', 200],
    ['bob', 'beta', 'git-receive-pack', 200],
    ['erin', 'beta', 'git-receive-pack', 200],
    ['erin', 'alpha', 'git-upload-pack', 404],  // 非成员：与不存在同 404（D-IC-06）
    ['dave', 'alpha', 'git-upload-pack', 404],
    ['dave', 'beta', 'git-receive-pack', 404],
    ['root', 'alpha', 'git-upload-pack', 404],  // 实例管理员非成员同样 404
    ['alice', 'ghost', 'git-upload-pack', 404],
  ];
  for (const [who, slug, service, expected] of ads) {
    const res = await fetch(httpUrl(slug, `/info/refs?service=${service}`), {
      headers: { authorization: basic(who) },
    });
    assert.equal(res.status, expected, `${who}×${slug}×${service}`);
    if (expected === 403) {
      assert.equal((await res.json() as { error?: { code?: string } }).error?.code, 'E-AUTHZ-001');
    } else {
      await drain(res);
    }
  }
  // 非成员 404 与未知库同体（不泄露存在性）
  const noMember = await fetch(httpUrl('beta', '/info/refs?service=git-upload-pack'), {
    headers: { authorization: basic('alice') },
  });
  const unknown = await fetch(httpUrl('ghost', '/info/refs?service=git-upload-pack'), {
    headers: { authorization: basic('alice') },
  });
  assert.deepEqual(await noMember.json(), await unknown.json(), '无权与不存在响应一致（D-IC-06）');

  // 真实克隆：成员成功（跨库阳性对照）；非成员克隆拒（404 映射 repository not found）
  await cloneOf('alpha', 'alice', 'a4-clone-alice');
  await assert.rejects(
    git(['clone', w.urlFor('beta', 'alice'), path.join(w.dataDir, 'a4-clone-beta')]),
    (e: PushError) => /not found|404/i.test(String(e.stderr)),
    'alice 克隆 beta 应被拒（非成员）',
  );
  await assert.rejects(
    git(['clone', w.urlFor('alpha', 'dave'), path.join(w.dataDir, 'a4-clone-dave')]),
    (e: PushError) => /not found|404/i.test(String(e.stderr)),
    'dave 克隆 alpha 应被拒（非成员）',
  );

  // reader 真实推送拒（403 在 receive-pack 引用发现即拒）；成员推送成（矩阵阳性极）
  const bobClone = path.join(w.dataDir, 'a4-bob-clone');
  await git(['clone', w.urlFor('alpha', 'bob'), bobClone]);
  await writeMd(bobClone, 'notes/by-bob.md', '---\ntitle: ByBob\n---\nbody\n');
  await commitAll(bobClone, 'reader tries to write');
  await assert.rejects(
    git(['-C', bobClone, 'push', 'origin', 'main']),
    (e: PushError) => /403|E-AUTHZ-001|无权|forbidden/i.test(String(e.stderr)),
    '只读成员 push 应被拒（只读成员不能写入——DOD-02）',
  );

  const carolClone = await cloneOf('alpha', 'carol', 'a4-carol-clone');
  await writeMd(carolClone, 'notes/matrix-probe.md', '---\ntitle: MatrixProbe\n---\nbody\n');
  const probeHead = await commitAll(carolClone, 'matrix probe');
  await git(['-C', carolClone, 'push', 'origin', 'main']);
  assert.equal(await headOf(w.alphaRepo), probeHead, '编辑者快进推送被接受（矩阵阳性极）');
});

// ── A5 历史/附件/搜索矩阵（DOD-02：无权库的历史、附件、对象、搜索结果不可访问） ──

test('A5 历史/附件/对象矩阵：跨库历史/diff/版本/还原页与附件读取 404；对象不跨库可达', async () => {
  const betaHead = await headOf(w.betaRepo);
  const betaFirstFiles = (await git(['--git-dir', w.betaRepo, 'ls-tree', '-r', '--name-only', 'refs/heads/main'])).stdout
    .split('\n')
    .filter((f) => f.endsWith('.md') && !f.endsWith('README.md'));
  const betaMd = betaFirstFiles[0]!;

  // 历史/diff/版本/还原（读面 + 写面）非成员 404 与不存在同体
  const historyFaces = [
    `/vaults/beta/history/${betaMd}`,
    `/vaults/beta/diff/${betaHead}/${betaMd}`,
    `/vaults/beta/version/${betaHead}/${betaMd}`,
    `/vaults/beta/restore/${betaHead}/${betaMd}`,
  ];
  for (const url of historyFaces) {
    const noMember = await w.app.inject({ method: 'GET', url, headers: SID('alice') });
    const ghost = await w.app.inject({ method: 'GET', url: url.replace('/beta/', '/ghost/'), headers: SID('alice') });
    assert.equal(noMember.statusCode, 404, `${url} 非成员应 404`);
    assert.equal(ghost.statusCode, 404);
    assert.deepEqual(noMember.body, ghost.body, `${url}：无权与不存在同体`);
  }

  // 附件（blob 寻址）：成员读 200 字节精确；非成员/无库关系 404；OID 不跨库可达
  const alphaPngOid = (
    await git(['--git-dir', w.alphaRepo, 'ls-tree', 'refs/heads/main', 'assets/logo.png'])
  ).stdout.split('\t')[0]!.split(' ')[2]!;
  const betaPngOid = (
    await git(['--git-dir', w.betaRepo, 'ls-tree', 'refs/heads/main', 'assets/secret.png'])
  ).stdout.split('\t')[0]!.split(' ')[2]!;

  const memberRead = await w.app.inject({
    method: 'GET',
    url: `/vaults/alpha/attach/${alphaPngOid}/logo.png`,
    headers: SID('bob'), // reader：读放行
  });
  assert.equal(memberRead.statusCode, 200, '成员（reader）附件读取放行');
  assert.equal(memberRead.rawPayload.length, ALPHA_PNG.length, '附件字节精确');

  const attachRejects: Array<[Who, string]> = [
    ['alice', `/vaults/beta/attach/${betaPngOid}/secret.png`], // 非成员×beta 附件
    ['dave', `/vaults/alpha/attach/${alphaPngOid}/logo.png`],  // 非成员×alpha 附件
    ['alice', `/vaults/alpha/attach/${betaPngOid}/probe.png`], // alpha 成员以 beta OID 探测（对象不跨库）
  ];
  for (const [who, url] of attachRejects) {
    const res = await w.app.inject({ method: 'GET', url, headers: SID(who) });
    assert.equal(res.statusCode, 404, `${who} ${url}`);
  }
});

test('A5 搜索矩阵：命中不泄露无权库（API 与页面）；非成员/实例管理员零结果', async () => {
  // 等索引追平 A4 的 matrix-probe 推送（搜索断言前的对账收敛）
  const deadline = Date.now() + 15_000;
  for (;;) {
    const res = await w.app.inject({
      method: 'GET', url: '/api/v1/admin/search-index', headers: BEARER('root'),
    });
    const status = res.json() as { vaults: { up_to_date: boolean }[] };
    if (status.vaults.length >= 2 && status.vaults.every((v) => v.up_to_date)) break;
    if (Date.now() > deadline) throw new Error('等待索引追平超时');
    await new Promise((r) => setTimeout(r, 25));
  }

  const search = (who: Who) =>
    w.app.inject({ method: 'GET', url: `/api/v1/search?q=${KEYWORD}`, headers: BEARER(who) }).then(
      (res) => ({ status: res.statusCode, hits: (res.json() as { results: Array<{ vault_slug: string; path: string }> }).results }),
    );

  const aliceHit = await search('alice');
  assert.equal(aliceHit.status, 200);
  assert.deepEqual(
    aliceHit.hits.map((r) => `${r.vault_slug}:${r.path}`),
    [`alpha:notes/${KEYWORD}-alpha.md`],
    'alice（仅 alpha 成员）只见 alpha 命中',
  );
  const bobHit = await search('bob');
  assert.deepEqual(
    bobHit.hits.map((r) => r.vault_slug),
    ['alpha', 'beta'],
    'bob（两库成员）见两库命中',
  );
  for (const who of ['dave', 'root'] as const) {
    const res = await search(who);
    assert.deepEqual(res.hits, [], `${who}（无成员关系/实例管理员）零结果`);
  }
  // 无权库文本不进响应（不泄露存在性）；页面同判定
  const aliceAll = await w.app.inject({ method: 'GET', url: `/api/v1/search?q=${KEYWORD}`, headers: BEARER('alice') });
  assert.ok(!aliceAll.body.includes('机密'), 'beta 命中标题不进 alice 的响应');
  const page = await w.app.inject({ method: 'GET', url: `/search?q=${KEYWORD}`, headers: SID('alice') });
  assert.equal(page.statusCode, 200);
  assert.ok(page.body.includes(`notes/${KEYWORD}-alpha.md`), '页面见 alpha 命中');
  assert.ok(!page.body.includes('机密'), '页面不呈现 beta 命中');
});

// ══════════════════════════════════════════════════════════════════════════════
// B. DOD-07 原生 Git × Web 并发终核（不静默覆盖；冲突草稿保留；恢复闭环）
//（S4-T7 的 Web×Git 冲突为 file 传输形态；此处他人 push 走真实 /git HTTP 通道
//  ——pre-receive 校验、审计、引用更新全链——并补反向与两网页提交组合）
// ══════════════════════════════════════════════════════════════════════════════

test('B1 并发终核（网页编辑中他人经真实 HTTP Git push）：后提交方 409 含当前 tip、先提交不覆盖、草稿逐字保留、刷新基线重提闭环', async () => {
  const base = await headOf(w.alphaRepo); // alice 打开编辑器时的基线
  const countBefore = await commitCount(w.alphaRepo);

  // alice 保存草稿（打开编辑器工作形态）
  const DRAFT = '---\ntitle: "并发草稿"\n---\n\nalice 的正文（标记 b1x）。\n';
  const saved = await w.app.inject({
    method: 'PUT',
    url: '/api/v1/vaults/alpha/drafts/notes/concurrent.md',
    headers: { 'content-type': 'application/json', ...SID_WRITE('alice') },
    payload: { content: DRAFT, base_commit: base },
  });
  assert.equal(saved.statusCode, 200, saved.body);

  // 他人（carol）经**真实 HTTP Git 通道**推进默认分支（clone→commit→push 全链）
  const carolClone = await cloneOf('alpha', 'carol', 'b1-carol-clone');
  await writeMd(carolClone, 'notes/from-git.md', '---\ntitle: "Git 推进"\n---\ngit\n');
  const gitHead = await commitAll(carolClone, 'carol pushes while alice edits');
  await git(['-C', carolClone, 'push', 'origin', 'main']);
  assert.equal(await headOf(w.alphaRepo), gitHead, '前置：分支已被真实 Git 通道推进');

  // alice 仍以打开编辑器时的基线提交 → 409 E-RES-003（预期旧 commit CAS）
  const stale = await submitPost('alice', base, [textChange('notes/concurrent.md', DRAFT)]);
  assert.equal(stale.statusCode, 409, stale.body);
  const body = stale.json() as { error: { code: string; details?: { base_commit?: string; current_head?: string } } };
  assert.equal(body.error.code, 'E-RES-003');
  assert.equal(body.error.details?.base_commit, base, 'details 呈现提交时的预期旧 commit');
  assert.equal(body.error.details?.current_head, gitHead, 'details 携带当前 tip（提示刷新基线）');

  // 不静默覆盖：先前提交（他人 push）仍在；仅他人一笔新增
  assert.equal(await headOf(w.alphaRepo), gitHead, '拒绝发布不覆盖——ref 停留在他人的提交');
  assert.equal(await commitCount(w.alphaRepo), countBefore + 1, '仅他人一笔新增提交');

  // 冲突草稿完整保留（active + 逐字内容 + 可恢复）
  const row = draftRow(w.alphaId, w.ids.alice, 'notes/concurrent.md');
  assert.equal(row?.status, 'active');
  assert.equal(row?.content, DRAFT, '草稿内容逐字保留');
  const restored = await w.app.inject({
    method: 'GET',
    url: '/api/v1/vaults/alpha/drafts/notes/concurrent.md',
    headers: SID('alice'),
  });
  assert.equal(restored.statusCode, 200, '冲突后草稿仍可恢复（§7）');

  // 恢复闭环：刷新基线（编辑器重开取最新 HEAD）→ 201，父 = 他人提交（快进）
  const fresh = await submitPost('alice', gitHead, [textChange('notes/concurrent.md', DRAFT)]);
  assert.equal(fresh.statusCode, 201, fresh.body);
  const webHead = (fresh.json() as { commit: string }).commit;
  const parent = (await git(['--git-dir', w.alphaRepo, 'rev-parse', `${webHead}^`])).stdout.trim();
  assert.equal(parent, gitHead, '重提以他人提交为父（快进、不覆盖）');
});

test('B2 并发反向（网页先发布→原生过时 push）：非快进拒、ref 不动、fetch+rebase 后成功且不丢任何一方', async () => {
  // carol 在当前基线克隆（即将变为过时基线）
  const base = await headOf(w.alphaRepo);
  const carolClone = await cloneOf('alpha', 'carol', 'b2-carol-clone');

  // alice 先经网页发布（推进默认分支）
  const WEB = '---\ntitle: "网页先发布"\n---\n\nalice web（标记 b2w）。\n';
  const web = await submitPost('alice', base, [textChange('notes/web-first.md', WEB)]);
  assert.equal(web.statusCode, 201, web.body);
  const webHead = (web.json() as { commit: string }).commit;

  // carol 在过时基线上提交并 push → 非快进被拒（不静默覆盖的反向极）
  await writeMd(carolClone, 'notes/git-late.md', '---\ntitle: "Git 后到"\n---\n\ncarol git（标记 b2g）。\n');
  await commitAll(carolClone, 'carol stale push');
  await assert.rejects(
    git(['-C', carolClone, 'push', 'origin', 'main']),
    (e: PushError) => /non-fast-forward|fetch first|rejected/i.test(String(e.stderr)),
    '过时基线 push 应被非快进拒绝',
  );
  assert.equal(await headOf(w.alphaRepo), webHead, '被拒推送后 ref 停留在网页发布提交');

  // 恢复闭环：fetch + rebase 到最新 → push 成功；两方内容都在
  await git(['-C', carolClone, 'fetch', 'origin']);
  await git(['-C', carolClone, 'rebase', 'origin/main']);
  const rebased = (await git(['-C', carolClone, 'rev-parse', 'HEAD'])).stdout.trim();
  await git(['-C', carolClone, 'push', 'origin', 'main']);
  assert.equal(await headOf(w.alphaRepo), rebased, 'rebase 后推送生效');
  // 网页发布提交仍是最终历史的祖先（任何一方内容都不丢）
  await git(['--git-dir', w.alphaRepo, 'merge-base', '--is-ancestor', webHead, 'refs/heads/main']);
  const tree = (await git(['--git-dir', w.alphaRepo, 'ls-tree', '-r', '--name-only', 'refs/heads/main'])).stdout;
  assert.ok(tree.includes('notes/web-first.md') && tree.includes('notes/git-late.md'), '两方内容都在最终树中');
});

test('B3 两网页提交冲突：后提交方 409、先提交不被覆盖、双方草稿按 §7 流转', async () => {
  const base = await headOf(w.alphaRepo);
  // 两人各自打开编辑器（同一基线）并保存草稿
  const CAROL = '---\ntitle: "Carol 先提交"\n---\ncarol\n';
  const ALICE = '---\ntitle: "Alice 后提交"\n---\nalice\n';
  const save = (who: Who, p: string, content: string) =>
    w.app.inject({
      method: 'PUT',
      url: `/api/v1/vaults/alpha/drafts/${p}`,
      headers: { 'content-type': 'application/json', ...SID_WRITE(who) },
      payload: { content, base_commit: base },
    });
  assert.equal((await save('carol', 'notes/two-web-carol.md', CAROL)).statusCode, 200);
  assert.equal((await save('alice', 'notes/two-web-alice.md', ALICE)).statusCode, 200);

  // carol 先提交 → 201
  const first = await submitPost('carol', base, [textChange('notes/two-web-carol.md', CAROL)]);
  assert.equal(first.statusCode, 201, first.body);
  const winnerHead = (first.json() as { commit: string }).commit;
  assert.equal(await headOf(w.alphaRepo), winnerHead, '201 commit = 发布后 HEAD');

  // alice 后提交（基线已过时）→ 409；先前提交不被覆盖；草稿按 §7 流转
  const second = await submitPost('alice', base, [textChange('notes/two-web-alice.md', ALICE)]);
  assert.equal(second.statusCode, 409, second.body);
  const body = second.json() as { error: { code: string; details?: { current_head?: string } } };
  assert.equal(body.error.code, 'E-RES-003');
  assert.equal(body.error.details?.current_head, winnerHead, '当前 tip = 先提交方的 commit');
  assert.equal(await headOf(w.alphaRepo), winnerHead, '先前提交不被覆盖');
  assert.equal(draftRow(w.alphaId, w.ids.alice, 'notes/two-web-alice.md')?.status, 'active', '后提交方冲突草稿保留');
  assert.equal(draftRow(w.alphaId, w.ids.alice, 'notes/two-web-alice.md')?.content, ALICE, '冲突草稿逐字保留');
  assert.equal(draftRow(w.alphaId, w.ids.carol, 'notes/two-web-carol.md')?.status, 'committed', '先提交方本人草稿标已提交');
});

// ══════════════════════════════════════════════════════════════════════════════
// C. DOD-05 validation §1 防绕过清单全量复测（服务端可执行项——S3-T4 面在终
//    回归世界复刻；⑦ 行为面=B1/B3、结构面=C10；⑧⑨⑩⑪ 见文件头映射）
// ══════════════════════════════════════════════════════════════════════════════

test('C1 防绕过①：克隆无 hook + --no-verify 推违规内容被拒——服务端最终防线（报告进审计行）', async () => {
  const clone = await cloneOf('alpha', 'carol', 'c1-clone');
  // 克隆不携带任何生效 hook（无 hook 客户端形态：hook 不随 clone 分发）
  const hooks = await readdir(path.join(clone, '.git', 'hooks'));
  assert.deepEqual(hooks.filter((f) => !f.endsWith('.sample')), [], '克隆应无任何生效 hook');

  const before = await headOf(w.alphaRepo);
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
  assert.equal(await headOf(w.alphaRepo), before, '被拒推送后服务端 ref 不变');

  // 拒绝也留审计行（DOD-11）：主体=认证员工（token 归属），结果=rejected
  const rejected = auditRows('vault.push', 'rejected');
  assert.ok(rejected.length >= 1, '拒绝留审计行');
  const mine = rejected.filter((r) => r.new_commit === bad);
  assert.equal(mine.length, 1, '本笔拒绝恰一行');
  assert.equal(mine[0]!.employee_id, w.ids.carol, '主体=认证员工（token 归属）');
  assert.equal(mine[0]!.credential_ref, `credential:${w.credIds.carol}`, '载体=推送所用凭据');
  assert.equal(mine[0]!.entry, 'git');
});

test('C2 防绕过②：先写坏后删被拒且 ref 不变——违规内容先进历史即拦截（逐提交归因）', async () => {
  const clone = await cloneOf('alpha', 'carol', 'c2-clone');
  const before = await headOf(w.alphaRepo);
  await writeMd(clone, 'notes/bad.md', 'no frontmatter at all\n');
  const badCommit = await commitAll(clone, 'add bad');
  await git(['-C', clone, 'rm', '-q', 'notes/bad.md']);
  await commitAll(clone, 'remove bad');
  const stderr = await rejectPush(['push', 'origin', 'main'], clone, /bad\.md/);
  const report = reportFromStderr(stderr);
  const f = report.files.find((x) => x.path === 'notes/bad.md');
  assert.equal(f?.commit, badCommit, '归因到引入坏内容的提交（非删除提交）');
  assert.ok(f?.issues.some((i) => i.code === 'E-FM-001'));
  assert.equal(await headOf(w.alphaRepo), before, '被拒推送后服务端 ref 不变');
});

test('C3 防绕过③：合并夹带被拒——evil merge 中两父皆无的违规文件进校验（E-FM-001）', async () => {
  const clone = await cloneOf('alpha', 'carol', 'c3-clone');
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
});

test('C4 良性合并不误拒：合并已在服务端的分支（文件内容等于一父）→ 接受（先清 C3 遗留分支）', async () => {
  const clone = await cloneOf('alpha', 'carol', 'c4-clone');
  // C3 的 feat 分支未进服务端（evil merge 被拒）——重走良性合并：topic 推送→main 合并
  await git(['-C', clone, 'checkout', '-q', '-b', 'topic']);
  await writeMd(clone, 'notes/topic.md', '---\ntitle: Topic\n---\nbody\n');
  await commitAll(clone, 'topic work');
  await git(['-C', clone, 'push', 'origin', 'topic']);
  await git(['-C', clone, 'checkout', '-q', 'main']);
  await git(['-C', clone, 'merge', '--no-ff', '-m', 'merge topic', 'origin/topic']);
  await git(['-C', clone, 'push', 'origin', 'main']);
  const audit = JSON.parse(
    await readFile(path.join(w.alphaRepo, 'notegit-validation.json'), 'utf8'),
  ) as Report;
  assert.equal(audit.result, 'pass', '等于某一父版本的文件不重判（合并不因存量内容被拒）');
});

test('C5 防绕过④：新库根提交全检——空库首推含违规被拒、删除重推仍拒；合规根提交接受（README 豁免）', async () => {
  // 终回归世界内新起空库（gamma——根提交用例的专用库）
  const vaultService = new VaultService({ db: w.db, repoOps: createVaultRepoOps(w.dataDir) });
  const gamma = await vaultService.createVaultWithRepo(
    { name: 'Gamma', slug: 'gamma-s9t2' },
    { employeeId: w.ids.alice, entry: 'web', carrierRef: 'session:fixture' },
  );
  const gammaRepo = vaultRepoPath(w.dataDir, gamma.id);
  const url = `http://alice:${w.tokens.alice}@127.0.0.1:${w.port}/git/gamma-s9t2.git`;

  const clone = path.join(w.dataDir, 'c5-clone');
  await git(['clone', url, clone]);
  await git(['-C', clone, 'config', 'user.email', 'alice@notegit.test']);
  await git(['-C', clone, 'config', 'user.name', 'alice']);
  await writeMd(clone, 'README.md', '# nav\n无 frontmatter 的导航文档\n');
  await writeMd(clone, 'notes/root-bad.md', 'no frontmatter\n');
  await commitAll(clone, 'root with bad');
  const stderr = await rejectPush(['push', 'origin', 'main'], clone, /root-bad\.md/);
  const report = reportFromStderr(stderr);
  assert.ok(report.files.some((f) => f.path === 'notes/root-bad.md' && f.issues.some((i) => i.code === 'E-FM-001')));
  // 违规历史已进本地——删除后重推仍拒（逐提交语义；与防绕过②同源）
  await git(['-C', clone, 'rm', '-q', 'notes/root-bad.md']);
  await commitAll(clone, 'remove bad');
  await rejectPush(['push', 'origin', 'main'], clone, /root-bad\.md/);
  // 合规根提交：新克隆全新首推（坏历史不在其历史中）；README 豁免在报告标注
  const fresh = path.join(w.dataDir, 'c5-fresh');
  await git(['clone', url, fresh]);
  await git(['-C', fresh, 'config', 'user.email', 'alice@notegit.test']);
  await git(['-C', fresh, 'config', 'user.name', 'alice']);
  await writeMd(fresh, 'README.md', '# nav\n无 frontmatter 的导航文档\n');
  await writeMd(fresh, 'notes/root-ok.md', '---\ntitle: Root\n---\nbody\n');
  await commitAll(fresh, 'root ok');
  await git(['-C', fresh, 'push', 'origin', 'main']);
  const audit = JSON.parse(await readFile(path.join(gammaRepo, 'notegit-validation.json'), 'utf8')) as Report;
  assert.equal(audit.result, 'pass');
  assert.equal(audit.files.find((f) => f.path === 'README.md')?.exempt, true, 'README 在报告中标注豁免');
});

test('C6 防绕过⑤：一次 push 多 ref 含一个违规 → 全部 rejected（服务端零 ref 更新）', async () => {
  const clone = await cloneOf('alpha', 'carol', 'c6-clone');
  const mainBefore = await headOf(w.alphaRepo);
  await writeMd(clone, 'notes/multi-good.md', '---\ntitle: MultiGood\n---\nbody\n');
  await commitAll(clone, 'good on main');
  await git(['-C', clone, 'branch', 'bad-branch']);
  await git(['-C', clone, 'checkout', '-q', 'bad-branch']);
  await writeMd(clone, 'notes/multi-evil.md', 'missing title here\n');
  await commitAll(clone, 'evil on bad-branch');
  await git(['-C', clone, 'checkout', '-q', 'main']);
  const stderr = await rejectPush(['push', 'origin', 'main', 'bad-branch'], clone, /multi-evil\.md/);
  const report = reportFromStderr(stderr);
  const refNames = (report.refs ?? []).map((r) => r.ref).sort();
  assert.deepEqual(refNames, ['refs/heads/bad-branch', 'refs/heads/main']);
  assert.equal(report.refs?.every((r) => r.outcome === 'rejected'), true);
  assert.equal(report.result, 'fail');
  // 服务端侧：合规 ref 也不得更新（pre-receive 拒绝即整包回滚的原生语义）
  assert.equal(await headOf(w.alphaRepo), mainBefore, '合规 ref 不得被更新');
  const refs = (await git(['--git-dir', w.alphaRepo, 'for-each-ref', '--format=%(refname)'])).stdout;
  assert.doesNotMatch(refs, /bad-branch/);
});

test('C7 防绕过⑥：tag 写入被拒——轻量与附注 tag 均不接受（第一版不提供 tag 写入）', async () => {
  const clone = await cloneOf('alpha', 'carol', 'c7-clone');
  await writeMd(clone, 'notes/tagged.md', '---\ntitle: Tagged\n---\nbody\n');
  await commitAll(clone, 'to tag');
  await git(['-C', clone, 'tag', 'v-light']);
  await git(['-C', clone, 'tag', '-a', 'v-annot', '-m', 'annotated']);
  await rejectPush(['push', 'origin', 'v-light'], clone, /tag/i);
  await rejectPush(['push', 'origin', 'v-annot'], clone, /tag/i);
  const refs = (await git(['--git-dir', w.alphaRepo, 'for-each-ref', '--format=%(refname)'])).stdout;
  assert.doesNotMatch(refs, /refs\/tags\//, '服务端不得出现任何 tag ref');
});

test('C8 危险 tree 条目经 index 夹带被拒：symlink（mode 120000）→ E-PATH-002', async () => {
  const clone = await cloneOf('alpha', 'carol', 'c8-clone');
  await addCacheInfo(clone, '120000', 'notes/evil-link', '/etc/passwd');
  await git(['-C', clone, 'commit', '-m', 'smuggle symlink']);
  const stderr = await rejectPush(['push', 'origin', 'main'], clone, /evil-link/);
  const report = reportFromStderr(stderr);
  const f = report.files.find((x) => x.path === 'notes/evil-link');
  assert.ok(f?.issues.some((i) => i.code === 'E-PATH-002'), 'symlink 条目被拒（架构 §9）');
});

test('C9 E-PATH-004 全 tree 基线：新增路径与库内存量路径大小写冲突被拒（actual=存量路径）', async () => {
  const clone = await cloneOf('alpha', 'carol', 'c9-clone');
  // alpha 种子已有 notes/first.md；经 plumbing 加入 Notes/First.md（大小写不敏感文件系统上无法在工作区共存）
  await addCacheInfo(clone, '100644', 'Notes/First.md', '---\ntitle: Collision\n---\nbody\n');
  await git(['-C', clone, 'commit', '-m', 'add case-variant']);
  const stderr = await rejectPush(['push', 'origin', 'main'], clone, /First\.md/);
  const report = reportFromStderr(stderr);
  const f = report.files.find((x) => x.path === 'Notes/First.md');
  const conflict = f?.issues.find((i) => i.code === 'E-PATH-004');
  assert.equal(conflict?.actual, 'notes/first.md', '冲突对端应为库内存量路径');
});

test('C10 防绕过⑦（结构面）：update-ref 唯一执行点=发布组件原子 CAS（web 域无直改引用路径）', async () => {
  // 扫描全部产品源码：exec update-ref 的调用点唯一（publish/pipeline.ts——带预期
  // 旧值的原子 CAS）；web/ 页面域不得出现任何直改引用的执行点（validation §1 ⑦）
  const srcRoot = path.resolve(import.meta.dirname, '../src');
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.ts')) files.push(full);
    }
  };
  await walk(srcRoot);
  assert.ok(files.length > 20, '源码扫描样本自检');
  const offenders: string[] = [];
  for (const file of files) {
    const body = await readFile(file, 'utf8');
    if (/execGit\(\s*\[\s*'update-ref'/.test(body)) offenders.push(path.relative(srcRoot, file));
  }
  assert.deepEqual(offenders, ['publish/pipeline.ts'], 'update-ref 执行点唯一（发布组件）');
  const pipeline = await readFile(path.join(srcRoot, 'publish/pipeline.ts'), 'utf8');
  assert.match(
    pipeline,
    /execGit\(\s*\[\s*'update-ref',\s*\w+(?:\.\w+)*,\s*\w+(?:\.\w+)*,\s*\w+(?:\.\w+)*\s*\]/,
    '发布组件 update-ref 携带预期旧值（原子 CAS——不覆盖并发写入）',
  );
  // pre-receive/post-receive/update shim 已安装（挂接点在位——B/C 面的真实链路前提）
  for (const name of ['pre-receive', 'update', 'post-receive']) {
    const hookPath = path.join(w.alphaRepo, 'hooks', name);
    assert.ok(existsSync(hookPath), `${name} shim 应已安装`);
    await access(hookPath, fsConstants.X_OK);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// D. DOD-03/11 审计主体终核：伪造 author 记认证主体；两入口交错发布成链
//（S3-T6 为 git 单入口链；此处同一 ref 上 git push 与 web submit 交错衔接）
// ══════════════════════════════════════════════════════════════════════════════

test('D1 审计主体终核：伪造 author 的 git push 与 web submit 均记认证主体；两入口交错成链、链尾=当前 ref', async () => {
  const h0 = await headOf(w.alphaRepo);

  // git 入口：伪造 author/committer 推送（架构 §4.4：客户端可填，仅元数据）
  const clone = await cloneOf('alpha', 'carol', 'd1-clone');
  await writeMd(clone, 'notes/audit-git.md', '---\ntitle: AuditGit\n---\nbody\n');
  const forged = await commitAll(clone, 'c-audit', 'Mallory The Forger'); // 伪造身份
  await git(['-C', clone, 'push', 'origin', 'main']);
  assert.equal(await headOf(w.alphaRepo), forged, '前置：伪造 author 的推送本身被接受（author 仅元数据）');

  const pushes = auditRows('vault.push', 'succeeded');
  const pushRow = pushes.filter((r) => r.new_commit === forged);
  assert.equal(pushRow.length, 1, '本次 push 恰一行成功终态');
  assert.equal(pushRow[0]!.employee_id, w.ids.carol, '主体=认证员工（token 归属），非 commit author');
  assert.equal(pushRow[0]!.credential_ref, `credential:${w.credIds.carol}`);
  assert.equal(pushRow[0]!.entry, 'git');
  assert.equal(pushRow[0]!.old_commit, h0, 'old=推送前 ref 实际值（派生，非硬编码）');
  assert.ok(!JSON.stringify(pushRow[0]).includes('Mallory'), '客户端伪造的 author 不出现在审计行');

  // web 入口：carol 提交（message 内伪造他人署名）——审计主体仍是认证员工
  const WEB = '---\ntitle: "审计 Web"\n---\nweb 正文。\n';
  const web = await submitPost('carol', forged, [textChange('notes/audit-web.md', WEB)], '由 mallory 供稿（伪造署名样本）');
  assert.equal(web.statusCode, 201, web.body);
  const webHead = (web.json() as { commit: string }).commit;

  const submits = auditRows('vault.web_submit', 'succeeded');
  const webRow = submits.filter((r) => r.new_commit === webHead);
  assert.equal(webRow.length, 1, '本次 web 提交恰一行成功终态');
  assert.equal(webRow[0]!.employee_id, w.ids.carol, '主体=会话认证员工（非 message 署名）');
  assert.equal(webRow[0]!.entry, 'web');
  assert.match(String(webRow[0]!.credential_ref), /^session:\d+$/, 'web 提交审计行携带会话载体（identity §8）');

  // 两入口交错成链（backup §5 不变量 1）：main 的成功链首尾相接、链尾=当前 ref；
  // 拒绝行（C 面全部拒绝）不污染链
  const chain = auditChain(w.db, w.alphaId).filter((r) => r.ref_name === 'refs/heads/main');
  assert.ok(chain.length >= 2, '链长度自检（本套件此前已有成功发布）');
  for (let i = 1; i < chain.length; i++) {
    assert.equal(chain[i - 1]!.new_commit, chain[i]!.old_commit, `成功段 ${i - 1}→${i} 相邻成链（跨入口）`);
  }
  const tail = chain[chain.length - 1]!;
  assert.equal(tail.old_commit, forged, '链尾段 = git push（伪造 author）段');
  assert.equal(tail.new_commit, webHead, '链尾 new = web 发布提交（两入口交错衔接）');
  assert.equal(tail.new_commit, await headOf(w.alphaRepo), '链尾 = ref 当前 OID');
  // 全部行已终态（无在途/待核对残留——异常恢复面的排空口径）
  assert.equal(drainCount(w.db), 0, '终核时点无 pending/unresolved 残留');
});

// ══════════════════════════════════════════════════════════════════════════════
// E. 撤权三入口终核（DOD-02/03：撤权阻断后续请求——同一世界 Web/API/Git 实时生效）
//（S2 lifecycle 为 Web/API 分面 + 组件级 Git；S3 为 Git 单面——此处三入口同世界
//  实测，且正/反两极控制内建：撤权前三入口全通，撤权后全 404 与不存在同体）
// ══════════════════════════════════════════════════════════════════════════════

test('E1 撤权三入口终核：erin 被 beta 撤权后——Web/API/Git 下一请求全 404 与不存在同体，列表即消失', async () => {
  // 阳性前置：撤权前三入口全通（正极控制——拒绝确由撤权所致）
  const webBefore = await w.app.inject({ method: 'GET', url: '/vaults/beta/browse', headers: SID('erin') });
  assert.equal(webBefore.statusCode, 200, '前置：撤权前 Web 可访问');
  const apiBefore = await w.app.inject({ method: 'GET', url: '/api/v1/vaults/beta', headers: BEARER('erin') });
  assert.equal(apiBefore.statusCode, 200, '前置：撤权前 API 可访问');
  const gitBefore = await fetch(httpUrl('beta', '/info/refs?service=git-upload-pack'), {
    headers: { authorization: basic('erin') },
  });
  assert.equal(gitBefore.status, 200, '前置：撤权前 Git 引用发现可访问');
  await drain(gitBefore);

  // bob（beta admin）撤 erin——经真实端点走完整授权路径
  const revoke = await w.app.inject({
    method: 'DELETE',
    url: '/api/v1/vaults/beta/members/erin',
    headers: { ...SID('bob'), origin: 'http://localhost' },
  });
  assert.equal(revoke.statusCode, 204, revoke.body);

  // Web：列表消失；直接访问 404 与不存在同体（D-IC-06）
  const list = await w.app.inject({ method: 'GET', url: '/vaults', headers: SID('erin') });
  assert.deepEqual(vaultSlugsInPage(list.body), [], '撤权后列表为空');
  const webAfter = await w.app.inject({ method: 'GET', url: '/vaults/beta/browse', headers: SID('erin') });
  const webGhost = await w.app.inject({ method: 'GET', url: '/vaults/ghost/browse', headers: SID('erin') });
  assert.equal(webAfter.statusCode, 404);
  assert.deepEqual(webAfter.body, webGhost.body, 'Web：撤权与不存在同体');

  // API：下一请求生效（同一 token，无缓存授权）
  const apiAfter = await w.app.inject({ method: 'GET', url: '/api/v1/vaults/beta', headers: BEARER('erin') });
  const apiGhost = await w.app.inject({ method: 'GET', url: '/api/v1/vaults/ghost', headers: BEARER('erin') });
  assert.equal(apiAfter.statusCode, 404);
  assert.deepEqual(apiAfter.body, apiGhost.body, 'API：撤权与不存在同体');

  // Git：读写引用发现一律 404；真实 fetch 拒
  for (const service of ['git-upload-pack', 'git-receive-pack'] as const) {
    const res = await fetch(httpUrl('beta', `/info/refs?service=${service}`), {
      headers: { authorization: basic('erin') },
    });
    assert.equal(res.status, 404, `撤权后 ${service} 应 404`);
    await drain(res);
  }
  const work = path.join(w.dataDir, 'e1-erin-clone');
  await assert.rejects(
    git(['clone', w.urlFor('beta', 'erin'), work]),
    (e: PushError) => /not found|404/i.test(String(e.stderr)),
    '撤权后克隆应被拒（与不存在不可区分）',
  );
});
