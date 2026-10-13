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

/** 历史版本预览 URL（S5-T2：commit 参数化的只读预览） */
export function versionUrl(slug: string, commitOid: string, treePath: string): string {
  return `/vaults/${encodeURIComponent(slug)}/version/${commitOid}/${treePath.split('/').map(encodeURIComponent).join('/')}`;
}

/** 还原入口 URL（S5-T2：GET 确认页与 POST 端点同址） */
export function restoreUrl(slug: string, commitOid: string, treePath: string): string {
  return `/vaults/${encodeURIComponent(slug)}/restore/${commitOid}/${treePath.split('/').map(encodeURIComponent).join('/')}`;
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
 *  `git log --format` 对照（一致性断言所依）；分页跨页导航 rel=prev/next。
 *  路径级行附版本预览与「还原到此版本」入口（S5-T2——还原=路径域操作，
 *  库级行无路径上下文不提供）。 */
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
  const rowLinks = (oid: string): string =>
    treePath === ''
      ? ''
      : ` <a href="${versionUrl(vault.slug, oid, treePath)}">预览</a> <a href="${restoreUrl(vault.slug, oid, treePath)}">还原到此版本</a>`;
  const rows = commits
    .map(
      (c) => `  <li class="commit" data-short="${escapeHtml(c.shortOid)}" data-author="${escapeHtml(c.authorName)}" data-date="${escapeHtml(c.authorDate)}" data-oid="${escapeHtml(c.oid)}" data-email="${escapeHtml(c.authorEmail)}" data-subject="${escapeHtml(c.subject)}">${escapeHtml(c.shortOid)} ${escapeHtml(c.subject)} — ${escapeHtml(c.authorName)}（Git 元数据） ${escapeHtml(c.authorDate)} <a href="${diffUrl(vault.slug, c.oid, treePath)}">diff</a>${rowLinks(c.oid)}</li>`,
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

// ── S5-T2 历史版本预览与还原（api.md §13 S5-T2 行）──────────────────────────

/** 版本预览正文形态（rendered=渲染管输出；其余如实标注——与 view 族同判） */
export type VersionBody =
  | { kind: 'rendered'; html: string; strippedHtml: boolean }
  | { kind: 'image'; imageUrl: string }
  | { kind: 'no-preview' }
  | { kind: 'too-large'; limitBytes: number };

/**
 * 历史版本预览页（任意提交处某文件的只读预览——S4 view 渲染复用，commit
 * 参数化）：正文 HTML 仅两个来源——渲染管输出（render.ts 安全管唯一通道，
 * 与 view 页同一不变量）或本模板生成的附件通道 `<img>`（URL 经 escapeHtml）；
 * 其余文本一律 escapeHtml。页面标注所依 commit 并链接该路径历史/diff/还原
 * 入口（还原入口=确认页，写权限由其提交时的发布组件判定）。
 */
export function versionPage(input: {
  vault: { slug: string; name: string };
  commitOid: string;
  treePath: string;
  sizeBytes: number | undefined;
  body: VersionBody;
}): string {
  const { vault, commitOid, treePath, sizeBytes, body } = input;
  const name = treePath.includes('/') ? treePath.slice(treePath.lastIndexOf('/') + 1) : treePath;
  const notice =
    body.kind === 'rendered' && body.strippedHtml
      ? '\n<p>注：原文含 HTML 标签，已按安全子集剥离（预览不解释 HTML；脚本/事件属性不执行）。</p>'
      : '';
  const article =
    body.kind === 'rendered'
      ? `<article id="doc">\n${body.html}\n</article>`
      : body.kind === 'image'
        ? `<p><img src="${escapeHtml(body.imageUrl)}" alt="${escapeHtml(name)}" loading="lazy"></p>\n<p>展示与加载一律经鉴权附件通道（blob 寻址、URL 不可枚举；撤权下一请求即 404）。</p>`
        : body.kind === 'too-large'
          ? `<p>文件过大（超过渲染上限 ${body.limitBytes} 字节），未渲染正文。</p>`
          : '<p>该文件类型不提供在线预览（v1 预览仅渲染 Markdown 正文）。</p>';
  return layout(
    `${name} 历史版本 — ${vault.name}`,
    `<h1>${escapeHtml(name)}（历史版本）</h1>
<nav aria-label="面包屑">${breadcrumb(vault, treePath)}</nav>
<p>类型：文件 · 大小：${sizeBytes ?? '?'} 字节 · 历史版本 @ ${escapeHtml(commitOid)}（只读预览——以新提交还原入口见下）${notice}</p>
<p><a href="${historyUrl(vault.slug, treePath)}">该路径历史</a> · <a href="${diffUrl(vault.slug, commitOid, treePath)}">diff</a> · <a href="${restoreUrl(vault.slug, commitOid, treePath)}">还原到此版本</a></p>
${article}
`,
  );
}

/** 还原确认页提示（组件拒绝回显同页——同 rename/delete 族 OpNotice 形态） */
export interface RestoreNotice {
  readonly message: string;
  readonly code?: string;
  readonly line?: number;
  readonly hint?: string;
}

/** 还原确认页（GET 表单页与 POST 拒绝回显共用）：目标=路径@commit；还原=以
 *  新提交恢复内容（不删除历史——旧版本仍可查）。POST 表单无字段（确认即
 *  提交）；写权限由发布组件判定（页面门槛=read 成员）。 */
export function restorePage(input: {
  vault: { slug: string; name: string };
  commitOid: string;
  treePath: string;
  sizeBytes: number | undefined;
  notice?: RestoreNotice;
}): string {
  const { vault, commitOid, treePath, sizeBytes, notice } = input;
  const noticeHtml =
    notice === undefined
      ? ''
      : `\n<p class="notice">${escapeHtml(notice.message)}${notice.code !== undefined ? `（code: ${escapeHtml(notice.code)}）` : ''}${notice.hint !== undefined ? `<br>建议：${escapeHtml(notice.hint)}` : ''}</p>`;
  return layout(
    `还原 ${treePath} — ${vault.name}`,
    `<h1>还原到 ${escapeHtml(treePath)} 的历史版本</h1>
<nav aria-label="面包屑">${breadcrumb(vault, treePath)}</nav>
<p>目标版本：${escapeHtml(treePath)} @ ${escapeHtml(commitOid)} · 类型：文件 · 大小：${sizeBytes ?? '?'} 字节</p>
<p>还原将以<b>新提交</b>把该路径恢复到此版本内容（提交以当前最新内容为基线；<b>不删除历史</b>——旧版本仍可在历史与版本预览中查看）。</p>${noticeHtml}
<p><a href="${versionUrl(vault.slug, commitOid, treePath)}">先预览该版本</a> · <a href="${historyUrl(vault.slug, treePath)}">返回该路径历史</a></p>
<form method="post" action="${restoreUrl(vault.slug, commitOid, treePath)}">
  <button type="submit">还原到此版本</button>
</form>
`,
  );
}
