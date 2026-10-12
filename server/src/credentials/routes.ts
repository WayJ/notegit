import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { CredentialsService, ApiError } from './service.ts';
import type { ServiceConfig, AuthTokenContext } from './service.ts';
import type { DatabaseSync } from 'node:sqlite';

/**
 * 访问凭据端点（api.md §4；identity §3.5 自助与代管并存）。
 * 认证载体 = `Authorization: Bearer ngt_…`（api.md §1）；Web 会话载体随 S2-T3 的
 * 共用 auth 插件接入（届时本插件 onRequest 认证钩子并入统一入口）。
 * 错误统一走 api.md §2.1 信封；凭据明文永不进入日志（identity §3.1/§8）。
 */

export type CredentialsPluginOptions = ServiceConfig;

/** 认证结果挂在请求对象上（WeakMap，避免与 S2-T3 全局类型扩充冲突） */
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

export const credentialsPlugin: FastifyPluginAsync<CredentialsPluginOptions> = async (
  instance: FastifyInstance,
  options: CredentialsPluginOptions,
) => {
  const svc = new CredentialsService(options);
  const db: DatabaseSync = options.db;

  // 认证钩子（identity §5.1 第 1 层；仅作用于本插件作用域内路由，/healthz 不受影响）
  instance.addHook('onRequest', async (request) => {
    const header = request.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      throw new ApiError(401, 'E-AUTH-001', '未认证');
    }
    authUsers.set(request, svc.authenticate(header.slice('Bearer '.length)));
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
    const { record, token } = svc.createCredential(user.employeeId, (request.body ?? {}) as Record<string, unknown>);
    request.log.info(
      { event: 'credential.create', employee_id: user.employeeId, credential_id: record.id },
      'credential created',
    );
    reply.code(201).send({ token, ...record });
  });

  instance.delete('/api/v1/credentials/:id', async (request, reply) => {
    const user = requireUser(request);
    const id = parseIdParam((request.params as { id: string }).id);
    svc.revokeCredential(id, user.employeeId, { actorEmployeeId: user.employeeId });
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

  instance.delete('/api/v1/admin/employees/:username/credentials/:id', async (request, reply) => {
    const admin = requireAdmin(request);
    const username = (request.params as { username: string }).username;
    const id = parseIdParam((request.params as { id: string }).id);
    const target = employeeIdByUsername(username);
    svc.revokeCredential(id, target, { actorEmployeeId: admin.employeeId, managedByUsername: username });
    request.log.info(
      { event: 'credential.revoke', employee_id: admin.employeeId, credential_id: id, managed_for: username },
      'credential revoked (managed)',
    );
    reply.code(204).send();
  });
};
