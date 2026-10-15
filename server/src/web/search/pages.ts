import { escapeHtml, layout } from '../pages.ts';
import { browseUrl, viewUrl } from '../browse/pages.ts';
import type { SearchHit } from '../../search/query.ts';

/**
 * S5-T4 搜索页模板（服务端渲染、无框架；插值唯一通道 escapeHtml——与 S2-T8/
 * S4 各 pages.ts 同规）。结果行带 data-vault/data-path/data-commit/data-matched
 * 属性（断言与一致性对账所依）；q 回显一律转义。
 *
 * UI-RESTYLE：DESIGN.md 视觉契约落位——表单行（输入 + 珊瑚主按钮）、结果表
 * 包裹层（<768px 卡内横滚不溢出）、提示块语义色。结果行 data-* 属性序列为
 * 断言所依——原样保留。
 *
 * S15-T1 库筛选 + ⌘K（W04/DOD-E4-05；S15 D1/D3）：表单行加库下拉（GET 参
 * 数 vault，默认 all——选项=全部+有权库，routes 传 vaultOptions 实时成员面，
 * 无权库不入选项）；vault=<无权或不存在 slug> 不回显不报错（D-IC-06 同形态
 * 空命中）；⌘K/Ctrl-K 聚焦搜索框进本页唯一内联 script 块（无 JS 时 GET 表
 * 单仍可提交——渐进增强）。
 */

const MATCH_LABELS: Readonly<Record<string, string>> = { title: '标题', tags: '标签', summary: '摘要' };

/**
 * ⌘K/Ctrl-K 聚焦搜索框（S15 D1：仅 /search 页内，不做全局快捷键）。页内增强
 * 脚本——layout() 并入本页唯一内联 script 块（与账户菜单脚本同块）；无 JS 时
 * GET 表单仍可提交，功能不受影响（渐进增强）。
 */
const SEARCH_KBD_SCRIPT = `
(function () {
  var q = document.getElementById('q');
  if (q === null) return; // 表单缺位页面零行为
  document.addEventListener('keydown', function (ev) {
    if ((ev.metaKey || ev.ctrlKey) && ev.key === 'k') {
      ev.preventDefault();
      q.focus();
    }
  });
})();
`;

export interface SearchPageInput {
  readonly viewer: { username: string; is_instance_admin?: boolean };
  /** 查询关键词（缺省/null=空态表单页）；页内回显须转义 */
  readonly q: string | null;
  /** 查询结果（q 非空时给定） */
  readonly result?: { hits: readonly SearchHit[]; truncated: boolean };
  /** 校验提示（如超长 q——422 同页呈现，表单可修正重查） */
  readonly notice?: string;
  /** S15-T1 库筛选下拉选项=当前员工有权库（routes 实时 listVaults——无权库不入选项）；缺省=仅「全部库」 */
  readonly vaultOptions?: readonly { readonly slug: string; readonly name: string }[];
  /** S15-T1 当前选中值（'all'=全部库；无权/不存在 slug 无对应选项——不回显，浏览器回落首项） */
  readonly vault?: string;
}

export function searchPage(input: SearchPageInput): string {
  const { q } = input;
  const vaultSelected = input.vault ?? 'all';
  const vaultOptions = [
    `<option value="all"${vaultSelected === 'all' ? ' selected' : ''}>全部库</option>`,
    ...(input.vaultOptions ?? []).map(
      (v) =>
        `<option value="${escapeHtml(v.slug)}"${vaultSelected === v.slug ? ' selected' : ''}>${escapeHtml(v.name)}（${escapeHtml(v.slug)}）</option>`,
    ),
  ].join('\n    ');
  const form = `<form method="get" action="/search" class="search-form">
  <label for="q">关键词（标题 / 标签 / 摘要）</label>
  <input type="search" id="q" name="q" value="${q === null ? '' : escapeHtml(q)}" maxlength="200" required>
  <label for="vault">库</label>
  <select id="vault" name="vault">
    ${vaultOptions}
  </select>
  <button type="submit" class="btn-primary">查找</button>
</form>`;

  let resultHtml = '';
  if (q !== null && input.result !== undefined) {
    const { hits, truncated } = input.result;
    const rows = hits
      .map((hit) => {
        const matchedLabels = hit.matched.map((m) => MATCH_LABELS[m] ?? m).join('、');
        return `  <tr data-vault="${escapeHtml(hit.vaultSlug)}" data-path="${escapeHtml(hit.path)}" data-commit="${escapeHtml(hit.commitOid)}" data-matched="${escapeHtml(hit.matched.join(','))}">
    <td><a href="${browseUrl(hit.vaultSlug, '')}">${escapeHtml(hit.vaultName)}</a></td>
    <td><a href="${viewUrl(hit.vaultSlug, hit.path)}">${escapeHtml(hit.path)}</a></td>
    <td>${hit.title === null ? '<em>（无标题——frontmatter 豁免文件）</em>' : escapeHtml(hit.title)}</td>
    <td>${hit.tags.length === 0 ? '' : escapeHtml(hit.tags.join('、'))}</td>
    <td>${escapeHtml(hit.summary)}</td>
    <td>${escapeHtml(matchedLabels)}</td>
  </tr>`;
      })
      .join('\n');
    const listing =
      hits.length === 0
        ? '<p class="state-note">无匹配结果（仅搜索你有权访问的库）。</p>'
        : `<div class="table-wrap">
<table>
  <thead><tr><th>库</th><th>路径</th><th>标题</th><th>标签</th><th>摘要片段</th><th>命中字段</th></tr></thead>
  <tbody>
${rows}
  </tbody>
</table>
</div>
${truncated ? '<p class="notice">结果超过 100 条，仅显示前 100 条（请用更精确的关键词收窄）。</p>' : ''}`;
    resultHtml = `<h2>「${escapeHtml(q)}」的查找结果</h2>
${listing}`;
  }

  return layout(
    '查找',
    `<div class="page">
  <div class="page-head">
  <h1>查找</h1>
  <p class="page-meta">当前登录：${escapeHtml(input.viewer.username)} · <a href="/">返回首页</a> · <a href="/vaults">知识库</a></p>
  </div>
  ${input.notice === undefined ? '' : `<p class="warn-block">${escapeHtml(input.notice)}</p>`}
  ${form}
  ${resultHtml}
</div>
`,
    SEARCH_KBD_SCRIPT, // S15-T1 ⌘K 聚焦（页内增强——并入本页唯一内联 script 块）
    {
      user: { username: input.viewer.username, isAdmin: input.viewer.is_instance_admin === true },
      active: 'search',
    },
  );
}
