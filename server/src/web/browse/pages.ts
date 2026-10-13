import { escapeHtml, layout } from '../pages.ts';
import type { VaultListItem } from '../../vaults/service.ts';
import type { TreeEntry } from './tree.ts';

/**
 * S4-T1 浏览族页面模板（D5 极简：服务端渲染、无框架；插值唯一通道 escapeHtml，
 * 与 S2-T8 pages.ts 同规）。数据页不做页内 fetch——列表与目录每次请求实时渲染
 * （实时查权限/默认分支，D-IC-05 精神），与「外壳 + fetch」的管理页分工不同。
 */

const ROLE_LABELS: Readonly<Record<string, string>> = { admin: '管理员', editor: '编辑者', reader: '读者' };

/** 有权库列表页（架构 §4.2：未授权的库不进入列表） */
export function vaultListPage(user: { username: string }, vaults: readonly VaultListItem[]): string {
  const rows = vaults
    .map(
      (v) => `  <tr>
    <td><a href="/vaults/${encodeURIComponent(v.slug)}/browse">${escapeHtml(v.name)}</a></td>
    <td>${escapeHtml(v.slug)}</td>
    <td>${ROLE_LABELS[v.role] ?? escapeHtml(v.role)}</td>
  </tr>`,
    )
    .join('');
  const listing =
    vaults.length === 0
      ? '<p>暂无有权访问的库。</p>'
      : `<table>
  <thead><tr><th>名称</th><th>slug</th><th>我的角色</th></tr></thead>
  <tbody>
${rows}
  </tbody>
</table>`;
  return layout(
    '知识库',
    `<h1>知识库</h1>
<p>当前登录：${escapeHtml(user.username)} · <a href="/">返回首页</a></p>
${listing}
`,
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
}

/**
 * 目录浏览页：条目序列与 `git ls-tree` 同集同序（li data-type/data-name，
 * 一致性断言所依）；README.md 渲染为目录导航并标注 frontmatter 豁免（架构
 * §5.2——README 无 frontmatter 不属错误，页面零校验、原样展示）。
 */
export function browsePage(input: BrowsePageInput): string {
  const { vault, dirPath, entries, readme } = input;
  const list = entries
    .map((e) => {
      const child = dirPath === '' ? e.name : `${dirPath}/${e.name}`;
      const label = escapeHtml(e.name) + (e.type === 'tree' ? '/' : '');
      const link = e.type === 'tree' ? `<a href="${browseUrl(vault.slug, child)}">${label}</a>` : e.type === 'blob' ? `<a href="${viewUrl(vault.slug, child)}">${label}</a>` : label;
      // S4-T5：文件条目附整理操作入口（页面无写操作——写权限在 POST 提交时判定）
      const ops = e.type === 'blob'
        ? ` <span class="entry-ops">(<a href="${renameUrl(vault.slug, child)}">重命名</a> · <a href="${deleteUrl(vault.slug, child)}">删除</a>)</span>`
        : '';
      return `  <li data-type="${e.type}" data-name="${escapeHtml(e.name)}"${e.size !== undefined ? ` data-size="${e.size}"` : ''}>${TYPE_LABELS[e.type]} ${link}${ops}</li>`;
    })
    .join('\n');
  const readmeHtml =
    readme === 'too-large'
      ? '<h2>README.md <small>（导航文档 · 豁免 frontmatter）</small></h2>\n<p>README 过大（超过渲染上限），未渲染正文。</p>'
      : readme === null
        ? ''
        : `<h2>README.md <small>（导航文档 · 豁免 frontmatter）</small></h2>\n<pre>${escapeHtml(readme)}</pre>`;
  return layout(
    `${vault.name} 目录`,
    `<h1>${escapeHtml(vault.name)}</h1>
<nav aria-label="面包屑">${breadcrumb(vault, dirPath)}</nav>
<ul class="entries">
${list}
</ul>
${readmeHtml}
`,
  );
}

/** 空库/存储不可用态（成员已确认——非 404；如实区分「无内容」与「无权」） */
export function browseStatePage(vault: { slug: string; name: string }, message: string): string {
  return layout(
    `${vault.name} 目录`,
    `<h1>${escapeHtml(vault.name)}</h1>
<nav aria-label="面包屑">${breadcrumb(vault, '')}</nav>
<p>${escapeHtml(message)}</p>
`,
  );
}

// 预览占位页（viewPlaceholderPage）——S4-T2 安全渲染落地时退役，预览页模板
// 迁至 view/pages.ts（view 路由族归 view/ 模块持有）。
