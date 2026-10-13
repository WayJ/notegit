#!/usr/bin/env node
/**
 * S8-T5 全新环境恢复 + R1–R14 演练（D5「演练即测试」：断言化、可复跑、输出可留档）。
 *
 * 覆盖 breakdown §2.7 S8-T5 完成标准（DOD-12 恢复侧证据；backup-recovery §7 十步 +
 * §8 清单逐项）：
 *   源实例（真实容器）→ 种数据（多员工多库多凭据 + 撤权态 + 草稿 + pepper 轮换窗口
 *   retired 条目）→ T4 备份 CLI → 产物断言 + 宿主离线验证 → **负路径**（篡改件被
 *   restore 拒绝装载、目标不被触碰）→ **全新环境**容器（新卷、应用未启动）→
 *   restore 离线装载（§7 步骤 2–6）→ NOTEGIT_MAINTENANCE_ON_START=1 维护态启动
 *   （§7 步骤 1）→ finalize（§7 步骤 7 只读对账 + 步骤 9 全量重建）→
 *   §8 R1–R14 逐项核对（维护内 R1–R12；R13 退出后冒烟；R14 指标面）→ 清场。
 *
 * 用法（仓库根执行）：
 *   node deploy/scripts/restore-drill.mjs [--port 39090] [--keep] [--no-build]
 * 输出即留档材料（示例：node deploy/scripts/restore-drill.mjs 2>&1 | tee <file>）。
 * 退出码 0 = 全链绿；任何断言失败即 1（保留容器供检查，docker logs 复盘）。
 *
 * 依赖：本机 Docker + 宿主 Node ≥24（离线验证/负路径直跑 TS）+ 宿主 git；
 * 仓库根作为 docker build 上下文。
 * 凭据卫生：bootstrap/重置/ngt_ 令牌只进内存与容器内临时文件；打印一律脱敏；
 * git 远端 URL 出错信息先掩码再打印。
 */
import { execFile, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';

const run = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HOST_CLI = path.join('server', 'src', 'backup', 'cli.ts');
const CONTAINER_CLI = 'src/backup/cli.ts'; // 容器 WORKDIR=/app/server（TS 执行策略：node 直跑）
const SRC = 'notegit-s8t5-src';
const TARGET = 'notegit-s8t5-restore';
const SRC_VOL = 'notegit-s8t5-src-data';
const BK_VOL = 'notegit-s8t5-src-backup';
const TARGET_VOL = 'notegit-s8t5-restore-data';
const IMAGE = 'notegit:s8t5-drill';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const optVal = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const PORT = Number(optVal('--port', '39090'));
const KEEP = flag('--keep');
const NO_BUILD = flag('--no-build');
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = BASE; // Cookie 写请求的同源 Origin（CSRF 校验，auth/csrf.ts）

const REDACT = (s) => (typeof s === 'string' && s.length > 8 ? `${s.slice(0, 6)}…${s.slice(-2)}` : '***');
const scrub = (s) => s.replace(/\/\/[^@/]+@/g, '//***@');

/** 演练内容指纹（R6/R7/R9 的核对基准——内容写入与断言共用同一来源） */
const NOTE_ALPHA = { path: 'notes/alpha-restore-drill.md', title: 'Restore Drill Alpha XQ7', body: '恢复演练 Alpha 笔记正文 Kappa32。' };
const NOTE_BETA = { path: 'notes/beta-restore-drill.md', title: 'Restore Drill Beta RW9', body: '恢复演练 Beta 笔记正文 Lambda54。' };
const NOTE_GAMMA = { path: 'notes/gamma-restore-drill.md', title: 'Restore Drill Gamma ZM3', body: '恢复演练 Gamma 笔记正文 Nu88。' };
const DRAFT = { path: 'notes/draft-restore-drill.md', title: 'Restore Drill Draft Pending', body: '恢复演练未发布草稿正文 Mu77。' };
const noteFile = (n) => `---\ntitle: ${n.title}\n---\n\n${n.body}\n`;

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
function runSync(cmd, argv, opts = {}) {
  return spawnSync(cmd, argv, { encoding: 'utf8', ...opts });
}
function fail(err) {
  console.error(`[${stamp()}] ✗ 失败于步骤 ${stepNo + 1}：${err instanceof Error ? err.message : String(err)}`);
  for (const c of [SRC, TARGET]) {
    try {
      const { stdout } = runSync('docker', ['logs', '--tail', '40', c]);
      if (stdout?.trim()) console.error(`\n—— ${c} 日志（尾部）——\n${stdout}`);
    } catch { /* 容器可能不在 */ }
  }
  console.error(`\n清理后重跑：docker rm -f ${SRC} ${TARGET} && docker volume rm ${SRC_VOL} ${BK_VOL} ${TARGET_VOL}`);
  process.exit(1);
}
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);

async function docker(...argv) {
  const { stdout, stderr } = await run('docker', argv, { maxBuffer: 64 * 1024 * 1024 });
  return stdout ?? stderr;
}
async function execIn(container, ...argv) {
  return (await run('docker', ['exec', container, ...argv], { maxBuffer: 64 * 1024 * 1024 })).stdout;
}
/** git 子命令（隔离宿主 gitconfig；凭据提示快速失败；错误先掩码再上抛） */
const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
};
async function git(gargs, cwd) {
  try {
    const { stdout, stderr } = await run('git', gargs, { cwd, env: GIT_ENV, maxBuffer: 64 * 1024 * 1024 });
    return { stdout, stderr };
  } catch (err) {
    err.message = scrub(err.message);
    throw err;
  }
}
/** 期待失败的 git 调用（401/404/拒绝面）：非零退出为预期，返回合并输出供断言 */
async function gitExpectFail(gargs, cwd) {
  const r = runSync('git', gargs, { cwd, env: GIT_ENV, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** HTTP JSON 助手：返回 {status, text, json, sid}（backup-drill 同款） */
async function http(method, url, { payload, cookie, bearer } = {}) {
  const headers = {};
  let body;
  if (payload !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(payload);
  }
  if (cookie !== undefined) {
    headers.cookie = `ngt_sid=${cookie}`;
    if (method !== 'GET' && method !== 'HEAD') headers.origin = ORIGIN;
  }
  if (bearer !== undefined) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(`${BASE}${url}`, { method, headers, body, redirect: 'manual' });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 响应（页面/204） */
  }
  const sid = res.headers.get('set-cookie')?.match(/ngt_sid=([^;]+)/)?.[1];
  return { status: res.status, text, json, sid };
}

async function waitDockerHealthy(container, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    last = (await docker('inspect', '--format', '{{.State.Health.Status}}', container)).trim();
    if (last === 'healthy') return;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`等待容器健康超时（最后状态：${last || '未知'}）`);
}
async function waitHttpHealthy(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      last = `${res.status}`;
      if (res.status === 200) return;
    } catch {
      last = 'connection refused';
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`等待 /healthz 200 超时（最后：${last}）`);
}

