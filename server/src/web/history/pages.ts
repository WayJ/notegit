import { escapeHtml, layout } from '../pages.ts';
import type { CommitEntry } from './log.ts';

/**
 * S5-T1 历史族页面模板（D6：S4 web 骨架同规——服务端渲染、无框架；插值唯一
 * 通道 escapeHtml）。安全不变量同 S4-T2 渲染管：输出中的标签/属性全部由本
 * 模板生成，文本（提交主题/作者/路径/diff 行）仅经 escapeHtml 进入输出——
 * diff 视图据此满足「diff 文本转义」（原文 HTML 永不被解释执行）。
 */

/** 历史页 URL（逐段编码；空路径 = 库级历史） */
export function historyUrl(slug: string, treePath: string): string {
  const enc = treePath.split('/').map(encodeURIComponent).join('/');
  return `/vaults/${encodeURIComponent(slug)}/history${enc === '' ? '' : '/' + enc}`;
}

/** 逐文件 diff URL（目标提交全 OID + 树路径） */
export function diffUrl(slug: string, commitOid: string, treePath: string): string {
  return `/vaults/${encodeURIComponent(slug)}/diff/${commitOid}/${treePath.split('/').map(encodeURIComponent).join('/')}`;
}

/** 面包屑：知识库 → 库根 → 逐级目录（历史页复用浏览族导航语义；当前段无链接） */
function breadcrumb(vault: { slug: string; name: string }, treePath: string): string {
  const parts = [
    `<a href="/vaults">知识库</a>`,
    `<a href="/vaults/${encodeURIComponent(vault.slug)}/browse">${escapeHtml(vault.name)}</a>`,
    `<a href="${historyUrl(vault.slug, '')}">提交历史</a>`,
  ];
  let acc = '';
  for (const seg of treePath.split('/').filter((s) => s !== '')) {
    acc = acc === '' ? seg : `${acc}/${seg}`;
    parts.push(`<a href="${historyUrl(vault.slug, acc)}">${escapeHtml(seg)}</a>`);
  }
  return parts.join(' <span aria-hidden="true">›</span> ');
}

/** DOD-03 主体标注（库级/路径级历史页共用）：作者=可填写元数据，主体=认证员工 */
const AUTHOR_NOTE =
  '<p class="note">提交作者为 Git 元数据展示（推送方可填写任意值）；操作主体以服务端审计记录的认证员工为准（DOD-03）。</p>';

/** 历史页（库级 treePath='' / 路径级 treePath=树路径）：提交行 data 属性与
 *  `git log --format` 对照（一致性断言所依）；分页跨页导航 rel=prev/next。 */
export function historyPage(input: {
  vault: { slug: string; name: string };
  /** 当前认证员工（主体视角呈现——与作者元数据区分） */
  viewer: { username: string };
  treePath: string;
  commits: readonly CommitEntry[];
  page: number;
  hasMore: boolean;
}): string {
  const { vault, viewer, treePath, commits, page, hasMore } = input;
  const scope = treePath === '' ? '（全库）' : `—— ${escapeHtml(treePath)}`;
  const rows = commits
    .map(
      (c) => `  <li class="commit" data-short="${escapeHtml(c.shortOid)}" data-author="${escapeHtml(c.authorName)}" data-date="${escapeHtml(c.authorDate)}" data-oid="${escapeHtml(c.oid)}" data-email="${escapeHtml(c.authorEmail)}" data-subject="${escapeHtml(c.subject)}">${escapeHtml(c.shortOid)} ${escapeHtml(c.subject)} — ${escapeHtml(c.authorName)}（Git 元数据） ${escapeHtml(c.authorDate)} <a href="${diffUrl(vault.slug, c.oid, treePath)}">diff</a></li>`,
    )
    .join('\n');
  const listing =
    commits.length === 0
      ? '<p>没有提交记录（路径可能从未存在或未在默认分支出现）。</p>'
      : `<ul class="commits">\n${rows}\n</ul>`;
  const pager =
    `<nav class="pager" aria-label="分页">` +
    (page > 1 ? `<a rel="prev" href="${historyUrl(vault.slug, treePath)}?page=${page - 1}">上一页</a> ` : '') +
    (hasMore ? `<a rel="next" href="${historyUrl(vault.slug, treePath)}?page=${page + 1}">下一页</a>` : '') +
    `</nav>`;
  return layout(
    `${vault.name} 提交历史`,
    `<h1>${escapeHtml(vault.name)} 提交历史${scope}</h1>
<p>当前登录：${escapeHtml(viewer.username)} · 默认分支实时读 Git · <a href="/vaults/${encodeURIComponent(vault.slug)}/browse${treePath === '' ? '' : '/' + treePath.split('/').map(encodeURIComponent).join('/')}">返回目录</a></p>
<nav aria-label="面包屑">${breadcrumb(vault, treePath)}</nav>
${listing}
${pager}
${AUTHOR_NOTE}
`,
  );
}

/** 空库/存储不可用态（成员已确认——非 404；如实区分「无内容」与「无权」） */
export function historyStatePage(vault: { slug: string; name: string }, message: string): string {
  return layout(
    `${vault.name} 提交历史`,
    `<h1>${escapeHtml(vault.name)} 提交历史</h1>
<nav aria-label="面包屑">${breadcrumb(vault, '')}</nav>
<p>${escapeHtml(message)}</p>
`,
  );
}

/** diff 行类别（前缀判定——与 git diff 原文形态一一对应；内容不参与判定） */
function diffLineKind(line: string): 'add' | 'del' | 'ctx' | 'meta' {
  if (
    line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('--- ') ||
    line.startsWith('+++ ') || line.startsWith('@@') || line.startsWith('new ') ||
    line.startsWith('deleted ') || line.startsWith('old mode') || line.startsWith('new mode') ||
    line.startsWith('similarity ') || line.startsWith('rename ') || line.startsWith('copy ') ||
    line.startsWith('Binary ') || line.startsWith('\\')
  ) {
    return 'meta';
  }
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'ctx';
}

/** 逐文件 diff 页（父提交↔目标）：diff 原文逐行转义呈现（data-kind 标注行类，
 *  行序列与 `git diff --no-color <父> <目标> -- <路径>` 原文一致——一致性断言
 *  所依）；空 diff = 该提交未触及此路径，如实标注。 */
export function diffPage(input: {
  vault: { slug: string; name: string };
  commitOid: string;
  treePath: string;
  diff: string;
}): string {
  const { vault, commitOid, treePath, diff } = input;
  const body =
    diff === ''
      ? '<p>该提交未修改此文件（diff 为空）。</p>'
      : `<pre class="diff-body">${diff
          .split('\n')
          .filter((l, idx, arr) => !(l === '' && idx === arr.length - 1)) // 去尾空行（git 输出行尾换行）
          .map((l) => `<span class="diff-line" data-kind="${diffLineKind(l)}">${escapeHtml(l)}</span>`)
          .join('')}</pre>`;
  return layout(
    `${treePath} diff — ${vault.name}`,
    `<h1>diff — ${escapeHtml(treePath)}</h1>
<nav aria-label="面包屑">${breadcrumb(vault, treePath)}</nav>
<p>提交 ${escapeHtml(commitOid)}（父提交 ↔ 目标）· <a href="${historyUrl(vault.slug, treePath)}">该路径历史</a></p>
<p>diff 内容按纯文本转义呈现（原文 HTML 不被解释执行——S4-T2 安全管不变量）。</p>
${body}
`,
  );
}
