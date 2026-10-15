import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthSuccess } from '../auth/lifecycle.ts';
import { indexPage, loginPage, adminPage, credentialsPage, layout } from './pages.ts';
import { html } from './page-kit.ts';
import { recentChangesForEmployee } from './activity/query.ts';
import { workbenchSummary, vaultCards, recentDocuments, WORKBENCH_RECENT_DOC_LIMIT } from './workbench/query.ts';

/**
 * S2-T8 最小页面外壳路由（GET；数据由页内 fetch 调 api.md 既有端点）：
 *
 * - GET /login        公开登录页（提交走 POST /api/v1/auth/login）。
 * - GET /             入口页：服务端渲染当前员工；管理入口仅实例管理员可见
 *                     （验收断言「普通成员看不到管理入口」）。
 * - GET /admin        管理页外壳：未认证 302 /login；非实例管理员 403（页面层兜底——
 *                     页面只是展示，全部操作的安全判定仍在 API 端 authorize/管理员门槛）。
 * - GET /credentials  员工自助凭据页外壳（创建/撤销/列表走 api.md §4）。
 *
 * 页面路由均为 GET（免 CSRF——安全方法）；认证经统一缝 authenticateRequest（实时
 * 查库，D-IC-05）。页面在 /api/v1 之外：初始化态闸门与维护写闸门均不作用于页面
 * 本身（页面无写操作；未初始化时登录不可用即自然引导至 bootstrap 流程）。
 *
 * S4-T1 起自 routes.ts 迁入本文件（routes.ts 改为纯组装点——D5 骨架裁决，行为
 * 不变，既有 web-pages/web-e2e 测试为守卫）。UI-RESTYLE：admin/credentials 页
 * 增传 viewer（顶部导航登录态/管理项落位——呈现层，判定不变）；403 兜底页套
 * layout 壳（DESIGN.md 视觉契约）。
 */

export interface ShellRoutesOptions {
  readonly db: DatabaseSync;
  readonly requirePageUser: (req: FastifyRequest, reply: FastifyReply) => Promise<AuthSuccess | null>;
  /** S14-T3：数据目录（工作台文档流的 git 路径派生所需）。缺省（S2 测试形态）
   *  时文档流如实为空态——与 browse 仓库读取空态同形态。 */
  readonly dataDir?: string;
}

export function registerShellRoutes(app: FastifyInstance, opts: ShellRoutesOptions): void {
  app.get('/login', async (_req, reply) => html(reply, loginPage()));

  app.get('/', async (req, reply) => {
    const outcome = await opts.requirePageUser(req, reply);
    if (!outcome) return reply;
    // 展示名实时查库（展示字段；active 与身份判定已由认证缝保证）
    const row = opts.db
      .prepare('SELECT display_name FROM employees WHERE id = ?')
      .get(outcome.subject.employee_id) as { display_name: string } | undefined;
    // S14-T3 工作台接线：三能力全部来自 web/workbench/query.ts（D26 成员过滤与
    // 统计口径已在该层锁定；本接线行不含判定逻辑）。dataDir 缺省（S2 测试形态）
    // 时文档流如实为空态——与 browse 仓库读取空态同形态。
    const docs =
      opts.dataDir === undefined
        ? []
        : await recentDocuments(opts.db, outcome.subject.employee_id, WORKBENCH_RECENT_DOC_LIMIT, {
            dataDir: opts.dataDir,
          });
    // S11-T2 首页「最近变更」区块：跨库最近发布（查询面实时成员过滤——
    // web/activity/query.ts，与检索同一判定面；本接线行不含判定逻辑）
    const recent = recentChangesForEmployee(opts.db, outcome.subject.employee_id);
    return html(
      reply,
      indexPage(
        {
          username: outcome.subject.username,
          display_name: row?.display_name ?? outcome.subject.username,
          is_instance_admin: outcome.subject.is_instance_admin,
        },
        {
          summary: workbenchSummary(opts.db, outcome.subject.employee_id),
          vaults: vaultCards(opts.db, outcome.subject.employee_id),
          docs,
        },
        recent,
      ),
    );
  });

  app.get('/admin', async (req, reply) => {
    const outcome = await opts.requirePageUser(req, reply);
    if (!outcome) return reply;
    if (!outcome.subject.is_instance_admin) {
      return html(
        reply
          .code(403),
        layout(
          '403',
          `<div class="center-card-wrap">
  <div class="center-card">
    <h1>403</h1>
    <p>需要实例管理员身份。</p>
    <p><a href="/">返回</a></p>
  </div>
</div>
`,
        ),
      );
    }
    return html(
      reply,
      adminPage({ username: outcome.subject.username, is_instance_admin: outcome.subject.is_instance_admin }),
    );
  });

  app.get('/credentials', async (req, reply) => {
    const outcome = await opts.requirePageUser(req, reply);
    if (!outcome) return reply;
    return html(
      reply,
      credentialsPage({ username: outcome.subject.username, is_instance_admin: outcome.subject.is_instance_admin }),
    );
  });
}
