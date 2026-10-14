import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { AuthSuccess } from '../../auth/lifecycle.ts';
import { authorize } from '../../auth/lifecycle.ts';
import { createDbMembershipSource } from '../../vaults/membership.ts';
import { VaultService } from '../../vaults/service.ts';
import { extractFrontmatter } from 'notegit-validation';
import { html, sendPageNotFound } from '../page-kit.ts';
import { canWriteVault } from '../role-gate.ts';
import { browseStatePage, browseUrl } from '../browse/pages.ts';
import { readEntryAt, readBlobText, README_RENDER_MAX_BYTES } from '../browse/tree.ts';
import { renderMarkdown } from './render.ts';
import {
  ATTACHMENT_CHANNEL_PENDING,
  attachmentUrl,
  repoPathOfRef,
  type AttachmentImageUrlResolver,
} from './attachments.ts';
import { viewPage, attachmentImagePage, noPreviewPage, tooLargePage } from './pages.ts';

/**
 * S4-T2 预览族路由（Markdown 预览与安全渲染）：
 *
 * - GET /vaults/{slug}/view/<路径>  文件预览：.md → 服务端安全渲染（render.ts
 *   清理管——服务端清理唯一通道）；非 .md 如实标注不渲染；超过渲染上限标注；
 *   目录路径 302 → browse（S4-T1 行为延续）。
 * - 认证/授权与 S4-T1 浏览族同判（实时查库、无权=不存在 404 同页 D-IC-06）。
 * - 附件图片（S4-T4 已接线）：仓库相对引用经 view/attachments.ts 通道解析为
 *   blob 寻址鉴权 URL（两遍法见 renderBody；解析不到保留占位标注）。
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

/** 附件通道以 image/* 服务的扩展名（直开页 <img> 内嵌集合——与 upload/routes.ts
 *  ATTACH_CONTENT_TYPES 的 image 升格集一致；svg 刻意不入：一律 octet-stream 纵深防御） */
const INLINE_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

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
  ): Promise<{ who: AuthSuccess; vault: { slug: string; name: string; id: number; defaultBranch: string } } | null> {
    const who = await opts.requirePageUser(req, reply);
    if (!who) return null;
    const decision = authorize(membershipSource, who.subject.employee_id, slug, 'read');
    if (!decision.allowed) return sendPageNotFound(reply), null; // 无权=不存在（D-IC-06）
    const row = vaults.getVaultRow(slug);
    if (!row) return sendPageNotFound(reply), null; // fail-closed
    return { who, vault: { slug: row.slug, name: row.name, id: row.id, defaultBranch: row.default_branch } };
  }

  const attachmentImageUrl = opts.attachmentImageUrl ?? ATTACHMENT_CHANNEL_PENDING;

  /**
   * S4-T4 附件通道装配（T2 占位接口接线）：渲染管解析器是同步接口，而 blob
   * 寻址需异步读树——两遍法：第一遍以记录解析器收集相对图片引用（无引用则
   * 第一遍输出即终态，不空跑第二遍）；对每个引用按文档目录语义解析仓库路径
   * （repoPathOfRef）并读默认分支 HEAD 条目，是 blob 则映射到鉴权附件 URL；
   * 第二遍以查表解析器正式渲染（渲染管纯函数，两遍输出除附件位一致）。解析
   * 不到（缺文件/越界/畸形/非 blob）保留占位标注——不泄露树内容。
   */
  async function renderBody(
    vault: { slug: string; id: number; defaultBranch: string },
    entryPath: string,
    body: string,
  ): Promise<{ html: string; strippedHtml: boolean }> {
    if (opts.attachmentImageUrl !== undefined || opts.dataDir === undefined) {
      return renderMarkdown(body, { attachmentImageUrl }); // 注入覆盖（测试缝）或通道未挂接
    }
    const refs = new Set<string>();
    const pass1 = renderMarkdown(body, {
      attachmentImageUrl: (ref) => {
        refs.add(ref);
        return null;
      },
    });
    if (refs.size === 0) return pass1;
    const resolved = new Map<string, string>();
    for (const ref of refs) {
      const repoPath = repoPathOfRef(entryPath, ref);
      if (repoPath === null) continue;
      const entry = await readEntryAt(opts.dataDir, vault.id, vault.defaultBranch, repoPath);
      if (entry.kind === 'ok' && entry.entry.type === 'blob') {
        resolved.set(repoPath, attachmentUrl(vault.slug, entry.entry.oid, entry.entry.name));
      }
    }
    const lookup: AttachmentImageUrlResolver = (ref) => {
      const repoPath = repoPathOfRef(entryPath, ref);
      return repoPath !== null ? (resolved.get(repoPath) ?? null) : null;
    };
    return renderMarkdown(body, { attachmentImageUrl: lookup });
  }

  app.get('/vaults/:slug/view/*', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const guard = await requireVault(req, reply, slug);
    if (!guard) return reply;
    const { who, vault } = guard;
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
    const shared = {
      vault,
      entryPath,
      sizeBytes: entry.size,
      viewer: { username: who.subject.username, is_instance_admin: who.subject.is_instance_admin },
    };

    if ((entry.size ?? 0) > PREVIEW_RENDER_MAX_BYTES) {
      return html(reply, tooLargePage({ ...shared, limitBytes: PREVIEW_RENDER_MAX_BYTES }));
    }
    if (!lower.endsWith('.md')) {
      const ext = lower.slice(lower.lastIndexOf('.'));
      if (IMAGE_EXTENSIONS.has(ext)) {
        // S4-T8 T4 遗留收口：直开页嵌鉴权附件通道 URL（blob 寻址）；仅对通道以
        // image/* 服务的类型内嵌（svg 等 octet-stream 纵深防御——标注不内嵌）
        const inlineable = INLINE_IMAGE_EXTENSIONS.has(ext);
        return html(
          reply,
          attachmentImagePage({
            ...shared,
            imageUrl: inlineable ? attachmentUrl(vault.slug, entry.oid, entry.name) : null,
          }),
        );
      }
      return html(reply, noPreviewPage(shared));
    }

    let text: string;
    try {
      text = await readBlobText(opts.dataDir, vault.id, entry.oid);
    } catch {
      return html(reply, browseStatePage(vault, '内容暂不可用（正文读取失败）。'));
    }
    const body = bodyAfterFrontmatter(text);
    const rendered = await renderBody(vault, entryPath, body);
    // S10-T1 编辑入口（呈现层 canWriteVault——D17 薄委托；edit 表单仅 .md，本分支恰为 .md）
    const canWrite = canWriteVault(membershipSource, who.subject.employee_id, slug);
    return html(
      reply,
      viewPage({
        vault,
        entryPath,
        sizeBytes: entry.size,
        bodyHtml: rendered.html,
        strippedHtml: rendered.strippedHtml,
        viewer: { username: who.subject.username, is_instance_admin: who.subject.is_instance_admin },
        canWrite,
      }),
    );
  });
}
