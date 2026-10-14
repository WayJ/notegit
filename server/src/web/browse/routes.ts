import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { AuthSuccess } from '../../auth/lifecycle.ts';
import { authorize } from '../../auth/lifecycle.ts';
import { createDbMembershipSource } from '../../vaults/membership.ts';
import { VaultService } from '../../vaults/service.ts';
import { html, sendPageNotFound } from '../page-kit.ts';
import { canWriteVault } from '../role-gate.ts';
import { vaultListPage, browsePage, browseStatePage, browseUrl } from './pages.ts';
import { readDirTree, findReadmeEntry, readBlobText, README_RENDER_MAX_BYTES } from './tree.ts';

/**
 * S4-T1 浏览族路由（有权库列表 + 目录浏览）：
 *
 * - GET /vaults                        有权库列表（实时查成员关系——与 GET /api/v1/vaults
 *                                      同一判定面 VaultService.listVaults，架构 §4.2）。
 * - GET /vaults/{slug}                 库根 302 → /vaults/{slug}/browse（成员；否则 404）。
 * - GET /vaults/{slug}/browse[/<路径>]  目录浏览（默认分支实时读 Git tree；面包屑/导航；
 *                                      README.md 渲染为目录导航，豁免标注）。
 * - GET /vaults/{slug}/view/<路径>      预览（S4-T2 起由 view/ 模块持有——安全渲染
 *                                      落地时占位路由迁出本文件，见 web/routes.ts 注册表）。
 *
 * 授权：页面级经共用 authorize（auth/lifecycle.ts × vaults/membership.ts 真实表
 * MembershipSource——与 Web API/Git 三入口同源）；无权与不存在一律 404 同页
 * （D-IC-06）。会话载体无凭据 scope（员工全量权限，identity §3.4）。
 *
 * 模块边界（D5 骨架裁决）：本文件是浏览族唯一路由入口；后续任务（T2 预览、T3
 * 表单、T4 上传……）各自新增页面模块并只在 web/routes.ts 组装点 append 一行，
 * 不改本文件、不改 web/ 之外。
 */

/** 浏览族所需选项（组装点传入项的结构化子集——模块不反向依赖 web/routes.ts） */
export interface BrowseRoutesOptions {
  readonly db: DatabaseSync;
  readonly dataDir?: string;
  readonly requirePageUser: (req: FastifyRequest, reply: FastifyReply) => Promise<AuthSuccess | null>;
}

export function registerBrowseRoutes(app: FastifyInstance, opts: BrowseRoutesOptions): void {
  const vaults = new VaultService({ db: opts.db }); // 只读消费（listVaults/getVaultRow；写路径不经页面）
  const membershipSource = createDbMembershipSource(opts.db); // 共用成员源（三入口同源）

  /** 页面授权：authorize 通过返回库行（slug→id→role 实时查表）；未认证 302、无权 404 同页 */
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
    if (!row) return sendPageNotFound(reply), null; // fail-closed（authorize 通过即成员在）
    return { who, vault: { slug: row.slug, name: row.name, id: row.id, defaultBranch: row.default_branch } };
  }

  app.get('/vaults', async (req, reply) => {
    const who = await opts.requirePageUser(req, reply);
    if (!who) return reply;
    const list = vaults.listVaults(who.subject.employee_id); // 实时查库（仅本人成员关系的库）
    return html(
      reply,
      vaultListPage(
        { username: who.subject.username, is_instance_admin: who.subject.is_instance_admin },
        list,
      ),
    );
  });

  // 库根：成员 → 302 目录浏览（canonical URL 单一）；无权与不存在同 404
  app.get('/vaults/:slug', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const guard = await requireVault(req, reply, slug);
    if (!guard) return reply;
    return reply.redirect(browseUrl(guard.vault.slug, ''), 302);
  });

  // 目录浏览（root 与多级同handler——wildcard 段即树路径；尾斜杠归一）
  const browseHandler = async (req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const { slug } = req.params as { slug: string };
    const guard = await requireVault(req, reply, slug);
    if (!guard) return reply;
    const { who, vault } = guard;
    if (opts.dataDir === undefined) {
      return html(reply, browseStatePage(vault, '内容暂不可用（仓库存储未挂接——仅测试形态会出现）。'));
    }
    const dirPath = (((req.params as Record<string, string>)['*'] ?? '')).replace(/\/+$/, '');
    const read = await readDirTree(opts.dataDir, vault.id, vault.defaultBranch, dirPath);
    if (read.kind === 'no-commits') return html(reply, browseStatePage(vault, '尚无提交内容（新库空初始化）。'));
    if (read.kind === 'unavailable') return html(reply, browseStatePage(vault, '内容暂不可用（仓库目录缺失或读取失败）。'));
    if (read.kind === 'not-found') return sendPageNotFound(reply);

    // README.md（大小写不敏感，架构 §5.2）：目录导航渲染 + 豁免标注；无 frontmatter 不报错（零校验）
    let readme: string | null | 'too-large' = null;
    const readmeEntry = findReadmeEntry(read.entries);
    if (readmeEntry !== undefined) {
      if ((readmeEntry.size ?? 0) > README_RENDER_MAX_BYTES) {
        readme = 'too-large';
      } else {
        try {
          readme = await readBlobText(opts.dataDir, vault.id, readmeEntry.oid);
        } catch {
          readme = null; // 读取失败不阻断目录列表（导航文本为增益非依赖）
        }
      }
    }
    return html(
      reply,
      browsePage({
        vault,
        dirPath,
        entries: read.entries,
        readme,
        // S10-T2 权限感知：写入口按当前会话员工对该库的写权渲染（canWriteVault
        // 唯一判定面；reader 只读态——D17 呈现层，POST 侧鉴权原样）
        canWrite: canWriteVault(membershipSource, who.subject.employee_id, vault.slug),
        viewer: { username: who.subject.username, is_instance_admin: who.subject.is_instance_admin },
      }),
    );
  };
  app.get('/vaults/:slug/browse', browseHandler);
  app.get('/vaults/:slug/browse/*', browseHandler);
  // GET /vaults/{slug}/view/* —— S4-T2 起由 view/routes.ts 持有（安全渲染接管，
  // 占位 handler 迁出；本模块只保留目录条目到预览页的链接 viewUrl）。
}
