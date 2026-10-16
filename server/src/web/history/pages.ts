import { escapeHtml, formatRelativeTime, layout } from '../pages.ts';
import { editUrl } from '../view/pages.ts';
import type { CommitEntry } from './log.ts';
import { formatCitation } from './cite.ts';

/**
 * S5-T1 历史族页面模板（服务端渲染、无框架；插值唯一通道 escapeHtml）。
 * 安全不变量同 S4-T2 渲染管：输出中的标签/属性全部由本模板生成，文本（提交
 * 主题/作者/路径/diff 行）仅经 escapeHtml 进入输出——diff 视图据此满足「diff
 * 文本转义」（原文 HTML 永不被解释执行）。
 *
 * UI-RESTYLE：DESIGN.md 视觉契约落位——diff/引用代码视图走深色代码窗卡
 * （code-window 形态：surface-dark + 等宽），提交行为卡列表；还原拒绝回显
 * error 语义色（E-码 + 修正建议）。行类 data-kind 与提交行 data-* 属性为
 * 一致性断言所依——原样保留。
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
    `<a href="${browseHref(vault.slug)}">${escapeHtml(vault.name)}</a>`,
    `<a href="${historyUrl(vault.slug, '')}">提交历史</a>`,
  ];
  let acc = '';
  for (const seg of treePath.split('/').filter((s) => s !== '')) {
    acc = acc === '' ? seg : `${acc}/${seg}`;
    parts.push(`<a href="${historyUrl(vault.slug, acc)}">${escapeHtml(seg)}</a>`);
  }
  return parts.join(' <span aria-hidden="true">›</span> ');
}

function browseHref(slug: string): string {
  return `/vaults/${encodeURIComponent(slug)}/browse`;
}

/** 主体标注（库级/路径级历史页共用；S21-T2/B6 页级说明——不逐行括注）：
 *  作者与时间为提交记录自带信息，主体=认证员工（员工可读表述） */
const AUTHOR_NOTE =
  '<p class="note">提交人与提交时间为 Git 元数据（推送方可自行填写，不代表登录身份）；站内操作记录以认证员工为准。</p>';

/** 历史页（库级 treePath='' / 路径级 treePath=树路径）：提交行 data 属性与
 *  `git log --format` 对照（一致性断言所依）；分页跨页导航 rel=prev/next。
 *  路径级行附版本预览与「还原到此版本」入口（S5-T2——还原=路径域操作，
 *  库级行无路径上下文不提供）。库级行 diff 入口 = 该提交涉及文件的逐文件
 *  diff 链接（S10-T1 D3——空 treePath 直链 diff 必然 404，死链形态不再生成）。 */
