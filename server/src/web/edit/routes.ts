import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { AuthSuccess } from '../../auth/lifecycle.ts';
import { authorize } from '../../auth/lifecycle.ts';
import { createDbMembershipSource } from '../../vaults/membership.ts';
import { VaultService } from '../../vaults/service.ts';
import { vaultRepoPath } from '../../vaults/repo-path.ts';
import { execGit } from '../../publish/git-exec.ts';
import { html, sendPageNotFound } from '../page-kit.ts';
import { canWriteVault } from '../role-gate.ts';
import { browseUrl } from '../browse/pages.ts';
import { readEntryAt, readBlobText, README_RENDER_MAX_BYTES, treePathOk } from '../browse/tree.ts';
import { parseDocForForm, titleFromFilename } from './form.ts';
import { editPage, readmeEditPage, editStatePage, newNotePage, newNoteExistsPage } from './pages.ts';
import { DraftsService, type DraftContent } from '../../drafts/service.ts';
import { editPreviewPlugin } from './preview.ts';

/**
 * S4-T3 编辑族路由（元数据表单 + 正文编辑）：
 *
 * - GET /vaults/{slug}/edit/<路径>  编辑页：.md 知识文档 → 六字段表单（title
 *   必填提示 + 从文件名生成 title 提交前可改 + status 下拉防呆 + tags 输入 +
 *   额外字段安全 YAML 文本区）+ 正文 textarea；README（大小写不敏感）豁免
 *   frontmatter → 仅正文；路径不存在 → 新建模式；非 .md 404（附件属 T4）；
 *   目录路径 302 → browse（与 view 族同判）。
 * - GET /vaults/{slug}/edit/new[?dir=&path=]  站内新建笔记页（S10-T3，D5）：
 *   复用编辑表单模板族呈现「新建模式」（路径输入预填目录前缀、title 必填、
 *   正文空、base_commit=默认分支 HEAD）；提交走既有 §8.2 submissions 端点
 *   （不新建端点）。?path= 既有路径 → 提示态（防误覆盖——upsert 覆盖语义）；
 *   不存在 → 确认态（预填完整路径，可回填本人草稿）。既有 edit/<路径> 行为
 *   零变化（静态段 new 优先于通配）。
 * - 页面=GET 无写操作（api.md §13/D5）：安全判定在 API 侧——页面仅要求 read
 *   成员（与 browse/view 同判，D-IC-06 无权=不存在 404）；写权限由提交时
 *   S3-T7 发布组件 authorization 阶段判定（占位调用面见 edit/submit.ts，
 *   HTTP 接线属 S4-T7）。保存=§7 草稿形状（存储 S4-T6）。
 * - base commit：打开编辑器即解析默认分支 HEAD 嵌入页面（提交 CAS 旧值 /
 *   草稿 base_commit——架构 §6「打开编辑器记录 base commit」，完整冲突保护
 *   属 S4-T7）。
 * - S4-T7 草稿预填（T6 遗留接页）：本人现行草稿（§7 active）存在 → 表单回填
 *   草稿内容（草稿优先于库内文件——作者最新工作），同时呈现草稿 base_commit
 *   旧值与保存时间（T6 notes 移交节）；草稿基线 ≠ 当前 HEAD → 如实标注
 *   「分支已前进」提示核对（直接提交将 409——刷新本页即取最新基线重提）。
 *
 * D5 模块自声明：不改 web/routes.ts 既有行（组装点 append 一行注册本模块）。
 */

export interface EditRoutesOptions {
  readonly db: DatabaseSync;
  readonly dataDir?: string;
  readonly requirePageUser: (req: FastifyRequest, reply: FastifyReply) => Promise<AuthSuccess | null>;
}

/** 编辑页加载上限：与 README/预览渲染上限同值同因（防超大文件拖垮页面） */
const EDIT_LOAD_MAX_BYTES = README_RENDER_MAX_BYTES;

