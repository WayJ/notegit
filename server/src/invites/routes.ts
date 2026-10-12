import type { FastifyInstance, FastifyReply } from 'fastify';
import type { WiredAppDeps } from '../app.ts';
import { createInvite, consumePasswordReset, InviteError } from './invite.ts';
import { passwordPolicyError } from './passwordPolicy.ts';
import { TokenError } from '../bootstrap/token.ts';

/**
 * POST /api/v1/admin/employees（邀请创建，api.md §3.1，需实例管理员）
 * POST /api/v1/auth/password-reset（公开消费端点，K5 令牌，api.md §3.2）
 *
 * 认证载体解析（ngt_sid Cookie / Bearer ngt_）随 S2-T3/T5 落地：resolveSubject 是
 * fail-closed 的注入缝（默认恒 null → 401），真实解析替换默认值；CSRF 同源校验
 * 仅适用于 Cookie 认证的写请求，随真实载体一并落地（api.md §1）。
 */

function sendError(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  return reply.code(status).send({ error: { code, message } });
}

export function registerInviteRoutes(app: FastifyInstance, deps: WiredAppDeps): void {
  app.post('/api/v1/admin/employees', async (req, reply) => {
    const subject = await deps.resolveSubject(req);
    if (!subject) return sendError(reply, 401, 'E-AUTH-001', '未认证');
    if (!subject.is_instance_admin) return sendError(reply, 403, 'E-AUTHZ-001', '需要实例管理员身份');
    const b = (req.body ?? {}) as Record<string, unknown>;
    const username = typeof b.username === 'string' ? b.username.trim() : '';
    const displayName = typeof b.display_name === 'string' ? b.display_name.trim() : '';
    if (!username || !displayName || username.length > 64 || displayName.length > 64) {
      return sendError(reply, 400, 'E-RES-004', '缺少或非法必填项：username / display_name（1–64 字符）');
    }
    try {
      const { token } = createInvite(deps.db, deps.pepper, { username, displayName, invitedBy: subject.employee_id }, new Date());
      // 明文令牌仅此一次（identity §7.2：经企业内渠道交付）
      return reply.code(201).send({ username, password_reset_token: token });
    } catch (err) {
      if (err instanceof InviteError) {
        return sendError(reply, 409, 'E-RES-002', '用户名已被占用');
      }
      throw err;
    }
  });

  app.post('/api/v1/auth/password-reset', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const token = typeof b.reset_token === 'string' ? b.reset_token : '';
    if (!token || typeof b.new_password !== 'string') {
      return sendError(reply, 400, 'E-RES-004', '缺少必填项：reset_token / new_password');
    }
    const policyError = passwordPolicyError(b.new_password);
    if (policyError) {
      return sendError(reply, 422, 'E-AUTH-008', policyError);
    }
    const passwordHash = await deps.hashPassword(b.new_password);
    try {
      consumePasswordReset(deps.db, deps.pepper, { token, newPasswordHash: passwordHash }, new Date());
      return reply.code(204).send();
    } catch (err) {
      if (err instanceof TokenError) {
        return sendError(reply, 401, 'E-AUTH-001', '重置令牌无效、过期或已使用');
      }
      throw err;
    }
  });
}
