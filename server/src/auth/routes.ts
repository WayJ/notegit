import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import {
  hashPassword,
  verifyPassword,
} from './password.ts';
import { validateNewPassword, verifyDummy, type PasswordPolicy } from './password-policy.ts';
import { createLoginBackoff, type LoginBackoffOptions } from './backoff.ts';
import {
  DEFAULT_SESSION_TIMEOUTS,
  authenticateSession,
  createSession,
  deleteSessionByHash,
  deleteSessionsForEmployee,
  diagnoseSessionFailure,
  sidHash,
  touchSession,
  type SessionDefaults,
} from './sessions.ts';

/**
 * 认证域路由（api.md §3）：login / logout / me / me/password / PATCH admin employees。
 * 会话认证每请求实时查库（identity §5.1 / D-IC-05，无缓存）。
 * 本插件不接入 buildApp（启动接线 open→pragmas→migrate→listen 属 S2-T2+ 统一启动流程）；
 * 应用组装与 CSRF 全局插件（api.md §1 E-AUTH-006）随后续任务落地。
 */

export interface AuthPluginOptions {
  db: DatabaseSync;
  /** K1 会话 HMAC 键（与 token pepper 同源，identity §4；注入由启动流程统一） */
  pepper: Uint8Array;
  now?: () => Date;
  backoff?: Partial<LoginBackoffOptions>;
  session?: Partial<SessionDefaults>;
  passwordPolicy?: PasswordPolicy;
}

const COOKIE_NAME = 'ngt_sid';

function cookieHeader(sid: string, clear = false): string {
  const base = clear ? `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` : `${COOKIE_NAME}=${sid}; Path=/; HttpOnly; Secure; SameSite=Lax`;
  return base;
}

function sendError(reply: FastifyReply, status: number, code: string, message: string, details?: Record<string, unknown>): FastifyReply {
  return reply.code(status).send({ error: { code, message, ...(details ? { details } : {}) } });
}

function readSidCookie(req: FastifyRequest): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE_NAME) return v.join('=') || null;
  }
  return null;
}

interface AuthedEmployee {
  employeeId: number;
  username: string;
  isInstanceAdmin: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    employee?: AuthedEmployee;
  }
}

