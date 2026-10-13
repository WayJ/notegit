import { escapeHtml, layout } from '../pages.ts';

/**
 * S4-T2 预览页模板（D5 极简：服务端渲染、无框架；插值唯一通道 escapeHtml）。
 * 正文 HTML 来自 view/render.ts 渲染管（其安全不变量 = 输出仅渲染器白名单
 * 标签），是页面里唯一不经 escapeHtml 的拼入点——render.ts 模块注释为凭。
 */

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

/** 文件元信息行（各预览形态共用） */
function metaLine(sizeBytes: number | undefined): string {
  return `<p>类型：文件 · 大小：${sizeBytes ?? '?'} 字节</p>`;
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
}): string {
  const { vault, entryPath, sizeBytes, bodyHtml, strippedHtml } = input;
  const name = entryPath.includes('/') ? entryPath.slice(entryPath.lastIndexOf('/') + 1) : entryPath;
  const notice = strippedHtml
    ? '\n<p>注：原文含 HTML 标签，已按安全子集剥离（预览不解释 HTML；脚本/事件属性不执行）。</p>'
    : '';
  return layout(
    `${name} — ${vault.name}`,
    `<h1>${escapeHtml(name)}</h1>
<nav aria-label="面包屑">${breadcrumb(vault, entryPath)} <span aria-hidden="true">›</span> ${escapeHtml(name)}</nav>
${metaLine(sizeBytes)}${notice}
<article id="doc">
${bodyHtml}
</article>
`,
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
}): string {
  const { vault, entryPath, sizeBytes, imageUrl } = input;
  const name = entryPath.includes('/') ? entryPath.slice(entryPath.lastIndexOf('/') + 1) : entryPath;
  const media =
    imageUrl !== null
      ? `<img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(name)}" loading="lazy">`
      : '<p>该类型不以图片方式在线展示（svg 等一律 octet-stream 服务——纵深防御；可经附件地址下载后查看）。</p>';
  return layout(
    `${name} — ${vault.name}`,
    `<h1>${escapeHtml(name)}</h1>
<nav aria-label="面包屑">${breadcrumb(vault, entryPath)} <span aria-hidden="true">›</span> ${escapeHtml(name)}</nav>
${metaLine(sizeBytes)}
<p>展示与加载一律经鉴权附件通道（blob 寻址、URL 不可枚举；撤权下一请求即 404）。</p>
${media}
`,
  );
}

/** 非 Markdown 且非图片附件：如实标注不预览（v1 预览仅渲染 .md 正文） */
export function noPreviewPage(input: {
  vault: { slug: string; name: string };
  entryPath: string;
  sizeBytes: number | undefined;
}): string {
  const { vault, entryPath, sizeBytes } = input;
  const name = entryPath.includes('/') ? entryPath.slice(entryPath.lastIndexOf('/') + 1) : entryPath;
  return layout(
    `${name} — ${vault.name}`,
    `<h1>${escapeHtml(name)}</h1>
<nav aria-label="面包屑">${breadcrumb(vault, entryPath)} <span aria-hidden="true">›</span> ${escapeHtml(name)}</nav>
${metaLine(sizeBytes)}
<p>该文件类型不提供在线预览（v1 预览仅渲染 Markdown 正文）。</p>
`,
  );
}

/** 超过渲染上限：元信息 + 如实标注（同 README 渲染上限先例，防超大文件拖垮页面） */
export function tooLargePage(input: {
  vault: { slug: string; name: string };
  entryPath: string;
  sizeBytes: number | undefined;
  limitBytes: number;
}): string {
  const { vault, entryPath, sizeBytes, limitBytes } = input;
  const name = entryPath.includes('/') ? entryPath.slice(entryPath.lastIndexOf('/') + 1) : entryPath;
  return layout(
    `${name} — ${vault.name}`,
    `<h1>${escapeHtml(name)}</h1>
<nav aria-label="面包屑">${breadcrumb(vault, entryPath)} <span aria-hidden="true">›</span> ${escapeHtml(name)}</nav>
${metaLine(sizeBytes)}
<p>文件过大（超过渲染上限 ${limitBytes} 字节），未渲染正文。</p>
`,
  );
}
