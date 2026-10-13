#!/usr/bin/env node
/**
 * S8-T1 首次初始化演练（D5「演练即测试」：断言化、可复跑、输出可留档）。
 *
 * 覆盖 breakdown §2.7 S8-T1 完成标准（DOD-01 场景前置证据）：
 *   全新容器 → 健康检查通过 → bootstrap 管理员 → 邀请员工 → 员工建库 →
 *   Git/网页双通道冒烟（push + 网页可见）→ 重启 → 账号/权限/知识/历史仍在。
 *
 * 用法（仓库根执行）：
 *   node deploy/scripts/init-drill.mjs [--port 39087] [--keep] [--no-build]
 * 输出即留档材料（示例：node deploy/scripts/init-drill.mjs 2>&1 | tee <file>）。
 * 退出码 0 = 全链绿；任何断言失败即 1（保留容器供检查，docker logs 复盘）。
 *
 * 依赖：本机 Docker（colima 或原生）；仓库根作为 docker build 上下文。
 * 凭据卫生：bootstrap/reset/ngt_ token 与口令只进内存；打印一律脱敏；
 * git 远端 URL 含 token，出错信息打印前先掩码。
 */
import { execFile, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';

const run = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CONTAINER = 'notegit-s8t1-drill';
const VOLUME = 'notegit-s8t1-drill-data';
const IMAGE = 'notegit:s8t1-drill';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const optVal = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const PORT = Number(optVal('--port', '39087'));
const KEEP = flag('--keep');
const NO_BUILD = flag('--no-build');
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = BASE; // Cookie 写请求的同源 Origin（CSRF 校验，auth/csrf.ts）

const REDACT = (s) => (typeof s === 'string' && s.length > 8 ? `${s.slice(0, 6)}…${s.slice(-2)}` : '***');

const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
let stepNo = 0;
function log(msg) {
  console.log(`[${stamp()}] ${msg}`);
}
function ok(msg) {
  stepNo += 1;
  console.log(`[${stamp()}] ✓ ${String(stepNo).padStart(2, '0')} ${msg}`);
}
function fail(err) {
  console.error(`[${stamp()}] ✗ 失败于步骤 ${stepNo + 1}：${err instanceof Error ? err.message : String(err)}`);
  console.error(`\n—— 容器日志（尾部 60 行，容器保留供检查：docker logs ${CONTAINER}）——`);
  try {
    const { stdout } = runSync('docker', ['logs', '--tail', '60', CONTAINER]);
    console.error(stdout);
  } catch {
    console.error('（容器日志不可用）');
  }
  console.error(`\n清理后重跑：docker rm -f ${CONTAINER} && docker volume rm ${VOLUME}`);
  process.exit(1);
}
function runSync(cmd, argv) {
  return spawnSync(cmd, argv, { encoding: 'utf8' });
}
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);

/** docker 子命令（异步） */
async function docker(...argv) {
  const { stdout, stderr } = await run('docker', argv, { maxBuffer: 64 * 1024 * 1024 });
  return stdout ?? stderr;
}
/** git 子命令（隔离宿主 gitconfig；凭据提示快速失败） */
const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
};
async function git(args, cwd) {
  try {
    const { stdout, stderr } = await run('git', args, { cwd, env: GIT_ENV, maxBuffer: 64 * 1024 * 1024 });
    return { stdout, stderr };
  } catch (err) {
    // 掩码 URL 内嵌凭据后再上抛
    err.message = err.message.replace(/\/\/[^@/]+@/g, '//***@');
    throw err;
  }
}
/** 打印前掩码 git 输出中可能内嵌的凭据（URL 形态 http://user:token@host） */
const scrub = (s) => s.replace(/\/\/[^@/]+@/g, '//***@');

/** HTTP JSON 助手：返回 {status, body(text), json(尽力), setCookie} */
async function http(method, url, { payload, cookie } = {}) {
  const headers = {};
  let body;
  if (payload !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(payload);
  }
  if (cookie !== undefined) {
    headers.cookie = `ngt_sid=${cookie}`;
    // Cookie 认证写请求需同源标记（浏览器自动带 Origin；此处模拟页面 fetch）
    if (method !== 'GET' && method !== 'HEAD') headers.origin = ORIGIN;
  }
  const res = await fetch(`${BASE}${url}`, { method, headers, body, redirect: 'manual' });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 响应（页面/204） */
  }
  const sc = res.headers.get('set-cookie');
  const sid = sc?.match(/ngt_sid=([^;]+)/)?.[1];
  return { status: res.status, text, json, sid };
}

