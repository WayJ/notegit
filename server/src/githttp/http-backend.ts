import path from 'node:path';
import { unlink } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { Writable } from 'node:stream';
import type { ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyPluginAsync } from 'fastify';
import { sweepOrphanedPending } from '../audit/reconciliation.ts';
import { createPushByteCounter, newPushId, pushBytesFile } from './receive-audit.ts';
import { authorize, type MembershipSource, type VaultScope } from '../auth/lifecycle.ts';
import { ApiError, type AuthTokenContext } from '../credentials/service.ts';
import type { MaintenanceGate } from '../maintenance/gate.ts';
import { vaultRepoDirName, vaultRepoPath } from '../vaults/repo-path.ts';
import { buildCgiEnv, buildRemoteUser, parseBasicAuth, parseGitSmartRequest } from './cgi.ts';
import { ensureReceiveSetup } from './hooks.ts';

/**
 * Git Smart HTTP 入口（S3-T2；api.md §8.4；D10 路线 B；架构 §3.2）：
 * Fastify 路由组装 CGI 环境转发 `git http-backend`，双向流式（reply.hijack +
 * content-type 透传，不解析 pack、不缓冲整包；**异步 spawn 强制**——N4 自死锁
 * 教训，同步形态被静态规则拦截）。
 *
 * 检查点序（每请求实时判定，D-IC-05 无缓存）：
 * 1. 端点白名单（parseGitSmartRequest：四个 Smart HTTP 端点之外 404）；
 * 2. 认证：HTTP Basic → ngt_ token（CredentialsService.authenticate，四状态
 *    精确映射 401；identity §3.1：用户名任意，token 是唯一凭据）；
 * 3. 维护模式：write 动作 403 E-MAINT-001（api.md §8.4；backup-recovery §3）；
 * 4. 授权：共用 authorize()（auth/lifecycle.ts × vaults/membership.ts——与
 *    Web/API 同源；refs 发现与 pack 双向同判定）；not_found → 404 不泄露
 *    存在性（D-IC-06），forbidden → 403；
 * 5. receive-pack：ensureReceiveSetup（denyNonFastForwards + 三个 hook 挂接点）；
 * 6. CGI 转发：PATH_INFO 只含 DB 稳定 ID 映射（vaultRepoDirName，无 slug），
 *    REMOTE_USER 透传认证主体（T4/T5/T6 的 hook 消费）。
 */

export interface GitHttpPluginOptions {
  /** 数据目录：<dataDir>/git 即 GIT_PROJECT_ROOT */
  readonly dataDir: string;
  /** 库文件路径：透传 NOTEGIT_DB 给 pre-receive hook（缺省则推送 fail-closed，读路径不受影响） */
  readonly dbFile?: string;
  readonly membershipSource: MembershipSource;
  /** HTTP Basic 口令侧 token 认证（凭据域服务；四状态 ApiError 原样上抛） */
  readonly authenticateToken: (token: string) => AuthTokenContext;
  readonly maintenanceGate: MaintenanceGate;
  /** S3-T6 审计清扫：receive 子进程链退出后，残留 pending 审计行按 pushId 标待核对。
   *  缺省（无 db 注入的单测形态）跳过清扫——行留待启动清扫。 */
  readonly db?: DatabaseSync;
}

/** pack 请求体上限：流式转发不落整包，此为防滥用护栏（资源限制正式值属 S3-T8） */
const GIT_BODY_LIMIT = 2 ** 30;

