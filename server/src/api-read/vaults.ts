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
import { VaultService } from '../vaults/service.ts';

/**
 * S18-T1 机器面读协议——库清单与逐库索引状态（E6 D36/D37；api.md §3 建议稿
 * docs/s18/api-amendments.md「## T1」，draft-first 不动 contracts/）。
 *
 * - **GET /api/v1/vaults**：当前凭据可见库清单。判定面 = `VaultService.listVaults`
 *   实时 JOIN `vault_members`（与检索、工作台 vaultCards 同一张表同一面——无权库
 *   零出现，撤权下一请求即消失，D-IC-05）+ token scope 交集（identity §3.4）。
 *   `doc_count` = `search_index` 行数（与工作台口径同源，数字差值不泄露无权库）。
 *   响应保持迁移前契约形状 `{vaults:[{slug,name,role,default_branch,main_admin_only}]}`
 *   并**增量**追加 `doc_count`：CLI（cli/src/ls/api.ts 形态校验）与 Web 页面消费
 *   既有字段，裸数组形态会破坏既有消费方——偏差与依据见建议稿 T1 节。
 * - **GET /api/v1/vaults/{slug}/index-status**：search_index_state 该库行
 *   （head_commit/indexed_at/lag_ms/consecutive_failures/last_error——变更感知
 *   面，agent 轮询判据）。门槛 = read 成员（共用 authorize，identity §5.1 第 2
 *   层）；无权/不存在 404 同体零区分（D-IC-06 API 面）。无状态行 = 首次未索引
 *   语义：除 slug 外字段如实全 null（不用 0 伪造「已索引无失败」）。
 *
 * 认证经 app.ts 统一缝（Bearer/会话双载体，四状态 401 JSON 信封——API 形态，
 * 非页面 302）。两个端点只读：GET 免 CSRF、不记审计行、维护模式放行（读路径族）。
 * 路由层零 SQL：权限判定经 authorize×MembershipSource、数据访问经 VaultService
 * （vaults-matrix 结构断言同一纪律在 api-read 域的延续）。D1 文件所有权：本模块
 * 持清单 + index-status 两路由（T2 持 api-read/{tree,docs}.ts）；清单路由自
 * vaults/routes.ts 迁入（该文件其余端点不动）。
 */

export interface ApiReadVaultsOptions {
  readonly db: DatabaseSync;
  readonly authenticateRequest: RequestAuthenticator;
  /** 缺省 = 真实表源（vaults/membership.ts）；注入缝供测试替换 */
  readonly membershipSource?: MembershipSource;
  /** 缺省 = 仅读形态 VaultService（无 repoOps——两端点零写路径） */
  readonly vaultService?: VaultService;
}

/** token 载体的 scope 收窄（identity §3.4）；会话载体 = 员工全量权限（undefined） */
function scopeOf(outcome: AuthSuccess): VaultScope | undefined {
  if (outcome.carrier === 'token' && outcome.token) {
    return { access: outcome.token.scopeAccess, vaultIds: outcome.token.scopeVaultIds };
  }
  return undefined;
}

export function registerApiReadVaultRoutes(app: FastifyInstance, opts: ApiReadVaultsOptions): void {
  const source = opts.membershipSource ?? createDbMembershipSource(opts.db);
  const svc = opts.vaultService ?? new VaultService({ db: opts.db });

  function send404(reply: FastifyReply): FastifyReply {
    return reply.code(404).send({ error: { code: 'E-RES-001', message: '资源不存在或无权访问' } });
  }

  // 库清单（api.md §5 同路径；S18-T1 增 doc_count——机器面变更感知的行数口径）
  app.get('/api/v1/vaults', async (req: FastifyRequest, reply: FastifyReply) => {
    const outcome = await opts.authenticateRequest(req);
    if (!outcome.ok) {
      rejectAuth(reply, outcome);
      return reply;
    }
    const scope = scopeOf(outcome);
    return { vaults: svc.listVaults(outcome.subject.employee_id, scope?.vaultIds) };
  });

  // 逐库索引状态（变更感知面；门槛 = read 成员）
  app.get('/api/v1/vaults/:slug/index-status', async (req: FastifyRequest, reply: FastifyReply) => {
    const outcome = await opts.authenticateRequest(req);
    if (!outcome.ok) {
      rejectAuth(reply, outcome);
      return reply;
    }
    const { slug } = req.params as { slug: string };
    const decision = authorize(source, outcome.subject.employee_id, slug, 'read', scopeOf(outcome));
    if (!decision.allowed) return send404(reply);
    const vault = svc.getVaultRow(slug);
    if (vault === undefined) return send404(reply); // fail-closed（authorize 通过即库在）
    const state = svc.getIndexState(vault.id);
    return {
      slug,
      head_commit: state?.head_commit ?? null,
      indexed_at: state?.indexed_at ?? null,
      lag_ms: state?.lag_ms ?? null,
      consecutive_failures: state?.consecutive_failures ?? null,
      last_error: state?.last_error ?? null,
    };
  });
}