export function historyPage(input: {
  vault: { slug: string; name: string };
  /** 当前认证员工（主体视角呈现——与作者元数据区分） */
  viewer: { username: string; display_name?: string; is_instance_admin?: boolean };
  treePath: string;
  commits: readonly CommitEntry[];
  page: number;
  hasMore: boolean;
  /** S10-T1：写权判定（canWriteVault——路径级 .md 行渲染「编辑此页」/reader 只读
   *  徽章；缺省不判定（测试直调形态））。edit 表单仅 .md——非 .md 路径不渲染
   *  （edit GET 对非 .md 一律 404，不得生成死链）。 */
  canWrite?: boolean;
}): string {
  const { vault, viewer, treePath, commits, page, hasMore, canWrite } = input;
  const scope = treePath === '' ? '（全库）' : `—— ${escapeHtml(treePath)}`;
  const isMd = treePath.toLowerCase().endsWith('.md');
  const editEntry =
    canWrite === undefined || !isMd
      ? ''
      : canWrite
        ? ` · <a href="${editUrl(vault.slug, treePath)}">编辑此页</a>`
        : ' · <span class="badge">只读</span>';
  // 返回目录 = 该路径的所在目录（browse 只列目录——文件路径 browse 一律 404，
  // 不得作为链接生成；S10-T1 链接健康所依）
  const parentDir = treePath.includes('/') ? treePath.slice(0, treePath.lastIndexOf('/')) : '';
  const backToBrowse = `/vaults/${encodeURIComponent(vault.slug)}/browse${
    parentDir === '' ? '' : '/' + parentDir.split('/').map(encodeURIComponent).join('/')
  }`;
  const diffLinks = (c: CommitEntry): string =>
    treePath === ''
      ? (c.files ?? []).map((f) => ` <a href="${diffUrl(vault.slug, c.oid, f)}">diff ${escapeHtml(f)}</a>`).join('')
      : ` <a href="${diffUrl(vault.slug, c.oid, treePath)}">diff</a>`;
  const rowLinks = (oid: string): string =>
    treePath === ''
      ? ''
      : ` <a href="${versionUrl(vault.slug, oid, treePath)}">预览</a> <a href="${restoreUrl(vault.slug, oid, treePath)}">还原到此版本</a> <code class="citation">${escapeHtml(formatCitation(vault.slug, treePath, oid))}</code>`;
  // S21-T2/B6：历史行两段式——主行=短 OID＋提交主题；次行=作者 · 相对时间
  // （title=ISO 绝对时间——全站相对时间统一）· diff/预览/还原链接。「（Git
  // 元数据）」逐行括注退役，由页级 AUTHOR_NOTE 说明承担。data-* 属性序列
  // 原样保留（一致性断言与 fixtures pageCommitSeq 提取所依）。
  const rows = commits
    .map(
      (c) => `  <li class="commit" data-short="${escapeHtml(c.shortOid)}" data-author="${escapeHtml(c.authorName)}" data-date="${escapeHtml(c.authorDate)}" data-oid="${escapeHtml(c.oid)}" data-email="${escapeHtml(c.authorEmail)}" data-subject="${escapeHtml(c.subject)}">
    <div class="commit-main"><code class="commit-oid">${escapeHtml(c.shortOid)}</code> <span class="commit-subject">${escapeHtml(c.subject)}</span></div>
    <div class="commit-meta"><span title="${escapeHtml(c.authorDate)}">${escapeHtml(c.authorName)} · ${escapeHtml(formatRelativeTime(c.authorDate))}</span>${diffLinks(c)}${rowLinks(c.oid)}</div>
  </li>`,
    )
    .join('\n');
  const listing =
    commits.length === 0
      ? '<p class="state-note">没有提交记录（路径可能从未存在或未在默认分支出现）。</p>'
      : `<ul class="commits">\n${rows}\n</ul>`;
  const pager =
    `<nav class="pager" aria-label="分页">` +
    (page > 1 ? `<a rel="prev" href="${historyUrl(vault.slug, treePath)}?page=${page - 1}">上一页</a> ` : '') +
    (hasMore ? `<a rel="next" href="${historyUrl(vault.slug, treePath)}?page=${page + 1}">下一页</a>` : '') +
    `</nav>`;
  return layout(
    `${vault.name} 提交历史`,
    `<div class="page">
  <div class="page-head">
  <h1>${escapeHtml(vault.name)} 提交历史${scope}</h1>
  <nav aria-label="面包屑">${breadcrumb(vault, treePath)}</nav>
  <p class="page-sub page-sub-quiet">默认分支实时读 Git · <a href="${backToBrowse}">返回目录</a>${editEntry}</p>
  </div>
  ${listing}
  ${pager}
  ${AUTHOR_NOTE}
</div>
`,
    '',
    {
      user: { username: viewer.username, displayName: viewer.display_name, isAdmin: viewer.is_instance_admin === true },
      active: 'vaults',
    },
  );
}

/** 空库/存储不可用态（成员已确认——非 404；如实区分「无内容」与「无权」）。
 *  S12-T2（coordinator 批准扩展）：可选 viewer → 顶栏账户位（缺省兼容旧调用形态）。 */