/** 宿主侧执行 CLI（离线验证/负路径——不起服务，直接吃产物目录） */
function hostCli(cliArgs) {
  const r = runSync('node', [HOST_CLI, ...cliArgs], { cwd: REPO_ROOT, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// ─────────────────────────── 演练主链 ───────────────────────────

try {
  log(`S8-T5 全新环境恢复演练开始（port ${PORT}，keep=${KEEP}，no-build=${NO_BUILD}）`);

  // ── 源实例：种数据 + 备份 ────────────────────────────────────────────────
  // 1) 前置
  {
    const serverVersion = (await docker('version', '--format', '{{.Server.Version}}')).trim();
    assert.match(process.version, /^v24\./, `宿主 Node 需 ≥24（type-stripping 直跑 TS），实际 ${process.version}`);
    await git(['--version']);
    ok(`前置就绪（Docker server ${serverVersion}；宿主 ${process.version}）`);
  }

  // 2) 清场（可复跑）
  await docker('rm', '-f', SRC).catch(() => '');
  await docker('rm', '-f', TARGET).catch(() => '');
  for (const v of [SRC_VOL, BK_VOL, TARGET_VOL]) await docker('volume', 'rm', '-f', v).catch(() => '');
  ok('清场完成（源实例/恢复实例与三卷已移除）');

  // 3) 构建镜像
  if (!NO_BUILD) {
    const t = Date.now();
    await docker('build', '-f', 'deploy/Dockerfile', '-t', IMAGE, REPO_ROOT);
    ok(`镜像构建完成（${((Date.now() - t) / 1000).toFixed(0)}s；restore/finalize CLI 随 server/ 树入镜像）`);
  }

  // 4) 源实例启动（/data 与 /backup 分卷——backup §6 分置的部署侧形态）
  await docker('run', '-d', '--name', SRC, '-p', `127.0.0.1:${PORT}:3000`, '-v', `${SRC_VOL}:/data`, '-v', `${BK_VOL}:/backup`, IMAGE);
  await docker('exec', '-u', 'root', SRC, 'chown', 'notegit:notegit', '/backup');
  await waitDockerHealthy(SRC, 90_000);
  ok(`源实例就绪（${SRC}；健康检查通过）`);

  // 5) 管理员初始化
  let rootSid;
  const ROOT_PW = 'drill-root-password-123456';
  {
    const bootstrapToken = (await execIn(SRC, 'cat', '/data/config/admin-bootstrap.token')).trim();
    const r = await http('POST', '/api/v1/auth/bootstrap', {
      payload: { bootstrap_token: bootstrapToken, username: 'root', display_name: 'Restore Drill Root', password: ROOT_PW },
    });
    assert.equal(r.status, 201, `bootstrap 应 201，得到 ${r.status}：${r.text.slice(0, 200)}`);
    const l = await http('POST', '/api/v1/auth/login', { payload: { username: 'root', password: ROOT_PW } });
    assert.equal(l.status, 200);
    rootSid = l.sid;
    ok(`管理员初始化完成（bootstrap 令牌脱敏 ${REDACT(bootstrapToken)}）`);
  }

  // 6) 员工 alice / bob（多员工；各自口令走真实重置链）
  const PW = { alice: 'drill-alice-password-123456', bob: 'drill-bob-password-123456' };
  const invite = async (username, displayName) => {
    const inv = await http('POST', '/api/v1/admin/employees', {
      cookie: rootSid,
      payload: { username, display_name: displayName },
    });
    assert.equal(inv.status, 201, `邀请 ${username} 应 201，得到 ${inv.status}：${inv.text.slice(0, 200)}`);
    const rst = await http('POST', '/api/v1/auth/password-reset', {
      payload: { reset_token: inv.json?.password_reset_token, new_password: PW[username] },
    });
    assert.equal(rst.status, 204, `重置 ${username} 应 204，得到 ${rst.status}`);
    const l = await http('POST', '/api/v1/auth/login', { payload: { username, password: PW[username] } });
    assert.equal(l.status, 200);
    return l.sid;
  };
  let aliceSid = await invite('alice', 'Alice Restore Drill');
  let bobSid = await invite('bob', 'Bob Restore Drill');
  ok('员工就位（alice、bob——经邀请+重置+登录真实链）');

  // 7) 建库：team-kb（alice admin + bob reader）与 bob-private（bob admin，alice 非成员）
  {
    const v1 = await http('POST', '/api/v1/vaults', { cookie: aliceSid, payload: { name: '恢复演练团队库', slug: 'team-kb' } });
    assert.equal(v1.status, 201, `建 team-kb 应 201，得到 ${v1.status}：${v1.text.slice(0, 200)}`);
    const addBob = await http('PUT', '/api/v1/vaults/team-kb/members/bob', { cookie: aliceSid, payload: { role: 'reader' } });
    assert.equal(addBob.status, 200, `bob 入 team-kb reader 应 200，得到 ${addBob.status}`);
    const v2 = await http('POST', '/api/v1/vaults', { cookie: bobSid, payload: { name: 'Bob 私库', slug: 'bob-private' } });
    assert.equal(v2.status, 201, `建 bob-private 应 201，得到 ${v2.status}`);
    ok('库就位（team-kb：alice=admin/bob=reader；bob-private：仅 bob——两不同成员集）');
  }

  // 8) 轮换前凭据 T_old（v1 哈希——R12 的旧版本哈希 token）
  let tokenOld;
  {
    const c = await http('POST', '/api/v1/credentials', {
      cookie: aliceSid,
      payload: { name: 'r12-old-pepper-v1', expires_at: new Date(Date.now() + 86_400_000).toISOString(), scope: { access: 'read_write', vaults: ['team-kb'] } },
    });
    assert.equal(c.status, 201);
    tokenOld = c.json?.token;
    ok(`轮换前凭据就位（T_old=v1 哈希，脱敏 ${REDACT(tokenOld)}——R12 标本）`);
  }

  // 9) pepper 轮换窗口（identity §6.2）：停源容器 → 卷内轮换（v1→retired，新 active v2）→ 重启
  {
    await docker('stop', SRC);
    const ROTATE = [
      "const { readFileSync, writeFileSync, chmodSync } = require('node:fs');",
      "const { randomBytes } = require('node:crypto');",
      "const f = '/data/keys/token-pepper.key';",
      "const p = JSON.parse(readFileSync(f, 'utf8'));",
      "if (p.retired.length !== 0) throw new Error('precondition: expected no retired entries');",
      "const retired = [...p.retired, p.active];",
      "const active = { version: p.active.version + 1, key: randomBytes(32).toString('hex') };",
      "writeFileSync(f, JSON.stringify({ active, retired }));",
      "chmodSync(f, 0o600);",
      "console.log('rotated active=v' + active.version + ' retired=[' + retired.map((r) => 'v' + r.version).join(',') + ']');",
    ].join('\n');
    const out = (await run('docker', ['run', '--rm', '-v', `${SRC_VOL}:/data`, IMAGE, 'node', '-e', ROTATE], { maxBuffer: 1024 * 1024 })).stdout;
    await docker('start', SRC);
    await waitDockerHealthy(SRC, 90_000);
    // 轮换后登录/凭据照常（会话域 rehash-on-use；此处直接重登取新会话，后续断言不受旧会话干扰）
    const l = await http('POST', '/api/v1/auth/login', { payload: { username: 'root', password: ROOT_PW } });
    assert.equal(l.status, 200, '轮换后登录应可用');
    rootSid = l.sid;
    const la = await http('POST', '/api/v1/auth/login', { payload: { username: 'alice', password: PW.alice } });
    const lb = await http('POST', '/api/v1/auth/login', { payload: { username: 'bob', password: PW.bob } });
    assert.equal(la.status, 200);
    assert.equal(lb.status, 200);
    aliceSid = la.sid;
    bobSid = lb.sid;
    ok(`pepper 轮换完成（${out.trim()}；源实例处于迁移窗口——后续备份含 retired 条目）`);
  }

  // 10) 轮换后凭据矩阵（v2 哈希）：RW×2 / 只读×1 / 管理员×1 / 建后即撤×1（R3/R4/R8 标本）
  let tokenAliceRw, tokenBobRo, tokenBobRw, tokenAdmin, tokenRevoked;
  const mkCred = async (sid, payload) => {
    const c = await http('POST', '/api/v1/credentials', { cookie: sid, payload });
    assert.equal(c.status, 201, `建凭据应 201，得到 ${c.status}：${c.text.slice(0, 200)}`);
    return c.json;
  };
  {
    tokenAliceRw = (await mkCred(aliceSid, { name: 'alice-rw', expires_at: new Date(Date.now() + 86_400_000).toISOString(), scope: { access: 'read_write', vaults: ['team-kb'] } })).token;
    tokenBobRo = (await mkCred(bobSid, { name: 'bob-ro-teamkb', expires_at: new Date(Date.now() + 86_400_000).toISOString(), scope: { access: 'read', vaults: ['team-kb'] } })).token;
    tokenBobRw = (await mkCred(bobSid, { name: 'bob-rw-private', expires_at: new Date(Date.now() + 86_400_000).toISOString(), scope: { access: 'read_write', vaults: ['bob-private'] } })).token;
    tokenAdmin = (await mkCred(rootSid, { name: 'restore-drill-admin', expires_at: new Date(Date.now() + 3_600_000).toISOString() })).token;
    const revoked = await mkCred(aliceSid, { name: 'revoked-before-backup', expires_at: new Date(Date.now() + 86_400_000).toISOString(), scope: { access: 'read_write', vaults: ['team-kb'] } });
    tokenRevoked = revoked.token;
    const d = await http('DELETE', `/api/v1/credentials/${revoked.id}`, { cookie: aliceSid });
    assert.equal(d.status, 204, `撤销应 204，得到 ${d.status}`);
    ok(`凭据矩阵就位（alice-RW/bob-RO/bob-RW/管理员/已撤销，脱敏 ${REDACT(tokenAliceRw)} 等——全部 v2 哈希）`);
  }

  // 11) Git 播种（服务端校验链全过；两库不同深度）+ 记录 pre 态 HEAD
  const cloneSrc = await mkdtemp(path.join(tmpdir(), 'notegit-s8t5-seed-'));
  let preHeadTeam, preHeadPrivate;
  const seedVault = async (slug, token, notes, who) => {
    const dir = path.join(cloneSrc, `${slug}-work`);
    const url = `http://${who}:${token}@127.0.0.1:${PORT}/git/${slug}.git`;
    await git(['clone', url, dir], cloneSrc);
    for (const n of notes) {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(path.dirname(path.join(dir, n.path)), { recursive: true });
      await writeFile(path.join(dir, n.path), noteFile(n));
      await git(['add', '.'], dir);
      await git(['-c', 'user.name=Drill Worker', '-c', 'user.email=drill@notegit.invalid', 'commit', '-m', `drill: ${n.title}`], dir);
    }
    const push = await git(['push', 'origin', 'HEAD:refs/heads/main'], dir);
    assert.ok(!/\[remote rejected\]|error:|fatal:/.test(push.stderr), `push ${slug} 应成功：${scrub(push.stderr).slice(0, 300)}`);
    const ls = await git(['ls-remote', url, 'refs/heads/main'], cloneSrc);
    return ls.stdout.trim().split(/\s+/)[0];
  };
  preHeadTeam = await seedVault('team-kb', tokenAliceRw, [NOTE_ALPHA, NOTE_BETA], 'alice');
  preHeadPrivate = await seedVault('bob-private', tokenBobRw, [NOTE_GAMMA], 'bob');
  assert.match(preHeadTeam, /^[0-9a-f]{40}$/);
  assert.match(preHeadPrivate, /^[0-9a-f]{40}$/);
  ok(`Git 播种完成（team-kb 2 commit、bob-private 1 commit；pre 态 HEAD ${preHeadTeam.slice(0, 10)}… / ${preHeadPrivate.slice(0, 10)}…）`);

  // 12) 未发布草稿（R10 标本——upsert 真实链）
  {
    const d = await http('PUT', `/api/v1/vaults/team-kb/drafts/${DRAFT.path}`, {
      cookie: aliceSid,
      payload: { content: noteFile(DRAFT), base_commit: null },
    });
    assert.equal(d.status, 200, `存草稿应 200，得到 ${d.status}：${d.text.slice(0, 200)}`);
    ok(`未发布草稿就位（${DRAFT.path}——R10 标本）`);
  }

  // 13) 管理员令牌入源容器临时文件 → 执行备份（T4 §4 步骤 1–7 全链）
  {
    const write = runSync('docker', ['exec', '-i', SRC, 'sh', '-c', 'cat > /tmp/backup-admin.token && chmod 600 /tmp/backup-admin.token'], { input: tokenAdmin, encoding: 'utf8' });
    assert.equal(write.status, 0, `容器内令牌文件写入应成功：${write.stderr?.slice(0, 200)}`);
    const bkRun = runSync('docker', ['exec', SRC, 'node', CONTAINER_CLI, 'backup', '--data-dir', '/data', '--out', '/backup', '--url', 'http://127.0.0.1:3000', '--token-file', '/tmp/backup-admin.token'], { encoding: 'utf8' });
    assert.equal(bkRun.status, 0, `备份 CLI 应退出 0，实际 ${bkRun.status}：\n${bkRun.stdout}${bkRun.stderr}`);
    console.log((bkRun.stdout ?? '').trim().split('\n').map((l) => `    │ ${l}`).join('\n'));
    ok('源实例备份完成（迁移窗口内备份——pepper 文件含 retired 条目）');
  }

  // 14) 产物断言（两件分置 + 权限 + retired 在件 + manifest 库数/HEAD 与 pre 态一致）
  let dataItem, keysItem, manifest;
  {
    const listing = (await execIn(SRC, 'ls', '-1', '/backup')).trim().split('\n').filter(Boolean);
    assert.equal(listing.length, 2, `备份根应恰有两件，实际：${listing.join(', ')}`);
    dataItem = listing.find((n) => n.endsWith('-data'));
    keysItem = listing.find((n) => n.endsWith('-keys'));
    assert.ok(dataItem && keysItem, `两件命名形态：${listing.join(', ')}`);
    const pepperRaw = (await execIn(SRC, 'cat', `/backup/${keysItem}/keys/token-pepper.key`)).trim();
    const pepper = JSON.parse(pepperRaw);
    assert.ok(Array.isArray(pepper.retired) && pepper.retired.length === 1, `密钥件应含 retired 条目（R12 前置），实际 ${pepperRaw.slice(0, 80)}`);
    assert.equal(pepper.retired[0].version, 1, 'retired 应为 v1（轮换序）');
    assert.equal(pepper.active.version, 2, 'active 应为 v2');
    manifest = JSON.parse((await execIn(SRC, 'cat', `/backup/${dataItem}/manifest.json`)).trim());
    assert.equal(manifest.vault_count, 2);
    const team = manifest.vaults.find((v) => v.slug === 'team-kb');
    const priv = manifest.vaults.find((v) => v.slug === 'bob-private');
    assert.equal(team?.head_oid, preHeadTeam, 'manifest team-kb HEAD = pre 态');
    assert.equal(priv?.head_oid, preHeadPrivate, 'manifest bob-private HEAD = pre 态');
    assert.equal(manifest.db.schema_version > 0, true);
    ok(`产物断言全过（两件分置；retired v1 在件；manifest 双库 HEAD 与 pre 态一致，schema v${manifest.db.schema_version}）`);
  }

  // 15) 产物出容器 → 宿主离线验证（§4 步骤 8 复跑——恢复前置的第二道核对）
  const hostBk = await mkdtemp(path.join(tmpdir(), 'notegit-s8t5-items-'));
  await docker('cp', `${SRC}:/backup/.`, hostBk);
  {
    const v = hostCli(['verify', '--data-item', path.join(hostBk, dataItem), '--keys-item', path.join(hostBk, keysItem)]);
    assert.equal(v.code, 0, `离线验证应全绿退出 0，实际 ${v.code}：\n${v.stdout}${v.stderr}`);
    assert.ok(v.stdout.includes('离线验证：全部通过'));
    ok(`宿主离线验证全绿（两件 ${dataItem} + ${keysItem}）`);
  }

  // 16) 负路径（恢复侧）：篡改件 → restore 拒绝装载且目标不被触碰
  {
    const tamperedRoot = await mkdtemp(path.join(tmpdir(), 'notegit-s8t5-tamper-'));
    const freshTarget = await mkdtemp(path.join(tmpdir(), 'notegit-s8t5-negtarget-'));
    try {
      await run('cp', ['-R', path.join(hostBk, dataItem), path.join(tamperedRoot, dataItem)], { maxBuffer: 1024 * 1024 });
      const { appendFileSync } = await import('node:fs');
      appendFileSync(path.join(tamperedRoot, dataItem, 'db', 'notegit.sqlite'), 'tampered-by-restore-drill');
      const r = hostCli(['restore', '--data-item', path.join(tamperedRoot, dataItem), '--keys-item', path.join(hostBk, keysItem), '--data-dir', freshTarget]);
      assert.notEqual(r.code, 0, '篡改产物的 restore 必须非零退出');
      assert.ok(r.stderr.includes('恢复前核验'), `失败面应点名恢复前核验（T4 离线验证复用）：\n${r.stderr.slice(0, 300)}`);
      const { readdirSync } = await import('node:fs');
      assert.equal(readdirSync(freshTarget).length, 0, '目标必须保持全新（无任何域被写入）');
      ok('负路径核实：产物篡改 → restore 拒绝装载（恢复前核验复用 T4 断言）、目标不被触碰');
    } finally {
      await rm(tamperedRoot, { recursive: true, force: true });
      await rm(freshTarget, { recursive: true, force: true });
    }
  }

  // ── 全新环境恢复（§7 十步） ─────────────────────────────────────────────
  // 17) 全新容器（新卷、应用未启动——sleep 入口；/data 仅镜像预建四空域）
  await docker('rm', '-f', SRC).catch(() => ''); // 源实例退场（产物已出容器；端口让给恢复实例）
  await docker('run', '-d', '--name', TARGET, '--entrypoint', 'sleep', '-p', `127.0.0.1:${PORT}:3000`, '-v', `${TARGET_VOL}:/data`, IMAGE, '3600');
  await docker('exec', '-u', 'root', TARGET, 'mkdir', '-p', '/restore');
  await docker('cp', `${hostBk}/.`, `${TARGET}:/restore/`);
  await docker('exec', '-u', 'root', TARGET, 'chown', '-R', 'notegit:notegit', '/restore');
  ok(`全新环境容器就位（${TARGET}；新卷 ${TARGET_VOL}，应用未启动——/data 仅镜像预建四空域）`);

  // 18) §7 步骤 2–6 离线装载（restore CLI；核对单逐项断言）
  {
    const r = runSync('docker', ['exec', TARGET, 'node', CONTAINER_CLI, 'restore', '--data-item', `/restore/${dataItem}`, '--keys-item', `/restore/${keysItem}`, '--data-dir', '/data'], { encoding: 'utf8' });
    assert.equal(r.status, 0, `restore CLI 应退出 0，实际 ${r.status}：\n${r.stdout}${r.stderr}`);
    for (const name of ['pre-verify', 'target-fresh', 'version-compat', 'config-restored', 'keys-restored', 'db-restored', 'git-restored', 'post-load-hashes', 'post-load-head-oid', 'post-load-db-integrity']) {
      assert.ok(r.stdout.includes(`✓ ${name}`), `restore 核对单应含 ✓ ${name}：\n${r.stdout}`);
    }
    console.log((r.stdout ?? '').trim().split('\n').map((l) => `    │ ${l}`).join('\n'));
    const gitDirs = (await execIn(TARGET, 'sh', '-c', 'ls -1 /data/git')).trim().split('\n').filter(Boolean);
    assert.equal(gitDirs.length, 2, `/data/git 应恰两库，实际 ${gitDirs.join(',')}`);
    const keysMode = (await execIn(TARGET, 'stat', '-c', '%a', '/data/keys')).trim();
    assert.equal(keysMode, '700', '恢复后 /data/keys 应 0700');
    const pepperMode = (await execIn(TARGET, 'stat', '-c', '%a', '/data/keys/token-pepper.key')).trim();
    assert.equal(pepperMode, '600', '恢复后 pepper 应 0600');
    ok('§7 步骤 2–6 离线装载完成（十项核对全绿；keys 0600/0700；库数 2）');
  }

  // 19) §7 步骤 1（形态）：以维护态启动应用 + 复核 + 业务写 503 证明
  {
    await docker('exec', '-d', '-e', 'NOTEGIT_MAINTENANCE_ON_START=1', TARGET, 'node', 'src/main.ts');
    await waitHttpHealthy(60_000);
    const face = await http('GET', '/api/v1/admin/maintenance', { bearer: tokenAdmin });
    assert.equal(face.status, 200, `恢复实例的管理员令牌应可用（同库同 pepper），得到 ${face.status}`);
    assert.equal(face.json?.enabled, true, '恢复实例应以维护态启动（§7 步骤 1）');
    const l = await http('POST', '/api/v1/auth/login', { payload: { username: 'alice', password: PW.alice } });
    assert.equal(l.status, 200, '维护中登录放行（D-BR-06）');
    const w = await http('PUT', `/api/v1/vaults/team-kb/drafts/${DRAFT.path}`, {
      cookie: l.sid,
      payload: { content: noteFile(DRAFT), base_commit: null },
    });
    assert.equal(w.status, 503, `维护中草稿写应 503，得到 ${w.status}`);
    assert.equal(w.json?.error?.code, 'E-MAINT-001');
    aliceSid = l.sid;
    const lb = await http('POST', '/api/v1/auth/login', { payload: { username: 'bob', password: PW.bob } });
    assert.equal(lb.status, 200);
    bobSid = lb.sid;
    ok('§7 步骤 1：NOTEGIT_MAINTENANCE_ON_START=1 维护态启动复核（enabled=true；业务写 503 E-MAINT-001；登录读放行）');
  }

  // 20) §7 步骤 7 + 步骤 9：finalize（只读对账 + S5-T5 全量重建）
  {
    const write = runSync('docker', ['exec', '-i', TARGET, 'sh', '-c', 'cat > /tmp/finalize-admin.token && chmod 600 /tmp/finalize-admin.token'], { input: tokenAdmin, encoding: 'utf8' });
    assert.equal(write.status, 0);
    const r = runSync('docker', ['exec', TARGET, 'node', CONTAINER_CLI, 'finalize', '--data-dir', '/data', '--url', 'http://127.0.0.1:3000', '--token-file', '/tmp/finalize-admin.token'], { encoding: 'utf8' });
    assert.equal(r.status, 0, `finalize 应退出 0，实际 ${r.status}：\n${r.stdout}${r.stderr}`);
    assert.ok(r.stdout.includes('对账（§7 步骤 7）'));
    assert.ok(r.stdout.includes('state=completed'), `重建应完成：\n${r.stdout}`);
    console.log((r.stdout ?? '').trim().split('\n').map((l) => `    │ ${l}`).join('\n'));
    ok('§7 步骤 7/9：finalize 完成（无残留对账 + 索引全量重建 completed；实例保持维护态）');
  }

  // ── §8 R1–R14 逐项核对（维护内 R1–R12；R13 退出后冒烟；R14 指标面） ──────

  // R1 管理员登录 + 管理面可用
  {
    const l = await http('POST', '/api/v1/auth/login', { payload: { username: 'root', password: ROOT_PW } });
    assert.equal(l.status, 200, `R1 管理员登录应 200，得到 ${l.status}`);
    rootSid = l.sid;
    const admin = await http('GET', '/api/v1/admin/employees', { cookie: rootSid });
    assert.equal(admin.status, 200, `R1 管理页应 200，得到 ${admin.status}`);
    assert.equal(admin.json?.employees?.length, 3, 'R1 员工数应为 3（root/alice/bob）');
    ok('R1 管理员登录：成功进入管理页（员工册 3 人在列）');
  }

  // R2 员工登录
  {
    const la = await http('POST', '/api/v1/auth/login', { payload: { username: 'alice', password: PW.alice } });
    const lb = await http('POST', '/api/v1/auth/login', { payload: { username: 'bob', password: PW.bob } });
    assert.equal(la.status, 200, `R2 alice 登录应 200，得到 ${la.status}`);
    assert.equal(lb.status, 200, `R2 bob 登录应 200，得到 ${lb.status}`);
    aliceSid = la.sid;
    bobSid = lb.sid;
    ok('R2 员工登录：alice、bob 均成功');
  }

  // R3 存量凭据可用（恢复前有效 token：ls-remote 认证通过并列出 refs）
  {
    const url = `http://drill:${tokenAliceRw}@127.0.0.1:${PORT}/git/team-kb.git`;
    const ls = await git(['ls-remote', url]);
    assert.ok(ls.stdout.includes('refs/heads/main'), `R3 应列出 refs，得到 ${scrub(ls.stdout).slice(0, 120)}`);
    const head = ls.stdout.trim().split(/\s+/)[0];
    assert.equal(head, manifest.vaults.find((v) => v.slug === 'team-kb').head_oid, 'R3 HEAD 应等于 manifest 记录');
    ok(`R3 存量凭据可用（alice-RW ls-remote 认证通过；HEAD==manifest ${head.slice(0, 10)}…）`);
  }

  // R4 撤销仍然生效（恢复前已撤销 token：401）
  {
    const r = await gitExpectFail(['ls-remote', `http://drill:${tokenRevoked}@127.0.0.1:${PORT}/git/team-kb.git`]);
    assert.notEqual(r.code, 0, 'R4 已撤销 token 必须失败');
    assert.match(r.out, /Authentication failed|401/, `R4 应为 401 形态：${scrub(r.out).slice(0, 160)}`);
    ok('R4 撤销仍然生效（恢复前撤销的 token → 401）');
  }

  // R5 库数量与映射一致（manifest vs /data/git vs Web 库列表；无孤儿）
  {
    const gitDirs = (await execIn(TARGET, 'sh', '-c', 'ls -1 /data/git')).trim().split('\n').filter(Boolean).sort();
    const bobList = await http('GET', '/api/v1/vaults', { cookie: bobSid });
    assert.equal(bobList.status, 200);
    const bobSlugs = bobList.json?.vaults.map((v) => v.slug).sort();
    assert.deepEqual(bobSlugs, ['bob-private', 'team-kb'], `R5 bob（两库成员）列表应含全部库，实际 ${JSON.stringify(bobSlugs)}`);
    const manifestSlugs = manifest.vaults.map((v) => v.slug).sort();
    assert.deepEqual(manifestSlugs, ['bob-private', 'team-kb'], 'R5 manifest 双库');
    assert.equal(gitDirs.length, manifest.vault_count, `R5 /data/git 数量 ${gitDirs.length} == manifest ${manifest.vault_count}`);
    // 映射核对：每个 git 目录可经 DB 映射（id.git 反解 id 在 manifest.vaults 内）
    for (const d of gitDirs) {
      const id = Number(d.replace(/\.git$/, ''));
      assert.ok(manifest.vaults.some((v) => v.id === id), `R5 孤儿检查：/data/git/${d} 应映射到 manifest 库`);
    }
    ok(`R5 库数量与映射一致（manifest ${manifest.vault_count} == /data/git ${gitDirs.length} == Web 列表 2；无孤儿）`);
  }

  // R6 内容一致（抽样 2 库：HEAD==manifest；Web 浏览/查看内容 == git clone 文件）
  const verifyClone = await mkdtemp(path.join(tmpdir(), 'notegit-s8t5-verify-'));
  {
    const checkVault = async (slug, token, note, sid) => {
      const ls = await git(['ls-remote', `http://drill:${token}@127.0.0.1:${PORT}/git/${slug}.git`, 'refs/heads/main']);
      const head = ls.stdout.trim().split(/\s+/)[0];
      assert.equal(head, manifest.vaults.find((v) => v.slug === slug).head_oid, `R6 ${slug} HEAD 应==manifest`);
      const dir = path.join(verifyClone, slug);
      await git(['clone', `http://drill:${token}@127.0.0.1:${PORT}/git/${slug}.git`, dir], verifyClone);
      const cloned = await readFileUtf8(path.join(dir, note.path));
      assert.ok(cloned.includes(note.title) && cloned.includes(note.body), `R6 ${slug} clone 内容应含标题与正文`);
      const browse = await http('GET', `/vaults/${slug}/browse/${path.dirname(note.path)}/`, { cookie: sid });
      assert.equal(browse.status, 200);
      assert.ok(browse.text.includes(note.path.split('/').pop()), `R6 ${slug} Web 浏览应列 ${note.path}`);
      const view = await http('GET', `/vaults/${slug}/view/${note.path}`, { cookie: sid });
      assert.equal(view.status, 200, `R6 ${slug} Web 查看应 200，得到 ${view.status}`);
      assert.ok(view.text.includes(note.body), `R6 ${slug} Web 查看应渲染正文（frontmatter 剥离——标题由 clone/检索面核对）`);
    };
    await checkVault('team-kb', tokenAliceRw, NOTE_ALPHA, aliceSid);
    await checkVault('bob-private', tokenBobRw, NOTE_GAMMA, bobSid);
    ok('R6 内容一致（两库 HEAD==manifest；Web 浏览/查看与 git clone 内容一致）');
  }

  // R7 历史完整（git log 提交数与消息；Web 历史页可见）
  {
    const teamLog = await git(['-C', path.join(verifyClone, 'team-kb'), 'log', '--oneline']);
    const lines = teamLog.stdout.trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 2, `R7 team-kb 应 2 commit，实际 ${lines.length}`);
    assert.ok(lines.some((l) => l.includes(NOTE_ALPHA.title)) && lines.some((l) => l.includes(NOTE_BETA.title)), 'R7 提交消息在列');
    const privLog = await git(['-C', path.join(verifyClone, 'bob-private'), 'log', '--oneline']);
    assert.equal(privLog.stdout.trim().split('\n').filter(Boolean).length, 1, 'R7 bob-private 应 1 commit');
    const hist = await http('GET', '/vaults/team-kb/history', { cookie: aliceSid });
    assert.equal(hist.status, 200);
    assert.ok(hist.text.includes(NOTE_ALPHA.title), 'R7 Web 历史页应含提交消息');
    ok('R7 历史完整（git log 计数/消息与播种一致；Web 历史页可用）');
  }

  // R8 权限矩阵（两员工 × 两不同成员集库：Web 列表 / 直接访问 / git clone 三处；只读 push 被拒）
  {
    const aliceList = await http('GET', '/api/v1/vaults', { cookie: aliceSid });
    const aliceSlugs = aliceList.json?.vaults.map((v) => v.slug).sort();
    assert.deepEqual(aliceSlugs, ['team-kb'], `R8 alice 列表应仅 team-kb，实际 ${JSON.stringify(aliceSlugs)}`);
    const direct = await http('GET', '/api/v1/vaults/bob-private', { cookie: aliceSid });
    assert.equal(direct.status, 404, `R8 alice 直接访问 bob-private 应 404，得到 ${direct.status}`);
    const denied = await gitExpectFail(['clone', `http://drill:${tokenAliceRw}@127.0.0.1:${PORT}/git/bob-private.git`, path.join(verifyClone, 'should-not-exist')]);
    assert.notEqual(denied.code, 0, 'R8 alice git clone bob-private 必须失败');
    assert.match(denied.out, /not found|404|Authentication/i, `R8 拒绝形态：${scrub(denied.out).slice(0, 160)}`);
    const roDir = path.join(verifyClone, 'team-kb-ro');
    await git(['clone', `http://drill:${tokenBobRo}@127.0.0.1:${PORT}/git/team-kb.git`, roDir], verifyClone);
    await writeFile(path.join(roDir, 'notes/ro-write-attempt.md'), noteFile({ title: 'RO Write Attempt', body: 'x' }));
    await git(['add', '.'], roDir);
    await git(['-c', 'user.name=Drill Bob', '-c', 'user.email=bob@notegit.invalid', 'commit', '-m', 'drill: ro attempt'], roDir);
    const roPush = await gitExpectFail(['push', 'origin', 'HEAD:refs/heads/main'], roDir);
    assert.notEqual(roPush.code, 0, 'R8 只读成员 push 必须被拒');
    assert.match(roPush.out, /\[remote rejected\]|pre-receive hook declined|non-fast-forward|403/, `R8 拒绝形态：${scrub(roPush.out).slice(0, 200)}`);
    ok('R8 权限矩阵（alice 无 bob-private：列表不含/直接 404/git 拒；bob 只读 team-kb：clone 可、push 拒）');
  }

  // R9 索引重建正确（标题检索命中；不泄露无权库）
  {
    const asAlice = await http('GET', `/api/v1/search?q=${encodeURIComponent('ZM3')}`, { cookie: aliceSid });
    assert.equal(asAlice.status, 200);
    assert.equal(asAlice.json?.results?.length, 0, `R9 alice 检索 Gamma（bob-private）应零结果——不泄露无权库，实际 ${JSON.stringify(asAlice.json?.results)}`);
    const asAliceHit = await http('GET', `/api/v1/search?q=${encodeURIComponent('XQ7')}`, { cookie: aliceSid });
    assert.ok(asAliceHit.json?.results?.some((r) => r.vault_slug === 'team-kb' && r.path === NOTE_ALPHA.path), `R9 alice 检索 Alpha 应命中 team-kb：${JSON.stringify(asAliceHit.json?.results?.slice(0, 2))}`);
    const asBob = await http('GET', `/api/v1/search?q=${encodeURIComponent('ZM3')}`, { cookie: bobSid });
    assert.ok(asBob.json?.results?.some((r) => r.vault_slug === 'bob-private' && r.path === NOTE_GAMMA.path), `R9 bob 检索 Gamma 应命中 bob-private：${JSON.stringify(asBob.json?.results?.slice(0, 2))}`);
    ok('R9 索引重建正确（重建后标题检索命中两库；无权库结果不泄露）');
  }

  // R10 草稿找回（存在且内容一致；可编辑性在 R13 退出维护后补证）
  {
    const d = await http('GET', '/api/v1/vaults/team-kb/drafts', { cookie: aliceSid });
    assert.equal(d.status, 200);
    const summary = d.json?.drafts?.find((x) => x.path === DRAFT.path);
    assert.ok(summary, `R10 草稿应在列，实际 ${JSON.stringify(d.json?.drafts)}`);
    const one = await http('GET', `/api/v1/vaults/team-kb/drafts/${DRAFT.path}`, { cookie: aliceSid });
    assert.equal(one.status, 200, `R10 草稿单读应 200，得到 ${one.status}`);
    assert.ok(
      (one.json?.content ?? '').includes(DRAFT.title) && (one.json?.content ?? '').includes(DRAFT.body),
      'R10 草稿内容应与播种逐字一致',
    );
    ok('R10 草稿找回（未发布草稿在列、内容逐字一致；可编辑性随 R13 退出维护后补证）');
  }

  // R11 审计对账（§7 步骤 7 已由 finalize 执行；此处独立抽查库内：无残留、成链、主体=认证员工）
  {
    const script = [
      "import { DatabaseSync } from 'node:sqlite';",
      "const db = new DatabaseSync('/data/db/notegit.sqlite', { readOnly: true });",
      "const residue = db.prepare(\"SELECT COUNT(*) AS n FROM audit_events WHERE event_kind IN ('vault.push','vault.web_submit') AND status IN ('pending','unresolved')\").get();",
      "const pushes = db.prepare(\"SELECT id, status, employee_id, ref_name, old_commit, new_commit FROM audit_events WHERE event_kind='vault.push' ORDER BY id\").all();",
      "console.log(JSON.stringify({ residue: residue.n, pushes }));",
      "db.close();",
    ].join('\n');
    const scriptFile = path.join(hostBk, 'r11-check.mjs');
    await writeFile(scriptFile, script);
    await docker('cp', scriptFile, `${TARGET}:/tmp/r11-check.mjs`);
    const out = (await execIn(TARGET, 'node', '/tmp/r11-check.mjs')).trim();
    const parsed = JSON.parse(out);
    assert.equal(parsed.residue, 0, `R11 无 pending 残留，实际 ${parsed.residue}`);
    assert.equal(parsed.pushes.length, 2, `R11 推送审计行应恰 2 行（team-kb 1 push 2 commit + bob-private 1 push），实际 ${parsed.pushes.length}`);
    for (const p of parsed.pushes) {
      assert.equal(p.status, 'succeeded', `R11 全部终态成功：${JSON.stringify(p)}`);
      assert.ok(typeof p.employee_id === 'number', `R11 主体=认证员工：${JSON.stringify(p)}`);
      assert.ok(p.old_commit === null || /^[0-9a-f]{40}$/.test(p.old_commit), 'R11 old 形态');
      assert.ok(/^[0-9a-f]{40}$/.test(p.new_commit), 'R11 new 形态');
    }
    ok(`R11 审计对账（finalize 步骤 7 + 库内独立抽查：residue=0；${parsed.pushes.length} 行全部 succeeded 且主体=认证员工）`);
  }

  // R12 pepper 版本兼容（迁移窗口备份：v1 哈希 token 经 retired 键可校验——identity §6.2）
  {
    const restoredPepper = JSON.parse((await execIn(TARGET, 'cat', '/data/keys/token-pepper.key')).trim());
    assert.equal(restoredPepper.retired?.length, 1, 'R12 恢复后 pepper 应含 retired v1');
    const ls = await git(['ls-remote', `http://drill:${tokenOld}@127.0.0.1:${PORT}/git/team-kb.git`, 'refs/heads/main']);
    assert.ok(ls.stdout.includes('refs/heads/main'), `R12 v1 哈希 token 经 retired 键应可校验：${scrub(ls.stdout).slice(0, 120)}`);
    ok('R12 pepper 版本兼容（恢复后 pepper 含 retired v1；旧版本哈希 token 认证通过——§6.2 可校验语义）');
  }

  // R13 维护模式退出可用（关闭后：一次网页提交 + 一次 push + 草稿可编辑）
  {
    const off = await http('DELETE', '/api/v1/admin/maintenance', { bearer: tokenAdmin });
    assert.equal(off.status, 204, `R13 退出维护应 204，得到 ${off.status}`);
    const face = await http('GET', '/api/v1/admin/maintenance', { bearer: tokenAdmin });
    assert.equal(face.json?.enabled, false, 'R13 已退出维护');
    // 先 push（FF），再以其 OID 为 base 做网页提交（避免非 FF 竞态）
    const work = path.join(verifyClone, 'team-kb');
    await writeFile(path.join(work, 'notes/post-restore-git.md'), noteFile({ title: 'Post Restore Git Push', body: '恢复后第一次 push。' }));
    await git(['add', '.'], work);
    await git(['-c', 'user.name=Drill Alice', '-c', 'user.email=alice@notegit.invalid', 'commit', '-m', 'drill: post-restore push'], work);
    const push = await git(['push', 'origin', 'HEAD:refs/heads/main'], work);
    assert.ok(!/\[remote rejected\]|error:|fatal:/.test(push.stderr), `R13 push 应成功：${scrub(push.stderr).slice(0, 300)}`);
    const ls = await git(['ls-remote', `http://drill:${tokenAliceRw}@127.0.0.1:${PORT}/git/team-kb.git`, 'refs/heads/main']);
    const newHead = ls.stdout.trim().split(/\s+/)[0];
    const submit = await http('POST', '/api/v1/vaults/team-kb/submissions', {
      cookie: aliceSid,
      payload: {
        base_commit: newHead,
        changes: [{ path: 'notes/post-restore-web.md', content: noteFile({ title: 'Post Restore Web Submit', body: '恢复后第一次网页提交。' }) }],
        message: 'drill: post-restore web submit',
      },
    });
    assert.equal(submit.status, 201, `R13 网页提交应 201，得到 ${submit.status}：${submit.text.slice(0, 200)}`);
    assert.match(submit.json?.commit ?? '', /^[0-9a-f]{40}$/);
    // R10 补证：退出维护后草稿可编辑
    const draftPut = await http('PUT', `/api/v1/vaults/team-kb/drafts/${DRAFT.path}`, {
      cookie: aliceSid,
      payload: { content: `${noteFile(DRAFT)}恢复后追加一行（R10 可编辑性补证）。\n`, base_commit: null },
    });
    assert.equal(draftPut.status, 200, `R10/R13 草稿编辑应 200，得到 ${draftPut.status}：${draftPut.text.slice(0, 200)}`);
    ok('R13 维护模式退出可用（一次 push FF + 一次网页提交 201；R10 草稿可编辑性补证通过）');
  }

  // R14 运维指标（健康检查、磁盘、备份完成时间——M4(a)：恢复实例 backup.completed 为快照后运行态，如实 null）
  {
    const h = await fetch(`${BASE}/healthz`);
    assert.equal(h.status, 200);
    const m = await http('GET', '/api/v1/admin/metrics', { bearer: tokenAdmin });
    assert.equal(m.status, 200, `R14 指标面应 200，得到 ${m.status}`);
    assert.ok(m.json?.disk, 'R14 磁盘水位字段应在');
    assert.equal(m.json?.backup?.wired, true, 'R14 backup 面已接线');
    assert.equal(m.json?.backup?.last_completed_at, null, 'R14 恢复实例 last_completed_at=null（backup.completed 为快照后运行态行，随 M4(a) 口径不入备份——本实例尚无自己的备份，如实 null）');
    ok('R14 运维指标（healthz 200；磁盘水位在；backup.wired=true 且 last_completed_at 如实 null——M4(a) 运维行不入备份口径的实证）');
  }

  await rm(cloneSrc, { recursive: true, force: true });
  await rm(verifyClone, { recursive: true, force: true });
  await rm(hostBk, { recursive: true, force: true });

  // 收尾
  if (KEEP) {
    ok(`演练全链绿（${stepNo} 步；R1–R14 全项过）。恢复实例保留运行中：${TARGET}（卷 ${TARGET_VOL}；--keep）`);
  } else {
    await docker('rm', '-f', TARGET);
    for (const v of [TARGET_VOL, BK_VOL, SRC_VOL]) await docker('volume', 'rm', v).catch(() => '');
    ok(`演练全链绿（${stepNo} 步；R1–R14 全项过）。容器与卷已清理（--keep 可保留检查）`);
  }
  log('S8-T5 全新环境恢复演练：PASS');
  process.exit(0);
} catch (err) {
  fail(err);
}

/** 小工具：宿主读文件为 utf8（顶部 import 保持精简） */
async function readFileUtf8(file) {
  const { readFile } = await import('node:fs/promises');
  return readFile(file, 'utf8');
}
