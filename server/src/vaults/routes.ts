import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import {
  authorize,
  rejectAuth,
  type AuthSuccess,
  type MembershipSource,
  type RequestAuthenticator,
  type VaultScope,
} from '../auth/lifecycle.ts';
import { ApiError } from '../credentials/service.ts';
import { VaultService } from './service.ts';

/**
 * 库与成员端点（api.md §5）。认证经 app.ts 统一缝（Bearer/会话双载体，四状态
 * 401 映射）；**授权判定一律经共用 authorize()（auth/lifecycle.ts ×
 * vaults/membership.ts 真实表源）**——Web/API 入口由此共用，Git 入口（S3 的
 * Smart HTTP Basic → token scope）消费同一组件（结构断言见 vaults-matrix.test.ts）。
 *
 * 404/403 语义（api.md §1/§2.3）：非成员与库不存在同 404 E-RES-001（D-IC-06）；
 * 成员而角色不足（含普通成员调成员管理接口）→ 403 E-AUTHZ-001。
 */

export interface VaultsPluginOptions {
  readonly service: VaultService;
  readonly authenticateRequest: RequestAuthenticator;
  readonly membershipSource: MembershipSource;
}

/** token 载体的 scope 收窄（identity §3.4）；会话载体 = 员工全量权限（undefined） */
function scopeOf(outcome: AuthSuccess): VaultScope | undefined {
  if (outcome.carrier === 'token' && outcome.token) {
    return { access: outcome.token.scopeAccess, vaultIds: outcome.token.scopeVaultIds };
  }
  return undefined;
}

