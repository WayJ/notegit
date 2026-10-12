import type { FastifyInstance, FastifyReply } from 'fastify';
import type { WiredAppDeps } from '../app.ts';
import { rejectAuth } from '../auth/lifecycle.ts';
import { createInvite, consumePasswordReset, InviteError } from './invite.ts';
import { passwordPolicyError } from './passwordPolicy.ts';
import { TokenError } from '../bootstrap/token.ts';
import { recordAuditEvent } from '../audit/audit.ts';

/**
 * POST /api/v1/admin/employees（邀请创建，api.md §3.1，需实例管理员）
 * POST /api/v1/auth/password-reset（公开消费端点，K5 令牌，api.md §3.2）
 *
 * 认证经 app.ts 的 authenticateRequest 缝（S2-T5 统一：Bearer/会话双载体，
 * 四状态精确 401 映射——停用账号 E-AUTH-004，替换 T2 期丢失原因的 SubjectResolver）。
 * Cookie 认证的写请求另受全局 CSRF 同源校验（auth/csrf.ts，S2-T5 收尾 c）。
 */

function sendError(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  return reply.code(status).send({ error: { code, message } });
}

export function registerInviteRoutes(app: FastifyInstance, deps: WiredAppDeps): void {
  app.post('/api/v1/admin/employees', async (req, reply) => {
    const outcome = await deps.authenticateRequest(req);
    if (!outcome.ok) return rejectAuth(reply, outcome);
    if (!outcome.subject.is_instance_admin) return sendError(reply, 403, 'E-AUTHZ-001', '需要实例管理员身份');
    const b = (req.body ?? {}) as Record<string, unknown>;
    const username = typeof b.username === 'string' ? b.username.trim() : '';
    const displayName = typeof b.display_name === 'string' ? b.display_name.trim() : '';
    if (!username || !displayName || username.length > 64 || displayName.length > 64) {
      return sendError(reply, 400, 'E-RES-004', '缺少或非法必填项：username / display_name（1–64 字符）');
    }
    try {
      const { token } = createInvite(deps.db, deps.pepper, { username, displayName, invitedBy: outcome.subject.employee_id }, new Date());
      // 审计（identity §8；storage-model §5）：主体 = 邀请管理员（认证员工）+ 载体 +
      // 入口；K5 令牌明文不入审计（脱敏守卫 fail-closed）
      recordAuditEvent(deps.db, {
        occurredAt: new Date().toISOString(),
        actorKind: 'employee',
        subject: {
          employeeId: outcome.subject.employee_id,
          carrierRef: outcome.carrierRef,
          entry: outcome.entry,
        },
        eventKind: 'employee.create',
        detail: { username },
      });
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
      const employeeId = consumePasswordReset(deps.db, deps.pepper, { token, newPasswordHash: passwordHash }, new Date());
      // 审计（identity §8；storage-model §5）：K5 一次性令牌不属凭据载体——
      // 主体 = 口令被重置的目标员工，credential_ref NULL，entry=api
      recordAuditEvent(deps.db, {
        occurredAt: new Date().toISOString(),
        actorKind: 'employee',
        employeeId,
        entry: 'api',
        eventKind: 'employee.password_reset',
        detail: { via: 'password_reset_token' },
      });
      return reply.code(204).send();
    } catch (err) {
      if (err instanceof TokenError) {
        return sendError(reply, 401, 'E-AUTH-001', '重置令牌无效、过期或已使用');
      }
      throw err;
    }
  });
}
