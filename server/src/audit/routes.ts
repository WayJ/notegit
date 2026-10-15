import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import {
  authorize,
  rejectAuth,
  type AuthSuccess,
  type MembershipSource,
  type RequestAuthenticator,
  type VaultScope,
} from '../auth/lifecycle.ts';
import { createDbMembershipSource } from '../vaults/membership.ts';
import {
  AUDIT_LIMIT_DEFAULT,
  AUDIT_LIMIT_MAX,
  decodeAuditCursor,
  queryInstanceAudit,
  queryVaultAudit,
  vaultIdBySlug,
  type AuditCursorAnchor,
  type AuditQueryFilters,
} from './query.ts';

/**
 * S19-T1 审计查询两端点（api.md §9 契约在册，严格按契约文本落码）：
 *
 * - **GET /api/v1/vaults/{slug}/audit**（库管理员或实例管理员）：403 E-AUTHZ-001
 *   （成员但非管理员）；404 E-RES-001（非成员，与不存在/scope 外同体——D-IC-06，
 *   不泄露存在性）；401 匿名（统一认证缝）。token 载体 scope 收窄（identity
 *   §3.4，只能收窄——实例管理员的凭据同样收窄）。
 * - **GET /api/v1/admin/audit**（实例管理员）：403 E-AUTHZ-001；含实例级事件
 *   （凭据域/密钥轮换/维护/备份/恢复对账——vault_id NULL 行）；vault 过滤参数
 *   按 slug（未知 slug → 200 空态，不 404——admin 已知全域，如实零行）。
 * - 共同响应 §9 形状 `{events:[…],next_cursor}`（形状在 query.ts，测试锁定）；
 *   limit 默认 50 上限 200（超出 422 E-RES-007，§1 分页语义）；cursor 不透明
 *   （畸形 → 422 E-RES-007）。
 * - 只读零写：GET 免 CSRF、维护模式读放行（app 级闸门 SAFE_METHODS 自动覆盖）、
 *   不记审计行。路由层零 SQL：权限判定经 MembershipSource/authorize、数据访问
 *   经 query.ts（与 api-read 域同一纪律）。
 */

export interface AuditQueryRoutesOptions {
  readonly db: DatabaseSync;
  readonly authenticateRequest: RequestAuthenticator;
  /** 缺省 = 真实表源（vaults/membership.ts）；注入缝供测试替换 */
  readonly membershipSource?: MembershipSource;
}

/** token 载体的 scope 收窄（identity §3.4）；会话载体 = 员工全量权限（undefined） */
function scopeOf(outcome: AuthSuccess): VaultScope | undefined {
  if (outcome.carrier === 'token' && outcome.token) {
    return { access: outcome.token.scopeAccess, vaultIds: outcome.token.scopeVaultIds };
  }
  return undefined;
}

interface PageParams {
  readonly filters: AuditQueryFilters;
  readonly limit: number;
  readonly cursor?: AuditCursorAnchor;
  readonly vault?: string;
}

type ParseResult = { ok: true; params: PageParams } | { ok: false; message: string };

/** limit/cursor/过滤参数解析（§1 分页语义 + §2.3 E-RES-007 校验风格） */
function parsePageParams(query: Record<string, unknown>): ParseResult {
  let limit = AUDIT_LIMIT_DEFAULT;
  const rawLimit = query.limit;
  if (rawLimit !== undefined) {
    if (typeof rawLimit !== 'string' || !/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > AUDIT_LIMIT_MAX) {
      return { ok: false, message: `参数语义不符：limit 须为 1–${AUDIT_LIMIT_MAX} 的整数` };
    }
    limit = Number(rawLimit);
  }
  let cursor: AuditCursorAnchor | undefined;
  const rawCursor = query.cursor;
  if (rawCursor !== undefined) {
    if (typeof rawCursor !== 'string' || rawCursor === '') {
      return { ok: false, message: '参数语义不符：cursor 无效' };
    }
    cursor = decodeAuditCursor(rawCursor);
    if (cursor === undefined) return { ok: false, message: '参数语义不符：cursor 无效' };
  }
  const str = (key: string): string | undefined => {
    const v = query[key];
    return typeof v === 'string' && v !== '' ? v : undefined;
  };
  const vault = str('vault');
  return {
    ok: true,
    params: {
      limit,
      ...(cursor !== undefined ? { cursor } : {}),
      filters: {
        ...(str('actor') !== undefined ? { actor: str('actor')! } : {}),
        ...(str('event_kind') !== undefined ? { eventKind: str('event_kind')! } : {}),
        ...(str('status') !== undefined ? { status: str('status')! } : {}),
        ...(str('since') !== undefined ? { since: str('since')! } : {}),
        ...(str('until') !== undefined ? { until: str('until')! } : {}),
      },
      ...(vault !== undefined ? { vault } : {}),
    },
  };
}

