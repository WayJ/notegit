import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { rejectAuth, type RequestAuthenticator } from '../auth/lifecycle.ts';
import type { SearchIndexer } from './indexer.ts';
import { SEARCH_MAX_Q_CHARS, searchKeyword } from './query.ts';

/**
 * 搜索域路由（S5-T3 管理端点 + S5-T4 查询端点）：
 *
 * - GET /api/v1/admin/search-index（实例管理员，S5-T3 最小可观测面；架构 §9
 *   「索引延迟可观测」）：逐库索引状态与延迟指标：
 *   - 时间戳：indexed_at / triggered_at / last_error_at；
 *   - 延迟指标：lag_ms（发布→已索引）、duration_ms（单次派生耗时）；
 *   - 失败告警：consecutive_failures / last_error（D7——失败不阻断发布，只在此可见）；
 *   - 实时新鲜度：up_to_date（state.head_commit vs 默认分支当前实际头——stale 即刻可见）。
 *   只读端点：无审计行、无状态改变（GET 免 CSRF）。
 *
 * - GET /api/v1/search?q=（S5-T4 查询端点，任意认证员工）：按 title/tags/summary
 *   关键词（LIKE 子串，%/_ 字面化）查本人有权库的已发布元数据；**鉴权过滤 =
 *   查询面实时 JOIN vault_members**（identity §5.1 第 2 层同一张表，逐请求查库
 *   无缓存——D7「不在此建权限缓存」；撤权下一查询即消失）+ token scope 交集
 *   （identity §3.4，与 GET /api/v1/vaults 同一收窄面）。结果含 库/路径/commit/
 *   摘要片段与命中字段；确定性排序（vault slug → path）；上限 SEARCH_RESULT_LIMIT
 *   行 + truncated 如实标注。错误：401（§1 通用）；400 E-RES-004（缺/空 q）；
 *   422 E-RES-007（q 超 SEARCH_MAX_Q_CHARS）。只读：无审计行（GET 免 CSRF）。
 *
 * 两个端点 api.md 均未入册——D11 模式（实现 + 契约补正建议稿 docs/s1/
 * search-index-amendments.md C2/C3，master 评审后归位；表行待 D13 一并落）。
 */

export interface SearchRoutesOptions {
  /** 查询端点数据面（search_index 表；鉴权过滤在查询 SQL 内实时 JOIN） */
  readonly db: DatabaseSync;
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

  // S5-T4 元数据查找：任意认证员工；成员关系实时过滤在查询面（query.ts）完成
  app.get('/api/v1/search', async (req: FastifyRequest, reply: FastifyReply) => {
    const outcome = await opts.authenticateRequest(req);
    if (!outcome.ok) {
      rejectAuth(reply, outcome);
      return;
    }
    const raw = (req.query as { q?: unknown }).q;
    if (typeof raw !== 'string' || raw.trim() === '') {
      reply.code(400).send({ error: { code: 'E-RES-004', message: '请求形态错误：q 必填且为非空字符串' } });
      return;
    }
    if (raw.length > SEARCH_MAX_Q_CHARS) {
      reply.code(422).send({ error: { code: 'E-RES-007', message: `参数语义不符：q 长度上界 ${SEARCH_MAX_Q_CHARS} 字符` } });
      return;
    }
    const scope =
      outcome.carrier === 'token' && outcome.token !== undefined && outcome.token.scopeVaultIds.length > 0
        ? outcome.token.scopeVaultIds
        : undefined;
    const { hits, truncated } = searchKeyword(opts.db, outcome.subject.employee_id, raw, scope);
    reply.send({
      q: raw,
      truncated,
      results: hits.map((hit) => ({
        vault_slug: hit.vaultSlug,
        vault_name: hit.vaultName,
        path: hit.path,
        commit_oid: hit.commitOid,
        title: hit.title,
        tags: hit.tags,
        summary: hit.summary,
        matched: hit.matched,
      })),
    });
  });
}