export function historyStatePage(
  vault: { slug: string; name: string },
  message: string,
  viewer?: { username: string; display_name?: string; is_instance_admin?: boolean },
): string {
  return layout(
    `${vault.name} 提交历史`,
    `<div class="page">
  <h1>${escapeHtml(vault.name)} 提交历史</h1>
  <nav aria-label="面包屑">${breadcrumb(vault, '')}</nav>
  <p class="state-note">${escapeHtml(message)}</p>
</div>
`,
    '',
    viewer !== undefined
      ? { user: { username: viewer.username, displayName: viewer.display_name, isAdmin: viewer.is_instance_admin === true }, active: 'vaults' }
      : undefined,
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
 *  所依）；空 diff = 该提交未触及此路径，如实标注。深色代码窗卡呈现。 */
export function diffPage(input: {
  vault: { slug: string; name: string };
  commitOid: string;
  treePath: string;
  diff: string;
  /** S12-T2（coordinator 批准扩展）：可选 viewer → 顶栏账户位 */
  viewer?: { username: string; display_name?: string; is_instance_admin?: boolean };
}): string {
  const { vault, commitOid, treePath, diff, viewer } = input;
  const body =
    diff === ''
      ? '<p class="state-note">该提交未修改此文件（diff 为空）。</p>'
      : `<pre class="diff-body">${diff
          .split('\n')
          .filter((l, idx, arr) => !(l === '' && idx === arr.length - 1)) // 去尾空行（git 输出行尾换行）
          .map((l) => `<span class="diff-line" data-kind="${diffLineKind(l)}">${escapeHtml(l)}</span>`)
          .join('')}</pre>`;
  return layout(
    `${treePath} diff — ${vault.name}`,
    `<div class="page">
  <div class="page-head">
  <h1>diff — ${escapeHtml(treePath)}</h1>
  <nav aria-label="面包屑">${breadcrumb(vault, treePath)}</nav>
  <p class="page-meta">提交 ${escapeHtml(commitOid)}（父提交 ↔ 目标）· <a href="${historyUrl(vault.slug, treePath)}">该路径历史</a></p>
  <p class="page-meta">diff 内容按纯文本转义呈现（原文 HTML 不被解释执行——S4-T2 安全管不变量）。</p>
  </div>
  ${body}
</div>
`,
    '',
    viewer !== undefined
      ? { user: { username: viewer.username, displayName: viewer.display_name, isAdmin: viewer.is_instance_admin === true }, active: 'vaults' }
      : undefined,
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
 * 入口（还原入口=确认页，写权限由其提交时的发布组件判定）；S10-T1 增编辑
 * 入口（canWriteVault 门控——如实标注编辑对象=当前 HEAD 内容，非此历史快照）。
 */
export function versionPage(input: {
  vault: { slug: string; name: string };
  commitOid: string;
  treePath: string;
  sizeBytes: number | undefined;
  body: VersionBody;
  /** S10-T1：写权判定（canWriteVault——.md 渲染形态渲染编辑入口 / reader 只读
   *  徽章；缺省不判定（测试直调形态））。仅 rendered 形态提供：edit 表单仅
   *  知识 Markdown——其余形态不生成（edit GET 对非 .md 一律 404）。 */
  canWrite?: boolean;
  /** S12-T2（coordinator 批准扩展）：可选 viewer → 顶栏账户位 */
  viewer?: { username: string; display_name?: string; is_instance_admin?: boolean };
}): string {
  const { vault, commitOid, treePath, sizeBytes, body, canWrite, viewer } = input;
  const name = treePath.includes('/') ? treePath.slice(treePath.lastIndexOf('/') + 1) : treePath;
  // 编辑入口如实标注：edit 路由编辑的始终是该文件当前分支内容（HEAD）——非此历史快照
  const editEntry =
    body.kind !== 'rendered' || canWrite === undefined
      ? ''
      : canWrite
        ? ` · <a href="${editUrl(vault.slug, treePath)}">编辑当前版本</a>（编辑器打开该文件当前最新内容，非此历史版本）`
        : ' · <span class="badge">只读</span>';
  const notice =
    body.kind === 'rendered' && body.strippedHtml
      ? '\n<p class="notice">注：原文含 HTML 标签，已按安全子集剥离（预览不解释 HTML；脚本/事件属性不执行）。</p>'
      : '';
  const article =
    body.kind === 'rendered'
      ? `<article id="doc">\n${body.html}\n</article>`
      : body.kind === 'image'
        ? `<p><img src="${escapeHtml(body.imageUrl)}" alt="${escapeHtml(name)}" loading="lazy"></p>\n<p class="page-meta">展示与加载一律经鉴权附件通道（blob 寻址、URL 不可枚举；撤权下一请求即 404）。</p>`
        : body.kind === 'too-large'
          ? `<p class="state-note">文件过大（超过渲染上限 ${body.limitBytes} 字节），未渲染正文。</p>`
          : '<p class="state-note">该文件类型不提供在线预览（v1 预览仅渲染 Markdown 正文）。</p>';
  return layout(
    `${name} 历史版本 — ${vault.name}`,
    `<div class="page">
  <div class="page-head">
  <h1>${escapeHtml(name)}（历史版本）</h1>
  <nav aria-label="面包屑">${breadcrumb(vault, treePath)}</nav>
  <p class="page-meta">类型：文件 · 大小：${sizeBytes ?? '?'} 字节 · 历史版本 @ ${escapeHtml(commitOid)}（只读预览——以新提交还原入口见下）${notice}</p>
  <p class="page-meta"><a href="${historyUrl(vault.slug, treePath)}">该路径历史</a> · <a href="${diffUrl(vault.slug, commitOid, treePath)}">diff</a> · <a href="${restoreUrl(vault.slug, commitOid, treePath)}">还原到此版本</a>${editEntry}</p>
  </div>
  <p class="cite-line">复制引用（库 / 路径 @ commit 三要素——与 Agent 报告引用格式一致，经 <a href="/cite">引用解析</a> 可回放本页）：<code class="citation">${escapeHtml(formatCitation(vault.slug, treePath, commitOid))}</code></p>
  ${article}
</div>
`,
    '',
    viewer !== undefined
      ? { user: { username: viewer.username, displayName: viewer.display_name, isAdmin: viewer.is_instance_admin === true }, active: 'vaults' }
      : undefined,
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
      : `\n<p class="op-error" role="alert"><strong>${escapeHtml(notice.message)}${notice.code !== undefined ? `（code: ${escapeHtml(notice.code)}）` : ''}</strong>${notice.line !== undefined ? `（第 ${notice.line} 行）` : ''}${notice.hint !== undefined ? `<br><small>建议：${escapeHtml(notice.hint)}</small>` : ''}</p>`;
  return layout(
    `还原 ${treePath} — ${vault.name}`,
    `<div class="page page-narrow">
  <div class="page-head">
  <h1>还原到 ${escapeHtml(treePath)} 的历史版本</h1>
  <nav aria-label="面包屑">${breadcrumb(vault, treePath)}</nav>
  <p class="page-meta">目标版本：${escapeHtml(treePath)} @ ${escapeHtml(commitOid)} · 类型：文件 · 大小：${sizeBytes ?? '?'} 字节</p>
  <p class="page-meta">还原将以<b>新提交</b>把该路径恢复到此版本内容（提交以当前最新内容为基线；<b>不删除历史</b>——旧版本仍可在历史与版本预览中查看）。</p>
  </div>${noticeHtml}
  <p class="page-meta"><a href="${versionUrl(vault.slug, commitOid, treePath)}">先预览该版本</a> · <a href="${historyUrl(vault.slug, treePath)}">返回该路径历史</a></p>
  <form method="post" action="${restoreUrl(vault.slug, commitOid, treePath)}" class="form-card">
  <div class="form-actions">
  <button type="submit" class="btn-primary">还原到此版本</button>
  </div>
  </form>
</div>
`,
  );
}

// ── S5-T6 引用解析入口与失败页（api.md §13 S5-T6 行）──────────────────────

/** 引用三要素格式说明（入口页/格式失败页共用文案——期望形态唯一来源） */
const CITE_FORMAT_HINT = '库 / 路径 @ commit（例：v-handbook / docs/getting-started.md @ 4c55b7a0d1e2f3a4）';

/** 引用解析入口页（GET /cite 空输入：粘贴表单 + 格式说明——GET 表单、无 JS） */
export function citeEntryPage(viewer?: { username: string; display_name?: string; is_instance_admin?: boolean }): string {
  return layout(
    '引用解析',
    `<div class="page page-narrow">
  <h1>引用解析</h1>
  <p>粘贴文档引用（三要素），解析到对应历史版本页：</p>
  <div class="form-card">
  <form method="get" action="/cite">
  <label for="c">引用（库 / 路径 @ commit）</label>
  <input type="text" name="c" id="c" size="64" placeholder="v-handbook / docs/getting-started.md @ 4c55b7a0d1e2f3a4">
  <div class="form-actions">
  <button type="submit" class="btn-primary">解析</button>
  </div>
  </form>
  </div>
  <p class="page-meta">期望格式：${escapeHtml(CITE_FORMAT_HINT)}——与 Agent 报告引用格式一致（回答引用可对应到 Web 历史）。</p>
</div>
`,
    '',
    viewer !== undefined
      ? { user: { username: viewer.username, displayName: viewer.display_name, isAdmin: viewer.is_instance_admin === true }, active: 'cite' }
      : { active: 'cite' },
  );
}

/** 引用格式失败页（404）：非三要素形态的可理解错误（静态同页——只谈格式，不触库判定） */
export function citeFormatErrorPage(viewer?: { username: string; display_name?: string; is_instance_admin?: boolean }): string {
  return layout(
    '引用格式无法解析',
    `<div class="page page-narrow">
  <h1>引用格式无法解析</h1>
  <p class="state-note">收到的引用不是「库 / 路径 @ commit」三要素形态，无法解析。</p>
  <p class="page-meta">期望格式：${escapeHtml(CITE_FORMAT_HINT)}。</p>
  <p><a href="/cite">返回引用解析入口</a></p>
</div>
`,
    '',
    viewer !== undefined
      ? { user: { username: viewer.username, displayName: viewer.display_name, isAdmin: viewer.is_instance_admin === true }, active: 'cite' }
      : { active: 'cite' },
  );
}

/** 引用存在性失败页（404 反存在性）：已过权限判定的引用未能对应任何历史版本。
 *  静态同页不区分原因（提交未知/非提交对象/该路径在该提交处不存在——不泄露
 *  库内容）；无权/未知库不在此页（D-IC-06 与页面族同页同码 404）。 */
export function citeUnresolvablePage(viewer?: { username: string; display_name?: string; is_instance_admin?: boolean }): string {
  return layout(
    '引用无法解析',
    `<div class="page page-narrow">
  <h1>引用无法解析</h1>
  <p class="state-note">引用未能对应到任何历史版本页（提交未知、非提交对象，或该路径在该提交处不存在——按反存在性语义不区分原因）。</p>
  <p class="page-meta">可核对引用三要素后经 <a href="/cite">引用解析入口</a> 重试，或在对应库的提交历史页查证。</p>
</div>
`,
    '',
    viewer !== undefined
      ? { user: { username: viewer.username, displayName: viewer.display_name, isAdmin: viewer.is_instance_admin === true }, active: 'cite' }
      : { active: 'cite' },
  );
}
