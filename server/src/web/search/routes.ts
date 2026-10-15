import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { AuthSuccess } from '../../auth/lifecycle.ts';
import { SEARCH_MAX_Q_CHARS, searchKeyword, type SearchResult } from '../../search/query.ts';
import { VaultService } from '../../vaults/service.ts';
import { html } from '../page-kit.ts';
import { searchPage } from './pages.ts';

/**
 * S5-T4 搜索页路由（api.md §13 表行待 D13——建议稿 docs/s1/
 * search-index-amendments.md C3；D6 页面走 S4 web 骨架 append）：
 *
 * GET /search?q=<关键词>&vault=<slug|all>——按 title/tags/摘要/path/body
 * 关键词查找本人有权库的已发布元数据。页面门槛=任意认证员工（未认证 302
 * /login）；**鉴权过滤在查询面**（search/query.ts 实时 JOIN vault_members——
 * 与 API 端点/授权层同一无缓存判定面，D7；撤权下一渲染即消失）。会话载体
 * 无 scope（员工全量权限，identity §3.4）。GET 免 CSRF；无写操作；空 q
 * 表单空态、超长 q 422 同页提示（与 API 端点同一上界常量）。
 *
 * S15-T1 库筛选（W04/DOD-E4-05；S15 D3）：`vault` GET 表单参数，默认 all。
 * 下拉选项=全部+当前员工有权库（listVaults——与 /vaults 列表同一实时 JOIN
 * vault_members 判定面，D26 侧信道延伸：无权库绝不出现为选项）。vault=<slug>
 * 收窄参数在**调用侧装配**（searchKeyword scopeVaultIds——不动 query.ts 鉴权
 * 语义），该库成员资格同面实时判定；直传 vault=<无权或不存在 slug> 按
 * D-IC-06「无权=不存在」处理——与未知库同形态：命中集空+如实提示，不区分
 * 两种语义、零泄露（slug 不回显），不报「你无权」。
 *
 * ⌘K/Ctrl-K 聚焦搜索框（S15 D1：仅 /search 页内）：页内增强脚本进本页唯一
 * 内联 script 块（searchPage → layout 单块）；无 JS 时 GET 表单仍可提交
 * （渐进增强）。
 *
 * D5 模块自声明：不改 web/routes.ts 既有行（组装点 append 一行注册本模块）。
 */

/** 搜索页所需选项（组装点传入项的结构化子集——模块不反向依赖 web/routes.ts） */
export interface SearchRoutesOptions {
  readonly db: DatabaseSync;
  readonly requirePageUser: (req: FastifyRequest, reply: FastifyReply) => Promise<AuthSuccess | null>;
}

export function registerSearchPageRoutes(app: FastifyInstance, opts: SearchRoutesOptions): void {
  const vaults = new VaultService({ db: opts.db }); // 只读消费（listVaults——下拉选项与 /vaults 列表同判定面）

  // 库筛选收窄的成员判定（S15-T1）：与检索查询面同一实时 JOIN vault_members、
  // 无缓存——撤权下一渲染即消失；非成员或库不存在一律返回 null（同形态）
  const memberVaultId = (employeeId: number, slug: string): number | null => {
    const row = opts.db
      .prepare(
        `SELECT v.id FROM vaults v
         JOIN vault_members m ON m.vault_id = v.id AND m.employee_id = ?
         WHERE v.slug = ?`,
      )
      .get(employeeId, slug) as { id: number } | undefined;
    return row?.id ?? null;
  };

  app.get('/search', async (req, reply) => {
    const who = await opts.requirePageUser(req, reply);
    if (!who) return reply;
    const query = req.query as { q?: unknown; vault?: unknown };
    // vault 参数（S15-T1）：缺省/空值=all；其余 slug 原样进入成员判定
    const vaultParam = typeof query.vault === 'string' && query.vault !== '' ? query.vault : 'all';
    const vaultOptions = vaults
      .listVaults(who.subject.employee_id) // 实时查库（仅本人成员关系的库——无权库不入选项）
      .map((v) => ({ slug: v.slug, name: v.name }));

    const raw = query.q;
    // 空/缺 q：表单空态（200）——页面形态宽进（与 API 400 语义分工）
    if (typeof raw !== 'string' || raw.trim() === '') {
      return html(
        reply,
        searchPage({
          viewer: {
            username: who.subject.username,
            is_instance_admin: who.subject.is_instance_admin,
          },
          q: null,
          vaultOptions,
          vault: vaultParam,
        }),
      );
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
            vaultOptions,
            vault: vaultParam,
          }),
        );
    }
    // 收窄装配（调用侧）：all=不收窄；成员库=scopeVaultIds=[id]；无权/不存在
    // =空命中同形态（D-IC-06——查询面自身可见性过滤不变，此为提前同形态短路）
    let result: SearchResult;
    if (vaultParam === 'all') {
      result = searchKeyword(opts.db, who.subject.employee_id, raw);
    } else {
      const vid = memberVaultId(who.subject.employee_id, vaultParam);
      result = vid === null ? { hits: [], truncated: false } : searchKeyword(opts.db, who.subject.employee_id, raw, [vid]);
    }
    return html(
      reply,
      searchPage({
        viewer: {
          username: who.subject.username,
          is_instance_admin: who.subject.is_instance_admin,
        },
        q: raw,
        result,
        vaultOptions,
        vault: vaultParam,
      }),
    );
  });
}