export const gitHttpPlugin: FastifyPluginAsync<GitHttpPluginOptions> = async (instance, opts) => {
  const projectRoot = path.join(opts.dataDir, 'git');

  // pack 请求体透传：不解析（body 保持 undefined、流不消费，handler 直接 pipe
  // req.raw）；解析器级 bodyLimit 抬高——默认 1MB 会误拒大推送。
  instance.addContentTypeParser(
    'application/x-git-upload-pack-request',
    { bodyLimit: GIT_BODY_LIMIT },
    (_req, _payload, done) => done(null),
  );
  instance.addContentTypeParser(
    'application/x-git-receive-pack-request',
    { bodyLimit: GIT_BODY_LIMIT },
    (_req, _payload, done) => done(null),
  );

  instance.all('/git/*', async (req, reply) => {
    const url = new URL(req.url, 'http://notegit.invalid');
    const target = parseGitSmartRequest(req.method, url.pathname, url.searchParams);
    if (target === null) {
      return reply.code(404).send({ error: { code: 'E-RES-001', message: '资源不存在或无权访问' } });
    }

    // 认证（Basic → token；失败 401 + WWW-Authenticate，四状态精确映射）
    const basic = parseBasicAuth(req.headers.authorization);
    const deny = (err?: ApiError) => {
      reply.header('www-authenticate', 'Basic realm="notegit", charset="UTF-8"');
      const error: Record<string, unknown> = {
        code: err?.code ?? 'E-AUTH-001',
        message: err?.message ?? '未认证',
      };
      if (err?.details !== undefined) error['details'] = err.details;
      return reply.code(401).send({ error });
    };
    if (basic === null) return deny();
    let token: AuthTokenContext;
    try {
      token = opts.authenticateToken(basic.password);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return deny(err);
      throw err;
    }

    // 维护模式：write 动作 403（api.md §8.4「维护模式：receive-pack 403」；
    // 读路径放行——backup-recovery §3 矩阵第 7 行）
    if (target.action === 'write' && opts.maintenanceGate.isEnabled()) {
      return reply.code(403).send({
        error: { code: 'E-MAINT-001', message: '维护中：写入被拒绝', details: { maintenance: true } },
      });
    }

    // 授权：共用 authorize（refs 发现与 pack 双向同判定，架构 §3.2）
    const scope: VaultScope = { access: token.scopeAccess, vaultIds: token.scopeVaultIds };
    const decision = authorize(opts.membershipSource, token.employeeId, target.slug, target.action, scope);
    if (!decision.allowed) {
      if (decision.reason === 'forbidden') {
        return reply.code(403).send({ error: { code: 'E-AUTHZ-001', message: '权限不足' } });
      }
      return reply.code(404).send({ error: { code: 'E-RES-001', message: '资源不存在或无权访问' } });
    }
    const hit = opts.membershipSource.lookup(target.slug, token.employeeId);
    if (hit === undefined) {
      return reply.code(404).send({ error: { code: 'E-RES-001', message: '资源不存在或无权访问' } }); // 不可达，fail-closed
    }

    // receive-pack：首个推送请求前完成仓库服务侧准备（幂等）
    const repoPath = vaultRepoPath(opts.dataDir, hit.vaultId);
    // S3-T6：一次 receive 请求一个 pushId（hook 预记录/终态核对与中断清扫的关联键）
    const pushId = target.service === 'git-receive-pack' ? newPushId() : undefined;
    // E-LIMIT-004 计量：chunked 推送无 CONTENT_LENGTH，经计数透传流累计并落盘（hook 读）
    const bytesFile = pushId === undefined ? undefined : pushBytesFile(repoPath, pushId);
    if (target.service === 'git-receive-pack') {
      await ensureReceiveSetup(repoPath);
    }

    const env = buildCgiEnv({
      method: req.method,
      pathInfo: `/${vaultRepoDirName(hit.vaultId)}${target.suffix}`,
      queryString: url.searchParams.toString(),
      projectRoot,
      remoteUser: buildRemoteUser(token.employeeId, token.credentialId),
      remoteAddr: req.socket.remoteAddress,
      contentType: req.headers['content-type'],
      contentLength: req.headers['content-length'],
      contentEncoding: firstHeader(req.headers['content-encoding']),
      acceptEncoding: firstHeader(req.headers['accept-encoding']),
      gitProtocol: firstHeader(req.headers['git-protocol']),
      extra: {
        NOTEGIT_DB: opts.dbFile,
        NOTEGIT_VAULT_ID: String(hit.vaultId),
        NOTEGIT_VAULT_SLUG: target.slug,
        NOTEGIT_PUSH_ID: pushId,
        NOTEGIT_PUSH_BYTES_FILE: bytesFile,
      },
    });

    // 双向流转发（此后错误只能落 raw 响应——Fastify 错误通道已被 hijack）
    reply.hijack();
    const res = reply.raw;
    const child = spawn('git', ['http-backend'], { env });
    child.on('error', (err) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      if (!res.writableEnded) res.end(`git http-backend 启动失败：${err.message}`);
    });
    child.on('close', () => {
      if (!res.writableEnded) res.end();
      // S3-T6 中断兜底：推送子进程链已退出，本次 push 仍有 pending 审计行 ⇒ 推送
      // 未能走到 post-receive 终态核对（receive-pack 被杀/异常退出）——标待核对
      // （unresolved，S8 恢复对账消费）；pushId 定域，不误伤并发在途推送。
      if (pushId !== undefined) {
        if (opts.db !== undefined) {
          try {
            const swept = sweepOrphanedPending(opts.db, { pushId, reason: 'receive-aborted' });
            if (swept > 0) {
              console.error(`[notegit githttp] vault=${hit.vaultId} push=${pushId} 中断：${swept} 行审计标待核对（unresolved）`);
            }
          } catch (err) {
            console.error(`[notegit githttp] 中断清扫失败（行留待启动清扫）：${err instanceof Error ? err.message : String(err)}`);
          }
        }
        if (bytesFile !== undefined) void unlink(bytesFile).catch(() => {});
      }
    });
    forwardCgiOutput(child, res);
    if (bytesFile !== undefined) {
      const counter = createPushByteCounter(bytesFile);
      req.raw.pipe(counter).pipe(child.stdin); // 计量透传：字节原样转发，终值落盘
    } else {
      req.raw.pipe(child.stdin);
    }
    // 客户端中断：终止子进程链，quarantine 原生保证不落半写状态。
    // 判据用响应侧 'close' + 未完成写入——请求侧 'close' 对无体 GET 在收头后
    // 即触发（destroyed 已置位），不能用作中断信号。
    res.on('close', () => {
      if (!res.writableEnded && child.exitCode === null && !child.killed) child.kill('SIGTERM');
    });
    return reply;
  });
};

