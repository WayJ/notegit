import { escapeHtml, layout } from '../pages.ts';

/**
 * S4-T5 重命名/删除页模板（D5 极简：服务端渲染、无框架；插值唯一通道
 * escapeHtml）。与 edit/pages.ts 同构——面包屑模块各自持有（D5：不改共享文件）。
 */

/** 面包屑（与 edit/pages.ts 同构——模块各自持有） */
function breadcrumb(vault: { slug: string; name: string }, entryPath: string): string {
  const parts = [
    `<a href="/vaults">知识库</a>`,
    `<a href="/vaults/${encodeURIComponent(vault.slug)}/browse">${escapeHtml(vault.name)}</a>`,
  ];
  const slash = entryPath.lastIndexOf('/');
  let acc = '';
  for (const seg of (slash === -1 ? [] : entryPath.slice(0, slash).split('/'))) {
    acc = acc === '' ? seg : `${acc}/${seg}`;
    parts.push(
      `<a href="/vaults/${encodeURIComponent(vault.slug)}/browse/${acc
        .split('/')
        .map(encodeURIComponent)
        .join('/')}">${escapeHtml(seg)}</a>`,
    );
  }
  return parts.join(' <span aria-hidden="true">›</span> ');
}

/** 树路径 → URL（逐段编码；与 browse/pages.ts 同规则） */
function encPath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/');
}

export interface OpNotice {
  readonly code?: string;
  readonly message: string;
  /** 校验 issue 的行定位（E-FM 码映射——validation §6.2 fields） */
  readonly line?: number;
}

function noticeHtml(notice: OpNotice | undefined): string {
  if (notice === undefined) return '';
  const code = notice.code === undefined ? '' : `<code>${escapeHtml(notice.code)}</code> `;
  const line = notice.line === undefined ? '' : `（第 ${notice.line} 行）`;
  return `<p class="op-error" role="alert"><strong>${code}</strong>${escapeHtml(notice.message)}${escapeHtml(line)}</p>`;
}

export interface RenamePageInput {
  readonly vault: { slug: string; name: string };
  readonly from: string;
  /** 当前输入值（GET 预填源路径；失败回显用户提交值） */
  readonly to: string;
  readonly notice?: OpNotice;
}

/** 重命名表单页（GET 无写操作；POST 走发布组件——写权限在提交时判定） */
export function renamePage(input: RenamePageInput): string {
  const { vault, from, to, notice } = input;
  const action = `/vaults/${encodeURIComponent(vault.slug)}/rename/${encPath(from)}`;
  const cancelHref = from.includes('/')
    ? `/vaults/${encodeURIComponent(vault.slug)}/browse/${encPath(from.slice(0, from.lastIndexOf('/')))}`
    : `/vaults/${encodeURIComponent(vault.slug)}/browse`;
  return layout(
    `重命名 ${from}`,
    `<h1>重命名</h1>
<nav aria-label="面包屑">${breadcrumb(vault, from)}</nav>
${noticeHtml(notice)}
<form method="post" action="${action}">
<p>原路径：<code>${escapeHtml(from)}</code></p>
<label>新路径（库内绝对路径，可含子目录；文件名须含扩展名）<br>
<input type="text" name="to" value="${escapeHtml(to)}" required maxlength="1024"></label>
<p><small>规则：改为 <code>.md</code> 须有合法 frontmatter（title 必填）；改名为 <code>README.md</code> 豁免 frontmatter（大小写不敏感）。</small></p>
<button type="submit">保存重命名</button>
<a href="${cancelHref}">取消</a>
</form>
`,
  );
}

export interface DeleteConfirmInput {
  readonly vault: { slug: string; name: string };
  readonly path: string;
  readonly notice?: OpNotice;
}

/** 删除确认页（GET 无写操作；历史保留如实标注——S5 历史页可查旧版本） */
export function deleteConfirmPage(input: DeleteConfirmInput): string {
  const { vault, path, notice } = input;
  const action = `/vaults/${encodeURIComponent(vault.slug)}/delete/${encPath(path)}`;
  const cancelHref = path.includes('/')
    ? `/vaults/${encodeURIComponent(vault.slug)}/browse/${encPath(path.slice(0, path.lastIndexOf('/')))}`
    : `/vaults/${encodeURIComponent(vault.slug)}/browse`;
  return layout(
    `删除 ${path}`,
    `<h1>删除确认</h1>
<nav aria-label="面包屑">${breadcrumb(vault, path)}</nav>
${noticeHtml(notice)}
<p>将删除：<code>${escapeHtml(path)}</code></p>
<p><small>说明：删除不做元数据校验；Git 历史保留——旧提交中的历史版本仍可查（后续历史/还原功能基于此）。</small></p>
<form method="post" action="${action}">
<button type="submit">确认删除</button>
<a href="${cancelHref}">取消</a>
</form>
`,
  );
}

/** 存储/读取不可用态（成员已确认——非 404；与 browseStatePage 同规） */
export function opStatePage(vault: { slug: string; name: string }, message: string): string {
  return layout(
    `${vault.name} 操作`,
    `<h1>${escapeHtml(vault.name)}</h1>
<nav aria-label="面包屑">${breadcrumb(vault, '')}</nav>
<p>${escapeHtml(message)}</p>
`,
  );
}
