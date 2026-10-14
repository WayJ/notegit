import { escapeHtml, layout } from '../pages.ts';
import type { VaultListItem } from '../../vaults/service.ts';
import type { TreeEntry } from './tree.ts';

/**
 * S4-T1 浏览族页面模板（服务端渲染、无框架；插值唯一通道 escapeHtml，与 S2-T8
 * pages.ts 同规）。数据页不做页内 fetch——列表与目录每次请求实时渲染（实时查
 * 权限/默认分支，D-IC-05 精神），与「外壳 + fetch」的管理页分工不同。
 *
 * UI-RESTYLE：DESIGN.md 视觉契约落位——库列表为卡片网格（feature-card 形态）、
 * 目录条目为表格化列表（条目集与序仍与 `git ls-tree` 同集同序，仅呈现）、README
 * 为米色导航卡；viewer 透传顶部导航登录态（呈现层）。
 */

/** 顶部导航登录态（呈现层透传——S2-T8「管理入口可见性」判定不在此） */
export interface PageViewer {
  readonly username: string;
  readonly is_instance_admin: boolean;
}

const ROLE_LABELS: Readonly<Record<string, string>> = { admin: '管理员', editor: '编辑者', reader: '读者' };

/** 有权库列表页（架构 §4.2：未授权的库不进入列表） */
export function vaultListPage(
  user: { username: string; is_instance_admin?: boolean },
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
    <p class="page-meta">当前登录：${escapeHtml(user.username)} · <a href="/">返回首页</a></p>
  </div>
  ${listing}
</div>
`,
    '',
    {
      user: { username: user.username, isAdmin: user.is_instance_admin === true },
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
  /** README.md 内容（escapeHtml 渲染为纯文本导航）；null=无/超限不渲染；'too-large'=超限标注 */
  readonly readme: string | null | 'too-large';
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
 * §5.2——README 无 frontmatter 不属错误，页面零校验、原样展示）。
 */
export function browsePage(input: BrowsePageInput): string {
  const { vault, dirPath, entries, readme, viewer } = input;
  const canWrite = input.canWrite !== false; // 缺省=写者形态（见 BrowsePageInput.canWrite 注）
  const list = entries
    .map((e) => {
      const child = dirPath === '' ? e.name : `${dirPath}/${e.name}`;
      const label = escapeHtml(e.name) + (e.type === 'tree' ? '/' : '');
      const link = e.type === 'tree' ? `<a href="${browseUrl(vault.slug, child)}">${label}</a>` : e.type === 'blob' ? `<a href="${viewUrl(vault.slug, child)}">${label}</a>` : label;
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
      return `  <li data-type="${e.type}" data-name="${escapeHtml(e.name)}"${e.size !== undefined ? ` data-size="${e.size}"` : ''}><span class="type-tag">${TYPE_LABELS[e.type]}</span> ${link}${ops}</li>`;
    })
    .join('\n');
  const readmeHtml =
    readme === 'too-large'
      ? '<section class="readme-card">\n<h2>README.md <small>（导航文档 · 豁免 frontmatter）</small></h2>\n<p>README 过大（超过渲染上限），未渲染正文。</p>\n</section>'
      : readme === null
        ? ''
        : `<section class="readme-card">\n<h2>README.md <small>（导航文档 · 豁免 frontmatter）</small></h2>\n<pre>${escapeHtml(readme)}</pre>\n</section>`;
  // S4-T8（T4 遗留收口）：目录级上传入口（写者）。S10-T2：reader 同位呈现只读徽章
  // （写入口隐藏，读者明确知态——F-2 满屏死按钮修复）。S10-T3：「新建笔记」主
  // 操作位（DESIGN.md button-primary——coral 仅主 CTA；目录上下文=当前目录）
  const uploadUrl = `/vaults/${encodeURIComponent(vault.slug)}/upload${dirPath === '' ? '' : '/' + dirPath.split('/').map(encodeURIComponent).join('/')}`;
  const headOps = canWrite
    ? ` <a class="btn btn-primary" href="${newNoteUrl(vault.slug, dirPath)}">新建笔记</a> <span class="entry-ops">(<a href="${uploadUrl}">上传</a>)</span>`
    : ` ${READONLY_BADGE}`;
  return layout(
    `${vault.name} 目录`,
    `<div class="page">
  <div class="page-head">
    <h1>${escapeHtml(vault.name)}</h1>
    <nav aria-label="面包屑">${breadcrumb(vault, dirPath)}</nav>${headOps}
  </div>
  <ul class="entries">
${list}
  </ul>
  ${readmeHtml}
</div>
`,
    '',
    viewer !== undefined ? { user: { username: viewer.username, isAdmin: viewer.is_instance_admin }, active: 'vaults' } : undefined,
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