async function waitHealthy(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    last = (await docker('inspect', '--format', '{{.State.Health.Status}}', CONTAINER)).trim();
    if (last === 'healthy') return;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`等待容器健康超时（最后状态：${last || '未知'}）`);
}

// ─────────────────────────── 演练主链 ───────────────────────────

try {
  log(`S8-T1 首次初始化演练开始（port ${PORT}，keep=${KEEP}，no-build=${NO_BUILD}）`);

  // 0) 前置：Docker 可用
  const serverVersion = (await docker('version', '--format', '{{.Server.Version}}')).trim();
  ok(`Docker 可用（server ${serverVersion}）`);

  // 1) 清场（可复跑：先清掉上一轮容器与卷，全新环境起步）
  await docker('rm', '-f', CONTAINER).catch(() => '');
  await docker('volume', 'rm', '-f', VOLUME).catch(() => '');
  ok('清场完成（上一轮容器/卷已移除）');

  // 2) 构建镜像（deploy/Dockerfile，上下文 = 仓库根）
  if (!NO_BUILD) {
    const t = Date.now();
    await docker('build', '-f', 'deploy/Dockerfile', '-t', IMAGE, REPO_ROOT);
    ok(`镜像构建完成（${((Date.now() - t) / 1000).toFixed(0)}s；构建期断言已在镜像内执行）`);
  }

  // 3) 全新容器启动：单实例 + 命名持久卷
  await docker('run', '-d', '--name', CONTAINER, '-p', `127.0.0.1:${PORT}:3000`, '-v', `${VOLUME}:/data`, IMAGE);
  ok(`容器已启动（${CONTAINER}，卷 ${VOLUME}）`);

  // 4) 健康检查：Dockerfile HEALTHCHECK → /healthz（架构 §10 最低清单）
  await waitHealthy(90_000);
  {
    const h = await http('GET', '/healthz');
    assert.equal(h.status, 200, `/healthz 应 200，得到 ${h.status}：${h.text.slice(0, 120)}`);
    assert.equal(h.json?.status, 'ok');
  }
  ok('健康检查通过（HEALTHCHECK=healthy + /healthz 200 {"status":"ok"}）');

  // 5) 镜像运行态抽检：非 root、git-http-backend 在位（N3）、node/git 版本留档
  {
    const uid = (await docker('exec', CONTAINER, 'id', '-u')).trim();
    assert.notEqual(uid, '0', `容器进程不得以 root 运行（id -u = ${uid}）`);
    await docker('exec', CONTAINER, 'sh', '-c', 'test -x "$(git --exec-path)/git-http-backend"');
    const nodeV = (await docker('exec', CONTAINER, 'node', '--version')).trim();
    const gitV = (await docker('exec', CONTAINER, 'git', '--version')).trim();
    ok(`运行态抽检：非 root（uid=${uid}）、git-http-backend 在位、${nodeV} / ${gitV}`);
  }

  // 6) bootstrap 管理员（identity §7.1：一次性 token 文件，用后即删）
  let bootstrapToken;
  {
    bootstrapToken = (await docker('exec', CONTAINER, 'cat', '/data/config/admin-bootstrap.token')).trim();
    assert.match(bootstrapToken, /^[A-Za-z0-9_-]{20,}$/, 'bootstrap token 文件应存在且非空');
    const r = await http('POST', '/api/v1/auth/bootstrap', {
      payload: {
        bootstrap_token: bootstrapToken,
        username: 'root',
        display_name: 'Drill Root Admin',
        password: 'drill-root-password-123456',
      },
    });
    assert.equal(r.status, 201, `bootstrap 应 201，得到 ${r.status}：${r.text.slice(0, 200)}`);
    assert.equal(r.json?.username, 'root');
    const gone = runSync('docker', ['exec', CONTAINER, 'test', '!', '-f', '/data/config/admin-bootstrap.token']);
    assert.equal(gone.status, 0, 'bootstrap token 文件应已删除（identity §7.1 用后即删）');
    ok(`管理员初始化完成（employee_id=${r.json.employee_id}；token 文件已删，打印脱敏 ${REDACT(bootstrapToken)}）`);
  }

  // 7) 管理员登录 → 会话
  let rootSid;
  {
    const r = await http('POST', '/api/v1/auth/login', {
      payload: { username: 'root', password: 'drill-root-password-123456' },
    });
    assert.equal(r.status, 200, `root 登录应 200，得到 ${r.status}：${r.text.slice(0, 200)}`);
    assert.ok(r.sid, '登录应发放 ngt_sid 会话 Cookie');
    rootSid = r.sid;
  }
  ok('管理员登录成功（ngt_sid 会话建立）');

  // 8) 邀请员工（POST /api/v1/admin/employees → 一次性重置口令令牌）
  let aliceReset;
  {
    const r = await http('POST', '/api/v1/admin/employees', {
      cookie: rootSid,
      payload: { username: 'alice', display_name: 'Alice Drill' },
    });
    assert.equal(r.status, 201, `邀请应 201，得到 ${r.status}：${r.text.slice(0, 200)}`);
    aliceReset = r.json?.password_reset_token;
    assert.match(aliceReset, /^[A-Za-z0-9_-]{43}$/);
    ok(`员工 alice 已邀请（重置令牌脱敏 ${REDACT(aliceReset)}）`);
  }

  // 9) 员工设初始口令并登录
  let aliceSid;
  {
    const c = await http('POST', '/api/v1/auth/password-reset', {
      payload: { reset_token: aliceReset, new_password: 'drill-alice-password-123456' },
    });
    assert.equal(c.status, 204, `口令设置应 204，得到 ${c.status}：${c.text.slice(0, 200)}`);
    const l = await http('POST', '/api/v1/auth/login', {
      payload: { username: 'alice', password: 'drill-alice-password-123456' },
    });
    assert.equal(l.status, 200);
    aliceSid = l.sid;
    assert.ok(aliceSid, 'alice 登录应发放会话');
    // 权限可见性 sanity：普通员工首页无管理入口、有凭据入口
    const idx = await http('GET', '/', { cookie: aliceSid });
    assert.equal(idx.status, 200);
    assert.ok(!idx.text.includes('"/admin"'), '普通员工不得看到管理入口');
    assert.ok(idx.text.includes('/credentials'), '员工应看到凭据入口');
  }
  ok('员工 alice 口令已设并登录（首页无管理入口）');

  // 10) 员工建库（创建者 = 库管理员）
  {
    const r = await http('POST', '/api/v1/vaults', {
      cookie: aliceSid,
      payload: { name: '演练知识库', slug: 'team-kb' },
    });
    assert.equal(r.status, 201, `建库应 201，得到 ${r.status}：${r.text.slice(0, 200)}`);
    assert.equal(r.json?.role, 'admin');
  }
  ok('库 team-kb 已创建（alice = 库管理员，默认分支 main）');

  // 11) 员工创建 Git 凭据（identity §3.1：明文仅一次；scope 收窄到 team-kb）
  let gitToken;
  {
    const r = await http('POST', '/api/v1/credentials', {
      cookie: aliceSid,
      payload: {
        name: 'drill-git',
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        scope: { access: 'read_write', vaults: ['team-kb'] },
      },
    });
    assert.equal(r.status, 201, `建凭据应 201，得到 ${r.status}：${r.text.slice(0, 200)}`);
    gitToken = r.json?.token;
    assert.match(gitToken, /^ngt_[A-Za-z0-9_-]{43}$/);
    ok(`Git 凭据已创建（明文仅一次，脱敏 ${REDACT(gitToken)}）`);
  }

  // 12) Git 通道冒烟：clone → 写有效笔记 → push（服务端校验链全过）
  const cloneDir = await mkdtemp(path.join(tmpdir(), 'notegit-drill-'));
  const MARKER = 's8t1-init-drill-marker-20261013';
  const GIT_URL = `http://drill:${gitToken}@127.0.0.1:${PORT}/git/team-kb.git`; // 用户名任意，token 是唯一凭据
  let pushedOid;
  {
    await git(['clone', GIT_URL, 'work'], cloneDir);
    const work = path.join(cloneDir, 'work');
    await mkdir(path.join(work, 'notes'), { recursive: true });
    await writeFile(
      path.join(work, 'notes', 'first.md'),
      `---\ntitle: Drill First Note\n---\n\n首次初始化演练推送正文（${MARKER}）。\n`,
    );
    await git(['add', 'notes/first.md'], work);
    await git(['-c', 'user.name=Drill Worker', '-c', 'user.email=drill@notegit.invalid', 'commit', '-m', 'drill: first note'], work);
    const push = await git(['push', 'origin', 'HEAD:refs/heads/main'], work);
    assert.ok(!/\[remote rejected\]|error:|fatal:/.test(push.stderr), `push 应成功，stderr：${scrub(push.stderr).slice(0, 300)}`);
    const ls = await git(['ls-remote', GIT_URL, 'refs/heads/main'], cloneDir);
    pushedOid = ls.stdout.trim().split(/\s+/)[0];
    assert.match(pushedOid, /^[0-9a-f]{40}$/, `ls-remote 应给出 main 的 OID，得到：${scrub(ls.stdout).slice(0, 120)}`);
  }
  ok(`Git 通道冒烟通过（push main → ${pushedOid.slice(0, 10)}…，pre-receive 校验链全过）`);

  // 13) 网页通道冒烟：库列表可见 + 推送内容可读（Web 与 Git 同视角）
  {
    const list = await http('GET', '/api/v1/vaults', { cookie: aliceSid });
    assert.ok(list.json?.vaults?.some((v) => v.slug === 'team-kb'), '库列表应含 team-kb');
    const view = await http('GET', '/vaults/team-kb/view/notes/first.md', { cookie: aliceSid });
    assert.equal(view.status, 200, `笔记网页应 200，得到 ${view.status}`);
    // 视图页以文件名为题（frontmatter title 不上页面题位），以正文标记物证内容
    assert.ok(view.text.includes('first.md') && view.text.includes(MARKER), '网页应渲染 Git 推送的笔记内容');
    // 未认证不可读（安全 sanity，不替代 DOD-02 全面验证）
    const anon = await http('GET', '/vaults/team-kb/view/notes/first.md');
    assert.notEqual(anon.status, 200, `未认证访问不应 200（得到 ${anon.status}）`);
  }
  ok('网页通道冒烟通过（列表可见、笔记可读、未认证被拒）');

  // 14) 重启容器 → 数据仍在（DOD-01 前置：账号/权限/知识/历史）
  await docker('restart', CONTAINER);
  await waitHealthy(90_000);
  {
    // 账号仍在：重启后双账号可再登录
    const rootAgain = await http('POST', '/api/v1/auth/login', {
      payload: { username: 'root', password: 'drill-root-password-123456' },
    });
    assert.equal(rootAgain.status, 200, `重启后 root 登录应 200，得到 ${rootAgain.status}：${rootAgain.text.slice(0, 200)}`);
    const aliceAgain = await http('POST', '/api/v1/auth/login', {
      payload: { username: 'alice', password: 'drill-alice-password-123456' },
    });
    assert.equal(aliceAgain.status, 200, `重启后 alice 登录应 200，得到 ${aliceAgain.status}`);
    const sid2 = aliceAgain.sid;
    // 权限/库映射仍在
    const list = await http('GET', '/api/v1/vaults', { cookie: sid2 });
    assert.ok(list.json?.vaults?.some((v) => v.slug === 'team-kb'), '重启后库列表应仍含 team-kb');
    // 历史仍在：同一凭据 ls-remote，OID 与重启前一致
    const ls = await git(['ls-remote', GIT_URL, 'refs/heads/main'], cloneDir);
    const oid2 = ls.stdout.trim().split(/\s+/)[0];
    assert.equal(oid2, pushedOid, `重启后 main OID 应不变（${oid2} vs ${pushedOid}）`);
    // 知识仍在：网页仍可读
    const view = await http('GET', '/vaults/team-kb/view/notes/first.md', { cookie: sid2 });
    assert.equal(view.status, 200);
    assert.ok(view.text.includes(MARKER), '重启后网页应仍渲染笔记内容');
    // bootstrap 一次性：重启不复活（identity §7.1 永久不可用）
    const gone = await http('POST', '/api/v1/auth/bootstrap', {
      payload: { bootstrap_token: bootstrapToken, username: 'x', display_name: 'x', password: 'x-password-123456' },
    });
    assert.equal(gone.status, 410, `已初始化实例 bootstrap 应 410，得到 ${gone.status}`);
  }
  ok('重启后数据仍在（账号/权限/历史/知识四项 + bootstrap 已永久关闭）');

  await rm(cloneDir, { recursive: true, force: true });

  // 15) 收尾
  if (KEEP) {
    ok(`演练全链绿（${stepNo} 步）。容器保留运行中：${CONTAINER}（卷 ${VOLUME}）`);
  } else {
    await docker('rm', '-f', CONTAINER);
    await docker('volume', 'rm', VOLUME);
    ok(`演练全链绿（${stepNo} 步）。容器与卷已清理（--keep 可保留实例检查）`);
  }
  log('S8-T1 首次初始化演练：PASS');
  process.exit(0);
} catch (err) {
  fail(err);
}
