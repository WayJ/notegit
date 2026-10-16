import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { Subject } from '../app.ts';
import { createRequestAuthenticator, rejectAuth, type AuthSuccess, type RequestAuthenticator } from './lifecycle.ts';
import { hashPassword, verifyPassword } from './password.ts';
import { validateNewPassword, verifyDummy, type PasswordPolicy } from './password-policy.ts';
import { createLoginBackoff, type LoginBackoffOptions } from './backoff.ts';
import type { PepperFile } from '../bootstrap/pepper.ts';
import {
  DEFAULT_SESSION_TIMEOUTS,
  createSession,
  deleteSessionByHash,
  deleteSessionsForEmployee,
  sidHash,
  type SessionDefaults,
} from './sessions.ts';
import { sessionClearCookie, sessionSetCookie } from './subject.ts';
import { recordAuditEvent } from '../audit/audit.ts';

/**
 * 认证域路由（api.md §3）：login / logout / me / me/password / PATCH admin employees。
 * 认证经 S2-T5 统一缝（auth/lifecycle.ts）：Bearer/会话双载体、实时查库无缓存
 * （identity §5.1 / D-IC-05）、四状态精确 401 映射——/me 与 /me/password 接受双载体
 * （api.md §3 错误列 001–004），logout 为会话载体操作（删除的是会话行）。
 */

export interface AuthPluginOptions {
  db: DatabaseSync;
  /** K1 pepper 版本化文件（会话与 token 的 HMAC 同源，identity §4；S2-T8 起会话校验
   *  含 retired 键 + rehash-on-use）。新会话/登出删除一律用 active 键（logout 前的
   *  认证已把 retired 命中的行 rehash 到 active）。 */
  pepper: PepperFile;
  /** 统一认证缝（S2-T5）：缺省 = 仅会话载体的 fail-closed 缝（Bearer → E-AUTH-001）；
   *  buildApp 注入双载体实现（含 token 四状态映射） */
  authenticateRequest?: RequestAuthenticator;
  now?: () => Date;
  backoff?: Partial<LoginBackoffOptions>;
  session?: Partial<SessionDefaults>;
  passwordPolicy?: PasswordPolicy;
}

function sendError(reply: FastifyReply, status: number, code: string, message: string, details?: Record<string, unknown>): FastifyReply {
  return reply.code(status).send({ error: { code, message, ...(details ? { details } : {}) } });
}

export const registerAuth: FastifyPluginAsync<AuthPluginOptions> = async (app, opts) => {
  const db = opts.db;
  const pepper = opts.pepper;
  const now = opts.now ?? (() => new Date());
  const backoff = createLoginBackoff(opts.backoff);
  const timeouts: SessionDefaults = { ...DEFAULT_SESSION_TIMEOUTS, ...opts.session };
  // 统一认证缝（S2-T5）：默认仅会话载体（独立注册时）；buildApp 注入双载体实现
  const authenticate: RequestAuthenticator =
    opts.authenticateRequest ??
    createRequestAuthenticator({ db, pepper, now, idleTimeoutMs: timeouts.idleTimeoutMs });

  /** 认证：成功得 AuthSuccess（双载体），失败按四状态映射 401 并直接回复。 */
  async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<AuthSuccess | null> {
    const outcome = await authenticate(req);
    if (outcome.ok) return outcome;
    rejectAuth(reply, outcome); // 会话载体失败同时清 Cookie（被登出呈现，identity §5.2）
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

    // 未初始化（employees 空）→ 503 E-AUTH-007（identity §7.1；完整初始化态门禁在 app.ts）
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
    const { sid } = createSession(db, row.id, pepper.active.key, now(), timeouts);
    reply.header('set-cookie', sessionSetCookie(sid));
    return { username, display_name: row.display_name, is_instance_admin: row.is_instance_admin === 1 };
  });

  app.post('/api/v1/auth/logout', async (req, reply) => {
    // logout 是会话载体操作（删除的是会话行，identity §1：不撤销 token）
    const outcome = await authenticate(req);
    if (!outcome.ok) return rejectAuth(reply, outcome);
    if (outcome.carrier !== 'session' || !outcome.session) {
      return sendError(reply, 401, 'E-AUTH-001', '未认证');
    }
    deleteSessionByHash(db, sidHash(outcome.session.sid, pepper.active.key));
    reply.header('set-cookie', sessionClearCookie());
    return reply.code(204).send();
  });

  app.get('/api/v1/me', async (req, reply) => {
    const auth = await requireAuth(req, reply);
    if (!auth) return reply;
    const subject: Subject = auth.subject;
    const row = db
      .prepare('SELECT display_name, active FROM employees WHERE id = ?')
      .get(subject.employee_id) as { display_name: string; active: number };
    return {
      username: subject.username,
      display_name: row.display_name,
      is_instance_admin: subject.is_instance_admin,
      active: row.active === 1,
    };
  });

  app.post('/api/v1/me/password', async (req, reply) => {
    const auth = await requireAuth(req, reply);
    if (!auth) return reply;
    const subject = auth.subject;
    const body = req.body as { current_password?: unknown; new_password?: unknown } | null;
    if (typeof body?.current_password !== 'string' || typeof body?.new_password !== 'string') {
      return sendError(reply, 400, 'E-RES-004', '请求形态错误：需要 current_password 与 new_password');
    }
    const row = db.prepare('SELECT password_hash FROM employees WHERE id = ?').get(subject.employee_id) as { password_hash: string };
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
    db.prepare('UPDATE employees SET password_hash = ? WHERE id = ?').run(newHash, subject.employee_id);
    deleteSessionsForEmployee(db, subject.employee_id);
    reply.header('set-cookie', sessionClearCookie());
    return reply.code(204).send();
  });

  app.patch('/api/v1/admin/employees/:username', async (req, reply) => {
    const auth = await requireAuth(req, reply);
    if (!auth) return reply;
    const subject = auth.subject;
    if (!subject.is_instance_admin) {
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
    if (body.active) {
      db.prepare('UPDATE employees SET active = 1, deactivated_at = NULL WHERE id = ?').run(target.id);
    } else {
      db.prepare('UPDATE employees SET active = 0, deactivated_at = ? WHERE id = ?').run(now().toISOString(), target.id);
    }
    // 审计（identity §8；storage-model §5）：主体 = 操作管理员 + 载体 + 入口；
    // 按请求最终态记 activate/deactivate（is_instance_admin 变更无注册表 kind，不记）
    recordAuditEvent(db, {
      occurredAt: now().toISOString(),
      actorKind: 'employee',
      subject: { employeeId: subject.employee_id, carrierRef: auth.carrierRef, entry: auth.entry },
      eventKind: body.active ? 'employee.activate' : 'employee.deactivate',
      detail: { username },
    });
    if (typeof body.is_instance_admin === 'boolean') {
      db.prepare('UPDATE employees SET is_instance_admin = ? WHERE id = ?').run(body.is_instance_admin ? 1 : 0, target.id);
    }
    return reply.code(204).send();
  });
};
