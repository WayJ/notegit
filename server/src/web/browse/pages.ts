import { escapeHtml, layout } from '../pages.ts';
import type { VaultListItem } from '../../vaults/service.ts';
import { extractFrontmatter } from 'notegit-validation';
import { renderMarkdown } from '../view/render.ts';
import type { LastCommitInfo, TreeEntry } from './tree.ts';

/**
 * S4-T1 浏览族页面模板（服务端渲染、无框架；插值唯一通道 escapeHtml，与 S2-T8
 * pages.ts 同规）。数据页不做页内 fetch——列表与目录每次请求实时渲染（实时查
 * 权限/默认分支，D-IC-05 精神），与「外壳 + fetch」的管理页分工不同。
 *
 * UI-RESTYLE：DESIGN.md 视觉契约落位——库列表为卡片网格（feature-card 形态）、
 * 目录条目为表格化列表（条目集与序仍与 `git ls-tree` 同集同序，仅呈现）、README
 * 为米色导航卡；viewer 透传顶部导航登录态（呈现层）。
 *
 * S11-T3：README 卡片复用 view 安全渲染管线（render.ts 只读 import——清理
 * 唯一通道不变量延续，browse 不另造清理器）；frontmatter 剥离不外露（F-8）；
 * 目录行附最后提交作者/相对时间（批量派生元数据，次要文本色）；browse 头加
 * 「最近变更」入口一行（读门槛语义——编辑者与读者都可见）。
 */

/** 顶部导航登录态（呈现层透传——S2-T8「管理入口可见性」判定不在此） */
export interface PageViewer {
  readonly username: string;
  /** S21-T1/A1：展示名（顶栏徽章单形态接线；缺省回落用户名） */
  readonly display_name?: string;
  readonly is_instance_admin: boolean;
}

const ROLE_LABELS: Readonly<Record<string, string>> = { admin: '管理员', editor: '编辑者', reader: '读者' };

/** 有权库列表页（架构 §4.2：未授权的库不进入列表） */
export function vaultListPage(
  user: { username: string; display_name?: string; is_instance_admin?: boolean },
  vaults: readonly VaultListItem[],
): string {
  const cards = vaults
    .map(
      (v) => `  <a class="vault-card" href="/vaults/${encodeURIComponent(v.slug)}/browse">
    <span class="vault-name">${escapeHtml(v.name)}</span>
    <span class="vault-slug">${escapeHtml(v.slug)}</span>
    <span class="badge">${ROLE_LABELS[v.role] ?? escapeHtml(v.role)}</span>
  </a>`,
    )
    .join('\n');
  const listing =
    vaults.length === 0
      ? '<p class="state-note">暂无有权访问的库。</p>'
      : `<div class="vault-grid">\n${cards}\n</div>`;
  return layout(
    '知识库',
    `<div class="page">
  <div class="page-head">
    <h1>知识库</h1>
    <p class="page-sub page-sub-quiet">按你的成员关系呈现有权文库 · <a href="/">返回首页</a></p>
  </div>
  ${listing}
</div>
`,
    '',
    {
      user: { username: user.username, displayName: user.display_name, isAdmin: user.is_instance_admin === true },
      active: 'vaults',
    },
  );
}

/** 树路径 URL（逐段编码；中文/空格名可安全往返） */
export function browseUrl(slug: string, treePath: string): string {
  const enc = treePath.split('/').map(encodeURIComponent).join('/');
  return `/vaults/${encodeURIComponent(slug)}/browse${enc === '' ? '' : '/' + enc}`;
}

export function viewUrl(slug: string, treePath: string): string {
  return `/vaults/${encodeURIComponent(slug)}/view/${treePath.split('/').map(encodeURIComponent).join('/')}`;
}

/** 编辑页 URL（S10-T2 新入口——D2：链接到既有 GET edit，不新增端点；仅 .md 文件挂） */
export function editUrl(slug: string, treePath: string): string {
  return `/vaults/${encodeURIComponent(slug)}/edit/${treePath.split('/').map(encodeURIComponent).join('/')}`;
}

/** 站内新建入口 URL（S10-T3，D5）：目录上下文=当前 browse 目录（库根不带 dir） */
export function newNoteUrl(slug: string, dirPath: string): string {
  const base = `/vaults/${encodeURIComponent(slug)}/edit/new`;
  return dirPath === '' ? base : `${base}?dir=${dirPath.split('/').map(encodeURIComponent).join('/')}`;
}

/** 整理操作入口（S4-T5：目录页最小可用——重命名表单页 / 删除确认页；GET 无写操作） */
export function renameUrl(slug: string, treePath: string): string {
  return `/vaults/${encodeURIComponent(slug)}/rename/${treePath.split('/').map(encodeURIComponent).join('/')}`;
}

export function deleteUrl(slug: string, treePath: string): string {
  return `/vaults/${encodeURIComponent(slug)}/delete/${treePath.split('/').map(encodeURIComponent).join('/')}`;
}

const TYPE_LABELS: Readonly<Record<string, string>> = { tree: '目录', blob: '文件', commit: '引用' };

