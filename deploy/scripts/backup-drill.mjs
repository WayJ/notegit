#!/usr/bin/env node
/**
 * S8-T4 一致备份演练（D5「演练即测试」：断言化、可复跑、输出可留档）。
 *
 * 覆盖 breakdown §2.7 S8-T4 完成标准（DOD-12 备份侧证据）：
 *   全新容器 → 初始化 + 建库 + 双通道真实数据 → 备份 CLI（§4 步骤 1–7：维护端点
 *   开闸 → 排空 → VACUUM INTO → git 复制+fsck → config/keys 分置两件 → manifest →
 *   关闸 → 健康检查 → 备份完成时间入指标）→ 产物布局/分置/权限断言 →
 *   docker cp 产物出容器 → **宿主离线验证**（§4 步骤 8：不起服务核对 manifest 与
 *   产物完整性）→ 篡改必被检（负路径）→ 备份后写入恢复（维护正确关闭）。
 *
 * 用法（仓库根执行）：
 *   node deploy/scripts/backup-drill.mjs [--port 39088] [--keep] [--no-build]
 * 输出即留档材料（示例：node deploy/scripts/backup-drill.mjs 2>&1 | tee <file>）。
 * 退出码 0 = 全链绿；任何断言失败即 1（保留容器供检查，docker logs 复盘）。
 *
 * 依赖：本机 Docker（colima 或原生）+ 宿主 Node ≥24（离线验证直跑 TS）；
 * 仓库根作为 docker build 上下文。
 * 凭据卫生：bootstrap/重置/ngt_ 令牌只进内存与容器内临时文件（路径挂内存态 tmpfs
 * 效果等同——容器即弃）；打印一律脱敏；git 远端 URL 出错信息先掩码再打印。
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
const CONTAINER = 'notegit-s8t4-drill';
const VOLUME = 'notegit-s8t4-drill-data';
const BK_VOLUME = 'notegit-s8t4-drill-backup';
const IMAGE = 'notegit:s8t4-drill';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const optVal = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const PORT = Number(optVal('--port', '39088'));
const KEEP = flag('--keep');
const NO_BUILD = flag('--no-build');
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = BASE; // Cookie 写请求的同源 Origin（CSRF 校验，auth/csrf.ts）

const REDACT = (s) => (typeof s === 'string' && s.length > 8 ? `${s.slice(0, 6)}…${s.slice(-2)}` : '***');
const scrub = (s) => s.replace(/\/\/[^@/]+@/g, '//***@');

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
  console.error(`\n—— 容器日志（尾部 60 行，容器保留供检查：docker logs ${CONTAINER}）——`);
  try {
    const { stdout } = runSync('docker', ['logs', '--tail', '60', CONTAINER]);
    console.error(stdout);
  } catch {
    console.error('（容器日志不可用）');
  }
  console.error(`\n清理后重跑：docker rm -f ${CONTAINER} && docker volume rm ${VOLUME} ${BK_VOLUME}`);
  process.exit(1);
}
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);

/** docker 子命令（异步） */
async function docker(...argv) {
  const { stdout, stderr } = await run('docker', argv, { maxBuffer: 64 * 1024 * 1024 });
  return stdout ?? stderr;
}
/** docker exec（携带 maxBuffer；返回 stdout） */
async function execIn(...argv) {
  return (await run('docker', ['exec', CONTAINER, ...argv], { maxBuffer: 64 * 1024 * 1024 })).stdout;
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

/** HTTP JSON 助手：返回 {status, text, json, sid}（init-drill 同款） */
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

/** 宿主侧执行备份 CLI（离线验证用——不起服务，直接吃产物目录） */
function hostCli(cliArgs) {
  const r = runSync('node', [HOST_CLI, ...cliArgs], { cwd: REPO_ROOT, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// ─────────────────────────── 演练主链 ───────────────────────────

try {
  log(`S8-T4 一致备份演练开始（port ${PORT}，keep=${KEEP}，no-build=${NO_BUILD}）`);

  // 0) 前置：Docker 与宿主 Node（离线验证运行时）
  const serverVersion = (await docker('version', '--format', '{{.Server.Version}}')).trim();
  const hostNode = process.version;
  assert.match(hostNode, /^v24\./, `宿主 Node 需 ≥24（type-stripping 直跑 TS），实际 ${hostNode}`);
  ok(`前置就绪（Docker server ${serverVersion}；宿主 ${hostNode}）`);

  // 1) 清场（可复跑：上一轮容器/双卷移除——数据卷 + 备份产物卷分置）
  await docker('rm', '-f', CONTAINER).catch(() => '');
  await docker('volume', 'rm', '-f', VOLUME).catch(() => '');
  await docker('volume', 'rm', '-f', BK_VOLUME).catch(() => '');
  ok('清场完成（数据卷与备份产物卷已移除——两卷分置起步）');

  // 2) 构建镜像（deploy/Dockerfile，上下文 = 仓库根）
  if (!NO_BUILD) {
    const t = Date.now();
    await docker('build', '-f', 'deploy/Dockerfile', '-t', IMAGE, REPO_ROOT);
    ok(`镜像构建完成（${((Date.now() - t) / 1000).toFixed(0)}s；备份工具随 server/ 树入镜像）`);
  }

  // 3) 全新容器启动：/data（数据）与 /backup（备份产物）两个独立卷
  await docker(
    'run', '-d', '--name', CONTAINER,
    '-p', `127.0.0.1:${PORT}:3000`,
    '-v', `${VOLUME}:/data`,
    '-v', `${BK_VOLUME}:/backup`,
    IMAGE,
  );
  // 备份产物目录属运维侧：命名卷初建为 root 属主，交付容器用户写权限（部署侧
  // 义务示例——备份输出目录须对应用用户可写，生产等价物为挂载时的属主规划）
  await docker('exec', '-u', 'root', CONTAINER, 'chown', 'notegit:notegit', '/backup');
  ok(`容器已启动（${CONTAINER}；/data 与 /backup 分卷——backup §6 分置的部署侧形态）`);

  // 4) 健康检查
  await waitHealthy(90_000);
  {
    const h = await http('GET', '/healthz');
    assert.equal(h.status, 200, `/healthz 应 200，得到 ${h.status}：${h.text.slice(0, 120)}`);
    assert.equal(h.json?.status, 'ok');
  }
  ok('健康检查通过（备份前实例就绪）');

  // 5) 初始化真实数据：bootstrap 管理员 → 邀请 alice → 建两库（一库播种、一库空置）
  let rootSid;
  {
    const bootstrapToken = (await execIn('cat', '/data/config/admin-bootstrap.token')).trim();
    const r = await http('POST', '/api/v1/auth/bootstrap', {
      payload: {
        bootstrap_token: bootstrapToken,
        username: 'root',
        display_name: 'Backup Drill Root',
        password: 'drill-root-password-123456',
      },
    });
    assert.equal(r.status, 201, `bootstrap 应 201，得到 ${r.status}：${r.text.slice(0, 200)}`);
    const l = await http('POST', '/api/v1/auth/login', {
      payload: { username: 'root', password: 'drill-root-password-123456' },
    });
    assert.equal(l.status, 200);
    rootSid = l.sid;
    ok(`管理员初始化完成（bootstrap 令牌脱敏 ${REDACT(bootstrapToken)}）`);
  }
  let aliceSid;
  {
    const inv = await http('POST', '/api/v1/admin/employees', {
      cookie: rootSid,
      payload: { username: 'alice', display_name: 'Alice Backup Drill' },
    });
    assert.equal(inv.status, 201, `邀请应 201，得到 ${inv.status}`);
    const reset = inv.json?.password_reset_token;
    await http('POST', '/api/v1/auth/password-reset', {
      payload: { reset_token: reset, new_password: 'drill-alice-password-123456' },
    });
    const l = await http('POST', '/api/v1/auth/login', {
      payload: { username: 'alice', password: 'drill-alice-password-123456' },
    });
    assert.equal(l.status, 200);
    aliceSid = l.sid;
    const v1 = await http('POST', '/api/v1/vaults', {
      cookie: aliceSid,
      payload: { name: '备份演练知识库', slug: 'team-kb' },
    });
    assert.equal(v1.status, 201, `建库应 201，得到 ${v1.status}：${v1.text.slice(0, 200)}`);
    const v2 = await http('POST', '/api/v1/vaults', {
      cookie: aliceSid,
      payload: { name: '空库（unborn 形态）', slug: 'empty-vault' },
    });
    assert.equal(v2.status, 201, `建空库应 201，得到 ${v2.status}`);
    ok('真实数据就位：员工 alice + 两库（team-kb 待播种、empty-vault 保持 unborn）');
  }

  // 6) Git 通道播种（2 commit；服务端校验链全过）并记录 pre 态 HEAD
  let preHead;
  let cloneDir;
  let gitToken;
  {
    const cred = await http('POST', '/api/v1/credentials', {
      cookie: aliceSid,
      payload: {
        name: 'backup-drill-git',
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        scope: { access: 'read_write', vaults: ['team-kb'] },
      },
    });
    assert.equal(cred.status, 201, `建凭据应 201，得到 ${cred.status}`);
    gitToken = cred.json?.token;
    assert.match(gitToken, /^ngt_[A-Za-z0-9_-]{43}$/);
    cloneDir = await mkdtemp(path.join(tmpdir(), 'notegit-s8t4-drill-'));
    const GIT_URL = `http://drill:${gitToken}@127.0.0.1:${PORT}/git/team-kb.git`;
    await git(['clone', GIT_URL, 'work'], cloneDir);
    const work = path.join(cloneDir, 'work');
    for (const i of [1, 2]) {
      await writeFile(
        path.join(work, `note-${i}.md`),
        `---\ntitle: Drill Note ${i}\n---\n\n备份演练第 ${i} 条笔记正文。\n`,
      );
      await git(['add', '.'], work);
      await git(['-c', 'user.name=Drill Worker', '-c', 'user.email=drill@notegit.invalid', 'commit', '-m', `drill: note ${i}`], work);
    }
    const push = await git(['push', 'origin', 'HEAD:refs/heads/main'], work);
    assert.ok(!/\[remote rejected\]|error:|fatal:/.test(push.stderr), `push 应成功：${scrub(push.stderr).slice(0, 300)}`);
    const ls = await git(['ls-remote', GIT_URL, 'refs/heads/main'], cloneDir);
    preHead = ls.stdout.trim().split(/\s+/)[0];
    assert.match(preHead, /^[0-9a-f]{40}$/);
    ok(`Git 播种完成（2 commit，pre 态 main=${preHead.slice(0, 10)}…）`);
  }

  // 7) 管理员 API 令牌 → 容器内临时文件（凭据不过 argv、不落宿主）
  let adminToken;
  {
    const cred = await http('POST', '/api/v1/credentials', {
      cookie: rootSid,
      payload: { name: 'backup-drill-admin', expires_at: new Date(Date.now() + 3_600_000).toISOString() },
    });
    assert.equal(cred.status, 201, `管理员凭据应 201，得到 ${cred.status}`);
    adminToken = cred.json?.token;
    const write = runSync(
      'docker',
      ['exec', '-i', CONTAINER, 'sh', '-c', 'cat > /tmp/backup-admin.token && chmod 600 /tmp/backup-admin.token'],
      { input: adminToken, encoding: 'utf8' },
    );
    assert.equal(write.status, 0, `容器内令牌文件写入应成功：${write.stderr?.slice(0, 200)}`);
    const mode = (await execIn('stat', '-c', '%a', '/tmp/backup-admin.token')).trim();
    assert.equal(mode, '600', `容器内令牌文件应 600，得到 ${mode}`);
    ok(`管理员令牌已入容器临时文件（脱敏 ${REDACT(adminToken)}；argv/宿主不留痕）`);
  }

  // 8) 执行备份（§4 步骤 1–7 全链——CLI 断言化每步，任一步失败即非零退出）
  const bkRun = runSync('docker', ['exec', CONTAINER, 'node', CONTAINER_CLI, 'backup', '--data-dir', '/data', '--out', '/backup', '--url', 'http://127.0.0.1:3000', '--token-file', '/tmp/backup-admin.token'], { encoding: 'utf8' });
  assert.equal(bkRun.status, 0, `备份 CLI 应退出 0，实际 ${bkRun.status}：\n${bkRun.stdout}${bkRun.stderr}`);
  console.log((bkRun.stdout ?? '').trim().split('\n').map((l) => `    │ ${l}`).join('\n'));
  ok('备份完成（CLI 退出码 0：开闸→排空→VACUUM INTO→git 复制+fsck→config/keys 分置→manifest→关闸→健康检查→完成审计）');

  // 9) 产物布局/分置/权限断言（容器内直接核对）
  let dataItem;
  let keysItem;
  {
    const listing = (await execIn('ls', '-1', '/backup')).trim().split('\n').filter(Boolean);
    assert.equal(listing.length, 2, `备份根应恰有两件（分置），实际：${listing.join(', ')}`);
    dataItem = listing.find((n) => n.endsWith('-data'));
    keysItem = listing.find((n) => n.endsWith('-keys'));
    assert.ok(dataItem && keysItem, `两件命名形态（*-data / *-keys）：${listing.join(', ')}`);
    const rootMode = (await execIn('stat', '-c', '%a', `/backup/${keysItem}`)).trim();
    assert.equal(rootMode, '700', `密钥件根应 0700，实际 ${rootMode}`);
    const keysDirMode = (await execIn('stat', '-c', '%a', `/backup/${keysItem}/keys`)).trim();
    assert.equal(keysDirMode, '700', `keys 目录应 0700，实际 ${keysDirMode}`);
    const pepperMode = (await execIn('sh', '-c', `stat -c '%a' /backup/${keysItem}/keys/*`)).trim();
    assert.ok(pepperMode.split('\n').every((m) => m === '600'), `密钥件内文件应全部 0600，实际：${pepperMode}`);
    const manifestRaw = (await execIn('cat', `/backup/${dataItem}/manifest.json`)).trim();
    const manifest = JSON.parse(manifestRaw);
    assert.equal(manifest.vault_count, 2);
    assert.equal(manifest.app_version, '0.0.0');
    assert.equal(manifest.db.engine, 'sqlite');
    assert.ok(manifest.time.completed_at >= manifest.time.maintenance_enabled_at, 't0 ≤ 完成时间');
    const seeded = manifest.vaults.find((v) => v.slug === 'team-kb');
    const empty = manifest.vaults.find((v) => v.slug === 'empty-vault');
    assert.equal(seeded?.head_oid, preHead, 'manifest 每库 HEAD OID = 播种库实际 HEAD');
    assert.equal(empty?.head_oid, null, '空库 unborn → head_oid null');
    assert.ok(seeded && manifest.fsck.checked.includes(seeded.id), `fsck 抽样覆盖播种库（checked=${JSON.stringify(manifest.fsck.checked)}）`);
    assert.equal(manifest.items.keys.dir_name, keysItem);
    assert.equal(manifest.items.data.dir_name, dataItem);
    ok(`产物断言全过（${dataItem} + ${keysItem} 分置；keys 0600/0700；manifest 字段与实际一致，host=${manifest.host}）`);
  }

  // 10) 备份完成时间写 T2 预留字段（R14 消费面）+ 维护模式确已关闭
  {
    const m = await http('GET', '/api/v1/admin/metrics', { bearer: adminToken });
    assert.equal(m.status, 200);
    assert.equal(m.json?.backup?.wired, true, '指标面 backup.wired = true（T4 接线）');
    const last = m.json?.backup?.last_completed_at;
    assert.match(last ?? '', /^\d{4}-\d{2}-\d{2}T/, `备份完成时间应为 ISO（实际：${last}）`);
    const maint = await http('GET', '/api/v1/admin/maintenance', { bearer: adminToken });
    assert.equal(maint.json?.enabled, false, '备份完成后维护模式已关闭（经实例端点核实）');
    ok(`指标面接线核实（backup.last_completed_at=${last}；维护模式已关）`);
  }

  // 11) 产物出容器 → 宿主**离线验证**（不起服务；§4 步骤 8）
  const hostBk = await mkdtemp(path.join(tmpdir(), 'notegit-s8t4-offline-'));
  await docker('cp', `${CONTAINER}:/backup/.`, hostBk);
  {
    const v = hostCli(['verify', '--data-item', path.join(hostBk, dataItem)]);
    assert.equal(v.code, 0, `离线验证应全绿退出 0，实际 ${v.code}：\n${v.stdout}${v.stderr}`);
    assert.ok(v.stdout.includes('✓ manifest-present'));
    assert.ok(v.stdout.includes('✓ file-hashes'));
    assert.ok(v.stdout.includes('✓ head-oid'));
    assert.ok(v.stdout.includes('离线验证：全部通过'));
    console.log(v.stdout.trim().split('\n').map((l) => `    │ ${l}`).join('\n'));
    ok(`宿主离线验证全绿（${dataItem}；此时无任何服务参与——verify 只吃产物）`);
  }

  // 12) 负路径：篡改必被检（离线验证不是橡皮图章——对快照库追加字节）
  {
    const target = path.join(hostBk, dataItem, 'db', 'notegit.sqlite');
    const { appendFileSync } = await import('node:fs');
    appendFileSync(target, 'tampered-by-drill');
    const v = hostCli(['verify', '--data-item', path.join(hostBk, dataItem)]);
    assert.notEqual(v.code, 0, '篡改后离线验证必须失败');
    assert.ok(v.stdout.includes('✗ file-hashes'), `失败面应点名 file-hashes：\n${v.stdout}`);
    ok('负路径核实：快照库篡改 → 离线验证失败并点名（file-hashes）');
  }

  // 13) 备份后写入恢复（步骤 7 关闸语义的运行态核实：业务写不再被拒）
  {
    const work = path.join(cloneDir, 'work');
    await writeFile(path.join(work, 'post-backup.md'), '---\ntitle: Post Backup\n---\n\n备份后的新写入。\n');
    await git(['add', '.'], work);
    await git(['-c', 'user.name=Drill Worker', '-c', 'user.email=drill@notegit.invalid', 'commit', '-m', 'drill: after backup'], work);
    const push = await git(['push', 'origin', 'HEAD:refs/heads/main'], work);
    assert.ok(!/\[remote rejected\]|error:|fatal:/.test(push.stderr), `备份后 push 应成功：${scrub(push.stderr).slice(0, 300)}`);
    ok('备份后业务写入恢复（push 成功——维护模式确实已退、排空无残留）');
  }

  await rm(cloneDir, { recursive: true, force: true });
  await rm(hostBk, { recursive: true, force: true });

  // 14) 收尾
  if (KEEP) {
    ok(`演练全链绿（${stepNo + 1} 步）。容器保留运行中：${CONTAINER}（卷 ${VOLUME} / ${BK_VOLUME}）`);
  } else {
    await docker('rm', '-f', CONTAINER);
    await docker('volume', 'rm', VOLUME);
    await docker('volume', 'rm', BK_VOLUME);
    ok(`演练全链绿（${stepNo + 1} 步）。容器与两卷已清理（--keep 可保留实例检查）`);
  }  log('S8-T4 一致备份演练：PASS');
  process.exit(0);
} catch (err) {
  fail(err);
}
