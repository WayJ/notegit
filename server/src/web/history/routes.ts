import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { Report } from 'notegit-validation';
import type { AuthSuccess } from '../../auth/lifecycle.ts';
import { authorize } from '../../auth/lifecycle.ts';
import type { MaintenanceGate } from '../../maintenance/gate.ts';
import type { RejectedResult } from '../../publish/index.ts';
import { createDbMembershipSource } from '../../vaults/membership.ts';
import { VaultService } from '../../vaults/service.ts';
import { vaultRepoPath } from '../../vaults/repo-path.ts';
import { html, sendPageNotFound } from '../page-kit.ts';
import { hintFor } from '../hints.ts';
import { viewUrl } from '../browse/pages.ts';
import { readBlobText, README_RENDER_MAX_BYTES } from '../browse/tree.ts';
import { renderMarkdown } from '../view/render.ts';
import { attachmentUrl, repoPathOfRef, type AttachmentImageUrlResolver } from '../view/attachments.ts';
import { readCommitLog, readCommitDiff } from './log.ts';
import { readEntryAtCommit, readBlobBytes, bodyAfterFrontmatter } from './version.ts';
import { restoreFileAtCommit } from './restore.ts';
import { parseCitation } from './cite.ts';
import {
  historyPage,
  historyStatePage,
  diffPage,
  versionPage,
  restorePage,
  versionUrl,
  citeEntryPage,
  citeFormatErrorPage,
  citeUnresolvablePage,
  type RestoreNotice,
  type VersionBody,
} from './pages.ts';

/**
 * S5 历史族路由（api.md §13 S5-T1/S5-T2 行）：
 *
 * - GET /vaults/{slug}/history[/{path}]  提交历史页（S5-T1）：库级（无路径）/
 *   路径级（该路径的提交），默认分支实时读 Git（每请求 spawn，无缓存——
 *   D-IC-05 精神；sprint S5 D5 无独立历史存储）；分页 ?page=N（跨页导航
 *   rel=prev/next）；主体呈现 = 当前认证员工视角，commit 作者仅元数据展示
 *   （DOD-03）。路径级行附版本预览与「还原到此版本」入口（S5-T2）。
 * - GET /vaults/{slug}/diff/{oid}/{path}  逐文件 diff 页（S5-T1，父提交↔目标；
 *   根提交以空树为基线）：diff 文本逐行转义呈现（S4-T2 安全管不变量——原文
 *   HTML 不被解释执行）；未触及路径如实标注空 diff。
 * - GET /vaults/{slug}/version/{oid}/{path}  历史版本只读预览（S5-T2）：S4
 *   view 渲染复用、commit 参数化（.md 安全渲染 / 图片经鉴权附件通道 / 其余
 *   如实标注）；附件引用按该提交树解析（历史 blob 仍在库内）。
 * - GET/POST /vaults/{slug}/restore/{oid}/{path}  还原确认页与端点（S5-T2）：
 *   还原 = 以新提交恢复该路径到此版本内容（不删历史；走 S3-T7 发布组件——
 *   base commit=当前 tip 的 CAS 冲突保护复用 S4-T7 机制）；页面门槛=read
 *   成员，写权限由发布组件判定；成功 302 → 当前预览页。
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
  /** 维护闸门（S5-T2 还原 POST 组件层最后一道；HTTP 层第一道=组装点 webWriteGuard） */
  readonly maintenanceGate?: MaintenanceGate;
}

