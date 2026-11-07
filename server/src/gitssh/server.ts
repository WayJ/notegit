/**
 * Git over SSH 传输面（与 Git Smart HTTP 平行的第二种接入方式）。
 *
 * 设计要点：
 * - 认证 = 公钥白名单（登记册见 keys.ts）：SSH 会话只认已登记且未吊销的公钥；
 *   员工身份即该公钥的登记主体（载体 = 公钥，权限按员工实时角色判定，与 Web
 *   会话载体同口径——不像 token 载体那样带库清单收窄）。
 * - 授权与 HTTP 面同源：authorize() 实时查成员关系（D-IC-05，无缓存）；维护模式
 *   下拒写；库不存在与无权访问同形（不泄露存在性）。
 * - 执行：直接 spawn `git upload-pack` / `git receive-pack`（不经 CGI），
 *   cwd = <dataDir>/git，参数为库目录名（由 vaultRepoDirName 映射，路径只经 DB 稳定 ID）。
 *   推送侧 hook 环境（REMOTE_USER/NOTEGIT_*）与 HTTP 面同构——pre-receive 的
 *   授权复查、计量与审计因此复用同一条链。
 * - 并发：与 HTTP 面共用 git 子进程闸门（git.maxConcurrentChildren）——两条传输
 *   面共用同一容量池，排队而非拒绝。
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import ssh2 from 'ssh2';
import type { Connection, ServerChannel } from 'ssh2';

const { Server, utils: sshUtils } = ssh2;
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { authorize, type MembershipSource, type VaultAction } from '../auth/lifecycle.ts';
import { sweepOrphanedPending } from '../audit/reconciliation.ts';
import { createPushByteCounter, newPushId, pushBytesFile } from '../githttp/receive-audit.ts';
import { ensureReceiveSetup } from '../githttp/hooks.ts';
import { createGitChildGate, effectiveGitLimits, type GitChildGate } from '../limits/git-gate.ts';
import type { MaintenanceGate } from '../maintenance/gate.ts';
import { vaultRepoDirName, vaultRepoPath } from '../vaults/repo-path.ts';
import { stripRepoSuffix } from '../githttp/cgi.ts';
import { fingerprintOf, SshKeyRegistry } from './keys.ts';

declare module 'fastify' {
  interface FastifyInstance {
    /** Git over SSH 传输面的装配上下文（app.ts 装配、main.ts 起服务）——
     *  成员关系源/维护闸门/子进程闸门与 HTTP 面同一实例，两条传输面共用一套容量与授权。 */
    sshContext?: {
      membershipSource: MembershipSource;
      maintenanceGate: MaintenanceGate;
      childProcessGate: GitChildGate;
    };
  }
}

/** 库 slug 字符集（与 api.md §5 一致：slug 只以小写字母/数字/`-` 构成）。 */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** git 客户端的 exec 命令形态：`git-upload-pack '<path>'` / `git-receive-pack '<path>'`。 */
const SSH_COMMAND_RE = /^(git-upload-pack|git-receive-pack) '?([^'\s]+)'?$/;

/** 命令解析（白名单化：非 pack 服务一律拒——不给 shell 留面）。 */
export function parseSshGitCommand(
  command: string,
): { service: 'git-upload-pack' | 'git-receive-pack'; path: string } | null {
  const m = SSH_COMMAND_RE.exec(command.trim());
  if (m === null) return null;
  return { service: m[1] as 'git-upload-pack' | 'git-receive-pack', path: m[2]! };
}

/**
 * 请求路径 → 库 slug：剥掉前导斜杠与 clone 地址惯例后缀（后缀剥离走 cgi.ts 的归一函数）。
 * 路径形态由服务端广告的 clone 地址决定，客户端原样回传。
 */
export function slugFromSshPath(requestPath: string): string | null {
  const cleaned = stripRepoSuffix(requestPath.replace(/^\/+/, ''));
  return SLUG_RE.test(cleaned) ? cleaned : null;
}

export interface GitSshServerOptions {
  readonly dataDir: string;
  readonly db: DatabaseSync;
  /** 库文件路径：透传 NOTEGIT_DB 给 pre-receive hook（缺省则推送 fail-closed）。 */
  readonly dbFile?: string;
  readonly membershipSource: MembershipSource;
  readonly maintenanceGate: MaintenanceGate;
  /** 与 HTTP 面共用的 git 子进程闸门；缺省自建（读同一配置覆盖链）。 */
  readonly childProcessGate?: GitChildGate;
  readonly host?: string;
  readonly port?: number;
}

