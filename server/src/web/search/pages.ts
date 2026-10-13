import { escapeHtml, layout } from '../pages.ts';
import { browseUrl, viewUrl } from '../browse/pages.ts';
import type { SearchHit } from '../../search/query.ts';

/**
 * S5-T4 搜索页模板（D5/D6 骨架裁决：服务端渲染、无框架；插值唯一通道
 * escapeHtml——与 S2-T8/S4 各 pages.ts 同规）。结果行带 data-vault/data-path/
 * data-commit/data-matched 属性（断言与一致性对账所依）；q 回显一律转义。
 */

const MATCH_LABELS: Readonly<Record<string, string>> = { title: '标题', tags: '标签', summary: '摘要' };

export interface SearchPageInput {
  readonly viewer: { username: string };
  /** 查询关键词（缺省/null=空态表单页）；页内回显须转义 */
  readonly q: string | null;
  /** 查询结果（q 非空时给定） */
  readonly result?: { hits: readonly SearchHit[]; truncated: boolean };
  /** 校验提示（如超长 q——422 同页呈现，表单可修正重查） */
  readonly notice?: string;
}

export function searchPage(input: SearchPageInput): string {
  const { q } = input;
  const form = `<form method="get" action="/search" class="search-form">
  <label for="q">关键词（标题 / 标签 / 摘要）</label>
  <input type="search" id="q" name="q" value="${q === null ? '' : escapeHtml(q)}" maxlength="200" required>
  <button type="submit">查找</button>
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
        ? '<p>无匹配结果（仅搜索你有权访问的库）。</p>'
        : `<table>
  <thead><tr><th>库</th><th>路径</th><th>标题</th><th>标签</th><th>摘要片段</th><th>命中字段</th></tr></thead>
  <tbody>
${rows}
  </tbody>
</table>
${truncated ? '<p>结果超过 100 条，仅显示前 100 条（请用更精确的关键词收窄）。</p>' : ''}`;
    resultHtml = `<h2>「${escapeHtml(q)}」的查找结果</h2>
${listing}`;
  }

  return layout(
    '查找',
    `<h1>查找</h1>
<p>当前登录：${escapeHtml(input.viewer.username)} · <a href="/">返回首页</a> · <a href="/vaults">知识库</a></p>
${input.notice === undefined ? '' : `<p class="notice">${escapeHtml(input.notice)}</p>`}
${form}
${resultHtml}
`,
  );
}