/** 面包屑：知识库 → 库根 → 逐级目录（当前段不加链接） */
function breadcrumb(vault: { slug: string; name: string }, dirPath: string): string {
  const parts = [`<a href="/vaults">知识库</a>`, `<a href="${browseUrl(vault.slug, '')}">${escapeHtml(vault.name)}</a>`];
  let acc = '';
  for (const seg of dirPath.split('/').filter((s) => s !== '')) {
    acc = acc === '' ? seg : `${acc}/${seg}`;
    parts.push(`<a href="${browseUrl(vault.slug, acc)}">${escapeHtml(seg)}</a>`);
  }
  return parts.join(' <span aria-hidden="true">›</span> ');
}

export interface BrowsePageInput {
  readonly vault: { slug: string; name: string };
  readonly dirPath: string;
  readonly entries: readonly TreeEntry[];
  /** README 卡片正文输入（S11-T3）：markdown=正常渲染（frontmatter 剥离 + view
   *  管线安全输出）；oversize=超渲染上限（回退 <pre> 原文形态并如实标注，
   *  frontmatter 同样不外露）；null=无 README 不渲染卡片。 */
  readonly readme: { readonly kind: 'markdown'; readonly text: string } | { readonly kind: 'oversize'; readonly text: string } | null;
  /** S11-T3 目录行最后提交元数据（条目名 → 最新触及提交；批量派生）。缺省=不
   *  呈现该列（模板直调测试兼容）；派生失败路由方传缺省——元数据为增益非依赖。 */
  readonly lastCommits?: ReadonlyMap<string, LastCommitInfo>;
  /** S10-T2 权限感知：当前会话员工对该库的写权（canWriteVault 实算；false=只读态
   *  ——隐藏 上传/编辑/重命名/删除 写入口 + 只读徽章。缺省 = 写者形态：模板直调
   *  测试兼容；生产路由恒传实算值——判定不在此层（D17 呈现层，非安全边界）） */
  readonly canWrite?: boolean;
  /** UI-RESTYLE：顶部导航登录态（可选——测试直调形态缺省） */
  readonly viewer?: PageViewer;
}

/** 只读徽章（S10-T2：DESIGN.md badge-pill 形态——`.badge` 既有类，token 语义） */
const READONLY_BADGE = '<span class="badge">只读成员</span>';

/**
 * 目录浏览页：条目序列与 `git ls-tree` 同集同序（li data-type/data-name，
 * 一致性断言所依）；README.md 渲染为目录导航并标注 frontmatter 豁免（架构
 * §5.2——README 无 frontmatter 不属错误，页面零校验；呈现上 frontmatter
 * 剥离不外露、正文走 view 安全渲染管线）。
 */

/** 绝对时间呈现（title 提示用）：ISO 自身字段直取，不做时区换算（提交环境时间如实） */
export function absoluteTimeText(iso: string): string {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso) ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : iso;
}

/** 相对时间（目录行次要文本）：刚刚 / N 分钟前 / N 小时前 / N 天前；超 30 天或
 *  时钟偏移为未来时回退绝对日期（不猜负向档位）。 */
export function relativeTimeText(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diff = now - t;
  if (diff < 60_000) return diff >= 0 ? '刚刚' : absoluteTimeText(iso);
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return absoluteTimeText(iso);
}

/** frontmatter 剥离（S11-T3）：与 view/routes.ts bodyAfterFrontmatter 同语义
 *  （block→闭合行后为正文；unterminated→lenient 跳过首行；none→原样）。view 侧
 *  为模块内私有函数——只读复用不扩改 view 域，剥离判定同源 validation
 *  extractFrontmatter，此为 browse 侧并行实现。 */
function readmeBody(text: string): string {
  const fm = extractFrontmatter(text);
  const lines = (text.startsWith('﻿') ? text.slice(1) : text).split('\n');
  if (fm.kind === 'block' && fm.closeLine !== undefined) return lines.slice(fm.closeLine).join('\n');
  if (fm.kind === 'unterminated') return lines.slice(1).join('\n');
  return text;
}

/** README 卡片：正常=frontmatter 剥离 + view 管线安全渲染（清理唯一通道）；
 *  超限=回退 <pre> 原文形态（转义纯文本）并如实标注——剥离先于回退。 */
function readmeCard(readme: BrowsePageInput['readme']): string {
  if (readme === null) return '';
  const head = '<h2>README.md <small>（导航文档 · 豁免 frontmatter）</small></h2>';
  const body = readmeBody(readme.text);
  if (readme.kind === 'oversize') {
    return `<section class="readme-card">\n${head}\n<p class="readme-note">README 过大（超过渲染上限），未渲染 Markdown，按原文展示。</p>\n<pre>${escapeHtml(body)}</pre>\n</section>`;
  }
  const rendered = renderMarkdown(body);
  const strippedNote = rendered.strippedHtml
    ? '\n<p class="readme-note">注：原文含 HTML 片段，已按安全渲染策略剥离（与预览页同一清理管线，不解释 HTML）。</p>'
    : '';
  return `<section class="readme-card">\n${head}${strippedNote}\n<div class="readme-body">${rendered.html}</div>\n</section>`;
}