export interface StartedGitSshServer {
  readonly port: number;
  close(): Promise<void>;
}

/** 宿主密钥：<dataDir>/ssh/host_ed25519_key，缺失时生成（0600，持久卷内）。 */
async function loadOrCreateHostKey(file: string): Promise<Buffer> {
  if (existsSync(file)) return readFile(file);
  await mkdir(path.dirname(file), { recursive: true });
  // OpenSSH 私钥形态（ssh2 解析器原生认；成员自己的 ~/.ssh 也是同形态）。
  const { private: privateKey } = sshUtils.generateKeyPairSync('ed25519');
  const key = Buffer.from(privateKey, 'utf8');
  await writeFile(file, key, { mode: 0o600 });
  await chmod(file, 0o600);
  return key;
}

/** 员工账号状态（停用即拒——与凭据/会话四状态同一语义）。 */
function employeeActive(db: DatabaseSync, employeeId: number): boolean {
  const row = db.prepare('SELECT active FROM employees WHERE id = ?').get(employeeId) as
    | { active: number }
    | undefined;
  return row !== undefined && row.active === 1;
}

export async function startGitSshServer(opts: GitSshServerOptions): Promise<StartedGitSshServer> {
  const projectRoot = path.join(opts.dataDir, 'git');
  const registry = new SshKeyRegistry({ db: opts.db });
  const gate =
    opts.childProcessGate ??
    createGitChildGate(() => effectiveGitLimits({ db: opts.db }).maxConcurrentChildren);
  const hostKey = await loadOrCreateHostKey(path.join(opts.dataDir, 'ssh', 'host_ed25519_key'));

  const server = new Server({ hostKeys: [hostKey] }, (client: Connection) => {
    void handleConnection(client, opts, registry, gate, projectRoot);
  });

  const host = opts.host ?? '0.0.0.0';
  const requestedPort = opts.port ?? 2222;
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once('error', onError);
    server.listen(requestedPort, host, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
  const address = server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : requestedPort;
  return {
    port: boundPort,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function handleConnection(
  client: Connection,
  opts: GitSshServerOptions,
  registry: SshKeyRegistry,
  gate: GitChildGate,
  projectRoot: string,
): Promise<void> {
  let employeeId: number | null = null;
  let keyId = 0;

  client.on('authentication', (ctx) => {
    if (ctx.method !== 'publickey' || ctx.key === undefined) {
      ctx.reject(['publickey']);
      return;
    }
    const offered = ctx.key.data;
    const blob = Buffer.isBuffer(offered) ? offered : Buffer.from(offered);
    const record = registry.resolve(fingerprintOf(blob));
    if (record === null || !employeeActive(opts.db, record.employeeId)) {
      ctx.reject(['publickey'], false);
      return;
    }
    employeeId = record.employeeId;
    keyId = record.id;
    ctx.accept();
  });

  client.on('ready', () => {
    client.on('session', (acceptSession) => {
      const session = acceptSession();
      let gitProtocol: string | undefined;
      session.on('env', (accept, _reject, info) => {
        // 只采信 GIT_PROTOCOL（协议版本协商）；其余 env 请求不落进子进程环境。
        if (info.key === 'GIT_PROTOCOL') {
          gitProtocol = info.val;
        }
        // accept 只在客户端要求回复（wantReply）时才有——无条件调用即崩。
        if (typeof accept === 'function') accept();
      });
      session.on('shell', (_accept: unknown, reject: () => void) => reject());
      session.on('pty-req', (_accept: unknown, reject: () => void) => reject());
      session.on('exec', (accept, _reject, info) => {
          // ssh2 要求在事件回调内同步 accept()——异步 accept 会让通道已被关闭，
        // 客户端只看到「Connection closed by remote host」。授权与 spawn 在接受后异步做，
        // 失败经 stderr + 非零退出码回给客户端（git 呈现为读不到远端）。
        const stream = accept();
        void handleExec(stream, info.command, employeeId, keyId, gitProtocol, opts, gate, projectRoot);
      });
    });
  });

  client.on('error', () => {
    // 客户端异常断开——不重连、不留半写状态（git 侧原子性保证）。
  });
}

async function handleExec(
  stream: ServerChannel,
  command: string,
  employeeId: number | null,
  keyId: number,
  gitProtocol: string | undefined,
  opts: GitSshServerOptions,
  gate: GitChildGate,
  projectRoot: string,
): Promise<void> {
  /** 拒绝路径统一形态：stderr 一行 + 非零退出码（git 侧读作「远端不可用/无权限」）。 */
  const deny = (message: string): void => {
    stream.stderr.write(`${message}\n`);
    stream.exit(1);
    stream.end();
  };
  if (employeeId === null) {
    deny('notegit: 未认证');
    return;
  }
  const parsed = parseSshGitCommand(command);
  if (parsed === null) {
    deny('notegit: 只允许 git-upload-pack / git-receive-pack');
    return;
  }
  const slug = slugFromSshPath(parsed.path);
  if (slug === null) {
    deny('notegit: 库路径非法');
    return;
  }
  const action: VaultAction = parsed.service === 'git-receive-pack' ? 'write' : 'read';
  if (action === 'write' && opts.maintenanceGate.isEnabled()) {
    deny('notegit: 维护中，写入被拒绝');
    return;
  }
  const decision = authorize(opts.membershipSource, employeeId, slug, action);
  if (!decision.allowed) {
    // 无权库与不存在同形（不泄露存在性，D-IC-06）。
    deny('notegit: 资源不存在或无权访问');
    return;
  }
  const hit = opts.membershipSource.lookup(slug, employeeId);
  if (hit === undefined) {
    deny('notegit: 资源不存在或无权访问');
    return;
  }
  const repoPath = vaultRepoPath(opts.dataDir, hit.vaultId);
  const pushId = action === 'write' ? newPushId() : undefined;
  const bytesFile = pushId === undefined ? undefined : pushBytesFile(repoPath, pushId);
  if (pushId !== undefined) {
    await ensureReceiveSetup(repoPath);
  }

  const env: NodeJS.ProcessEnv = { ...process.env };
  // REMOTE_USER 与 HTTP 面同构（<employeeId>:<credentialId>）：pre-receive 据此取
  // 认证主体做执行点复查——SSH 面的「凭据 id」是公钥登记行 id。
  env['REMOTE_USER'] = `${employeeId}:${keyId}`;
  if (opts.dbFile !== undefined) env['NOTEGIT_DB'] = opts.dbFile;
  env['NOTEGIT_VAULT_ID'] = String(hit.vaultId);
  env['NOTEGIT_VAULT_SLUG'] = slug;
  if (pushId !== undefined && bytesFile !== undefined) {
    env['NOTEGIT_PUSH_ID'] = pushId;
    env['NOTEGIT_PUSH_BYTES_FILE'] = bytesFile;
  }
  if (gitProtocol !== undefined) env['GIT_PROTOCOL'] = gitProtocol;

  const slot = await gate.acquire();
  const child = spawn(
    'git',
    [action === 'write' ? 'receive-pack' : 'upload-pack', vaultRepoDirName(hit.vaultId)],
    { cwd: projectRoot, env },
  );
  child.on('error', (err) => {
    slot.release();
    stream.stderr.write(`git ${action === 'write' ? 'receive-pack' : 'upload-pack'} 启动失败：${err.message}\n`);
    stream.exit(1);
    stream.end();
  });
  child.on('close', (code) => {
    slot.release();
    // 必须回 exit-status：git 客户端据此判命令成败——不回即「remote transport reported error」。
    stream.exit(code ?? 0);
    if (!stream.writableEnded) stream.end();
    if (pushId !== undefined) {
      // 中断兜底：推送子进程链已退出但未走到 post-receive 终态核对 → 标待核对。
      try {
        const swept = sweepOrphanedPending(opts.db, { pushId, reason: 'receive-aborted' });
        if (swept > 0) {
          console.error(`[notegit gitssh] vault=${hit.vaultId} push=${pushId} 中断：${swept} 行审计标待核对（unresolved）`);
        }
      } catch (err) {
        console.error(`[notegit gitssh] 中断清扫失败（行留待启动清扫）：${err instanceof Error ? err.message : String(err)}`);
      }
      if (bytesFile !== undefined) void import('node:fs/promises').then((fs) => fs.unlink(bytesFile)).catch(() => {});
    }
  });
  // end:false —— 通道的收尾由我们在子进程退出时统一做（先回 exit-status 再 EOF：
  // pipe 默认的 end() 会先关掉可写侧，随后的 exit() 就被 ssh2 丢弃，git 侧只见到
  // 「remote transport reported error」）。
  child.stdout.pipe(stream, { end: false });
  child.stderr.pipe(stream.stderr);
  if (bytesFile !== undefined) {
    const counter = createPushByteCounter(bytesFile);
    stream.pipe(counter).pipe(child.stdin);
  } else {
    stream.pipe(child.stdin);
  }
  stream.on('close', () => {
    if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
  });
}
