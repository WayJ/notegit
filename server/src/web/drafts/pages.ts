import { escapeHtml, layout, formatRelativeTime } from '../pages.ts';
import type { MyDraftRow } from './query.ts';

/**
 * S12-T2 我的草稿页模板（服务端渲染、无页面自有脚本——顶栏账户脚本由 layout
 * 并入；插值唯一通道 escapeHtml）。条目=库 slug（browse 入口链接）/路径/更新
 * 时间（相对时间，与最近变更条目同形态件 formatRelativeTime）/「继续编辑」
 * （既有 edit 页——写入面不动，本页只读）。
 */

/** edit 页 URL（与 browse/view 的 editUrl 同构；逐段编码，中文/空格名可安全往返） */
function editHref(slug: string, path: string): string {
  return `/vaults/${encodeURIComponent(slug)}/edit/${path.split('/').map(encodeURIComponent).join('/')}`;
}

/** 草稿条目行（data 属性为一致性断言所依——与 activity-item 同提取形态） */
function draftRow(r: MyDraftRow): string {
  const vaultHref = `/vaults/${encodeURIComponent(r.vaultSlug)}`;
  return `<li class="commit draft-item" data-vault="${escapeHtml(r.vaultSlug)}" data-path="${escapeHtml(r.path)}" data-when="${escapeHtml(r.updatedAt)}"><a href="${vaultHref}">${escapeHtml(r.vaultSlug)}</a> · <code>${escapeHtml(r.path)}</code> · 更新于 <time datetime="${escapeHtml(r.updatedAt)}">${escapeHtml(formatRelativeTime(r.updatedAt))}</time> · <a href="${editHref(r.vaultSlug, r.path)}">继续编辑</a></li>`;
}

/** 我的草稿页：跨库本人现行草稿列表（空态如实；过滤口径页面标注） */
export function draftsPage(input: {
  viewer: { username: string; displayName?: string; isAdmin: boolean };
  rows: readonly MyDraftRow[];
}): string {
  const { viewer, rows } = input;
  const listing =
    rows.length === 0
      ? '<p class="state-note">尚无本人草稿（在编辑页「保存草稿」后，跨库草稿在此汇总呈现）。</p>'
      : `<ul class="commits">\n${rows.map(draftRow).join('\n')}\n</ul>`;
  return layout(
    '我的草稿',
    `<div class="page">
  <div class="page-head">
  <h1>我的草稿</h1>
  <p class="page-sub page-sub-quiet">跨库列出本人现行草稿（${rows.length} 条） · <a href="/">返回首页</a></p>
  </div>
  ${listing}
  <p class="note">仅本人可见（草稿按作者私有）；按你的库成员关系过滤——已撤权库的草稿行不呈现（草稿数据保留，重新获权后恢复可见）；「继续编辑」回到对应库的编辑页。</p>
</div>
`,
    '',
    {
      user: {
        username: viewer.username,
        isAdmin: viewer.isAdmin,
        ...(viewer.displayName !== undefined ? { displayName: viewer.displayName } : {}),
      },
      active: 'drafts',
    },
  );
}
