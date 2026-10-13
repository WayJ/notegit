import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { Issue, Report } from 'notegit-validation';
import { rulesVersion, summarize } from 'notegit-validation';
import {
  authorize,
  rejectAuth,
  type AuthSuccess,
  type MembershipSource,
  type RequestAuthenticator,
  type VaultScope,
} from '../auth/lifecycle.ts';
import { createDbMembershipSource } from '../vaults/membership.ts';
import { VaultService } from '../vaults/service.ts';
import { effectiveConfig } from '../limits/engine.ts';
import { DraftsService } from './service.ts';

/**
 * S4-T6 草稿端点（api.md §7；T3 定形的 PUT 形状落地——edit/draft.ts 占位激活）：
 *
 * - GET /api/v1/vaults/{slug}/drafts（成员）：本人现行草稿列表。
 * - PUT /api/v1/vaults/{slug}/drafts/{path}（editor+；写）：upsert 每作者每路径
 *   一份；body={content, base_commit}；200 {updated_at}。
 * - GET /api/v1/vaults/{slug}/drafts/{path}（成员）：本人现行草稿单读；
 *   200 {content, base_commit, updated_at}。
 * - DELETE /api/v1/vaults/{slug}/drafts/{path}（editor+；写）：204。
 * - 授权：认证经 app.ts 统一缝（四状态 401 映射）→ authorize 实时查表
 *   （identity §5.1 第 2 层）——非成员/未知库 404 E-RES-001（D-IC-06），
 *   reader 写 403 E-AUTHZ-001；token scope 取交集（同 vaults 域）。
 *   他人草稿按作者私有不可达（读 = 无自己的现行草稿 = 404 同码）。
 * - 422：路径非法（E-PATH-001）/草稿超长（E-LIMIT-001，maxDocumentBytes）——
 *   body 直接是 T2 validation-report（scope=web-submit，api.md §2.3 非信封）。
 * - 维护 503 E-MAINT-001：app 级 maintenanceGuard 自动覆盖 /api/v1 非安全
 *   方法（写端点无需各自挂接——gate.ts 注记明列「草稿」）。
 * - CSRF：会话载体状态改变请求经 app 级 csrfGuard 同源校验（identity §4）。
 */

export interface DraftsPluginOptions {
  readonly db: DatabaseSync;
  readonly authenticateRequest: RequestAuthenticator;
}

/**
 * 草稿 PUT 传输护栏（同 upload 形态的裁决：防 413 先于热生效 E-LIMIT-001 给出
 * 费解拒绝）：组装时读一次生效 maxDocumentBytes、按 JSON 转义膨胀上界 ×6 只升
 * 不降（floor 8 MiB）；正式判定逐请求走 DraftsService.put（limits 引擎覆盖链
 * 实时读取——admin 改配置立即生效）。
 */
const DRAFT_BODY_GUARD_FLOOR = 8 * 1024 * 1024;

/** 拒绝 issues → T2 报告（§7「422 = T2 报告」；单文件保存——files 即该路径） */
function webSubmitReport(path: string, issues: readonly Issue[]): Report {
  const files = [{ path, status: 'fail' as const, issues: [...issues] }];
  return {
    rulesVersion: rulesVersion(),
    scope: 'web-submit',
    result: 'fail',
    exitCode: 1,
    summary: summarize(files, []),
    files,
  };
}

