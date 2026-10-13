#!/usr/bin/env node
/**
 * S8-T7 升级迁移与回退演练（D5「演练即测试」：断言化、可复跑、输出可留档）。
 *
 * 覆盖 breakdown §2.7 S8-T7 完成标准（DOD-13 升级/回退证据；backup-recovery §9
 * 升级迁移与回退框架全链）：
 *   种子实例（真实容器，多员工多库多凭据）→ §9 升级流程（开维护 → **负路径：
 *   跳过/缺失升级前备份证据被拒（D-BR-08）** → 升级前一致备份（维护不关闸）→
 *   gate 放行 → 换镜像（N-1 旧版库构造：迁移 9 回退手术——业务数据不动，派生
 *   索引按 D-BR-07 可重建口径抹除）→ NOTEGIT_MAINTENANCE_ON_START=1 启动 →
 *   启动自动迁移 8→9（有序 + 重启可重入两证）→ 维护内冒烟（healthz/关键读面/
 *   写仍拒）→ T6 对账 CLI → 派生索引重建 → 退出维护 → push+网页写冒烟 →
 *   数据完整性）→ §9 回退演练（回退判定 → T5 restore 两相位恢复升级前备份 →
 *   版本核对断言（D-BR-05：无降级机构，schema==manifest）→ T6 对账 → 业务数据
 *   零损失 @备份点 + 运维行/会话丢弃属预期（§9 记录说明）→ 重建 → 退出维护 →
 *   回退后可写冒烟）→ 清场。
 *
 * 【仿真边界（如实记录）】本仓无历史版本镜像，「旧版本实例」以**当前镜像 +
 * schema N-1 库**构造（迁移回退手术：删末版 schema_version 行 + DROP 该版新增
 * 表 + 复原 append-only 触发器；业务数据零改动）。被真实证得的部分：新二进制
 * 对旧 schema 库的启动自动迁移（8→9 前向、有序、可重入）、§9 流程序与强制面、
 * 回退 = 备份恢复。不能证得的部分：旧二进制自身的运行行为（不存在旧二进制）。
 * 升级前备份的 manifest schema 为 9（由当前二进制执行——生产中由旧二进制执行
 * 为 8）；回退版本核对断言因此锚定 manifest 值（9==9），不锚定「旧版 = 8」。
 *
 * 用法（仓库根执行）：
 *   node deploy/scripts/upgrade-drill.mjs [--port 39091] [--keep] [--no-build]
 * 输出即留档材料（示例：node deploy/scripts/upgrade-drill.mjs 2>&1 | tee <file>）。
 * 退出码 0 = 全链绿；任何断言失败即 1（保留容器供检查，docker logs 复盘）。
 *
 * 依赖：本机 Docker + 宿主 Node ≥24（gate 负路径直跑 TS）+ 宿主 git；
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
const RECONCILE_CLI = 'src/audit/reconcile-cli.ts';
const SRC = 'notegit-s8t7-src';
const NEW = 'notegit-s8t7-new';
const ROLL = 'notegit-s8t7-roll';
const SRC_VOL = 'notegit-s8t7-src-data';
const BK_VOL = 'notegit-s8t7-src-backup';
const ROLL_VOL = 'notegit-s8t7-roll-data';
const IMAGE = 'notegit:s8t7-drill';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const optVal = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const PORT = Number(optVal('--port', '39091'));
const KEEP = flag('--keep');
const NO_BUILD = flag('--no-build');
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = BASE; // Cookie 写请求的同源 Origin（CSRF 校验，auth/csrf.ts）

const REDACT = (s) => (typeof s === 'string' && s.length > 8 ? `${s.slice(0, 6)}…${s.slice(-2)}` : '***');
const scrub = (s) => s.replace(/\/\/[^@/]+@/g, '//***@');

/** 演练内容指纹（升级前后/回退后的核对基准——内容写入与断言共用同一来源） */
const NOTE_ALPHA = { path: 'notes/alpha-upgrade-drill.md', title: 'Upgrade Drill Alpha VF3', body: '升级演练 Alpha 笔记正文 Omega61。' };
const NOTE_BETA = { path: 'notes/beta-upgrade-drill.md', title: 'Upgrade Drill Beta KQ8', body: '升级演练 Beta 笔记正文 Psi29。' };
const NOTE_GAMMA = { path: 'notes/gamma-upgrade-drill.md', title: 'Upgrade Drill Gamma RD5', body: '升级演练 Gamma 笔记正文 Chi47。' };
const DRAFT = { path: 'notes/draft-upgrade-drill.md', title: 'Upgrade Drill Draft Pending', body: '升级演练未发布草稿正文 Theta83。' };
const NOTE_POST_PUSH = { path: 'notes/post-upgrade-push.md', title: 'Post Upgrade Push ZZ1', body: '升级后第一次 push（冒烟）。' };
const NOTE_POST_WEB = { path: 'notes/post-upgrade-web.md', title: 'Post Upgrade Web ZZ2', body: '升级后第一次网页提交（冒烟）。' };
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
  for (const c of [SRC, NEW, ROLL]) {
    try {
      const { stdout } = runSync('docker', ['logs', '--tail', '40', c]);
      if (stdout?.trim()) console.error(`\n—— ${c} 日志（尾部）——\n${stdout}`);
    } catch { /* 容器可能不在 */ }
  }
  console.error(`\n清理后重跑：docker rm -f ${SRC} ${NEW} ${ROLL} && docker volume rm ${SRC_VOL} ${BK_VOL} ${ROLL_VOL}`);
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

/** HTTP JSON 助手：返回 {status, text, json, sid}（restore-drill 同款） */
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