export function registerEditRoutes(app: FastifyInstance, opts: EditRoutesOptions): void {
  const vaults = new VaultService({ db: opts.db }); // 只读消费（getVaultRow）
  const membershipSource = createDbMembershipSource(opts.db); // 三入口同源成员判定
  const drafts = new DraftsService({ db: opts.db }); // 只读消费（get——回填预取）

  // S12-T1 编辑预览片段端点（sprint D2——POST /edit-preview/{slug}/{path}；
  // 插件作用域自带 JSON 传输护栏；维护放行先例与路径裁决见 preview.ts 头注）
  app.register(editPreviewPlugin, {
    db: opts.db,
    ...(opts.dataDir !== undefined ? { dataDir: opts.dataDir } : {}),
    requirePageUser: opts.requirePageUser,
  });

  async function requireVault(
    req: FastifyRequest,
    reply: FastifyReply,
    slug: string,
  ): Promise<{ who: AuthSuccess; slug: string; name: string; id: number; defaultBranch: string } | null> {
    const who = await opts.requirePageUser(req, reply);
    if (!who) return null;
    const decision = authorize(membershipSource, who.subject.employee_id, slug, 'read');
    if (!decision.allowed) return sendPageNotFound(reply), null; // 无权=不存在（D-IC-06）
    const row = vaults.getVaultRow(slug);
    if (!row) return sendPageNotFound(reply), null; // fail-closed
    return { who, slug: row.slug, name: row.name, id: row.id, defaultBranch: row.default_branch };
  }

  /** 回填信息（T6 移交：呈现草稿基线旧值；stale = 分支已前进如实标注） */
  function draftInfoOf(draft: DraftContent | null, currentBase: string | null) {
    return draft === null
      ? {}
      : { draft: { baseCommit: draft.base_commit, updatedAt: draft.updated_at, stale: draft.base_commit !== currentBase } };
  }

  /** 默认分支 HEAD（base commit）；空库/解析失败 = null（分支创建语义） */
  async function headCommit(dataDir: string, vaultId: number, branch: string): Promise<string | null> {
    try {
      const out = await execGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
        cwd: vaultRepoPath(dataDir, vaultId),
      });
      const oid = out.trim();
      return oid === '' ? null : oid;
    } catch {
      return null; // 未知 ref（空库）——rev-parse --quiet 非零
    }
  }

  // S10-T3 站内新建（sprint D5）：browse「新建笔记」入口落点。静态段 new 优先于
  // 下方通配 edit/*（既有 edit/<路径> 行为零变化——wildcard 仍承接 new.md 等实路径）。
  // 页面=GET 无写操作（§13 同族）：门槛 read 成员（D-IC-06 无权=不存在 404 同页）；
  // 写权限由提交时发布组件判定（页面零校验；reader 只读态与 T2 edit GET 同形 D4）。
  // 防误覆盖（submissions 对 upsert 语义是覆盖同名）：?path= 指向既有条目 → 提示态
  // （不呈现创建表单）；不存在 → 确认态（预填完整路径+「将创建新文件」）；表单脚本
  // 提交前 HEAD view 探测存在性（D17 呈现层防护，POST 端点行为不变）。
  app.get('/vaults/:slug/edit/new', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const vault = await requireVault(req, reply, slug);
    if (!vault) return reply;
    if (opts.dataDir === undefined) {
      return html(reply, editStatePage(vault, '内容暂不可用（仓库存储未挂接——仅测试形态会出现）。'));
    }
    const query = req.query as Record<string, unknown>;
    const dir = String(query.dir ?? '').replace(/^\/+/, '').replace(/\/+$/, '');
    if (!treePathOk(dir)) return sendPageNotFound(reply); // 畸形目录 404 同页（反存在性）

    const baseCommit = await headCommit(opts.dataDir, vault.id, vault.defaultBranch);
    const canWrite = canWriteVault(membershipSource, vault.who.subject.employee_id, vault.slug);
    const viewer = { username: vault.who.subject.username, is_instance_admin: vault.who.subject.is_instance_admin };

    // ?path= 候选路径（确认态/提示态）；无 path= 直出空表单（路径输入预填目录前缀）
    const candRaw = query.path === undefined ? undefined : String(query.path).replace(/^\/+/, '').replace(/\/+$/, '');
    if (candRaw !== undefined) {
      if (!treePathOk(candRaw) || !candRaw.toLowerCase().endsWith('.md')) {
        return sendPageNotFound(reply); // 表单仅知识 Markdown（与 edit 族同判）；畸形 404
      }
      const read = await readEntryAt(opts.dataDir, vault.id, vault.defaultBranch, candRaw);
      if (read.kind === 'unavailable') {
        return html(reply, editStatePage(vault, '内容暂不可用（仓库目录缺失或读取失败）。'));
      }
      if (read.kind === 'ok') {
        // 已存在（blob/tree 皆为存在）：提示态——创建表单不得呈现（防误覆盖）
        return html(reply, newNoteExistsPage(vault, candRaw, read.entry.type === 'tree' ? 'tree' : 'blob'));
      }
      // 不存在/no-commits：确认态——预填完整路径；本人现行草稿回填（编辑页既有逻辑同构）
      const draft = drafts.get(vault.id, vault.who.subject.employee_id, candRaw);
      return html(
        reply,
        newNotePage({
          vault,
          dir,
          pathPrefill: candRaw,
          baseCommit,
          canWrite,
          viewer,
          prefill: draft !== null ? parseDocForForm(draft.content) : parseDocForForm(''),
          ...draftInfoOf(draft, baseCommit),
        }),
      );
    }

    return html(
      reply,
      newNotePage({
        vault,
        dir,
        baseCommit,
        canWrite,
        viewer,
        prefill: parseDocForForm(''), // 空表单（title 必填——E-FM-003 映射既有兜底）
      }),
    );
  });

  app.get('/vaults/:slug/edit/*', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const vault = await requireVault(req, reply, slug);
    if (!vault) return reply;
    if (opts.dataDir === undefined) {
      return html(reply, editStatePage(vault, '内容暂不可用（仓库存储未挂接——仅测试形态会出现）。'));
    }
    const entryPath = (((req.params as Record<string, string>)['*'] ?? '')).replace(/\/+$/, '');
    if (entryPath === '') return sendPageNotFound(reply); // 编辑需要明确文件路径

    const name = entryPath.includes('/') ? entryPath.slice(entryPath.lastIndexOf('/') + 1) : entryPath;
    const isReadme = name.toLowerCase() === 'readme.md'; // 架构 §5.2 豁免（大小写不敏感）
    const read = await readEntryAt(opts.dataDir, vault.id, vault.defaultBranch, entryPath);
    if (read.kind === 'unavailable') {
      return html(reply, editStatePage(vault, '内容暂不可用（仓库目录缺失或读取失败）。'));
    }

    // 既有条目：目录 302（先于扩展名判定——目录路径不以 .md 结尾也转发 browse）
    if (read.kind === 'ok' && read.entry.type === 'tree') {
      return reply.redirect(browseUrl(vault.slug, entryPath), 302);
    }
    if (!entryPath.toLowerCase().endsWith('.md')) return sendPageNotFound(reply); // 表单仅知识 Markdown

    // 既有文件：子模块 404、超上限如实标注；新建：no-commits/not-found/missing
    if (read.kind === 'ok') {
      if (read.entry.type === 'commit') return sendPageNotFound(reply);
      if ((read.entry.size ?? 0) > EDIT_LOAD_MAX_BYTES) {
        return html(reply, editStatePage(vault, `文件过大（超过编辑加载上限 ${EDIT_LOAD_MAX_BYTES} 字节），未装入表单。`));
      }
    }

    const baseCommit = await headCommit(opts.dataDir, vault.id, vault.defaultBranch);
    // S4-T7 草稿预填（T6 遗留接页）：本人现行草稿优先于库内文件（§7 GET 同一
    // 存储面；按作者私有——他人草稿在此取数路径上不可达）
    const draft = drafts.get(vault.id, vault.who.subject.employee_id, entryPath);

    if (read.kind !== 'ok') {
      // 新建模式：title 从文件名生成（提交前可改——架构 §5.1）；有草稿则回填草稿
      const empty = parseDocForForm('');
      return html(
        reply,
        editPage({
          vault,
          entryPath,
          mode: 'new',
          baseCommit,
          // S10-T2 权限感知：reader 只读态（D4：门槛 read 成员不变；canWriteVault
          // 唯一判定面，D17 呈现层——POST 侧鉴权原样）
          canWrite: canWriteVault(membershipSource, vault.who.subject.employee_id, vault.slug),
          viewer: { username: vault.who.subject.username, is_instance_admin: vault.who.subject.is_instance_admin },
          prefill:
            draft !== null
              ? parseDocForForm(draft.content)
              : { ...empty, fields: { ...empty.fields, title: titleFromFilename(entryPath) } },
          ...draftInfoOf(draft, baseCommit),
        }),
      );
    }

    let text: string;
    try {
      text = await readBlobText(opts.dataDir, vault.id, read.entry.oid);
    } catch {
      return html(reply, editStatePage(vault, '内容暂不可用（正文读取失败）。'));
    }

    if (isReadme) {
      // README 豁免：不套六字段表单（正文即全文——含 frontmatter 也原样呈现，保存不丢）
      return html(
        reply,
        readmeEditPage({
          vault,
          entryPath,
          mode: 'edit',
          baseCommit,
          // S10-T2 权限感知：同六字段页——reader 只读态（D4/D17）
          canWrite: canWriteVault(membershipSource, vault.who.subject.employee_id, vault.slug),
          viewer: { username: vault.who.subject.username, is_instance_admin: vault.who.subject.is_instance_admin },
          body: draft?.content ?? text,
          ...draftInfoOf(draft, baseCommit),
        }),
      );
    }
    return html(
      reply,
      editPage({
        vault,
        entryPath,
        mode: 'edit',
        baseCommit,
        // S10-T2 权限感知：reader 只读态——字段禁用、无保存/提交控件（D4/D17）
        canWrite: canWriteVault(membershipSource, vault.who.subject.employee_id, vault.slug),
        viewer: { username: vault.who.subject.username, is_instance_admin: vault.who.subject.is_instance_admin },
        prefill: draft !== null ? parseDocForForm(draft.content) : parseDocForForm(text),
        ...draftInfoOf(draft, baseCommit),
      }),
    );
  });
}