export function browsePage(input: BrowsePageInput): string {
  const { vault, dirPath, entries, readme, lastCommits, viewer } = input;
  const canWrite = input.canWrite !== false; // 缺省=写者形态（见 BrowsePageInput.canWrite 注）
  const list = entries
    .map((e) => {
      const child = dirPath === '' ? e.name : `${dirPath}/${e.name}`;
      const label = escapeHtml(e.name) + (e.type === 'tree' ? '/' : '');
      const link = e.type === 'tree' ? `<a href="${browseUrl(vault.slug, child)}">${label}</a>` : e.type === 'blob' ? `<a href="${viewUrl(vault.slug, child)}">${label}</a>` : label;
      // S11-T3 最后提交元数据（批量派生——增益列）：li 携带 data-author/data-time，
      // 可见文本次要色（作者 · 相对时间），title 提示绝对时间
      const meta = lastCommits?.get(e.name);
      const metaAttrs = meta === undefined ? '' : ` data-author="${escapeHtml(meta.author)}" data-time="${escapeHtml(meta.isoTime)}"`;
      const metaHtml = meta === undefined
        ? ''
        : ` <span class="entry-meta" title="${escapeHtml(absoluteTimeText(meta.isoTime))}">${escapeHtml(meta.author)} · ${escapeHtml(relativeTimeText(meta.isoTime))}</span>`;
      // S4-T5 文件条目整理入口 + S10-T2 编辑入口（D2：既有 GET edit；仅 .md 挂——
      // 非 .md edit 404，不造死链）。写入口按 canWriteVault 渲染：reader 不见死按钮
      // （F-2）；POST 侧鉴权原样（D17）
      const ops = e.type === 'blob' && canWrite
        ? ` <span class="entry-ops">(${[
            e.name.toLowerCase().endsWith('.md') ? `<a href="${editUrl(vault.slug, child)}">编辑</a>` : '',
            `<a href="${renameUrl(vault.slug, child)}">重命名</a>`,
            `<a href="${deleteUrl(vault.slug, child)}">删除</a>`,
          ]
            .filter((s) => s !== '')
            .join(' · ')})</span>`
        : '';
      return `  <li data-type="${e.type}" data-name="${escapeHtml(e.name)}"${e.size !== undefined ? ` data-size="${e.size}"` : ''}${metaAttrs}><span class="type-tag">${TYPE_LABELS[e.type]}</span> ${link}${metaHtml}${ops}</li>`;
    })
    .join('\n');
  const readmeHtml = readmeCard(readme);
  // S4-T8（T4 遗留收口）：目录级上传入口（写者）。S10-T2：reader 同位呈现只读徽章
  // （写入口隐藏，读者明确知态——F-2 满屏死按钮修复）。S10-T3：「新建笔记」主
  // 操作位（DESIGN.md button-primary——coral 仅主 CTA；目录上下文=当前目录）
  const uploadUrl = `/vaults/${encodeURIComponent(vault.slug)}/upload${dirPath === '' ? '' : '/' + dirPath.split('/').map(encodeURIComponent).join('/')}`;
  const headOps = canWrite
    ? ` <a class="btn btn-primary" href="${newNoteUrl(vault.slug, dirPath)}">新建笔记</a> <span class="entry-ops">(<a href="${uploadUrl}">上传</a>)</span>`
    : ` ${READONLY_BADGE}`;
  // S11-T3「最近变更」入口一行（读门槛语义——编辑者与读者都可见；目标页由
  // T2 activity 模块持有，本模块只负责链接行）
  const activityLine = `<p class="page-meta"><a href="/vaults/${encodeURIComponent(vault.slug)}/activity">最近变更</a></p>`;
  return layout(
    `${vault.name} 目录`,
    `<div class="page">
  <div class="page-head">
    <h1>${escapeHtml(vault.name)}</h1>
    <nav aria-label="面包屑">${breadcrumb(vault, dirPath)}</nav>${headOps}
    ${activityLine}
  </div>
  <ul class="entries">
${list}
  </ul>
  ${readmeHtml}
</div>
`,
    '',
    viewer !== undefined ? { user: { username: viewer.username, displayName: viewer.display_name, isAdmin: viewer.is_instance_admin }, active: 'vaults' } : undefined,
  );
}

/** 空库/存储不可用态（成员已确认——非 404；如实区分「无内容」与「无权」） */
export function browseStatePage(vault: { slug: string; name: string }, message: string): string {
  return layout(
    `${vault.name} 目录`,
    `<div class="page">
  <h1>${escapeHtml(vault.name)}</h1>
  <nav aria-label="面包屑">${breadcrumb(vault, '')}</nav>
  <p class="state-note">${escapeHtml(message)}</p>
</div>
`,
  );
}

// 预览占位页（viewPlaceholderPage）——S4-T2 安全渲染落地时退役，预览页模板
// 迁至 view/pages.ts（view 路由族归 view/ 模块持有）。
