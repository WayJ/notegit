import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { AuthSuccess } from '../../auth/lifecycle.ts';
import { authorize } from '../../auth/lifecycle.ts';
import { createDbMembershipSource } from '../../vaults/membership.ts';
import { VaultService } from '../../vaults/service.ts';
import { extractFrontmatter } from 'notegit-validation';
import { effectiveConfig } from '../../limits/engine.ts';
import { sendPageNotFound } from '../page-kit.ts';
import { readEntryAt, README_RENDER_MAX_BYTES, treePathOk } from '../browse/tree.ts';
import { renderMarkdown } from '../view/render.ts';
import { attachmentUrl, repoPathOfRef, type AttachmentImageUrlResolver } from '../view/attachments.ts';

/**
 * S12-T1 编辑预览片段端点（sprint D2：服务端安全渲染——预览与发布后 view 同
 * 一渲染管线，安全不变量（render.ts 清理通道唯一）由此延续）：
 *
 * - POST /edit-preview/{slug}/{path}（请求体 {content}）：{path} 为文档库内
 *   路径（仓库相对图片引用的解析基准——与 view 两遍法同构；不要求存在：预览
 *   渲染的是请求体内容，非库内文件，无存在性 oracle）。成功 200 text/html
 *   **片段**（view renderBody 同一输出——frontmatter 剥离后正文渲染，与 view
 *   页 article#doc 内层逐字一致；非整页）。
 * - 认证/授权与 edit GET 同判（requirePageUser 302 + authorize read；无权=
 *   不存在 404 同页 D-IC-06）。门槛=read 成员（reader 可预览——预览不产生
 *   任何写入）。
 * - 维护模式放行（只读推导——api.md §2「候选校验（§8.2 validations）为只读
 *   推导，放行」同款）：端点零写面（不落库、不产 Git 版本、不记审计），路径
 *   落在两道维护闸门前缀（/api/v1、/vaults/ 写守卫）之外——worker ruling：
 *   写面不含 write-gate.ts（前缀规则不可豁免），示例路径 /vaults/{slug}/
 *   preview 会被 /vaults/ 非安全方法规则拦为 503，故注册于前缀外（语义等价，
 *   §13 建议稿按实登路径）。
 * - 渲染上限与 view 同值同因（README_RENDER_MAX_BYTES——超大内容 413 如实
 *   拒渲染）；传输护栏同 drafts/submissions 形态（插件作用域 JSON 解析器
 *   bodyLimit 只升不降，防缺省 1 MiB 先于上限判定给费解 413）。
 *
 * D5 模块自声明：注册点在 edit/routes.ts（append 一行）；view 域只读 import
 * （render.ts 渲染管 + attachments.ts 附件 URL 解析——两处均不改）。
 */

export interface PreviewRoutesOptions {
  readonly db: DatabaseSync;
  readonly dataDir?: string;
  readonly requirePageUser: (req: FastifyRequest, reply: FastifyReply) => Promise<AuthSuccess | null>;
}

/** 传输护栏下限（同 drafts/submissions 形态：JSON 转义余量 + 上限判定不先于护栏） */
const PREVIEW_BODY_GUARD_FLOOR = 8 * 1024 * 1024;

/** frontmatter 剥离：与 view/routes.ts bodyAfterFrontmatter 同规则逐字复制
 * （模块各自持有——D5 不改共享文件；一致性由「预览与 view 同渲染」测试锁定） */
function bodyAfterFrontmatter(text: string): string {
  const fm = extractFrontmatter(text);
  const lines = (text.startsWith('﻿') ? text.slice(1) : text).split('\n');
  if (fm.kind === 'block' && fm.closeLine !== undefined) return lines.slice(fm.closeLine).join('\n');
  if (fm.kind === 'unterminated') return lines.slice(1).join('\n');
  return text;
}

