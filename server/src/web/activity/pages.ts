import { escapeHtml, layout, activityEntryRow } from '../pages.ts';
import type { ActivityEntry } from './query.ts';

/**
 * S11-T2 库内最近变更页模板（服务端渲染、无脚本；插值唯一通道 escapeHtml——
 * 条目行 activityEntryRow 为首页区块共用件，同形态）。数据源=审计成功发布行
 * （web/activity/query.ts——sprint S11 D3 派生即审计）；条目主体=服务端审计
 * 记录的认证员工（DOD-03——commit 作者为 Git 元数据，不入主体）。
 */

/** activity 页 URL（browse/history 入口链接用——逐段编码） */
export function activityUrl(slug: string): string {
  return `/vaults/${encodeURIComponent(slug)}/activity`;
}

/** 库内最近变更页：面包屑 + 条目列表（新→旧）+ 主体标注 */
export function vaultActivityPage(input: {
  vault: { slug: string; name: string };
  viewer: { username: string; is_instance_admin?: boolean };
  entries: readonly ActivityEntry[];
}): string {
  const { vault, viewer, entries } = input;
  const vaultHref = `/vaults/${encodeURIComponent(vault.slug)}`;
  const listing =
    entries.length === 0
      ? '<p class="state-note">尚无最近变更（发布动作产生后在此呈现）。</p>'
      : `<ul class="commits">\n${entries.map(activityEntryRow).join('\n')}\n</ul>`;
  return layout(
    `${vault.name} 最近变更`,
    `<div class="page">
  <div class="page-head">
  <h1>${escapeHtml(vault.name)} 最近变更</h1>
  <nav aria-label="面包屑"><a href="/vaults">知识库</a> <span aria-hidden="true">›</span> <a href="${vaultHref}/browse">${escapeHtml(vault.name)}</a> <span aria-hidden="true">›</span> 最近变更</nav>
  <p class="page-meta">当前登录：${escapeHtml(viewer.username)} · 数据源=服务端审计（成功发布事件，最近 ${entries.length} 条） · <a href="${vaultHref}/browse">返回目录</a> · <a href="${vaultHref}/history">提交历史</a></p>
  </div>
  ${listing}
  <p class="note">条目主体=服务端审计记录的认证员工（commit 作者为 Git 元数据展示，推送方可填写任意值——DOD-03）。</p>
</div>
`,
    '',
    {
      user: { username: viewer.username, isAdmin: viewer.is_instance_admin === true },
      active: 'vaults',
    },
  );
}