/** 宿主侧执行 CLI（gate 负路径——不起服务，直接吃参数） */
function hostCli(cliArgs) {
  const r = runSync('node', [HOST_CLI, ...cliArgs], { cwd: REPO_ROOT, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** 容器内只读 DB 检查（node:sqlite；返回 JSON 反序列化结果） */
async function dbQuery(container, sql, params = []) {
  const script = [
    "const { DatabaseSync } = require('node:sqlite');",
    "const db = new DatabaseSync('/data/db/notegit.sqlite', { readOnly: true });",
    `const rows = db.prepare(${JSON.stringify(sql)}).all(${params.map((p) => JSON.stringify(p)).join(', ')});`,
    'console.log(JSON.stringify(rows));',
    'db.close();',
  ].join('\n');
  const out = await execIn(container, 'node', '-e', script);
  return JSON.parse(out.trim());
}

/** 管理员令牌入容器临时文件（凭据卫生：不进 argv/日志） */
function putToken(container, token, file) {
  const write = runSync('docker', ['exec', '-i', container, 'sh', '-c', `cat > ${file} && chmod 600 ${file}`], { input: token, encoding: 'utf8' });
  assert.equal(write.status, 0, `容器内令牌文件写入应成功（${file}）：${write.stderr?.slice(0, 200)}`);
}

// ─────────────────────────── 演练主链 ───────────────────────────

try {
  log(`S8-T7 升级迁移与回退演练开始（port ${PORT}，keep=${KEEP}，no-build=${NO_BUILD}）`);

  // ── 种子实例：数据就位 + pre 态记录 ────────────────────────────────────────
  // 1) 前置
  {
    const serverVersion = (await docker('version', '--format', '{{.Server.Version}}')).trim();
    assert.match(process.version, /^v24\./, `宿主 Node 需 ≥24（type-stripping 直跑 TS），实际 ${process.version}`);
    await git(['--version']);
    ok(`前置就绪（Docker server ${serverVersion}；宿主 ${process.version}）`);
  }

  // 2) 清场（可复跑）
  for (const c of [SRC, NEW, ROLL]) await docker('rm', '-f', c).catch(() => '');
  for (const v of [SRC_VOL, BK_VOL, ROLL_VOL]) await docker('volume', 'rm', '-f', v).catch(() => '');
  ok('清场完成（src/new/roll 三容器与三卷已移除）');

  // 3) 构建镜像
  if (!NO_BUILD) {
    const t = Date.now();
    await docker('build', '-f', 'deploy/Dockerfile', '-t', IMAGE, REPO_ROOT);
    ok(`镜像构建完成（${((Date.now() - t) / 1000).toFixed(0)}s；upgrade 三相位 CLI 随 server/ 树入镜像）`);
  }

  // 4) 种子实例启动（/data 与 /backup 分卷——backup §6 分置的部署侧形态）
  await docker('run', '-d', '--name', SRC, '-p', `127.0.0.1:${PORT}:3000`, '-v', `${SRC_VOL}:/data`, '-v', `${BK_VOL}:/backup`, IMAGE);
  await docker('exec', '-u', 'root', SRC, 'chown', 'notegit:notegit', '/backup');
  await waitDockerHealthy(SRC, 90_000);
  ok(`种子实例就绪（${SRC}；健康检查通过）`);

  // 5) 管理员初始化
  let rootSid;
  const ROOT_PW = 'drill-root-password-123456';
  {
    const bootstrapToken = (await execIn(SRC, 'cat', '/data/config/admin-bootstrap.token')).trim();
    const r = await http('POST', '/api/v1/auth/bootstrap', {
      payload: { bootstrap_token: bootstrapToken, username: 'root', display_name: 'Upgrade Drill Root', password: ROOT_PW },
    });
    assert.equal(r.status, 201, `bootstrap 应 201，得到 ${r.status}：${r.text.slice(0, 200)}`);
    const l = await http('POST', '/api/v1/auth/login', { payload: { username: 'root', password: ROOT_PW } });
    assert.equal(l.status, 200);
    rootSid = l.sid;
    ok(`管理员初始化完成（bootstrap 令牌脱敏 ${REDACT(bootstrapToken)}）`);
  }

  // 6) 员工 alice / bob（各自口令走真实邀请+重置+登录链）
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
  const aliceSeedSid = await invite('alice', 'Alice Upgrade Drill');
  const bobSeedSid = await invite('bob', 'Bob Upgrade Drill');
  ok('员工就位（alice、bob——经邀请+重置+登录真实链）');

  // 7) 建库：team-kb（alice admin + bob reader）与 bob-private（bob admin，alice 非成员）
  {
    const v1 = await http('POST', '/api/v1/vaults', { cookie: aliceSeedSid, payload: { name: '升级演练团队库', slug: 'team-kb' } });
    assert.equal(v1.status, 201, `建 team-kb 应 201，得到 ${v1.status}：${v1.text.slice(0, 200)}`);
    const addBob = await http('PUT', '/api/v1/vaults/team-kb/members/bob', { cookie: aliceSeedSid, payload: { role: 'reader' } });
    assert.equal(addBob.status, 200, `bob 入 team-kb reader 应 200，得到 ${addBob.status}`);
    const v2 = await http('POST', '/api/v1/vaults', { cookie: bobSeedSid, payload: { name: 'Bob 私库', slug: 'bob-private' } });
    assert.equal(v2.status, 201, `建 bob-private 应 201，得到 ${v2.status}`);
    ok('库就位（team-kb：alice=admin/bob=reader；bob-private：仅 bob——两不同成员集）');
  }

  // 8) 凭据矩阵（升级后存量可用/撤销仍生效/只读拒写标本）
  let tokenAliceRw, tokenBobRo, tokenBobRw, tokenAdmin, tokenRevoked;
  const mkCred = async (sid, payload) => {
    const c = await http('POST', '/api/v1/credentials', { cookie: sid, payload });
    assert.equal(c.status, 201, `建凭据应 201，得到 ${c.status}：${c.text.slice(0, 200)}`);
    return c.json;
  };
  {
    tokenAliceRw = (await mkCred(aliceSeedSid, { name: 'alice-rw', expires_at: new Date(Date.now() + 86_400_000).toISOString(), scope: { access: 'read_write', vaults: ['team-kb'] } })).token;
    tokenBobRo = (await mkCred(bobSeedSid, { name: 'bob-ro-teamkb', expires_at: new Date(Date.now() + 86_400_000).toISOString(), scope: { access: 'read', vaults: ['team-kb'] } })).token;
    tokenBobRw = (await mkCred(bobSeedSid, { name: 'bob-rw-private', expires_at: new Date(Date.now() + 86_400_000).toISOString(), scope: { access: 'read_write', vaults: ['bob-private'] } })).token;
    tokenAdmin = (await mkCred(rootSid, { name: 'upgrade-drill-admin', expires_at: new Date(Date.now() + 3_600_000).toISOString() })).token;
    const revoked = await mkCred(aliceSeedSid, { name: 'revoked-before-upgrade', expires_at: new Date(Date.now() + 86_400_000).toISOString(), scope: { access: 'read_write', vaults: ['team-kb'] } });
    tokenRevoked = revoked.token;
    const d = await http('DELETE', `/api/v1/credentials/${revoked.id}`, { cookie: aliceSeedSid });
    assert.equal(d.status, 204, `撤销应 204，得到 ${d.status}`);
    ok(`凭据矩阵就位（alice-RW/bob-RO/bob-RW/管理员/已撤销，脱敏 ${REDACT(tokenAliceRw)} 等）`);
  }

  // 9) Git 播种（服务端校验链全过）+ 记录 pre 态 HEAD
  const seedDir = await mkdtemp(path.join(tmpdir(), 'notegit-s8t7-seed-'));
  let preHeadTeam, preHeadPrivate;
  const seedVault = async (slug, token, notes, who) => {
    const dir = path.join(seedDir, `${slug}-work`);
    const url = `http://${who}:${token}@127.0.0.1:${PORT}/git/${slug}.git`;
    await git(['clone', url, dir], seedDir);
    for (const n of notes) {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(path.dirname(path.join(dir, n.path)), { recursive: true });
      await writeFile(path.join(dir, n.path), noteFile(n));
      await git(['add', '.'], dir);
      await git(['-c', 'user.name=Drill Worker', '-c', 'user.email=drill@notegit.invalid', 'commit', '-m', `drill: ${n.title}`], dir);
    }
    const push = await git(['push', 'origin', 'HEAD:refs/heads/main'], dir);
    assert.ok(!/\[remote rejected\]|error:|fatal:/.test(push.stderr), `push ${slug} 应成功：${scrub(push.stderr).slice(0, 300)}`);
    const ls = await git(['ls-remote', url, 'refs/heads/main'], seedDir);
    return ls.stdout.trim().split(/\s+/)[0];
  };
  preHeadTeam = await seedVault('team-kb', tokenAliceRw, [NOTE_ALPHA, NOTE_BETA], 'alice');
  preHeadPrivate = await seedVault('bob-private', tokenBobRw, [NOTE_GAMMA], 'bob');
  assert.match(preHeadTeam, /^[0-9a-f]{40}$/);
  assert.match(preHeadPrivate, /^[0-9a-f]{40}$/);
  ok(`Git 播种完成（team-kb 2 commit、bob-private 1 commit；pre 态 HEAD ${preHeadTeam.slice(0, 10)}… / ${preHeadPrivate.slice(0, 10)}…）`);

  // 10) 未发布草稿（升级/回退后找回标本）
  {
    const d = await http('PUT', `/api/v1/vaults/team-kb/drafts/${DRAFT.path}`, {
      cookie: aliceSeedSid,
      payload: { content: noteFile(DRAFT), base_commit: null },
    });
    assert.equal(d.status, 200, `存草稿应 200，得到 ${d.status}：${d.text.slice(0, 200)}`);
    ok(`未发布草稿就位（${DRAFT.path}）`);
  }

  // 11) pre 态指纹（业务数据/审计/迁移形态/派生索引——升级前后与回退后的核对基准）
  let preState;
  {
    const [employees, vaults, pushes, schema, draftRows] = await Promise.all([
      dbQuery(SRC, 'SELECT COUNT(*) AS n FROM employees'),
      dbQuery(SRC, 'SELECT COUNT(*) AS n FROM vaults'),
      dbQuery(SRC, "SELECT COUNT(*) AS n FROM audit_events WHERE event_kind IN ('vault.push','vault.web_submit') AND status='succeeded'"),
      dbQuery(SRC, 'SELECT version, applied_at FROM schema_version ORDER BY version'),
      dbQuery(SRC, "SELECT COUNT(*) AS n FROM drafts WHERE status='active'"),
    ]);
    preState = {
      employees: employees[0].n,
      vaults: vaults[0].n,
      pushes: pushes[0].n,
      schemaRows: schema,
      drafts: draftRows[0].n,
      headTeam: preHeadTeam,
      headPrivate: preHeadPrivate,
    };
    assert.equal(preState.employees, 3, 'pre 态员工数');
    assert.equal(preState.vaults, 2, 'pre 态库数');
    assert.equal(preState.pushes, 2, 'pre 态成功发布审计行');
    assert.equal(preState.drafts, 1, 'pre 态草稿数');
    assert.equal(preState.schemaRows.length, 9, `pre 态 schema_version 应 9 行（当前版本），实际 ${preState.schemaRows.length}`);
    // 派生索引在位（升级手术将抹除——D-BR-07 可重建口径的对照面）；推送触发的
    // 增量索引有异步延迟（§9 索引延迟可观测），有界等待命中
    const indexDeadline = Date.now() + 20_000;
    for (;;) {
      const s = await http('GET', `/api/v1/search?q=${encodeURIComponent('VF3')}`, { cookie: aliceSeedSid });
      if (s.json?.results?.some((r) => r.vault_slug === 'team-kb' && r.path === NOTE_ALPHA.path)) break;
      if (Date.now() > indexDeadline) {
        throw new Error(`pre 态检索应有 Alpha 命中（索引延迟有界等待 20s 超时）：${JSON.stringify(s.json?.results)}`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    ok(`pre 态指纹记录（员工 ${preState.employees}、库 ${preState.vaults}、成功发布 ${preState.pushes}、草稿 ${preState.drafts}、schema 1..9、检索命中在位）`);
  }

  // ── §9 升级流程 ──────────────────────────────────────────────────────────
  // 12) 开维护（§9 步骤 2）：写拒/读放行矩阵复核
  {
    const on = await http('POST', '/api/v1/admin/maintenance', { bearer: tokenAdmin });
    assert.equal(on.status, 204, `开维护应 204，得到 ${on.status}`);
    const face = await http('GET', '/api/v1/admin/maintenance', { bearer: tokenAdmin });
    assert.equal(face.json?.enabled, true, '维护面 enabled=true');
    const w = await http('PUT', `/api/v1/vaults/team-kb/drafts/${DRAFT.path}`, {
      cookie: aliceSeedSid,
      payload: { content: noteFile(DRAFT), base_commit: null },
    });
    assert.equal(w.status, 503, `维护中草稿写应 503，得到 ${w.status}`);
    assert.equal(w.json?.error?.code, 'E-MAINT-001');
    const l = await http('POST', '/api/v1/auth/login', { payload: { username: 'alice', password: PW.alice } });
    assert.equal(l.status, 200, '维护中登录放行（D-BR-06）');
    ok('§9 开维护完成（enabled=true；业务写 503 E-MAINT-001；登录读放行）');
  }

  // 13) 负路径 A：跳过升级前备份被流程拒绝（D-BR-08——breakdown 断言位；宿主侧）
  {
    const r = hostCli(['upgrade', 'gate', '--skip-pre-upgrade-backup']);
    assert.notEqual(r.code, 0, '跳过形态必须非零退出');
    assert.ok(r.stderr.includes('D-BR-08'), `拒绝文案应点名 D-BR-08：\n${r.stderr.slice(0, 300)}`);
    ok('负路径 A：upgrade gate --skip-pre-upgrade-backup → 拒绝（D-BR-08 升级前备份强制——跳过无门）');
  }

  // 14) 负路径 B：无备份证据被拒（容器内——守在换镜像发生的环境）
  {
    const r = runSync('docker', ['exec', SRC, 'node', CONTAINER_CLI, 'upgrade', 'gate'], { encoding: 'utf8' });
    assert.notEqual(r.status, 0, '无证据形态必须非零退出');
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    assert.ok(/证据|D-BR-08/.test(out), `拒绝文案应点名证据缺失/D-BR-08：\n${out.slice(0, 300)}`);
    ok('负路径 B：upgrade gate（无 --data-item 证据）→ 拒绝（未完成备份不得升级）');
  }

  // 15) 升级前一致备份（§9 步骤 3；维护不关闸——upgrade pre-backup）
  let dataItem, keysItem, manifest;
  {
    putToken(SRC, tokenAdmin, '/tmp/upgrade-admin.token');
    const r = runSync('docker', ['exec', SRC, 'node', CONTAINER_CLI, 'upgrade', 'pre-backup', '--data-dir', '/data', '--out', '/backup', '--url', 'http://127.0.0.1:3000', '--token-file', '/tmp/upgrade-admin.token'], { encoding: 'utf8' });
    assert.equal(r.status, 0, `upgrade pre-backup 应退出 0，实际 ${r.status}：\n${r.stdout}${r.stderr}`);
    console.log((r.stdout ?? '').trim().split('\n').map((l) => `    │ ${l}`).join('\n'));
    const face = await http('GET', '/api/v1/admin/maintenance', { bearer: tokenAdmin });
    assert.equal(face.json?.enabled, true, '§9 升级前备份后维护必须保持开启（全程维护）');
    const listing = (await execIn(SRC, 'ls', '-1', '/backup')).trim().split('\n').filter(Boolean);
    assert.equal(listing.length, 2, `备份根应恰有两件，实际：${listing.join(', ')}`);
    dataItem = listing.find((n) => n.endsWith('-data'));
    keysItem = listing.find((n) => n.endsWith('-keys'));
    manifest = JSON.parse((await execIn(SRC, 'cat', `/backup/${dataItem}/manifest.json`)).trim());
    assert.equal(manifest.vault_count, 2, 'manifest 库数');
    assert.equal(manifest.vaults.find((v) => v.slug === 'team-kb')?.head_oid, preHeadTeam, 'manifest team-kb HEAD = pre 态');
    assert.equal(manifest.vaults.find((v) => v.slug === 'bob-private')?.head_oid, preHeadPrivate, 'manifest bob-private HEAD = pre 态');
    const backupRows = await dbQuery(SRC, "SELECT COUNT(*) AS n FROM audit_events WHERE event_kind='backup.completed'");
    assert.equal(backupRows[0].n, 1, '升级前备份完成审计行恰 1 行');
    ok(`升级前一致备份完成（两件 ${dataItem} + ${keysItem}；manifest 双库 HEAD=pre 态；维护保持开启；backup.completed 在案）`);
  }

  // 16) gate 放行（D-BR-08 正路径）：产物出容器 → 宿主离线验证复算 → 放行
  const hostBk = await mkdtemp(path.join(tmpdir(), 'notegit-s8t7-items-'));
  {
    await docker('cp', `${SRC}:/backup/.`, hostBk);
    const r = hostCli(['upgrade', 'gate', '--data-item', path.join(hostBk, dataItem), '--keys-item', path.join(hostBk, keysItem)]);
    assert.equal(r.code, 0, `gate 应放行退出 0，实际 ${r.code}：\n${r.stdout}${r.stderr}`);
    assert.ok(r.stdout.includes('放行'), `放行输出：\n${r.stdout.slice(0, 300)}`);
    ok('gate 放行（T4 离线验证复算全绿——升级可继续 §9）');
  }

  // 17) 换镜像（§9 步骤 4 的演练形态）：停旧容器 → N-1 旧版库构造（迁移回退手术）
  //     【仿真边界】无历史镜像——「旧版本数据卷」= 删迁移 9 行 + DROP 其新增派生表
  //     （业务数据零改动；append-only 触发器先落再复原——手术仅演练构造用）。
  let surgeryDoneAt;
  {
    await docker('stop', SRC);
    const SURGERY = [
      "const { DatabaseSync } = require('node:sqlite');",
      "const db = new DatabaseSync('/data/db/notegit.sqlite');",
      "const top = () => db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v;",
      "const biz = () => JSON.stringify({",
      "  employees: db.prepare('SELECT COUNT(*) AS n FROM employees').get().n,",
      "  vaults: db.prepare('SELECT COUNT(*) AS n FROM vaults').get().n,",
      "  pushes: db.prepare(\"SELECT COUNT(*) AS n FROM audit_events WHERE event_kind='vault.push' AND status='succeeded'\").get().n,",
      "});",
      "if (top() !== 9) throw new Error('precondition: expected schema top 9, got ' + top());",
      "const before = biz();",
      "db.exec('DROP TRIGGER schema_version_no_update');",
      "db.exec('DROP TRIGGER schema_version_no_delete');",
      "db.prepare('DELETE FROM schema_version WHERE version = 9').run();",
      "db.exec('DROP TABLE search_index_state');",
      "db.exec('DROP TABLE search_index');",
      "db.exec(\"CREATE TRIGGER schema_version_no_update BEFORE UPDATE ON schema_version BEGIN SELECT RAISE(ABORT, 'schema_version is append-only (backup-recovery §9)'); END\");",
      "db.exec(\"CREATE TRIGGER schema_version_no_delete BEFORE DELETE ON schema_version BEGIN SELECT RAISE(ABORT, 'schema_version is append-only (backup-recovery §9)'); END\");",
      "const tables = db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'search_index%'\").all();",
      "if (top() !== 8) throw new Error('post: expected schema top 8, got ' + top());",
      "if (tables.length !== 0) throw new Error('post: search tables should be gone');",
      "if (biz() !== before) throw new Error('post: business data must be untouched: ' + biz() + ' vs ' + before);",
      "console.log(JSON.stringify({ top: top(), business: JSON.parse(before) }));",
      "db.close();",
    ].join('\n');
    const out = (await run('docker', ['run', '--rm', '-v', `${SRC_VOL}:/data`, IMAGE, 'node', '-e', SURGERY], { maxBuffer: 1024 * 1024 })).stdout;
    surgeryDoneAt = new Date();
    const parsed = JSON.parse(out.trim());
    assert.equal(parsed.top, 8, '手术后 schema 顶 = 8（N-1）');
    assert.deepEqual(parsed.business, { employees: 3, vaults: 2, pushes: 2 }, '手术后业务数据零改动');
    ok(`旧版库构造完成（schema 9→8 手术：迁移 9 行删除 + search 两表 DROP + 触发器复原；业务数据 {员工 3, 库 2, push 2} 零改动——「旧版本实例」就位）`);
  }

  // 18) 启动新版本（§9 步骤 4–5）：新容器（镜像形态的换镜像）+ 维护态启动 → 启动自动迁移 8→9
  let row9First;
  {
    await docker('run', '-d', '--name', NEW, '-e', 'NOTEGIT_MAINTENANCE_ON_START=1', '-p', `127.0.0.1:${PORT}:3000`, '-v', `${SRC_VOL}:/data`, IMAGE);
    await waitDockerHealthy(NEW, 90_000);
    await waitHttpHealthy(60_000);
    const face = await http('GET', '/api/v1/admin/maintenance', { bearer: tokenAdmin });
    assert.equal(face.json?.enabled, true, '新版本以维护态启动（维护跨换镜像连续——§9 全程维护）');
    const rows = await dbQuery(NEW, 'SELECT version, applied_at FROM schema_version ORDER BY version');
    assert.equal(rows.length, 9, `启动自动迁移后 schema_version 应 9 行，实际 ${rows.length}`);
    assert.deepEqual(rows.map((r) => r.version), [1, 2, 3, 4, 5, 6, 7, 8, 9], '版本恰为 1..9（有序）');
    row9First = rows[8].applied_at;
    assert.ok(Date.parse(row9First) >= Date.parse(surgeryDoneAt.toISOString()) - 60_000, `迁移 9 的 applied_at（${row9First}）应为启动后新写入（手术时刻 ${surgeryDoneAt.toISOString()}）`);
    putToken(NEW, tokenAdmin, '/tmp/upgrade-admin.token');
    const post = runSync('docker', ['exec', NEW, 'node', CONTAINER_CLI, 'upgrade', 'post', '--data-dir', '/data', '--url', 'http://127.0.0.1:3000', '--token-file', '/tmp/upgrade-admin.token'], { encoding: 'utf8' });
    assert.equal(post.status, 0, `upgrade post 应退出 0，实际 ${post.status}：\n${post.stdout}${post.stderr}`);
    console.log((post.stdout ?? '').trim().split('\n').map((l) => `    │ ${l}`).join('\n'));
    ok(`新版本启动自动迁移完成（8→9 前向：行 9 applied_at=${row9First}；upgrade post 核对通过：1..9 连续无缺）`);
  }

  // 19) 可重入复核（§9 有序可重入——既有机制核对）：重启 → 已应用跳过、不重复执行
  {
    await docker('restart', NEW);
    await waitDockerHealthy(NEW, 90_000);
    await waitHttpHealthy(60_000);
    const rows = await dbQuery(NEW, 'SELECT version, applied_at FROM schema_version ORDER BY version');
    assert.equal(rows.length, 9, '重启后仍 9 行（不重复插入）');
    assert.equal(rows[8].applied_at, row9First, `重启后迁移 9 的 applied_at 不变（可重入——已应用跳过）：${rows[8].applied_at} vs ${row9First}`);
    const post = runSync('docker', ['exec', NEW, 'node', CONTAINER_CLI, 'upgrade', 'post', '--data-dir', '/data', '--url', 'http://127.0.0.1:3000', '--token-file', '/tmp/upgrade-admin.token'], { encoding: 'utf8' });
    assert.equal(post.status, 0, `重启后 upgrade post 仍应 0，实际 ${post.status}：\n${post.stdout}${post.stderr}`);
    ok('可重入复核（重启后已应用版本跳过：行数与 applied_at 逐字不变；upgrade post 复跑通过）');
  }

  // 20) 维护内冒烟（§9 步骤 6 冒烟的读面半场——写面在退出维护后，见步骤 24）
  let aliceSid;
  {
    const h = await fetch(`${BASE}/healthz`);
    assert.equal(h.status, 200, 'healthz 200');
    const l = await http('POST', '/api/v1/auth/login', { payload: { username: 'alice', password: PW.alice } });
    assert.equal(l.status, 200, '升级后登录可用');
    aliceSid = l.sid; // 升级窗口会话（回退丢弃标本——§9 记录说明）
    const list = await http('GET', '/api/v1/vaults', { cookie: aliceSid });
    assert.equal(list.status, 200);
    assert.deepEqual(list.json?.vaults.map((v) => v.slug), ['team-kb'], `alice 库列表应恰 team-kb，实际 ${JSON.stringify(list.json?.vaults)}`);
    const view = await http('GET', `/vaults/team-kb/view/${NOTE_ALPHA.path}`, { cookie: aliceSid });
    assert.equal(view.status, 200, `Alpha 查看应 200，得到 ${view.status}`);
    assert.ok(view.text.includes(NOTE_ALPHA.body), 'Alpha 正文经 Web 可读（迁移后权威内容在位）');
    const draft = await http('GET', `/api/v1/vaults/team-kb/drafts/${DRAFT.path}`, { cookie: aliceSid });
    assert.equal(draft.status, 200, '草稿可读');
    const w = await http('PUT', `/api/v1/vaults/team-kb/drafts/${DRAFT.path}`, {
      cookie: aliceSid,
      payload: { content: noteFile(DRAFT), base_commit: null },
    });
    assert.equal(w.status, 503, `维护未退出前写仍拒（503），得到 ${w.status}`);
    ok('维护内冒烟（healthz；登录/库列表/Alpha 查看/草稿读全绿；写仍 503——冒烟写面待退出维护）');
  }

  // 21) 对账（consume T6 CLI——§7 步骤 7 形态；维护 fail-closed 消费）
  {
    const r = runSync('docker', ['exec', NEW, 'node', RECONCILE_CLI, 'reconcile', '--data-dir', '/data', '--url', 'http://127.0.0.1:3000', '--token-file', '/tmp/upgrade-admin.token'], { encoding: 'utf8' });
    assert.equal(r.status, 0, `T6 对账应退出 0，实际 ${r.status}：\n${r.stdout}${r.stderr}`);
    assert.ok(r.stdout.includes('全部通过'), `对账汇总应全部通过：\n${r.stdout.slice(-400)}`);
    console.log((r.stdout ?? '').trim().split('\n').slice(-2).map((l) => `    │ ${l}`).join('\n'));
    ok('T6 恢复对账通过（维护内执行：定终态 0、残留 0、成链 0 违例、无孤儿——升级未破引用-审计一致）');
  }

  // 22) 派生索引重建（迁移 9 新表为空 → S5-T5 全量重建；§9 索引延迟可观测口径）
  {
    const trigger = await http('POST', '/api/v1/admin/search-index/rebuild', { bearer: tokenAdmin });
    assert.ok(trigger.status === 202 || trigger.status === 409, `重建触发应 202/409，得到 ${trigger.status}`);
    const deadline = Date.now() + 60_000;
    for (;;) {
      const face = await http('GET', '/api/v1/admin/search-index', { bearer: tokenAdmin });
      assert.equal(face.status, 200);
      if (face.json?.rebuild?.state === 'completed') break;
      if (Date.now() > deadline) throw new Error(`重建等待超时：${JSON.stringify(face.json?.rebuild)}`);
      await new Promise((r) => setTimeout(r, 500));
    }
    const s = await http('GET', `/api/v1/search?q=${encodeURIComponent('VF3')}`, { cookie: aliceSid });
    assert.ok(s.json?.results?.some((r) => r.vault_slug === 'team-kb' && r.path === NOTE_ALPHA.path), `升级后检索应命中 Alpha：${JSON.stringify(s.json?.results?.slice(0, 2))}`);
    const sG = await http('GET', `/api/v1/search?q=${encodeURIComponent('RD5')}`, { cookie: aliceSid });
    assert.equal(sG.json?.results?.length, 0, 'alice 检索 Gamma（bob-private）应零结果——不泄露无权库');
    ok('派生索引全量重建完成（升级后检索命中 Alpha；无权库不泄露——迁移新表自空场重建的实证）');
  }

  // 23) 退出维护（§9 步骤 7——显式操作）
  {
    const off = await http('DELETE', '/api/v1/admin/maintenance', { bearer: tokenAdmin });
    assert.equal(off.status, 204, `退出维护应 204，得到 ${off.status}`);
    const face = await http('GET', '/api/v1/admin/maintenance', { bearer: tokenAdmin });
    assert.equal(face.json?.enabled, false, '已退出维护');
    ok('退出维护完成（显式 DELETE；升级主流程收束）');
  }

  // 24) 冒烟写面（§9「一次 push 冒烟」+ 网页提交——升级接受判据）
  let postUpgradeHead;
  {
    const work = path.join(seedDir, 'team-kb-work');
    await writeFile(path.join(work, NOTE_POST_PUSH.path), noteFile(NOTE_POST_PUSH));
    await git(['add', '.'], work);
    await git(['-c', 'user.name=Drill Alice', '-c', 'user.email=alice@notegit.invalid', 'commit', '-m', `drill: ${NOTE_POST_PUSH.title}`], work);
    const push = await git(['push', 'origin', 'HEAD:refs/heads/main'], work);
    assert.ok(!/\[remote rejected\]|error:|fatal:/.test(push.stderr), `升级后 push 应成功：${scrub(push.stderr).slice(0, 300)}`);
    const ls = await git(['ls-remote', `http://drill:${tokenAliceRw}@127.0.0.1:${PORT}/git/team-kb.git`, 'refs/heads/main'], seedDir);
    postUpgradeHead = ls.stdout.trim().split(/\s+/)[0];
    assert.match(postUpgradeHead, /^[0-9a-f]{40}$/);
    const submit = await http('POST', '/api/v1/vaults/team-kb/submissions', {
      cookie: aliceSid,
      payload: {
        base_commit: postUpgradeHead,
        changes: [{ path: NOTE_POST_WEB.path, content: noteFile(NOTE_POST_WEB) }],
        message: `drill: ${NOTE_POST_WEB.title}`,
      },
    });
    assert.equal(submit.status, 201, `升级后网页提交应 201，得到 ${submit.status}：${submit.text.slice(0, 200)}`);
    const pushes = await dbQuery(NEW, "SELECT COUNT(*) AS n FROM audit_events WHERE event_kind IN ('vault.push','vault.web_submit') AND status='succeeded'");
    assert.equal(pushes[0].n, 4, `升级接受后成功发布应 4 行（pre 2 + push 1 + web 1），实际 ${pushes[0].n}`);
    ok('冒烟写面（升级后一次 push FF + 一次网页提交 201；审计行 2→4）——升级演练主链全绿');
  }

  // ── §9 回退演练（D-BR-05：回退 = 恢复升级前一致备份；不做 schema 降级） ──
  // 25) 回退判定（升级已接受后发现问题 → 回退）：停新版本 → 全新卷 + T5 restore 离线装载
  {
    await docker('rm', '-f', NEW); // 端口与「新版本」退场；回退实例接管
    await docker('run', '-d', '--name', ROLL, '--entrypoint', 'sleep', '-p', `127.0.0.1:${PORT}:3000`, '-v', `${ROLL_VOL}:/data`, IMAGE, '3600');
    await docker('exec', '-u', 'root', ROLL, 'mkdir', '-p', '/restore');
    await docker('cp', `${hostBk}/.`, `${ROLL}:/restore/`);
    await docker('exec', '-u', 'root', ROLL, 'chown', '-R', 'notegit:notegit', '/restore');
    const r = runSync('docker', ['exec', ROLL, 'node', CONTAINER_CLI, 'restore', '--data-item', `/restore/${dataItem}`, '--keys-item', `/restore/${keysItem}`, '--data-dir', '/data'], { encoding: 'utf8' });
    assert.equal(r.status, 0, `restore CLI 应退出 0，实际 ${r.status}：\n${r.stdout}${r.stderr}`);
    for (const name of ['pre-verify', 'target-fresh', 'version-compat', 'config-restored', 'keys-restored', 'db-restored', 'git-restored', 'post-load-hashes', 'post-load-head-oid', 'post-load-db-integrity']) {
      assert.ok(r.stdout.includes(`✓ ${name}`), `restore 核对单应含 ✓ ${name}：\n${r.stdout}`);
    }
    console.log((r.stdout ?? '').trim().split('\n').map((l) => `    │ ${l}`).join('\n'));
    ok(`回退离线装载完成（T5 restore 复用：升级前备份 ${dataItem} → 全新卷 ${ROLL_VOL}，十项核对全绿）`);
  }

  // 26) 回退实例以维护态启动（§7 步骤 1 形态）
  {
    await docker('exec', '-d', '-e', 'NOTEGIT_MAINTENANCE_ON_START=1', ROLL, 'node', 'src/main.ts');
    await waitHttpHealthy(60_000);
    const face = await http('GET', '/api/v1/admin/maintenance', { bearer: tokenAdmin });
    assert.equal(face.status, 200, `管理员令牌跨回退仍有效（同库同 pepper），得到 ${face.status}`);
    assert.equal(face.json?.enabled, true, '回退实例以维护态启动');
    putToken(ROLL, tokenAdmin, '/tmp/roll-admin.token');
    ok('回退实例维护态启动（管理员令牌可用；enabled=true）');
  }

  // 27) 版本核对断言（D-BR-05：不做 schema 降级——回退只恢复，无降级机构运转）
  {
    const rows = await dbQuery(ROLL, 'SELECT version, applied_at FROM schema_version ORDER BY version');
    assert.equal(rows.length, manifest.db.schema_version, `回退后 schema_version 行数 == manifest 版本（${manifest.db.schema_version}），实际 ${rows.length}`);
    assert.deepEqual(rows.map((r) => r.version), Array.from({ length: manifest.db.schema_version }, (_, i) => i + 1), '版本恰为 1..manifest 版本（每版恰一行——append-only，无降级改写）');
    const post = runSync('docker', ['exec', ROLL, 'node', CONTAINER_CLI, 'upgrade', 'post', '--data-dir', '/data', '--url', 'http://127.0.0.1:3000', '--token-file', '/tmp/roll-admin.token'], { encoding: 'utf8' });
    assert.equal(post.status, 0, `回退实例 upgrade post 应 0（迁移形态完好），实际 ${post.status}：\n${post.stdout}${post.stderr}`);
    ok(`回退版本核对（schema 1..${manifest.db.schema_version} == manifest v${manifest.db.schema_version}；无降级路径被触发——回退=恢复，D-BR-05）`);
  }

  // 28) T6 对账（回退 = 恢复语义 → §7 步骤 7 对账在回退实例复跑）
  {
    const r = runSync('docker', ['exec', ROLL, 'node', RECONCILE_CLI, 'reconcile', '--data-dir', '/data', '--url', 'http://127.0.0.1:3000', '--token-file', '/tmp/roll-admin.token'], { encoding: 'utf8' });
    assert.equal(r.status, 0, `回退实例 T6 对账应退出 0，实际 ${r.status}：\n${r.stdout}${r.stderr}`);
    assert.ok(r.stdout.includes('全部通过'));
    ok('回退实例 T6 对账通过（引用-审计成链一致——备份点状态自洽）');
  }

  // 29) 业务数据零损失 @备份点（breakdown 完成标准）+ 升级窗口写入随回退丢弃（§9 记录说明）
  {
    const [teamHead, privHead] = await Promise.all([
      git(['ls-remote', `http://drill:${tokenAliceRw}@127.0.0.1:${PORT}/git/team-kb.git`, 'refs/heads/main'], seedDir),
      git(['ls-remote', `http://drill:${tokenBobRw}@127.0.0.1:${PORT}/git/bob-private.git`, 'refs/heads/main'], seedDir),
    ]);
    assert.equal(teamHead.stdout.trim().split(/\s+/)[0], preHeadTeam, `回退后 team-kb HEAD == pre 态（备份点零损失）`);
    assert.equal(privHead.stdout.trim().split(/\s+/)[0], preHeadPrivate, '回退后 bob-private HEAD == pre 态');
    // 升级接受后的冒烟写入（post-upgrade push/web）随回退丢弃——回退语义，非损失
    const tree = await git(['ls-remote', `http://drill:${tokenAliceRw}@127.0.0.1:${PORT}/git/team-kb.git`, 'refs/heads/main'], seedDir);
    assert.notEqual(tree.stdout.trim().split(/\s+/)[0], postUpgradeHead, '升级后 HEAD 已随回退退场');
    const employees = await dbQuery(ROLL, 'SELECT COUNT(*) AS n FROM employees');
    const vaults = await dbQuery(ROLL, 'SELECT COUNT(*) AS n FROM vaults');
    const pushes = await dbQuery(ROLL, "SELECT COUNT(*) AS n FROM audit_events WHERE event_kind IN ('vault.push','vault.web_submit') AND status='succeeded'");
    assert.equal(employees[0].n, preState.employees, '回退后员工数 == pre 态');
    assert.equal(vaults[0].n, preState.vaults, '回退后库数 == pre 态');
    assert.equal(pushes[0].n, preState.pushes, `回退后成功发布审计 == pre 态（${preState.pushes}）——升级窗口发布已随回退丢弃`);
    const l = await http('POST', '/api/v1/auth/login', { payload: { username: 'alice', password: PW.alice } });
    assert.equal(l.status, 200, '回退后登录可用');
    const draft = await http('GET', `/api/v1/vaults/team-kb/drafts/${DRAFT.path}`, { cookie: l.sid });
    assert.equal(draft.status, 200, '回退后草稿在列');
    assert.ok((draft.json?.content ?? '').includes(DRAFT.body), '回退后草稿内容逐字一致');
    const ls = await git(['ls-remote', `http://drill:${tokenAliceRw}@127.0.0.1:${PORT}/git/team-kb.git`], seedDir);
    assert.ok(ls.stdout.includes('refs/heads/main'), '回退后存量凭据（alice-RW）认证通过');
    const revoked = await gitExpectFail(['ls-remote', `http://drill:${tokenRevoked}@127.0.0.1:${PORT}/git/team-kb.git`], seedDir);
    assert.notEqual(revoked.code, 0, '回退后撤销凭据仍被拒（401）');
    ok('业务数据零损失 @备份点（双库 HEAD/员工/库/审计/草稿/凭据全==pre 态；升级窗口发布随回退退场——回退语义）');
  }

  // 30) 运维行与会话丢弃属预期（§9「记录说明」：备份点后的运行态写入不入回退世界）
  {
    const backupRows = await dbQuery(ROLL, "SELECT COUNT(*) AS n FROM audit_events WHERE event_kind='backup.completed'");
    assert.equal(backupRows[0].n, 0, `升级前备份的 backup.completed 审计行（备份点后写入）应随回退丢弃，实际 ${backupRows[0].n} 行`);
    const enableRows = await dbQuery(ROLL, "SELECT COUNT(*) AS n FROM audit_events WHERE event_kind='maintenance.enable'");
    assert.equal(enableRows[0].n, 1, '备份点前的 maintenance.enable 行在案（备份点边界两侧如实分界）');
    const stale = await http('GET', `/api/v1/vaults/team-kb/drafts/${DRAFT.path}`, { cookie: aliceSid });
    assert.ok(stale.status === 401 || stale.status === 403, `升级窗口会话（备份点后创建）应随回退失效，得到 ${stale.status}`);
    ok('运维行/会话丢弃口径实证（backup.completed 与窗口会话随回退消失；备份点前的 enable 行保留——§9 属预期而非损失）');
  }

  // 31) 派生索引重建（回退实例——§7 步骤 9 同款）+ 退出维护
  {
    const trigger = await http('POST', '/api/v1/admin/search-index/rebuild', { bearer: tokenAdmin });
    assert.ok(trigger.status === 202 || trigger.status === 409, `重建触发应 202/409，得到 ${trigger.status}`);
    const deadline = Date.now() + 60_000;
    for (;;) {
      const face = await http('GET', '/api/v1/admin/search-index', { bearer: tokenAdmin });
      if (face.json?.rebuild?.state === 'completed') break;
      if (Date.now() > deadline) throw new Error(`重建等待超时：${JSON.stringify(face.json?.rebuild)}`);
      await new Promise((r) => setTimeout(r, 500));
    }
    const l = await http('POST', '/api/v1/auth/login', { payload: { username: 'alice', password: PW.alice } });
    const s = await http('GET', `/api/v1/search?q=${encodeURIComponent('VF3')}`, { cookie: l.sid });
    assert.ok(s.json?.results?.some((r) => r.vault_slug === 'team-kb' && r.path === NOTE_ALPHA.path), `回退后检索应命中 Alpha：${JSON.stringify(s.json?.results?.slice(0, 2))}`);
    const off = await http('DELETE', '/api/v1/admin/maintenance', { bearer: tokenAdmin });
    assert.equal(off.status, 204, `回退实例退出维护应 204，得到 ${off.status}`);
    ok('回退实例索引重建 + 退出维护（检索命中恢复；回退流程收束）');
  }

  // 32) 回退后可写冒烟（「回退恢复原状」——服务恢复且可写）
  {
    const l = await http('POST', '/api/v1/auth/login', { payload: { username: 'alice', password: PW.alice } });
    assert.equal(l.status, 200);
    const ls = await git(['ls-remote', `http://drill:${tokenAliceRw}@127.0.0.1:${PORT}/git/team-kb.git`, 'refs/heads/main'], seedDir);
    const head = ls.stdout.trim().split(/\s+/)[0];
    const submit = await http('POST', '/api/v1/vaults/team-kb/submissions', {
      cookie: l.sid,
      payload: {
        base_commit: head,
        changes: [{ path: 'notes/post-rollback-web.md', content: noteFile({ title: 'Post Rollback Web AA9', body: '回退后第一次网页提交。' }) }],
        message: 'drill: post-rollback web submit',
      },
    });
    assert.equal(submit.status, 201, `回退后网页提交应 201，得到 ${submit.status}：${submit.text.slice(0, 200)}`);
    const work = path.join(seedDir, 'team-kb-work');
    // 回退把远端拨回备份点：本地工作区仍带着升级窗口提交（远端已无）——
    // 先对齐恢复后的远端（fetch + reset --hard，真实客户端回退后的同样动作），再做新提交
    await git(['fetch', 'origin'], work);
    await git(['reset', '--hard', 'origin/main'], work);
    await writeFile(path.join(work, 'notes/post-rollback-push.md'), noteFile({ title: 'Post Rollback Push AA8', body: '回退后第一次 push。' }));
    await git(['add', '.'], work);
    await git(['-c', 'user.name=Drill Alice', '-c', 'user.email=alice@notegit.invalid', 'commit', '-m', 'drill: post-rollback push'], work);
    const push = await git(['push', 'origin', 'HEAD:refs/heads/main'], work);
    assert.ok(!/\[remote rejected\]|error:|fatal:/.test(push.stderr), `回退后 push 应成功：${scrub(push.stderr).slice(0, 300)}`);
    ok('回退后可写冒烟（一次网页提交 201 + 一次 push FF）——回退演练全链绿');
  }

  await rm(seedDir, { recursive: true, force: true });
  await rm(hostBk, { recursive: true, force: true });

  // 收尾
  if (KEEP) {
    ok(`演练全链绿（${stepNo} 步；§9 升级+回退全链 + D-BR-08 负路径 ×2 + 跨版本 8→9 + 可重入）。回退实例保留运行中：${ROLL}（卷 ${ROLL_VOL}；--keep）`);
  } else {
    await docker('rm', '-f', ROLL);
    await docker('rm', '-f', SRC).catch(() => '');
    for (const v of [ROLL_VOL, BK_VOL, SRC_VOL]) await docker('volume', 'rm', v).catch(() => '');
    ok(`演练全链绿（${stepNo} 步；§9 升级+回退全链 + D-BR-08 负路径 ×2 + 跨版本 8→9 + 可重入）。容器与卷已清理（--keep 可保留检查）`);
  }
  log('S8-T7 升级迁移与回退演练：PASS');
  process.exit(0);
} catch (err) {
  fail(err);
}
