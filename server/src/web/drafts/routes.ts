import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { AuthSuccess } from '../../auth/lifecycle.ts';
import { html } from '../page-kit.ts';
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
  readonly requirePageUser: (req: FastifyRequest, reply: FastifyReply) => Promise<AuthSuccess | null>;
}

export function registerDraftsPageRoutes(app: FastifyInstance, opts: DraftsPageRoutesOptions): void {
  app.get('/drafts', async (req, reply) => {
    const who = await opts.requirePageUser(req, reply);
    if (!who) return reply;
    // 展示名实时查库（与 shell GET / 同一形态——展示字段；身份判定已由认证缝保证）
    const row = opts.db
      .prepare('SELECT display_name FROM employees WHERE id = ?')
      .get(who.subject.employee_id) as { display_name: string } | undefined;
    const rows = myDraftsAcrossVaults(opts.db, who.subject.employee_id);
    return html(
      reply,
      draftsPage({
        viewer: {
          username: who.subject.username,
          isAdmin: who.subject.is_instance_admin,
          ...(row !== undefined ? { displayName: row.display_name } : {}),
        },
        rows,
      }),
    );
  });
}
