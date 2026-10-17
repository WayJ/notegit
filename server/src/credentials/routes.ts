import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { CredentialsService, ApiError } from './service.ts';
import type { AuthTokenContext } from './service.ts';
import type { DatabaseSync } from 'node:sqlite';
import { authFailureMessage, type RequestAuthenticator } from '../auth/lifecycle.ts';

/**
 * 访问凭据端点（api.md §4；identity §3.5 自助与代管并存）。
 * 认证经 app.ts 的 authenticateRequest 缝（S2-T5 统一）：Bearer（显式头凭据，优先）
 * 或 ngt_sid 会话 Cookie；四状态精确 401 映射（E-AUTH-001..004，identity §5.2）。
 * 会话载体无凭据 scope（收窄仅对 token 有意义）；审计 entry 按载体归因
 * （web/api，identity §8）。错误统一走 api.md §2.1 信封；凭据明文永不进入日志。
 */

export interface CredentialsPluginOptions {
  readonly db: DatabaseSync;
  readonly service: CredentialsService;
  readonly authenticateRequest: RequestAuthenticator;
}

/** 认证结果挂在请求对象上（WeakMap，避免与 S2-T3 全局类型扩充冲突；
 *  键为请求对象——每请求一个新键，天然不跨请求，非缓存（D-IC-05）） */
const authUsers = new WeakMap<FastifyRequest, AuthTokenContext>();

function requireUser(request: FastifyRequest): AuthTokenContext {
  const user = authUsers.get(request);
  if (!user) throw new ApiError(401, 'E-AUTH-001', '未认证');
  return user;
}

function parseIdParam(raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new ApiError(400, 'E-RES-004', '请求形态错误：路径参数非法');
  }
  return Number(raw);
}

/** 认证失败 → 凭据域信封（与 lifecycle.rejectAuth 同一映射/文案，经插件错误处理器呈现） */
function authErrorOf(failure: { code: 'E-AUTH-001' | 'E-AUTH-002' | 'E-AUTH-003' | 'E-AUTH-004'; reason: string }): ApiError {
  return new ApiError(401, failure.code, authFailureMessage(failure.code), { reason: failure.reason });
}

export const credentialsPlugin: FastifyPluginAsync<CredentialsPluginOptions> = async (
  instance: FastifyInstance,
  options: CredentialsPluginOptions,
) => {
  const svc = options.service;
  const db: DatabaseSync = options.db;

  // 认证钩子（identity §5.1 第 1 层；仅作用于本插件作用域内路由，/healthz 与其他域不受影响）
  instance.addHook('onRequest', async (request) => {
    const outcome = await options.authenticateRequest(request);
    if (!outcome.ok) throw authErrorOf(outcome);
    if (outcome.carrier === 'token' && outcome.token) {
      // token 载体：凭据 scope 收窄随授权层取交集（identity §3.4）
      authUsers.set(request, {
        credentialId: outcome.token.credentialId,
        employeeId: outcome.subject.employee_id,
        isInstanceAdmin: outcome.subject.is_instance_admin,
        scopeAccess: outcome.token.scopeAccess,
        scopeVaultIds: [...outcome.token.scopeVaultIds],
        entry: 'api',
      });
      return;
    }
    // 会话载体：无凭据上下文（员工全量权限；audit 载体标识随 T7 对接）
    authUsers.set(request, {
      credentialId: 0,
      employeeId: outcome.subject.employee_id,
      isInstanceAdmin: outcome.subject.is_instance_admin,
      scopeAccess: 'read_write',
      scopeVaultIds: [],
      entry: 'web',
    });
  });

  instance.setErrorHandler((err: Error & { statusCode?: number }, _request, reply) => {
    if (err instanceof ApiError) {
      const envelope: Record<string, unknown> = { code: err.code, message: err.message };
      if (err.details !== undefined) envelope['details'] = err.details;
      reply.code(err.status).send({ error: envelope });
      return;
    }
    // 请求体解析失败（非法 JSON 等）→ E-RES-004（api.md §2.3）
    if (err.statusCode === 400) {
      reply.code(400).send({ error: { code: 'E-RES-004', message: '请求形态错误' } });
      return;
    }
    reply.send(err);
  });

  instance.get('/api/v1/credentials', async (request) => {
    const user = requireUser(request);
    return { credentials: svc.listCredentials(user.employeeId) };
  });

  instance.post('/api/v1/credentials', async (request, reply) => {
    const user = requireUser(request);
    const { record, token } = svc.createCredential(user.employeeId, (request.body ?? {}) as Record<string, unknown>, {
      entry: user.entry,
    });
    request.log.info(
      { event: 'credential.create', employee_id: user.employeeId, credential_id: record.id },
      'credential created',
    );
    reply.code(201).send({ token, ...record });
  });

  instance.delete('/api/v1/credentials/:id', async (request, reply) => {
    const user = requireUser(request);
    const id = parseIdParam((request.params as { id: string }).id);
    svc.revokeCredential(id, user.employeeId, { actorEmployeeId: user.employeeId, entry: user.entry });
    request.log.info(
      { event: 'credential.revoke', employee_id: user.employeeId, credential_id: id },
      'credential revoked',
    );
    reply.code(204).send();
  });

  // —— 管理员代管（identity §3.5；api.md §4：需实例管理员，否则 403 E-AUTHZ-001） ——

  const requireAdmin = (request: FastifyRequest): AuthTokenContext => {
    const user = requireUser(request);
    if (!user.isInstanceAdmin) throw new ApiError(403, 'E-AUTHZ-001', '权限不足');
    return user;
  };

  const employeeIdByUsername = (username: string): number => {
    const row = db.prepare(`SELECT id FROM employees WHERE username = ?`).get(username) as { id: number } | undefined;
    if (!row) throw new ApiError(404, 'E-RES-001', '资源不存在或无权访问');
    return row.id;
  };

  instance.get('/api/v1/admin/employees/:username/credentials', async (request) => {
    requireAdmin(request);
    const target = employeeIdByUsername((request.params as { username: string }).username);
    return { credentials: svc.listCredentials(target) };
  });

  // S37 管理员代签（api.md §4 增补）：凭据归属目标员工，scope 校验同自助（§3.4 只能收窄）；
  // origin=admin_delegated；审计主体=代签管理员（detail 记委托）。
  instance.post('/api/v1/admin/employees/:username/credentials', async (request, reply) => {
    const admin = requireAdmin(request);
    const username = (request.params as { username: string }).username;
    const target = employeeIdByUsername(username);
    const { record, token } = svc.createCredential(target, (request.body ?? {}) as Record<string, unknown>, {
      entry: admin.entry,
      delegatedBy: { employeeId: admin.employeeId, username },
    });
    request.log.info(
      { event: 'credential.create', employee_id: admin.employeeId, credential_id: record.id, delegated_for: username },
      'credential created (delegated)',
    );
    reply.code(201).send({ token, ...record });
  });

  instance.delete('/api/v1/admin/employees/:username/credentials/:id', async (request, reply) => {
    const admin = requireAdmin(request);
    const username = (request.params as { username: string }).username;
    const id = parseIdParam((request.params as { id: string }).id);
    const target = employeeIdByUsername(username);
    svc.revokeCredential(id, target, { actorEmployeeId: admin.employeeId, managedByUsername: username, entry: admin.entry });
    request.log.info(
      { event: 'credential.revoke', employee_id: admin.employeeId, credential_id: id, managed_for: username },
      'credential revoked (managed)',
    );
    reply.code(204).send();
  });
};
