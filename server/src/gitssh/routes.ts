/**
 * SSH 公钥管理端点（实例管理员面；dshent 平台代成员登记的唯一入口）。
 *
 * - 登记/吊销只经此面：员工无自助面（公钥登记即身份绑定，管理面留审计）。
 * - 审计：登记与吊销各记一行（actor=代登记的管理员，detail 记目标员工与指纹）——
 *   公钥材料（wire blob）不进审计，只记指纹。
 * - 错误：形态非法 400 E-RES-004、目标员工不存在 404 E-RES-001、公钥已归属他人
 *   409 E-RES-002。
 */
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { ApiError } from '../credentials/service.ts';
import { authFailureMessage, type AuthSuccess, type RequestAuthenticator } from '../auth/lifecycle.ts';
import { parsePublicKey, SshKeyRegistry } from './keys.ts';

export interface SshKeyPluginOptions {
  readonly db: DatabaseSync;
  readonly authenticateRequest: RequestAuthenticator;
  readonly now?: () => string;
}

export const sshKeyPlugin: FastifyPluginAsync<SshKeyPluginOptions> = async (
  instance: FastifyInstance,
  options: SshKeyPluginOptions,
) => {
  const db = options.db;
  const now = options.now ?? (() => new Date().toISOString());
  const registry = new SshKeyRegistry({ db, now });

  /** 认证 + 管理员判定（失败抛 ApiError；成功返回窄化后的主体）。 */
  const requireAdmin = async (request: FastifyRequest): Promise<AuthSuccess> => {
    const outcome = await options.authenticateRequest(request);
    if (!outcome.ok) {
      throw new ApiError(401, outcome.code, authFailureMessage(outcome.code), { reason: outcome.reason });
    }
    if (!outcome.subject.is_instance_admin) {
      throw new ApiError(403, 'E-AUTHZ-001', '权限不足');
    }
    return outcome;
  };

  instance.addHook('onRequest', async (request) => {
    await requireAdmin(request);
  });

  const employeeIdByUsername = (username: string): number => {
    const row = db.prepare('SELECT id FROM employees WHERE username = ?').get(username) as
      | { id: number }
      | undefined;
    if (!row) throw new ApiError(404, 'E-RES-001', '资源不存在或无权访问');
    return row.id;
  };

  const audit = (
    actorEmployeeId: number,
    eventKind: 'ssh_key.create' | 'ssh_key.revoke',
    detail: Record<string, unknown>,
  ): void => {
    db.prepare(
      `INSERT INTO audit_events (occurred_at, actor_kind, employee_id, credential_ref, entry, event_kind, vault_id, status, detail)
       VALUES (?, 'employee', ?, ?, 'api', ?, NULL, 'succeeded', ?)`,
    ).run(now(), actorEmployeeId, 'ssh_key', eventKind, JSON.stringify(detail));
  };

  instance.get('/api/v1/admin/employees/:username/ssh-keys', async (request) => {
    const target = employeeIdByUsername((request.params as { username: string }).username);
    return { keys: registry.list(target) };
  });

  instance.post('/api/v1/admin/employees/:username/ssh-keys', async (request, reply) => {
    const actor = (await requireAdmin(request)).subject;
    const username = (request.params as { username: string }).username;
    const target = employeeIdByUsername(username);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const publicKey = body['publicKey'];
    const label = body['label'];
    if (typeof publicKey !== 'string' || publicKey.trim() === '') {
      throw new ApiError(400, 'E-RES-004', '请求形态错误：publicKey 必填');
    }
    if (label !== undefined && label !== null && typeof label !== 'string') {
      throw new ApiError(400, 'E-RES-004', '请求形态错误：label 须为字符串');
    }
    const parsed = parsePublicKey(publicKey);
    if (parsed === null) {
      throw new ApiError(400, 'E-RES-004', '请求形态错误：publicKey 不是可解析的 SSH 公钥');
    }
    let record;
    try {
      record = registry.register(target, parsed, typeof label === 'string' ? label : null);
    } catch {
      throw new ApiError(409, 'E-RES-002', '公钥已归属其他员工');
    }
    audit(actor.employee_id, 'ssh_key.create', {
      username,
      key_id: record.id,
      fingerprint: record.fingerprint,
    });
    request.log.info(
      { event: 'ssh_key.create', employee_id: actor.employee_id, key_id: record.id, managed_for: username },
      'ssh key registered (managed)',
    );
    reply.code(201).send(record);
  });

  instance.delete('/api/v1/admin/employees/:username/ssh-keys/:id', async (request, reply) => {
    const actor = (await requireAdmin(request)).subject;
    const username = (request.params as { username: string }).username;
    const rawId = (request.params as { id: string }).id;
    if (!/^\d+$/.test(rawId)) {
      throw new ApiError(400, 'E-RES-004', '请求形态错误：路径参数非法');
    }
    const target = employeeIdByUsername(username);
    const revoked = registry.revoke(target, Number(rawId));
    if (!revoked) {
      throw new ApiError(404, 'E-RES-001', '资源不存在或无权访问');
    }
    audit(actor.employee_id, 'ssh_key.revoke', { username, key_id: Number(rawId) });
    request.log.info(
      { event: 'ssh_key.revoke', employee_id: actor.employee_id, key_id: Number(rawId), managed_for: username },
      'ssh key revoked (managed)',
    );
    reply.code(204).send();
  });
};
