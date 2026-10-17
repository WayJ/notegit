import { rm } from 'node:fs/promises';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { isUninitialized } from './state.ts';
import { completeBootstrap, TokenError } from './token.ts';
import type { WiredAppDeps } from '../app.ts';
import { passwordPolicyError } from '../invites/passwordPolicy.ts';
import { recordAuditEvent } from '../audit/audit.ts';
import { isValidUsername } from '../identity/username.ts';

/**
 * POST /api/v1/auth/bootstrap（api.md §3，一次性）：
 * 前置初始化态（employees 空），否则 410 E-RES-006；成功 201 {employee_id, username}；
 * token 单次失效、文件由应用删除（identity §7.1-3）。不自动登录。
 * 审计 account.bootstrap（actor_kind=bootstrap；api.md §3）。
 */

function sendError(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  return reply.code(status).send({ error: { code, message } });
}

export function registerBootstrapRoutes(app: FastifyInstance, deps: WiredAppDeps): void {
  app.post('/api/v1/auth/bootstrap', async (req, reply) => {
    if (!isUninitialized(deps.db)) {
      return sendError(reply, 410, 'E-RES-006', '实例已完成初始化，bootstrap 端点永久不可用');
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const token = typeof b.bootstrap_token === 'string' ? b.bootstrap_token : '';
    const username = typeof b.username === 'string' ? b.username.trim() : '';
    const displayName = typeof b.display_name === 'string' ? b.display_name.trim() : '';
    if (!token || !username || !displayName || typeof b.password !== 'string') {
      return sendError(reply, 400, 'E-RES-004', '缺少必填项：bootstrap_token / username / display_name / password');
    }
    if (!isValidUsername(username)) {
      return sendError(reply, 400, 'E-RES-004', 'username 格式非法：小写字母/数字起首的裸名（≤64）或 name@workspace 带域形态');
    }
    const policyError = passwordPolicyError(b.password);
    if (policyError) {
      return sendError(reply, 422, 'E-AUTH-008', policyError);
    }
    // Argon2id 默认实现（src/auth/password.ts，S2-T2 落地）；测试注入桩以省 ~20ms/次哈希
    const passwordHash = await deps.hashPassword(b.password);
    try {
      const { employeeId } = completeBootstrap(deps.db, deps.pepper, { token, username, displayName, passwordHash }, new Date());
      // api.md §3：token 单次失效并由应用删除文件；文件缺失不影响已完成的事务
      await rm(deps.bootstrapTokenFile, { force: true });
      // 审计（identity §8；storage-model §5）：actor_kind=bootstrap ⇒ employee_id NULL
      //（DDL 注释一致性），创建的管理员记于 detail；入口=api（HTTP 初始化，无凭据载体）
      recordAuditEvent(deps.db, {
        occurredAt: new Date().toISOString(),
        actorKind: 'bootstrap',
        entry: 'api',
        eventKind: 'account.bootstrap',
        detail: { username, employee_id: employeeId },
      });
      return reply.code(201).send({ employee_id: employeeId, username });
    } catch (err) {
      if (err instanceof TokenError) {
        return sendError(reply, 401, 'E-AUTH-001', 'bootstrap token 无效、过期或已使用');
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('UNIQUE constraint failed: employees.username')) {
        return sendError(reply, 409, 'E-RES-002', '用户名已被占用');
      }
      throw err;
    }
  });
}