/** 页码解析：整数 ≥1 归一，否则第一页（畸形/越界值不冒充 404——窗口自然空态） */
function parsePage(query: unknown): number {
  const raw = (query as { page?: unknown }).page;
  const n = typeof raw === 'string' ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

/** 拒绝阶段 → HTTP 状态码（S5-T2 还原端点——与 rename/delete 同一最小语义映射） */
function statusOfStage(stage: RejectedResult['stage'], reason: string): number {
  if (stage === 'validation') return 422; // 内容校验拒绝（E-FM/E-PATH/E-LIMIT 码）
  if (stage === 'authorization' || stage === 'branch-rules') return 403; // 写权限
  if (stage === 'base-commit' || stage === 'update-ref') return 409; // CAS 冲突（并发——不静默覆盖）
  if (stage === 'execution-point') return reason.includes('维护') ? 503 : 403;
  return 500; // candidate/audit/settle：组件内部失败（fail-closed，不发布）
}

/** 拒绝阶段 → 错误码（api.md §1 注册码——同页不泄露额外信息；S4-T8 统一提示） */
function codeOfStage(stage: RejectedResult['stage'], reason: string): string | undefined {
  if (stage === 'authorization') return 'E-RES-001';
  if (stage === 'branch-rules') return 'E-AUTHZ-001';
  if (stage === 'base-commit' || stage === 'update-ref') return 'E-RES-003';
  if (stage === 'execution-point') return reason.includes('维护') ? 'E-MAINT-001' : 'E-AUTHZ-001';
  return undefined; // validation（取报告 issue 码）/ candidate·audit·settle（无注册码不杜撰）
}

/** 服务端注入的提交身份（identity §8：同 upload/rename 形态——审计主体=认证员工） */
function identityOf(who: AuthSuccess): { name: string; email: string } {
  return { name: who.subject.username, email: `${who.subject.username}@users.notegit.invalid` };
}

/** 报告首个 error 级 issue → 确认页 notice（单文件变更取首个；S4-T8 统一提示附 hint） */
function firstErrorNotice(report: Report | undefined): RestoreNotice | undefined {
  if (report === undefined) return undefined;
  for (const file of report.files) {
    const issue = file.issues.find((x) => x.severity === 'error');
    if (issue !== undefined) {
      return {
        code: issue.code,
        message: issue.message,
        ...(issue.line !== undefined ? { line: issue.line } : {}),
        ...(hintFor(issue.code) !== undefined ? { hint: hintFor(issue.code) } : {}),
      };
    }
  }
  return undefined;
}

export function registerHistoryRoutes(app: FastifyInstance, opts: HistoryRoutesOptions): void {
  // 表单 POST 唯一内容类型（还原按钮=原生表单，无 JS、无新依赖；rename 族已
  // 注册则不重复——Fastify 同型重复注册抛错）
  if (!app.hasContentTypeParser('application/x-www-form-urlencoded')) {
    app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body: string, done) =>
      done(null, Object.fromEntries(new URLSearchParams(body))),
    );
  }
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
        viewer: {
          username: who.subject.username,
          is_instance_admin: who.subject.is_instance_admin,
        },
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

  // ── S5-T2 历史版本预览与还原 ──────────────────────────────────────────────

  /** 预览渲染上限：与 view 族同值同因（防超大文件拖垮页面） */
  const PREVIEW_RENDER_MAX_BYTES = README_RENDER_MAX_BYTES;
  /** 常见图片附件扩展名（分类标注——与 view/routes.ts 同集） */
  const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico']);
  /** 附件通道以 image/* 服务的扩展名（直开页 <img> 内嵌集合——与 view/upload 同集；svg 纵深防御不入） */
  const INLINE_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

  /** 目标条目定位（版本预览/还原共用）：blob 放行；tree/commit 与「该版本处
   *  无此路径」一律 404（不虚构内容）；读取失败空态页。 */
  async function requireEntryAt(
    reply: FastifyReply,
    vault: { slug: string; name: string; id: number; defaultBranch: string },
    oid: string,
    treePath: string,
  ): Promise<{ commitOid: string; oid: string; size: number | undefined; mode: string } | null> {
    const read = await readEntryAtCommit(opts.dataDir!, vault.id, oid, treePath);
    if (read.kind === 'unavailable') {
      return html(reply, historyStatePage(vault, '内容暂不可用（仓库目录缺失或读取失败）。')), null;
    }
    if (read.kind !== 'ok' || read.entry.type !== 'blob') return sendPageNotFound(reply), null; // 未知 OID/该版本缺失/树路径（反存在性）
    return { commitOid: read.commitOid, oid: read.entry.oid, size: read.entry.size, mode: read.mode };
  }

  // 历史版本只读预览（S4 view 渲染复用，commit 参数化）
  app.get('/vaults/:slug/version/:oid/*', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const guard = await requireVault(req, reply, slug);
    if (!guard) return reply;
    const { vault } = guard;
    if (opts.dataDir === undefined) {
      return html(reply, historyStatePage(vault, '内容暂不可用（仓库存储未挂接——仅测试形态会出现）。'));
    }
    const { oid } = req.params as { oid: string };
    const treePath = (((req.params as Record<string, string>)['*'] ?? '')).replace(/\/+$/, '');
    const read = await readEntryAtCommit(opts.dataDir, vault.id, oid, treePath);
    if (read.kind === 'unavailable') return html(reply, historyStatePage(vault, '内容暂不可用（仓库目录缺失或读取失败）。'));
    if (read.kind !== 'ok' || read.entry.type !== 'blob') return sendPageNotFound(reply); // 未知 OID/该版本缺失/树路径（反存在性）
    const { commitOid, entry } = read;
    const shared = { vault, commitOid, treePath, sizeBytes: entry.size };

    if ((entry.size ?? 0) > PREVIEW_RENDER_MAX_BYTES) {
      return html(reply, versionPage({ ...shared, body: { kind: 'too-large', limitBytes: PREVIEW_RENDER_MAX_BYTES } }));
    }
    const lower = entry.name.toLowerCase();
    if (!lower.endsWith('.md')) {
      if (IMAGE_EXTENSIONS.has(lower.slice(lower.lastIndexOf('.')))) {
        // 内嵌集合与 view 直开页同集（svg 等不以 image/* 服务——标注不内嵌）
        const inlineable = INLINE_IMAGE_EXTENSIONS.has(lower.slice(lower.lastIndexOf('.')));
        return html(
          reply,
          versionPage({
            ...shared,
            body: inlineable
              ? { kind: 'image', imageUrl: attachmentUrl(vault.slug, entry.oid, entry.name) }
              : { kind: 'no-preview' },
          }),
        );
      }
      return html(reply, versionPage({ ...shared, body: { kind: 'no-preview' } }));
    }

    let text: string;
    try {
      text = await readBlobText(opts.dataDir, vault.id, entry.oid);
    } catch {
      return html(reply, historyStatePage(vault, '内容暂不可用（正文读取失败）。'));
    }
    const body = bodyAfterFrontmatter(text);
    // 两遍法（view/routes.ts 同构）：第一遍收集仓库相对图片引用，按该提交树
    // 解析（历史 blob 仍在库内——附件通道按 blob 寻址可达）；第二遍正式渲染。
    const refs = new Set<string>();
    const pass1 = renderMarkdown(body, {
      attachmentImageUrl: (ref) => {
        refs.add(ref);
        return null;
      },
    });
    if (refs.size === 0) {
      return html(reply, versionPage({ ...shared, body: { kind: 'rendered', html: pass1.html, strippedHtml: pass1.strippedHtml } }));
    }
    const resolved = new Map<string, string>();
    for (const ref of refs) {
      const repoPath = repoPathOfRef(treePath, ref);
      if (repoPath === null) continue;
      const at = await readEntryAtCommit(opts.dataDir, vault.id, commitOid, repoPath);
      if (at.kind === 'ok' && at.entry.type === 'blob') {
        resolved.set(repoPath, attachmentUrl(vault.slug, at.entry.oid, at.entry.name));
      }
    }
    const lookup: AttachmentImageUrlResolver = (ref) => {
      const repoPath = repoPathOfRef(treePath, ref);
      return repoPath !== null ? (resolved.get(repoPath) ?? null) : null;
    };
    const pass2 = renderMarkdown(body, { attachmentImageUrl: lookup });
    return html(reply, versionPage({ ...shared, body: { kind: 'rendered', html: pass2.html, strippedHtml: pass2.strippedHtml } }));
  });

  // 还原确认页（GET，门槛=read 成员；写权限由 POST 时发布组件判定）
  app.get('/vaults/:slug/restore/:oid/*', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const guard = await requireVault(req, reply, slug);
    if (!guard) return reply;
    const { vault } = guard;
    if (opts.dataDir === undefined) {
      return html(reply, historyStatePage(vault, '内容暂不可用（仓库存储未挂接——仅测试形态会出现）。'));
    }
    const { oid } = req.params as { oid: string };
    const treePath = (((req.params as Record<string, string>)['*'] ?? '')).replace(/\/+$/, '');
    const entry = await requireEntryAt(reply, vault, oid, treePath);
    if (!entry) return reply;
    return html(reply, restorePage({ vault, commitOid: entry.commitOid, treePath, sizeBytes: entry.size }));
  });

  // 还原端点（POST：以新提交恢复该路径到此版本——走 S3-T7 发布组件）
  app.post('/vaults/:slug/restore/:oid/*', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const guard = await requireVault(req, reply, slug);
    if (!guard) return reply;
    const { who, vault } = guard;
    if (opts.dataDir === undefined) {
      return reply.code(503).type('text/plain; charset=utf-8').send('内容暂不可用（仓库存储未挂接——仅测试形态会出现）。');
    }
    const { oid } = req.params as { oid: string };
    const treePath = (((req.params as Record<string, string>)['*'] ?? '')).replace(/\/+$/, '');
    const entry = await requireEntryAt(reply, vault, oid, treePath);
    if (!entry) return reply;

    // 内容逐字节读取（二进制安全——附件同样可还原）
    let bytes: Buffer;
    try {
      const read = await readBlobBytes(vaultRepoPath(opts.dataDir, vault.id), entry.oid);
      if (read === null) throw new Error('blob 不在库内');
      bytes = read;
    } catch {
      return html(reply, historyStatePage(vault, '内容暂不可用（原文件读取失败）。'));
    }

    const publish = await restoreFileAtCommit({
      db: opts.db,
      dataDir: opts.dataDir,
      subject: { employeeId: who.subject.employee_id, carrierRef: who.carrierRef },
      vault: { slug: vault.slug, id: vault.id, defaultBranch: vault.defaultBranch },
      identity: identityOf(who),
      restoreOid: entry.commitOid,
      path: treePath,
      content: bytes,
      mode: entry.mode,
      ...(opts.maintenanceGate !== undefined ? { maintenanceGate: opts.maintenanceGate } : {}),
    });

    if (publish.kind === 'rejected') {
      const stageCode = codeOfStage(publish.stage, publish.reason);
      const notice: RestoreNotice =
        publish.stage === 'validation'
          ? (firstErrorNotice(publish.report) ?? { message: publish.reason })
          : {
              message: publish.reason,
              ...(stageCode !== undefined ? { code: stageCode } : {}),
              ...(stageCode !== undefined && hintFor(stageCode) !== undefined ? { hint: hintFor(stageCode) } : {}),
            };
      return reply.code(statusOfStage(publish.stage, publish.reason)).send(
        restorePage({ vault, commitOid: entry.commitOid, treePath, sizeBytes: entry.size, notice }),
      );
    }
    return reply.redirect(viewUrl(vault.slug, treePath), 302);
  });

  // ── S5-T6 引用解析入口/深链（api.md §13 S5-T6 行）─────────────────────────

  // GET /cite[?c=<库 / 路径 @ commit>]：引用三要素解析到对应历史版本页——
  // 成功 302 → version 路由（缩写 commit 归一为全 SHA 深链）；空 c=入口表单页。
  // 失败两类各自可理解且同页：形态不符（只谈格式，不触库）与存在性失败（已过
  // 权限判定后不区分原因——反存在性）；无权/未知库走 D-IC-06 同页 404。
  app.get('/cite', async (req, reply) => {
    const who = await opts.requirePageUser(req, reply);
    if (!who) return reply;
    const raw = (req.query as { c?: unknown }).c;
    const citation = typeof raw === 'string' ? raw.trim() : '';
    if (citation === '') return html(reply, citeEntryPage()); // 空输入回入口表单（不报错）
    const parsed = parseCitation(citation);
    if (parsed === null) {
      return reply.code(404).type('text/html; charset=utf-8').send(citeFormatErrorPage());
    }
    const guard = await requireVault(req, reply, parsed.slug); // 未认证 302/无权=不存在 404 同页
    if (!guard) return reply;
    const { vault } = guard;
    if (opts.dataDir === undefined) {
      return html(reply, historyStatePage(vault, '内容暂不可用（仓库存储未挂接——仅测试形态会出现）。'));
    }
    const read = await readEntryAtCommit(opts.dataDir, vault.id, parsed.commit, parsed.path);
    if (read.kind === 'unavailable') return html(reply, historyStatePage(vault, '内容暂不可用（仓库目录缺失或读取失败）。'));
    if (read.kind !== 'ok' || read.entry.type !== 'blob') {
      return reply.code(404).type('text/html; charset=utf-8').send(citeUnresolvablePage());
    }
    return reply.redirect(versionUrl(vault.slug, read.commitOid, parsed.path), 302);
  });
}