export function registerAuditQueryRoutes(app: FastifyInstance, opts: AuditQueryRoutesOptions): void {
  const source = opts.membershipSource ?? createDbMembershipSource(opts.db);

  function send404(reply: FastifyReply): FastifyReply {
    return reply.code(404).send({ error: { code: 'E-RES-001', message: '资源不存在或无权访问' } });
  }

  function send403(reply: FastifyReply, message: string): FastifyReply {
    return reply.code(403).send({ error: { code: 'E-AUTHZ-001', message } });
  }

  function send422(reply: FastifyReply, message: string): FastifyReply {
    return reply.code(422).send({ error: { code: 'E-RES-007', message } });
  }

  app.get('/api/v1/vaults/:slug/audit', async (req: FastifyRequest, reply: FastifyReply) => {
    const outcome = await opts.authenticateRequest(req);
    if (!outcome.ok) {
      rejectAuth(reply, outcome);
      return reply;
    }
    const { slug } = req.params as { slug: string };
    // 门槛（§9）：库管理员或实例管理员。先 404（非成员/不存在——D-IC-06），
    // 再 403（成员但角色不足）——与 §1 404/403 语义序一致。
    const scope = scopeOf(outcome);
    const isInstanceAdmin = outcome.subject.is_instance_admin;
    const hit = source.lookup(slug, outcome.subject.employee_id);
    if (hit !== undefined) {
      // 成员：authorize 实时判定（含 token scope 收窄；scope 外 404 同体）
      const decision = authorize(source, outcome.subject.employee_id, slug, 'read', scope);
      if (!decision.allowed) return send404(reply);
      if (decision.role !== 'admin' && !isInstanceAdmin) {
        return send403(reply, '需要库管理员或实例管理员身份');
      }
    } else {
      // 非成员：仅实例管理员可读（§9「或」语义）；token scope 仍收窄（凭据只能收窄）
      if (!isInstanceAdmin) return send404(reply);
      if (scope !== undefined && scope.vaultIds.length > 0) {
        const id = vaultIdBySlug(opts.db, slug);
        if (id === undefined || !scope.vaultIds.includes(id)) return send404(reply);
      }
    }
    const parsed = parsePageParams(req.query as Record<string, unknown>);
    if (!parsed.ok) return send422(reply, parsed.message);
    const page = queryVaultAudit(opts.db, slug, parsed.params.filters, parsed.params.limit, parsed.params.cursor);
    return { events: page.events, next_cursor: page.nextCursor };
  });

  app.get('/api/v1/admin/audit', async (req: FastifyRequest, reply: FastifyReply) => {
    const outcome = await opts.authenticateRequest(req);
    if (!outcome.ok) {
      rejectAuth(reply, outcome);
      return reply;
    }
    if (!outcome.subject.is_instance_admin) {
      return send403(reply, '需要实例管理员身份');
    }
    const parsed = parsePageParams(req.query as Record<string, unknown>);
    if (!parsed.ok) return send422(reply, parsed.message);
    const page = queryInstanceAudit(
      opts.db,
      parsed.params.filters,
      parsed.params.limit,
      parsed.params.cursor,
      parsed.params.vault,
    );
    return { events: page.events, next_cursor: page.nextCursor };
  });
}