/** 重复头取首值（转发面单值语义；git 客户端不会重复发送这些头） */
function firstHeader(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** CGI 头块解析：`Status: NNN` → HTTP 状态码，其余原样透传（content-type 等） */
function parseCgiHeaders(block: string): { status: number; headers: Record<string, string> } {
  let status = 200;
  const headers: Record<string, string> = {};
  for (const line of block.split('\r\n')) {
    const i = line.indexOf(':');
    if (i === -1) continue;
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    if (key.toLowerCase() === 'status') status = Number.parseInt(value, 10) || 200;
    else headers[key] = value;
  }
  return { status, headers };
}

/**
 * http-backend stdout → HTTP 响应：先积累到 CGI 头结束符（\r\n\r\n，仅头部
 * 量级），writeHead 后其余全部直通；写入以 'drain' 回压——对端未排空前不读
 * 下一块（防背压，流式不缓冲整包）。
 */
function forwardCgiOutput(child: ChildProcess, res: ServerResponse): void {
  let headersDone = false;
  let headerBuf: Buffer | null = null;
  const forward = (chunk: Buffer, cb: (err?: Error | null) => void) => {
    if (res.write(chunk)) cb();
    else res.once('drain', () => cb());
  };
  const out = new Writable({
    write(chunk: Buffer, _encoding, cb) {
      if (headersDone) {
        forward(chunk, cb);
        return;
      }
      headerBuf = headerBuf === null ? chunk : Buffer.concat([headerBuf, chunk]);
      const idx = headerBuf.indexOf('\r\n\r\n');
      if (idx === -1) return cb(); // 头未完整，继续积累
      const { status, headers } = parseCgiHeaders(headerBuf.subarray(0, idx).toString('utf8'));
      res.writeHead(status, headers);
      headersDone = true;
      const rest = headerBuf.subarray(idx + 4);
      if (rest.length > 0) forward(rest, cb);
      else cb();
    },
  });
  child.stdout!.pipe(out);
}