export const draftsPlugin: FastifyPluginAsync<DraftsPluginOptions> = async (
  instance: FastifyInstance,
  options: DraftsPluginOptions,
) => {
  const source: MembershipSource = createDbMembershipSource(options.db);
  const vaults = new VaultService({ db: options.db }); // 只读消费（getVaultRow）
  const drafts = new DraftsService({ db: options.db });

  // 传输护栏（见 DRAFT_BODY_GUARD_FLOOR 注）：插件作用域内覆盖 application/json
  // 解析器——本域唯一 JSON 端点是草稿 PUT（content 可近 maxDocumentBytes，
  // Fastify 缺省 1 MiB bodyLimit 会先于正式判定给出 413/400）。
  const bodyLimit = Math.max(effectiveConfig({ db: options.db }).maxDocumentBytes * 6, DRAFT_BODY_GUARD_FLOOR);
  instance.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit }, (_req, body, done) => {
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      done(err as Error, undefined); // 非法 JSON → app 级错误处理 400 E-RES-004
    }
  });

  /** 认证（identity §5.1 第 1 层）：失败按四状态映射 401 并回复 */
  async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<AuthSuccess | null> {
    const outcome = await options.authenticateRequest(req);
    if (outcome.ok) return outcome;
    rejectAuth(reply, outcome);
    return null;
  }

  /** token 载体的 scope 收窄（identity §3.4）；会话载体 = 员工全量权限 */
  function scopeOf(outcome: AuthSuccess): VaultScope | undefined {
    if (outcome.carrier === 'token' && outcome.token) {
      return { access: outcome.token.scopeAccess, vaultIds: outcome.token.scopeVaultIds };
    }
    return undefined;
  }

  function send404(reply: FastifyReply): FastifyReply {
    return reply.code(404).send({ error: { code: 'E-RES-001', message: '资源不存在或无权访问' } });
  }

  function send403(reply: FastifyReply): FastifyReply {
    return reply.code(403).send({ error: { code: 'E-AUTHZ-001', message: '权限不足' } });
  }

  /** 库门槛：认证 → authorize（非成员/未知库 404；reader 写 403）→ 库行 fail-closed */
  async function requireVault(
    req: FastifyRequest,
    reply: FastifyReply,
    slug: string,
    action: 'read' | 'write',
  ): Promise<{ auth: AuthSuccess; vaultId: number } | null> {
    const auth = await requireAuth(req, reply);
    if (!auth) return null;
    const decision = authorize(source, auth.subject.employee_id, slug, action, scopeOf(auth));
    if (!decision.allowed) {
      if (decision.reason === 'forbidden') return send403(reply), null; // reader 写（§7 editor+）
      return send404(reply), null; // 非成员/未知库同 404（D-IC-06）
    }
    const row = vaults.getVaultRow(slug);
    if (!row) return send404(reply), null; // fail-closed
    return { auth, vaultId: row.id };
  }

  /** 路径参数 → 库内路径（通配段；前导 / 归一）。非法形状交 service 判 E-PATH-001 */
  function entryPathOf(req: FastifyRequest): string {
    return ((req.params as Record<string, string>)['*'] ?? '').replace(/^\/+/, '');
  }

  /** §7 PUT 请求体形态：{content: string, base_commit: string|null} */
  function parsePutBody(body: unknown): { content: string; baseCommit: string | null } | null {
    if (typeof body !== 'object' || body === null) return null;
    const b = body as Record<string, unknown>;
    if (typeof b['content'] !== 'string') return null;
    if (b['base_commit'] !== null && typeof b['base_commit'] !== 'string') return null;
    return { content: b['content'], baseCommit: b['base_commit'] as string | null };
  }

  // 列表（成员）：本人现行草稿
  instance.get('/api/v1/vaults/:slug/drafts', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const guard = await requireVault(req, reply, slug, 'read');
    if (!guard) return reply;
    return { drafts: drafts.list(guard.vaultId, guard.auth.subject.employee_id) };
  });

  // 保存（editor+；写）：upsert 每作者每路径一份现行草稿
  instance.put('/api/v1/vaults/:slug/drafts/*', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const guard = await requireVault(req, reply, slug, 'write');
    if (!guard) return reply;
    const body = parsePutBody(req.body);
    if (body === null) {
      return reply.code(400).send({ error: { code: 'E-RES-004', message: '请求形态错误（content 必填字符串、base_commit 须字符串或 null）' } });
    }
    const path = entryPathOf(req);
    const result = drafts.put(guard.vaultId, guard.auth.subject.employee_id, path, body.content, body.baseCommit);
    if (result.kind === 'rejected') {
      return reply.code(422).send(webSubmitReport(path, result.issues)); // T2 报告（非信封）
    }
    return { updated_at: result.updatedAt };
  });

  // 单读（成员）：本人现行草稿（他人草稿不可达——无自己的行 = 404）
  instance.get('/api/v1/vaults/:slug/drafts/*', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const guard = await requireVault(req, reply, slug, 'read');
    if (!guard) return reply;
    const draft = drafts.get(guard.vaultId, guard.auth.subject.employee_id, entryPathOf(req));
    if (draft === null) return send404(reply);
    return draft;
  });

  // 删除（editor+；写）：本人现行草稿
  instance.delete('/api/v1/vaults/:slug/drafts/*', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const guard = await requireVault(req, reply, slug, 'write');
    if (!guard) return reply;
    if (!drafts.delete(guard.vaultId, guard.auth.subject.employee_id, entryPathOf(req))) return send404(reply);
    return reply.code(204).send();
  });
};
