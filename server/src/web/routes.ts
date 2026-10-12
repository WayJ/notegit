import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthSuccess, RequestAuthenticator } from '../auth/lifecycle.ts';
import { indexPage, loginPage, adminPage, credentialsPage } from './pages.ts';

/**
 * S2-T8 最小页面路由（GET 外壳；数据由页内 fetch 调 api.md 既有端点）：
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
 */

export interface WebRoutesOptions {
  readonly db: DatabaseSync;
  readonly authenticateRequest: RequestAuthenticator;
}

function html(reply: FastifyReply, body: string): FastifyReply {
  return reply.type('text/html; charset=utf-8').send(body);
}

export function registerWebRoutes(app: FastifyInstance, opts: WebRoutesOptions): void {
  app.get('/login', async (_req, reply) => html(reply, loginPage()));

  /** 页面认证：成功返回主体；未认证 302 /login（已回复返回 null）。四状态失败
   *  （过期/停用等）同样 302 引导到登录页；失效 Cookie 由登录重发覆盖（页面路径
   *  不走 rejectAuth，故不清 Cookie——Cookie 已不可用，无安全影响）。 */
  async function requirePageUser(req: FastifyRequest, reply: FastifyReply): Promise<AuthSuccess | null> {
    const outcome = await opts.authenticateRequest(req);
    if (outcome.ok) return outcome;
    reply.redirect('/login', 302);
    return null;
  }

  app.get('/', async (req, reply) => {
    const outcome = await requirePageUser(req, reply);
    if (!outcome) return reply;
    // 展示名实时查库（展示字段；active 与身份判定已由认证缝保证）
    const row = opts.db
      .prepare('SELECT display_name FROM employees WHERE id = ?')
      .get(outcome.subject.employee_id) as { display_name: string } | undefined;
    return html(
      reply,
      indexPage({
        username: outcome.subject.username,
        display_name: row?.display_name ?? outcome.subject.username,
        is_instance_admin: outcome.subject.is_instance_admin,
      }),
    );
  });

  app.get('/admin', async (req, reply) => {
    const outcome = await requirePageUser(req, reply);
    if (!outcome) return reply;
    if (!outcome.subject.is_instance_admin) {
      return reply
        .code(403)
        .type('text/html; charset=utf-8')
        .send('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><body><h1>403</h1><p>需要实例管理员身份。<a href="/">返回</a></p></body></html>');
    }
    return html(reply, adminPage());
  });

  app.get('/credentials', async (req, reply) => {
    const outcome = await requirePageUser(req, reply);
    if (!outcome) return reply;
    return html(reply, credentialsPage());
  });
}
