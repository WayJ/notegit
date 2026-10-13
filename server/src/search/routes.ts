import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { rejectAuth, type RequestAuthenticator } from '../auth/lifecycle.ts';
import type { SearchIndexer } from './indexer.ts';

/**
 * 搜索索引管理端点（S5-T3 最小可观测面；架构 §9「索引延迟可观测」）：
 * GET /api/v1/admin/search-index（实例管理员）——逐库索引状态与延迟指标：
 * - 时间戳：indexed_at / triggered_at / last_error_at；
 * - 延迟指标：lag_ms（发布→已索引）、duration_ms（单次派生耗时）；
 * - 失败告警：consecutive_failures / last_error（D7——失败不阻断发布，只在此可见）；
 * - 实时新鲜度：up_to_date（state.head_commit vs 默认分支当前实际头——stale 即刻可见）。
 * 只读端点：无审计行、无状态改变（GET 免 CSRF）。
 * api.md 尚无此端点定义——D11 模式（实现 + 契约补正建议稿 docs/s1/
 * search-index-amendments.md，master 评审后归位；维护端点 A1 同款先例）。
 */

export interface SearchRoutesOptions {
  readonly authenticateRequest: RequestAuthenticator;
  /** 索引器实例（dataDir 接线形态）；缺省（无 dataDir 的 S2 测试形态）→ 只报 running:false */
  readonly indexer?: SearchIndexer;
}

export function registerSearchRoutes(app: FastifyInstance, opts: SearchRoutesOptions): void {
  app.get('/api/v1/admin/search-index', async (req: FastifyRequest, reply: FastifyReply) => {
    const outcome = await opts.authenticateRequest(req);
    if (!outcome.ok) {
      rejectAuth(reply, outcome);
      return;
    }
    if (!outcome.subject.is_instance_admin) {
      reply.code(403).send({ error: { code: 'E-AUTHZ-001', message: '需要实例管理员身份' } });
      return;
    }
    if (opts.indexer === undefined) {
      // 无 dataDir（测试形态）：索引器未接线——如实报告而非空库清单
      reply.send({ running: false, pollMs: null, vaults: [] });
      return;
    }
    reply.send(await opts.indexer.status());
  });
}