export const editPreviewPlugin: FastifyPluginAsync<PreviewRoutesOptions> = async (
  instance: FastifyInstance,
  options: PreviewRoutesOptions,
) => {
  const vaults = new VaultService({ db: options.db }); // 只读消费（getVaultRow）
  const membershipSource = createDbMembershipSource(options.db); // 同源成员判定

  // 传输护栏（插件作用域——本域唯一 JSON 端点；不影响 app 级解析器）
  const bodyLimit = Math.max(effectiveConfig({ db: options.db }).maxDocumentBytes * 6, PREVIEW_BODY_GUARD_FLOOR);
  instance.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit }, (_req, body, done) => {
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  /** 库门槛：与 edit GET 同判（认证 302 → authorize read 404 → 库行 fail-closed） */
  async function requireVault(
    req: FastifyRequest,
    reply: FastifyReply,
    slug: string,
  ): Promise<{ vault: { slug: string; id: number; defaultBranch: string } } | null> {
    const who = await options.requirePageUser(req, reply);
    if (!who) return null;
    const decision = authorize(membershipSource, who.subject.employee_id, slug, 'read');
    if (!decision.allowed) return sendPageNotFound(reply), null; // 无权=不存在（D-IC-06）
    const row = vaults.getVaultRow(slug);
    if (!row) return sendPageNotFound(reply), null; // fail-closed
    return { vault: { slug: row.slug, id: row.id, defaultBranch: row.default_branch } };
  }

  /**
   * 附件通道两遍法：与 view/routes.ts renderBody 同构逐字复制（渲染管解析器
   * 同步接口 × blob 寻址异步读树——第一遍收集引用、逐引用解析、第二遍正式
   * 渲染；一致性由「预览与 view 同渲染」测试锁定）。解析不到保留占位标注。
   */
  async function renderBody(
    vault: { slug: string; id: number; defaultBranch: string },
    entryPath: string,
    body: string,
  ): Promise<string> {
    if (options.dataDir === undefined) return renderMarkdown(body).html; // 理论不可达（503 前置）
    const refs = new Set<string>();
    renderMarkdown(body, {
      attachmentImageUrl: (ref) => {
        refs.add(ref);
        return null;
      },
    });
    if (refs.size === 0) return renderMarkdown(body).html;
    const resolved = new Map<string, string>();
    for (const ref of refs) {
      const repoPath = repoPathOfRef(entryPath, ref);
      if (repoPath === null) continue;
      const entry = await readEntryAt(options.dataDir, vault.id, vault.defaultBranch, repoPath);
      if (entry.kind === 'ok' && entry.entry.type === 'blob') {
        resolved.set(repoPath, attachmentUrl(vault.slug, entry.entry.oid, entry.entry.name));
      }
    }
    const lookup: AttachmentImageUrlResolver = (ref) => {
      const repoPath = repoPathOfRef(entryPath, ref);
      return repoPath !== null ? (resolved.get(repoPath) ?? null) : null;
    };
    return renderMarkdown(body, { attachmentImageUrl: lookup }).html;
  }

  instance.post('/edit-preview/:slug/*', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const guard = await requireVault(req, reply, slug);
    if (!guard) return reply;
    if (options.dataDir === undefined) {
      return reply.code(503).type('text/plain; charset=utf-8').send('内容暂不可用（仓库存储未挂接——仅测试形态会出现）。');
    }
    const entryPath = ((req.params as Record<string, string>)['*'] ?? '').replace(/^\/+/, '');
    if (entryPath === '' || !treePathOk(entryPath)) return sendPageNotFound(reply); // 畸形=不存在（同族判定）

    // 请求形态：{content: string}（§13 建议稿形态；形态错误 400 E-RES-004）
    const body = req.body as { content?: unknown } | undefined;
    if (typeof body?.content !== 'string') {
      return reply.code(400).send({ error: { code: 'E-RES-004', message: '请求形态错误（content 必填字符串）' } });
    }
    // 渲染上限与 view 同值同因（超限如实拒渲染——不拖垮页面）
    if (Buffer.byteLength(body.content, 'utf8') > README_RENDER_MAX_BYTES) {
      return reply
        .code(413)
        .type('text/plain; charset=utf-8')
        .send(`内容过大（超过渲染上限 ${README_RENDER_MAX_BYTES} 字节），未渲染预览。`);
    }

    const html = await renderBody(guard.vault, entryPath, bodyAfterFrontmatter(body.content));
    return reply.code(200).type('text/html; charset=utf-8').send(html);
  });
};
