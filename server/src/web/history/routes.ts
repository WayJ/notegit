import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { AuthSuccess } from '../../auth/lifecycle.ts';
import { authorize } from '../../auth/lifecycle.ts';
import { createDbMembershipSource } from '../../vaults/membership.ts';
import { VaultService } from '../../vaults/service.ts';
import { html, sendPageNotFound } from '../page-kit.ts';
import { readCommitLog, readCommitDiff } from './log.ts';
import { historyPage, historyStatePage, diffPage } from './pages.ts';

/**
 * S5-T1 历史族路由（api.md §13 S5-T1 行）：
 *
 * - GET /vaults/{slug}/history[/{path}]  提交历史页：库级（无路径）/路径级
 *   （该路径的提交），默认分支实时读 Git（每请求 spawn，无缓存——D-IC-05 精神；
 *   sprint S5 D5 无独立历史存储）；分页 ?page=N（跨页导航 rel=prev/next）；
 *   主体呈现 = 当前认证员工视角，commit 作者仅元数据展示（DOD-03）。
 * - GET /vaults/{slug}/diff/{oid}/{path}  逐文件 diff 页（父提交↔目标；根提交
 *   以空树为基线）：diff 文本逐行转义呈现（S4-T2 安全管不变量——原文 HTML
 *   不被解释执行）；未触及路径如实标注空 diff。
 *
 * 认证/授权与浏览族同判（实时查库、无权=不存在 404 同页 D-IC-06；未认证
 * 302 /login）。D5 模块自声明：不改 web/routes.ts 既有行（组装点 append 一行
 * 注册本模块）。
 */

/** 历史族所需选项（组装点传入项的结构化子集——模块不反向依赖 web/routes.ts） */
export interface HistoryRoutesOptions {
  readonly db: DatabaseSync;
  readonly dataDir?: string;
  readonly requirePageUser: (req: FastifyRequest, reply: FastifyReply) => Promise<AuthSuccess | null>;
}

/** 页码解析：整数 ≥1 归一，否则第一页（畸形/越界值不冒充 404——窗口自然空态） */
function parsePage(query: unknown): number {
  const raw = (query as { page?: unknown }).page;
  const n = typeof raw === 'string' ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

export function registerHistoryRoutes(app: FastifyInstance, opts: HistoryRoutesOptions): void {
  const vaults = new VaultService({ db: opts.db }); // 只读消费（getVaultRow）
  const membershipSource = createDbMembershipSource(opts.db); // 三入口同源成员判定

  /** 页面授权：authorize 通过返回库行 + 认证主体；未认证 302、无权 404 同页 */
  async function requireVault(
    req: FastifyRequest,
    reply: FastifyReply,
    slug: string,
  ): Promise<{ who: AuthSuccess; vault: { slug: string; name: string; id: number; defaultBranch: string } } | null> {
    const who = await opts.requirePageUser(req, reply);
    if (!who) return null;
    const decision = authorize(membershipSource, who.subject.employee_id, slug, 'read');
    if (!decision.allowed) return sendPageNotFound(reply), null; // 无权=不存在（D-IC-06）
    const row = vaults.getVaultRow(slug);
    if (!row) return sendPageNotFound(reply), null; // fail-closed
    return {
      who,
      vault: { slug: row.slug, name: row.name, id: row.id, defaultBranch: row.default_branch },
    };
  }

  // 提交历史页（库级与路径级同 handler——wildcard 段即树路径；尾斜杠归一）
  const historyHandler = async (req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const { slug } = req.params as { slug: string };
    const guard = await requireVault(req, reply, slug);
    if (!guard) return reply;
    const { who, vault } = guard;
    if (opts.dataDir === undefined) {
      return html(reply, historyStatePage(vault, '内容暂不可用（仓库存储未挂接——仅测试形态会出现）。'));
    }
    const treePath = (((req.params as Record<string, string>)['*'] ?? '')).replace(/\/+$/, '');
    const page = parsePage(req.query);
    const read = await readCommitLog(opts.dataDir, vault.id, vault.defaultBranch, treePath, page);
    if (read.kind === 'no-commits') return html(reply, historyStatePage(vault, '尚无提交内容（新库空初始化）。'));
    if (read.kind === 'unavailable') return html(reply, historyStatePage(vault, '内容暂不可用（仓库目录缺失或读取失败）。'));
    if (read.kind === 'not-found') return sendPageNotFound(reply); // 畸形路径形态（反存在性）
    return html(
      reply,
      historyPage({
        vault,
        viewer: { username: who.subject.username },
        treePath,
        commits: read.commits,
        page,
        hasMore: read.hasMore,
      }),
    );
  };
  app.get('/vaults/:slug/history', historyHandler);
  app.get('/vaults/:slug/history/*', historyHandler);

  // 逐文件 diff 页（父提交↔目标；oid = 提交缩写/全 SHA——log.ts 收 OID 形态）
  app.get('/vaults/:slug/diff/:oid/*', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const guard = await requireVault(req, reply, slug);
    if (!guard) return reply;
    const { vault } = guard;
    if (opts.dataDir === undefined) {
      return html(reply, historyStatePage(vault, '内容暂不可用（仓库存储未挂接——仅测试形态会出现）。'));
    }
    const { oid } = req.params as { oid: string };
    const treePath = (((req.params as Record<string, string>)['*'] ?? '')).replace(/\/+$/, '');
    const read = await readCommitDiff(opts.dataDir, vault.id, oid, treePath);
    if (read.kind === 'not-found') return sendPageNotFound(reply); // 未知/非提交 OID、畸形路径（反存在性）
    if (read.kind === 'unavailable') return html(reply, historyStatePage(vault, '内容暂不可用（仓库目录缺失或读取失败）。'));
    return html(reply, diffPage({ vault, commitOid: read.commitOid, treePath, diff: read.diff }));
  });
}
