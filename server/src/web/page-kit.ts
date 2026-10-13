import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthSuccess, RequestAuthenticator } from '../auth/lifecycle.ts';
import { notFoundPage } from './pages.ts';

/**
 * 页面公共件（S4-T1 起，web 域各页面模块共用）：外壳路由、浏览路由与后续任务
 * （T2–T8）的页面模块都经这里取统一行为——HTML 响应、页面认证、404 页。
 * 语义与 S2-T8 routes.ts 内联实现一致（提取不改行为），此后不再每任务重写。
 */

/** HTML 页面响应（统一 charset；模板一律来自 pages.ts / 各模块 pages.ts，插值仅 escapeHtml） */
export function html(reply: FastifyReply, body: string): FastifyReply {
  return reply.type('text/html; charset=utf-8').send(body);
}

/** 页面 404：无权与不存在同页同码（D-IC-06 的页面形态——不泄露库存在性） */
export function sendPageNotFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).type('text/html; charset=utf-8').send(notFoundPage());
}

/**
 * 页面认证守卫（S2-T8 语义提取）：成功返回主体；未认证/四状态失败 302 /login
 * （已回复返回 null）。页面路径不走 rejectAuth，不清 Cookie——Cookie 已不可用，
 * 无安全影响；登录成功重发覆盖。安全判定（authorize/管理员门槛）在各路由叠加。
 */
export function createPageGuard(authenticateRequest: RequestAuthenticator) {
  return async function requirePageUser(req: FastifyRequest, reply: FastifyReply): Promise<AuthSuccess | null> {
    const outcome = await authenticateRequest(req);
    if (outcome.ok) return outcome;
    reply.redirect('/login', 302);
    return null;
  };
}
