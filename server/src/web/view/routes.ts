import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { AuthSuccess } from '../../auth/lifecycle.ts';
import { authorize } from '../../auth/lifecycle.ts';
import { createDbMembershipSource } from '../../vaults/membership.ts';
import { VaultService } from '../../vaults/service.ts';
import { extractFrontmatter } from 'notegit-validation';
import { html, sendPageNotFound } from '../page-kit.ts';
import { browseStatePage, browseUrl } from '../browse/pages.ts';
import { readEntryAt, readBlobText, README_RENDER_MAX_BYTES } from '../browse/tree.ts';
import { renderMarkdown } from './render.ts';
import { ATTACHMENT_CHANNEL_PENDING } from './attachments.ts';
import { viewPage, attachmentImagePage, noPreviewPage, tooLargePage } from './pages.ts';

/**
 * S4-T2 预览族路由（Markdown 预览与安全渲染）：
 *
 * - GET /vaults/{slug}/view/<路径>  文件预览：.md → 服务端安全渲染（render.ts
 *   清理管——服务端清理唯一通道）；非 .md 如实标注不渲染；超过渲染上限标注；
 *   目录路径 302 → browse（S4-T1 行为延续）。
 * - 认证/授权与 S4-T1 浏览族同判（实时查库、无权=不存在 404 同页 D-IC-06）。
 * - 附件图片：渲染管经 view/attachments.ts 接口（S4-T2 占位 null → 标注；
 *   S4-T4 落地附件路由后装配真实解析器）。
 *
 * D5 模块自声明：不改 web/routes.ts 既有行（组装点 append 一行注册本模块）。
 */

export interface ViewRoutesOptions {
  readonly db: DatabaseSync;
  readonly dataDir?: string;
  readonly requirePageUser: (req: FastifyRequest, reply: FastifyReply) => Promise<AuthSuccess | null>;
  /** 附件鉴权通道解析器（S4-T4 装配传入；缺省 = 通道未接入占位） */
  readonly attachmentImageUrl?: (repoRelPath: string) => string | null;
}

/** 预览渲染上限：与 S4-T1 README 渲染上限同值同因（防超大文件拖垮页面） */
const PREVIEW_RENDER_MAX_BYTES = README_RENDER_MAX_BYTES;

/** 常见图片附件扩展名（展示层分类仅影响标注文案；读取/清单规则在 validation §5） */
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico']);

/** frontmatter 剥离：闭合块之后为正文；未闭合按 lenient 跳过首行（预览不校验） */
function bodyAfterFrontmatter(text: string): string {
  const fm = extractFrontmatter(text);
  const lines = (text.startsWith('﻿') ? text.slice(1) : text).split('\n');
  if (fm.kind === 'block' && fm.closeLine !== undefined) return lines.slice(fm.closeLine).join('\n');
  if (fm.kind === 'unterminated') return lines.slice(1).join('\n');
  return text;
}

export function registerViewRoutes(app: FastifyInstance, opts: ViewRoutesOptions): void {
  const vaults = new VaultService({ db: opts.db }); // 只读消费（getVaultRow）
  const membershipSource = createDbMembershipSource(opts.db); // 三入口同源成员判定

  async function requireVault(
    req: FastifyRequest,
    reply: FastifyReply,
    slug: string,
  ): Promise<{ slug: string; name: string; id: number; defaultBranch: string } | null> {
    const who = await opts.requirePageUser(req, reply);
    if (!who) return null;
    const decision = authorize(membershipSource, who.subject.employee_id, slug, 'read');
    if (!decision.allowed) return sendPageNotFound(reply), null; // 无权=不存在（D-IC-06）
    const row = vaults.getVaultRow(slug);
    if (!row) return sendPageNotFound(reply), null; // fail-closed
    return { slug: row.slug, name: row.name, id: row.id, defaultBranch: row.default_branch };
  }

  const attachmentImageUrl = opts.attachmentImageUrl ?? ATTACHMENT_CHANNEL_PENDING;

  app.get('/vaults/:slug/view/*', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const vault = await requireVault(req, reply, slug);
    if (!vault) return reply;
    if (opts.dataDir === undefined) {
      return html(reply, browseStatePage(vault, '内容暂不可用（仓库存储未挂接——仅测试形态会出现）。'));
    }
    const entryPath = (((req.params as Record<string, string>)['*'] ?? '')).replace(/\/+$/, '');
    const read = await readEntryAt(opts.dataDir, vault.id, vault.defaultBranch, entryPath);
    if (read.kind !== 'ok') return sendPageNotFound(reply); // 缺失/空库/unavailable 同 404（反存在性）
    const { entry } = read;
    if (entry.type === 'tree') return reply.redirect(browseUrl(vault.slug, entryPath), 302);
    if (entry.type === 'commit') return sendPageNotFound(reply); // 子模块不属 v1 页面域

    const lower = entry.name.toLowerCase();
    const shared = { vault, entryPath, sizeBytes: entry.size };

    if ((entry.size ?? 0) > PREVIEW_RENDER_MAX_BYTES) {
      return html(reply, tooLargePage({ ...shared, limitBytes: PREVIEW_RENDER_MAX_BYTES }));
    }
    if (!lower.endsWith('.md')) {
      const page = IMAGE_EXTENSIONS.has(lower.slice(lower.lastIndexOf('.')))
        ? attachmentImagePage(shared)
        : noPreviewPage(shared);
      return html(reply, page);
    }

    let text: string;
    try {
      text = await readBlobText(opts.dataDir, vault.id, entry.oid);
    } catch {
      return html(reply, browseStatePage(vault, '内容暂不可用（正文读取失败）。'));
    }
    const body = bodyAfterFrontmatter(text);
    const rendered = renderMarkdown(body, { attachmentImageUrl });
    return html(
      reply,
      viewPage({
        vault,
        entryPath,
        sizeBytes: entry.size,
        bodyHtml: rendered.html,
        strippedHtml: rendered.strippedHtml,
      }),
    );
  });
}
