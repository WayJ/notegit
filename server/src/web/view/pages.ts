import { escapeHtml, layout } from '../pages.ts';

/**
 * S4-T2 预览页模板（服务端渲染、无框架；插值唯一通道 escapeHtml）。
 * 正文 HTML 来自 view/render.ts 渲染管（其安全不变量 = 输出仅渲染器白名单
 * 标签），是页面里唯一不经 escapeHtml 的拼入点——render.ts 模块注释为凭。
 *
 * UI-RESTYLE：文档阅读排版（衬线标题 + 正文 16px/1.55——DESIGN.md 字体层级，
 * 正文标签样式见 assets/styles.css `article#doc` 族）；元信息行徽章化；viewer
 * 透传顶部导航登录态（呈现层）。
 */

/** 顶部导航登录态（呈现层透传） */
export interface PageViewer {
  readonly username: string;
  readonly is_instance_admin: boolean;
}

/** 面包屑：知识库 → 库根 → 逐级目录 → 当前文件（与 browse 页同构，末段无链接） */
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

/** 文件元信息行（各预览形态共用）——徽章化呈现（「大小：N 字节」文本形态为既有断言所依） */
function metaLine(sizeBytes: number | undefined): string {
  return `<div class="meta-badges"><span class="badge">文件</span><span class="badge badge-muted">大小：${sizeBytes ?? '?'} 字节</span></div>`;
}

/** Markdown 正文预览页：frontmatter 已剥离；正文 = 安全渲染管输出 */
export function viewPage(input: {
  vault: { slug: string; name: string };
  entryPath: string;
  sizeBytes: number | undefined;
  /** renderMarkdown 输出（安全 HTML） */
  bodyHtml: string;
  /** 原文含被剥离的原始 HTML（如实标注） */
  strippedHtml: boolean;
  /** UI-RESTYLE：顶部导航登录态（可选——测试直调形态缺省） */
  viewer?: PageViewer;
}): string {
  const { vault, entryPath, sizeBytes, bodyHtml, strippedHtml, viewer } = input;
  const name = entryPath.includes('/') ? entryPath.slice(entryPath.lastIndexOf('/') + 1) : entryPath;
  const notice = strippedHtml
    ? '\n<p class="notice">注：原文含 HTML 标签，已按安全子集剥离（预览不解释 HTML；脚本/事件属性不执行）。</p>'
    : '';
  return layout(
    `${name} — ${vault.name}`,
    `<div class="page">
  <div class="page-head">
    <h1>${escapeHtml(name)}</h1>
    <nav aria-label="面包屑">${breadcrumb(vault, entryPath)} <span aria-hidden="true">›</span> ${escapeHtml(name)}</nav>
  </div>
  ${metaLine(sizeBytes)}${notice}
  <article id="doc">
${bodyHtml}
  </article>
</div>
`,
    '',
    viewer !== undefined ? { user: { username: viewer.username, isAdmin: viewer.is_instance_admin }, active: 'vaults' } : undefined,
  );
}

/** 图片附件直开页（S4-T8 T4 遗留收口：经鉴权附件通道 URL 嵌 <img>——blob 寻址、
 *  逐请求 authorize、nosniff+private；imageUrl=null=不以 image/* 服务的类型
 *  （svg 纵深防御等）——如实标注不内嵌） */
export function attachmentImagePage(input: {
  vault: { slug: string; name: string };
  entryPath: string;
  sizeBytes: number | undefined;
  /** 鉴权附件通道 URL（attachmentUrl）；null=该类型不经 image/* 服务（不内嵌） */
  imageUrl: string | null;
  /** UI-RESTYLE：顶部导航登录态（可选） */
  viewer?: PageViewer;
}): string {
  const { vault, entryPath, sizeBytes, imageUrl, viewer } = input;
  const name = entryPath.includes('/') ? entryPath.slice(entryPath.lastIndexOf('/') + 1) : entryPath;
  const media =
    imageUrl !== null
      ? `<figure class="attachment-figure"><img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(name)}" loading="lazy"></figure>`
      : '<p class="state-note">该类型不以图片方式在线展示（svg 等一律 octet-stream 服务——纵深防御；可经附件地址下载后查看）。</p>';
  return layout(
    `${name} — ${vault.name}`,
    `<div class="page">
  <div class="page-head">
    <h1>${escapeHtml(name)}</h1>
    <nav aria-label="面包屑">${breadcrumb(vault, entryPath)} <span aria-hidden="true">›</span> ${escapeHtml(name)}</nav>
  </div>
  ${metaLine(sizeBytes)}
  <p class="page-meta">展示与加载一律经鉴权附件通道（blob 寻址、URL 不可枚举；撤权下一请求即 404）。</p>
  ${media}
</div>
`,
    '',
    viewer !== undefined ? { user: { username: viewer.username, isAdmin: viewer.is_instance_admin }, active: 'vaults' } : undefined,
  );
}

/** 非 Markdown 且非图片附件：如实标注不预览（v1 预览仅渲染 .md 正文） */
export function noPreviewPage(input: {
  vault: { slug: string; name: string };
  entryPath: string;
  sizeBytes: number | undefined;
  /** UI-RESTYLE：顶部导航登录态（可选） */
  viewer?: PageViewer;
}): string {
  const { vault, entryPath, sizeBytes, viewer } = input;
  const name = entryPath.includes('/') ? entryPath.slice(entryPath.lastIndexOf('/') + 1) : entryPath;
  return layout(
    `${name} — ${vault.name}`,
    `<div class="page">
  <div class="page-head">
    <h1>${escapeHtml(name)}</h1>
    <nav aria-label="面包屑">${breadcrumb(vault, entryPath)} <span aria-hidden="true">›</span> ${escapeHtml(name)}</nav>
  </div>
  ${metaLine(sizeBytes)}
  <p class="state-note">该文件类型不提供在线预览（v1 预览仅渲染 Markdown 正文）。</p>
</div>
`,
    '',
    viewer !== undefined ? { user: { username: viewer.username, isAdmin: viewer.is_instance_admin }, active: 'vaults' } : undefined,
  );
}

/** 超过渲染上限：元信息 + 如实标注（同 README 渲染上限先例，防超大文件拖垮页面） */
export function tooLargePage(input: {
  vault: { slug: string; name: string };
  entryPath: string;
  sizeBytes: number | undefined;
  limitBytes: number;
  /** UI-RESTYLE：顶部导航登录态（可选） */
  viewer?: PageViewer;
}): string {
  const { vault, entryPath, sizeBytes, limitBytes, viewer } = input;
  const name = entryPath.includes('/') ? entryPath.slice(entryPath.lastIndexOf('/') + 1) : entryPath;
  return layout(
    `${name} — ${vault.name}`,
    `<div class="page">
  <div class="page-head">
    <h1>${escapeHtml(name)}</h1>
    <nav aria-label="面包屑">${breadcrumb(vault, entryPath)} <span aria-hidden="true">›</span> ${escapeHtml(name)}</nav>
  </div>
  ${metaLine(sizeBytes)}
  <p class="state-note">文件过大（超过渲染上限 ${limitBytes} 字节），未渲染正文。</p>
</div>
`,
    '',
    viewer !== undefined ? { user: { username: viewer.username, isAdmin: viewer.is_instance_admin }, active: 'vaults' } : undefined,
  );
}
