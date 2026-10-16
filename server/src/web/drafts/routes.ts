import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { html, type PageAuth } from '../page-kit.ts';
import { myDraftsAcrossVaults } from './query.ts';
import { draftsPage } from './pages.ts';

/**
 * S12-T2 我的草稿页路由（§13 /drafts 行——建议稿 docs/s12/api-amendments.md）：
 * GET /drafts——当前员工跨库本人现行草稿列表。
 *
 * - 门槛=任意认证员工（requirePageUser；未认证 302 /login）；GET 免 CSRF；
 *   无写操作（只读 drafts——写入面属既有编辑页与 §7 端点，本模块零写入）。
 * - 成员过滤在查询函数内（实时 JOIN vault_members——与检索/最近变更同一判定
 *   面，见 web/drafts/query.ts 头注；撤权库草稿行不呈现）。
 *
 * D5 模块自声明：不改 web/routes.ts 既有行（组装点 append 一行注册本模块）。
 */

/** drafts 页所需选项（组装点传入项的结构化子集——模块不反向依赖 web/routes.ts） */
export interface DraftsPageRoutesOptions {
  readonly db: DatabaseSync;
  readonly requirePageUser: (req: FastifyRequest, reply: FastifyReply) => Promise<PageAuth | null>;
}

export function registerDraftsPageRoutes(app: FastifyInstance, opts: DraftsPageRoutesOptions): void {
  app.get('/drafts', async (req, reply) => {
    const who = await opts.requirePageUser(req, reply);
    if (!who) return reply;
    // 展示名由页面守卫附带（S21-T1/A1 集中到 createPageGuard——本路由不再自建查询）
    const rows = myDraftsAcrossVaults(opts.db, who.subject.employee_id);
    return html(
      reply,
      draftsPage({
        viewer: {
          username: who.subject.username,
          displayName: who.display_name,
          isAdmin: who.subject.is_instance_admin,
        },
        rows,
      }),
    );
  });
}