export const vaultsPlugin: FastifyPluginAsync<VaultsPluginOptions> = async (
  instance: FastifyInstance,
  options: VaultsPluginOptions,
) => {
  const svc = options.service;
  const source = options.membershipSource;

  /** 认证（identity §5.1 第 1 层）：失败按四状态映射 401 并回复 */
  async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<AuthSuccess | null> {
    const outcome = await options.authenticateRequest(req);
    if (outcome.ok) return outcome;
    rejectAuth(reply, outcome);
    return null;
  }

  function send404(reply: FastifyReply): FastifyReply {
    return reply.code(404).send({ error: { code: 'E-RES-001', message: '资源不存在或无权访问' } });
  }

  function send403(reply: FastifyReply): FastifyReply {
    return reply.code(403).send({ error: { code: 'E-AUTHZ-001', message: '权限不足' } });
  }

  /**
   * 库管理员判定（api.md §5 各端点「库管理员」）：先经共用 authorize 以成员关系
   * 区分 404（非成员/不存在，D-IC-06）与已知库，再验角色；写类管理操作以
   * action='write' 走 scope 交集（read-scoped token 不可做管理写）。
   * 返回 null 表示已回复。
   */
  async function requireVaultAdmin(
    req: FastifyRequest,
    reply: FastifyReply,
    slug: string,
    action: 'read' | 'write',
  ): Promise<{ vaultId: number; auth: AuthSuccess } | null> {
    const auth = await requireAuth(req, reply);
    if (!auth) return null;
    const decision = authorize(source, auth.subject.employee_id, slug, action, scopeOf(auth));
    if (!decision.allowed) {
      if (decision.reason === 'forbidden') return send403(reply), null;
      return send404(reply), null;
    }
    if (decision.role !== 'admin') return send403(reply), null;
    const row = svc.getVaultRow(slug);
    if (!row) return send404(reply), null; // authorize 通过即成员在——理论不可达，fail-closed
    return { vaultId: row.id, auth };
  }

  instance.setErrorHandler((err: Error & { statusCode?: number }, _request, reply) => {
    if (err instanceof ApiError) {
      const envelope: Record<string, unknown> = { code: err.code, message: err.message };
      if (err.details !== undefined) envelope['details'] = err.details;
      reply.code(err.status).send({ error: envelope });
      return;
    }
    if (err.statusCode === 400) {
      reply.code(400).send({ error: { code: 'E-RES-004', message: '请求形态错误' } });
      return;
    }
    reply.send(err);
  });

  // 建库：任意 active 员工（认证层逐请求保证 active）；创建者自动 admin（api.md §5）。
  // S3-T1：经 createVaultWithRepo——行事务 + bare 仓库 init（失败补偿回滚，无孤儿配置行）
  instance.post('/api/v1/vaults', async (request, reply) => {
    const auth = await requireAuth(request, reply);
    if (!auth) return reply;
    const vault = await svc.createVaultWithRepo((request.body ?? {}) as Record<string, unknown>, {
      employeeId: auth.subject.employee_id,
      entry: auth.entry,
      carrierRef: auth.carrierRef,
    });
    return reply.code(201).send(vault);
  });

  // 列表：仅当前员工有成员关系的库（未授权库不出现）；token scope 再取交集
  instance.get('/api/v1/vaults', async (request, reply) => {
    const auth = await requireAuth(request, reply);
    if (!auth) return reply;
    const scope = scopeOf(auth);
    return { vaults: svc.listVaults(auth.subject.employee_id, scope?.vaultIds) };
  });

  // 单库：非成员与不存在同 404（D-IC-06）
  instance.get('/api/v1/vaults/:slug', async (request, reply) => {
    const auth = await requireAuth(request, reply);
    if (!auth) return reply;
    const { slug } = request.params as { slug: string };
    const decision = authorize(source, auth.subject.employee_id, slug, 'read', scopeOf(auth));
    if (!decision.allowed) return send404(reply);
    const row = svc.getVaultRow(slug);
    if (!row) return send404(reply); // fail-closed（authorize 通过即成员在）
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      role: decision.role,
      default_branch: row.default_branch,
      main_admin_only: row.main_admin_only === 1,
    };
  });

  // 改库（库管理员）：slug 可改名、内部 id 与仓库路径不变（架构 §7.2）
  instance.patch('/api/v1/vaults/:slug', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const guard = await requireVaultAdmin(request, reply, slug, 'write');
    if (!guard) return reply;
    const updated = svc.updateVault(slug, (request.body ?? {}) as Record<string, unknown>, {
      employeeId: guard.auth.subject.employee_id,
      entry: guard.auth.entry,
      carrierRef: guard.auth.carrierRef,
    });
    return { ...updated, role: 'admin' };
  });

  // 成员列表（库管理员）
  instance.get('/api/v1/vaults/:slug/members', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const guard = await requireVaultAdmin(request, reply, slug, 'read');
    if (!guard) return reply;
    return { members: svc.listMembers(guard.vaultId) };
  });

  // 授权/改角色（库管理员；upsert，PK 防重复授权）
  instance.put('/api/v1/vaults/:slug/members/:username', async (request, reply) => {
    const { slug, username } = request.params as { slug: string; username: string };
    const guard = await requireVaultAdmin(request, reply, slug, 'write');
    if (!guard) return reply;
    const body = (request.body ?? {}) as { role?: unknown };
    return svc.putMember(guard.vaultId, username, body.role, {
      employeeId: guard.auth.subject.employee_id,
      entry: guard.auth.entry,
      carrierRef: guard.auth.carrierRef,
    });
  });

  // 撤权（库管理员）：下一请求生效（identity §5.2 行 4）
  instance.delete('/api/v1/vaults/:slug/members/:username', async (request, reply) => {
    const { slug, username } = request.params as { slug: string; username: string };
    const guard = await requireVaultAdmin(request, reply, slug, 'write');
    if (!guard) return reply;
    svc.deleteMember(guard.vaultId, username, {
      employeeId: guard.auth.subject.employee_id,
      entry: guard.auth.entry,
      carrierRef: guard.auth.carrierRef,
    });
    return reply.code(204).send();
  });
};
