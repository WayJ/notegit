import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { AuthSuccess } from '../../auth/lifecycle.ts';
import { SEARCH_MAX_Q_CHARS, searchKeyword } from '../../search/query.ts';
import { html } from '../page-kit.ts';
import { searchPage } from './pages.ts';

/**
 * S5-T4 搜索页路由（api.md §13 表行待 D13——建议稿 docs/s1/
 * search-index-amendments.md C3；D6 页面走 S4 web 骨架 append）：
 *
 * GET /search?q=<关键词>——按 title/tags/摘要关键词查找本人有权库的已发布
 * 元数据。页面门槛=任意认证员工（未认证 302 /login）；**鉴权过滤在查询面**
 * （search/query.ts 实时 JOIN vault_members——与 API 端点/授权层同一无缓存
 * 判定面，D7；撤权下一渲染即消失）。会话载体无 scope（员工全量权限，
 * identity §3.4）。GET 免 CSRF；无写操作；空 q 表单空态、超长 q 422 同页
 * 提示（与 API 端点同一上界常量）。
 *
 * D5 模块自声明：不改 web/routes.ts 既有行（组装点 append 一行注册本模块）。
 */

/** 搜索页所需选项（组装点传入项的结构化子集——模块不反向依赖 web/routes.ts） */
export interface SearchRoutesOptions {
  readonly db: DatabaseSync;
  readonly requirePageUser: (req: FastifyRequest, reply: FastifyReply) => Promise<AuthSuccess | null>;
}

export function registerSearchPageRoutes(app: FastifyInstance, opts: SearchRoutesOptions): void {
  app.get('/search', async (req, reply) => {
    const who = await opts.requirePageUser(req, reply);
    if (!who) return reply;
    const raw = (req.query as { q?: unknown }).q;
    // 空/缺 q：表单空态（200）——页面形态宽进（与 API 400 语义分工）
    if (typeof raw !== 'string' || raw.trim() === '') {
      return html(reply, searchPage({ viewer: {
          username: who.subject.username,
          is_instance_admin: who.subject.is_instance_admin,
        }, q: null }));
    }
    if (raw.length > SEARCH_MAX_Q_CHARS) {
      return reply
        .code(422)
        .type('text/html; charset=utf-8')
        .send(
          searchPage({
            viewer: {
          username: who.subject.username,
          is_instance_admin: who.subject.is_instance_admin,
        },
            q: raw,
            notice: `关键词过长（上界 ${SEARCH_MAX_Q_CHARS} 字符）——请收窄后重查。`,
          }),
        );
    }
    const result = searchKeyword(opts.db, who.subject.employee_id, raw);
    return html(
      reply,
      searchPage({ viewer: {
          username: who.subject.username,
          is_instance_admin: who.subject.is_instance_admin,
        }, q: raw, result }),
    );
  });
}