export const registerAuth: FastifyPluginAsync<AuthPluginOptions> = async (app, opts) => {
  const db = opts.db;
  const pepper = opts.pepper;
  const now = opts.now ?? (() => new Date());
  const backoff = createLoginBackoff(opts.backoff);
  const timeouts: SessionDefaults = { ...DEFAULT_SESSION_TIMEOUTS, ...opts.session };

  /** 会话认证（identity §5.1 第 1 层）：成功装饰 req.employee，失败直接回复 401。 */
  async function requireSession(req: FastifyRequest, reply: FastifyReply): Promise<AuthedEmployee | null> {
    const sid = readSidCookie(req);
    if (!sid) {
      sendError(reply, 401, 'E-AUTH-001', '未认证');
      return null;
    }
    const hash = sidHash(sid, pepper);
    const auth = authenticateSession(db, hash, now(), timeouts.idleTimeoutMs);
    if (auth) {
      const row = db.prepare('SELECT username FROM employees WHERE id = ?').get(auth.employeeId) as { username: string } | undefined;
      touchSession(db, auth.sessionId, now());
      if (row) {
        return { employeeId: auth.employeeId, username: row.username, isInstanceAdmin: auth.isInstanceAdmin };
      }
    }
    const failure = diagnoseSessionFailure(db, hash, now(), timeouts.idleTimeoutMs);
    if (failure === 'account_disabled') {
      // 停用零延迟（identity §5.2）：下一请求登出——401 E-AUTH-004 + 清 Cookie
      reply.header('set-cookie', cookieHeader('', true));
      sendError(reply, 401, 'E-AUTH-004', '账号已停用', { reason: 'account_disabled' });
      return null;
    }
    reply.header('set-cookie', cookieHeader('', true));
    sendError(reply, 401, 'E-AUTH-001', '未认证');
    return null;
  }

  app.post('/api/v1/auth/login', async (req, reply) => {
    const body = req.body as { username?: unknown; password?: unknown } | null;
    if (
      typeof body?.username !== 'string' || body.username.length === 0 ||
      typeof body?.password !== 'string' || body.password.length === 0
    ) {
      return sendError(reply, 400, 'E-RES-004', '请求形态错误：需要 username 与 password');
    }
    const { username, password } = body;
    const nowMs = now().getTime();
    const ip = req.ip;

    // 未初始化（employees 空）→ 503 E-AUTH-007（identity §7.1；完整初始化态门禁属 S2-T2）
    const employeeCount = (db.prepare('SELECT COUNT(*) AS n FROM employees').get() as { n: number }).n;
    if (employeeCount === 0) {
      return sendError(reply, 503, 'E-AUTH-007', '实例未初始化');
    }

    // 退避闸门（identity §2；api.md E-AUTH-005）：窗口内 429，不校验口令、不计失败
    const gate = backoff.check(username, ip, nowMs);
    if (gate.locked) {
      reply.header('retry-after', String(Math.ceil(gate.retryAfterMs / 1000)));
      return sendError(reply, 429, 'E-AUTH-005', '登录尝试过于频繁，请稍后重试', {
        retry_after_seconds: Math.ceil(gate.retryAfterMs / 1000),
      });
    }

    const row = db
      .prepare('SELECT id, display_name, password_hash, is_instance_admin, active FROM employees WHERE username = ?')
      .get(username) as
      | { id: number; display_name: string; password_hash: string; is_instance_admin: number; active: number }
      | undefined;

    if (!row) {
      await verifyDummy(password); // 等时：用户不存在与口令错误耗时一致
      backoff.recordFailure(username, ip, nowMs);
      return sendError(reply, 401, 'E-AUTH-001', '用户名或口令错误');
    }
    const ok = await verifyPassword(row.password_hash, password);
    if (!ok || row.active !== 1) {
      backoff.recordFailure(username, ip, nowMs);
      return sendError(reply, 401, 'E-AUTH-001', '用户名或口令错误');
    }

    backoff.recordSuccess(username, ip);
    const { sid } = createSession(db, row.id, pepper, now(), timeouts);
    reply.header('set-cookie', cookieHeader(sid));
    return { username, display_name: row.display_name, is_instance_admin: row.is_instance_admin === 1 };
  });

  app.post('/api/v1/auth/logout', async (req, reply) => {
    const employee = await requireSession(req, reply);
    if (!employee) return reply;
    const sid = readSidCookie(req);
    if (sid) deleteSessionByHash(db, sidHash(sid, pepper));
    reply.header('set-cookie', cookieHeader('', true));
    return reply.code(204).send();
  });

  app.get('/api/v1/me', async (req, reply) => {
    const employee = await requireSession(req, reply);
    if (!employee) return reply;
    const row = db
      .prepare('SELECT username, display_name, is_instance_admin, active FROM employees WHERE id = ?')
      .get(employee.employeeId) as { username: string; display_name: string; is_instance_admin: number; active: number };
    return {
      username: row.username,
      display_name: row.display_name,
      is_instance_admin: row.is_instance_admin === 1,
      active: row.active === 1,
    };
  });

  app.post('/api/v1/me/password', async (req, reply) => {
    const employee = await requireSession(req, reply);
    if (!employee) return reply;
    const body = req.body as { current_password?: unknown; new_password?: unknown } | null;
    if (typeof body?.current_password !== 'string' || typeof body?.new_password !== 'string') {
      return sendError(reply, 400, 'E-RES-004', '请求形态错误：需要 current_password 与 new_password');
    }
    const row = db.prepare('SELECT password_hash FROM employees WHERE id = ?').get(employee.employeeId) as { password_hash: string };
    if (!(await verifyPassword(row.password_hash, body.current_password))) {
      return sendError(reply, 401, 'E-AUTH-001', '用户名或口令错误');
    }
    const policy = validateNewPassword(body.new_password, opts.passwordPolicy);
    if (!policy.ok) {
      return sendError(reply, 422, policy.code, policy.message);
    }
    const newHash = await hashPassword(body.new_password);
    // 副作用（identity §2）：该账号全部 Web 会话失效；访问凭据不自动撤销
    //（token 域随 S2-T4 落地，本路径不触碰任何凭据存储——写面断言见 auth-routes.test.ts）。
    db.prepare('UPDATE employees SET password_hash = ? WHERE id = ?').run(newHash, employee.employeeId);
    deleteSessionsForEmployee(db, employee.employeeId);
    reply.header('set-cookie', cookieHeader('', true));
    return reply.code(204).send();
  });

  app.patch('/api/v1/admin/employees/:username', async (req, reply) => {
    const employee = await requireSession(req, reply);
    if (!employee) return reply;
    if (!employee.isInstanceAdmin) {
      return sendError(reply, 403, 'E-AUTHZ-001', '权限不足：需要实例管理员');
    }
    const { username } = req.params as { username: string };
    const target = db.prepare('SELECT id FROM employees WHERE username = ?').get(username) as { id: number } | undefined;
    if (!target) {
      return sendError(reply, 404, 'E-RES-001', '资源不存在');
    }
    const body = req.body as { active?: unknown; is_instance_admin?: unknown } | null;
    if (body === null || typeof body !== 'object' || typeof body.active !== 'boolean') {
      return sendError(reply, 400, 'E-RES-004', '请求形态错误：需要 active: boolean');
    }
    // 审计事件（employee.deactivate / employee.activate）随审计基座（S2-T7）挂接
    if (body.active) {
      db.prepare('UPDATE employees SET active = 1, deactivated_at = NULL WHERE id = ?').run(target.id);
    } else {
      db.prepare('UPDATE employees SET active = 0, deactivated_at = ? WHERE id = ?').run(now().toISOString(), target.id);
    }
    if (typeof body.is_instance_admin === 'boolean') {
      db.prepare('UPDATE employees SET is_instance_admin = ? WHERE id = ?').run(body.is_instance_admin ? 1 : 0, target.id);
    }
    return reply.code(204).send();
  });
};
