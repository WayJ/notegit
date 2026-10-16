import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { authorize } from '../../auth/lifecycle.ts';
import { createDbMembershipSource } from '../../vaults/membership.ts';
import { VaultService } from '../../vaults/service.ts';
import { html, sendPageNotFound, type PageAuth } from '../page-kit.ts';
import { recentChangesForVault } from './query.ts';
import { vaultActivityPage } from './pages.ts';

/**
 * S11-T2 库内最近变更路由（api.md §13 activity 页行——建议稿
 * docs/s11/api-amendments.md §13）：GET /vaults/{slug}/activity。
 *
 * - 门槛=read 成员（authorize 实时查库；非成员/库不存在 404 同页同体
 *   D-IC-06；未认证 302 /login）；GET 免 CSRF；无写操作（只读审计——
 *   sprint S11 D3 数据源=审计成功发布行，不新增存储）。
 * - 条目同首页「最近变更」区块形态（activityEntryRow 共用件）+detail 携带
 *   路径的 view 链接；排序新→旧、上限 20（web/activity/query.ts）。
 *
 * D5 模块自声明：不改 web/routes.ts 既有行（组装点 append 一行注册本模块）。
 */

/** activity 页所需选项（组装点传入项的结构化子集——模块不反向依赖 web/routes.ts） */
export interface ActivityRoutesOptions {
  readonly db: DatabaseSync;
  readonly requirePageUser: (req: FastifyRequest, reply: FastifyReply) => Promise<PageAuth | null>;
}

export function registerActivityRoutes(app: FastifyInstance, opts: ActivityRoutesOptions): void {
  const vaults = new VaultService({ db: opts.db }); // 只读消费（getVaultRow）
  const membershipSource = createDbMembershipSource(opts.db); // 三入口同源成员判定

  app.get('/vaults/:slug/activity', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const who = await opts.requirePageUser(req, reply);
    if (!who) return reply;
    const decision = authorize(membershipSource, who.subject.employee_id, slug, 'read');
    if (!decision.allowed) return sendPageNotFound(reply); // 无权=不存在（D-IC-06）
    const row = vaults.getVaultRow(slug);
    if (!row) return sendPageNotFound(reply); // fail-closed
    const entries = recentChangesForVault(opts.db, row.id);
    return html(
      reply,
      vaultActivityPage({
        vault: { slug: row.slug, name: row.name },
        viewer: { username: who.subject.username, display_name: who.display_name, is_instance_admin: who.subject.is_instance_admin },
        entries,
      }),
    );
  });
}
