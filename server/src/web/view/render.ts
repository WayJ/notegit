/**
 * S4-T2 Markdown 安全渲染管（breakdown §2.3：HTML 清理、URL 协议白名单、
 * 脚本/事件属性剥离；架构 §6「Markdown 预览清理 HTML、限制 URL 协议」）。
 *
 * 安全不变量（XSS 样本集全清的依据）：
 * 1. 原文文本仅经 escapeHtml 进入输出；输出中的标签/属性全部由本渲染器自身
 *    生成（服务端清理唯一通道——原文 HTML 永不被解释执行）；
 * 2. 原始 HTML 一律剥离：危险容器（script/iframe/style/…）连内容整段剥离，
 *    其余标签只剥标签保留正文，注释整段丢弃，未闭合标签弃至串尾（同浏览器
 *    「EOF in tag」语义）；
 * 3. URL 协议白名单：http/https/相对/锚点；含控制字符或空白的 URL 一律拒载
 *    （浏览器 URL 解析会先剥离制表符等，`java\tscript:` 类混淆必须整体拒绝）；
 * 4. 仓库相对图片经附件回调出鉴权 URL（S4-T4 附件路由接口；未接入 → 占位标注）。
 *
 * v1 支持子集（D5 极简路线）：标题/段落/无序有序列表（平级）/引用（嵌套递归）/
 * GFM 表格/围栏代码块/分隔线/链接/图片/强调/行内码/硬换行。不支持：行内 HTML
 * 解释（一律剥离）、参考式链接、setext 标题、缩进代码块、任务列表、自动链接、
 * 表格对齐样式（th/td 不出 style，白名单外属性一律不生成）。
 */

/** 渲染选项 */
export interface RenderOptions {
  /** 仓库相对图片 → 鉴权附件 URL（S4-T4 附件路由接口占位）；返回 null = 通道
   *  未接入 → 页面占位标注。入参为 Markdown 原始相对路径（相对当前文档）。 */
  readonly attachmentImageUrl?: (repoRelPath: string) => string | null;
}

/** 渲染结果 */
export interface RenderResult {
  /** 安全 HTML 片段（仅白名单标签；可直接拼入页面） */
  readonly html: string;
  /** 原文含被剥离的原始 HTML（页面如实标注用） */
  readonly strippedHtml: boolean;
}

/** HTML 文本转义（与 web/pages.ts 同规则；渲染管不依赖页面层） */
function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// ── URL 协议白名单 ──────────────────────────────────────────────────────────

type UrlKind = 'http' | 'https' | 'relative' | 'anchor' | 'refused';

/** 白名单判定：http(s)/无协议（相对/锚点）放行；其余协议与含空白/控制字符的
 *  URL 一律 refused（拒载）。 */
export function classifyUrl(rawUrl: string): UrlKind {
  const u = rawUrl.trim();
  if (u === '' || /[\x00-\x20\x7f]/.test(u)) return 'refused'; // 空白/控制字符：混淆一律拒
  const m = /^([a-zA-Z][a-zA-Z0-9+.\-]*):/.exec(u);
  if (m === null) return u.startsWith('#') ? 'anchor' : 'relative';
  const scheme = m[1].toLowerCase();
  return scheme === 'http' || scheme === 'https' ? scheme : 'refused';
}

// ── 原始 HTML 剥离 ──────────────────────────────────────────────────────────

/** 危险容器标签：连内容整段剥离（脚本载荷与可走私执行构造的宿主） */
const STRIP_WITH_CONTENT = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template',
  'svg', 'math', 'title', 'textarea', 'frameset', 'frame', 'applet',
]);
/** 危险空标签：只剥标签（无内容可剥） */
const STRIP_TAG_ONLY = new Set(['meta', 'link', 'base']);

type ParsedTag = { name: string; end: number } | 'unclosed' | null;

/** 解析 `<` 起始的一个标签：闭合返回 {name,end>；有名字但无 `>` 返回 'unclosed'
 *  （弃至串尾，同浏览器 EOF-in-tag）；形态不明返回 null（按普通文本转义）。 */
function parseTag(s: string, start: number): ParsedTag {
  let i = start + 1;
  if (s[i] === '/') i++;
  const nameM = /^[a-zA-Z][a-zA-Z0-9]*/.exec(s.slice(i));
  if (nameM === null) return null;
  const name = nameM[0];
  i += name.length;
  // 属性扫描：名 [= "值" | '值' | 裸值]…直到 >（引号内可含 >）
  while (i < s.length) {
    const c = s[i];
    if (c === '>') return { name, end: i + 1 };
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const attrName = /^[a-zA-Z_:][a-zA-Z0-9_:.-]*/.exec(s.slice(i));
    if (attrName === null) return null; // 形态不明 → 普通文本
    i += attrName[0].length;
    let j = i;
    while (j < s.length && /\s/.test(s[j])) j++;
    if (s[j] === '=') {
      j++;
      while (j < s.length && /\s/.test(s[j])) j++;
      const q = s[j];
      if (q === '"' || q === "'") {
        const close = s.indexOf(q, j + 1);
        if (close === -1) return 'unclosed'; // 引号未闭合：弃至串尾
        j = close + 1;
      } else {
        while (j < s.length && !/\s/.test(s[j]) && s[j] !== '>') j++;
      }
      i = j;
    } // 无值属性（disabled 等）→ 继续下一轮
  }
  return 'unclosed';
}

/** 剥离原始 HTML：危险容器连内容丢弃、其余剥标签保留正文、注释整段丢弃。
 *  返回剥离后的纯文本（未转义——统一交给后续 escapeHtml）。 */
function stripRawHtml(s: string, ctx: RenderCtx): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] !== '<') {
      out += s[i];
      i++;
      continue;
    }
    if (s.startsWith('<!--', i)) {
      const close = s.indexOf('-->', i + 4);
      ctx.stripped = true;
      i = close === -1 ? s.length : close + 3; // 注释整段丢弃（未闭合弃至串尾）
      continue;
    }
    const tag = parseTag(s, i);
    if (tag === null) {
      out += '<'; // 非标签形态的 < 按普通文本转义
      i++;
      continue;
    }
    ctx.stripped = true;
    if (tag === 'unclosed') {
      i = s.length; // 未闭合标签：弃至串尾（浏览器同语义，属性文本不外泄）
      continue;
    }
    const name = tag.name.toLowerCase();
    if (STRIP_WITH_CONTENT.has(name)) {
      const closeRe = new RegExp(`</${name}\\s*>`, 'i'); // 危险容器：连内容剥到闭合
      const close = closeRe.exec(s.slice(tag.end));
      i = close === null ? s.length : tag.end + close.index + close[0].length;
      continue;
    }
    i = tag.end; // 其余标签（含危险空标签与普通开/闭标签）：只剥标签
  }
  return out;
}

// ── 行内渲染 ────────────────────────────────────────────────────────────────

interface RenderCtx {
  readonly tokens: string[]; // 已定形安全片段（含转义；可内嵌更早的占位符）
  readonly attachmentImageUrl?: (repoRelPath: string) => string | null;
  stripped: boolean;
}

/** 占位符：\x00N\x00（输入已剔除 \x00 不可伪造；escapeHtml 不触碰 \x00） */
function token(ctx: RenderCtx, html: string): string {
  ctx.tokens.push(html);
  return `\x00${ctx.tokens.length - 1}\x00`;
}

/** 占位符代换：token 只内嵌更小序号 token，逐轮展开至无占位符 */
function resolve(s: string, ctx: RenderCtx): string {
  while (s.includes('\x00')) {
    s = s.replace(/\x00(\d+)\x00/g, (_m, n: string) => ctx.tokens[Number(n)] ?? '');
  }
  return s;
}

/** 链接目的地 + 可选标题 解析（`(dest "title")` 部分）；malformed 返回 null */
function parseDestination(s: string, start: number): { url: string; title?: string; end: number } | null {
  let i = start;
  while (i < s.length && /\s/.test(s[i])) i++;
  let url: string;
  if (s[i] === '<') {
    const close = s.indexOf('>', i + 1);
    if (close === -1) return null;
    url = s.slice(i + 1, close);
    i = close + 1;
  } else {
    let depth = 0;
    const j0 = i;
    while (i < s.length) {
      const c = s[i];
      if (c === '\\' && i + 1 < s.length) {
        i += 2;
        continue;
      }
      if (c === '(') depth++;
      else if (c === ')') {
        if (depth === 0) break;
        depth--;
      } else if (/\s/.test(c)) break;
      i++;
    }
    if (depth !== 0 || i === j0) return null;
    url = s.slice(j0, i);
  }
  let title: string | undefined;
  let j = i;
  while (j < s.length && /\s/.test(s[j])) j++;
  if (s[j] === '"' || s[j] === "'") {
    const q = s[j];
    const close = s.indexOf(q, j + 1);
    if (close === -1) return null;
    title = s.slice(j + 1, close);
    j = close + 1;
  }
  while (j < s.length && /\s/.test(s[j])) j++;
  if (s[j] !== ')') return null;
  return { url, title, end: j + 1 };
}

/** 行内管线次序：码距保护 → 反斜杠转义 → 原始 HTML 剥离 → 链接/图片 →
 *  统一转义 → 强调。先码距后剥离，保证代码内容逐字展示不被「清理」改写。 */
function renderInline(src: string, ctx: RenderCtx, depth: number): string {
  let s = src;
  // 1) 码距（内容原样转义成 token——内联码不做任何二次渲染）
  s = s.replace(/(`+)([\s\S]*?)\1/g, (_w, fence: string, body: string) => {
    let content = body;
    if (/^ [\s\S]* $/.test(content) && content.trim() !== '') content = content.slice(1, -1);
    return token(ctx, `<code>${escapeHtml(content).replaceAll('\n', ' ')}</code>`);
  });
  // 2) 反斜杠转义（CommonMark 可转义标点；先于剥离——`\<` 不开标签）
  s = s.replace(/\\([!-/:-@[-`{-~])/g, (_w, p: string) => token(ctx, escapeHtml(p)));
  // 3) 原始 HTML 剥离（标签/属性/危险内容永不进入后续阶段）
  s = stripRawHtml(s, ctx);
  // 4) 图片与链接（目的地先定形；链接文字递归行内渲染，depth 防病态嵌套）
  s = renderLinksAndImages(s, ctx, depth);
  // 5) 其余文本统一转义
  s = escapeHtml(s);
  // 6) 强调（在已转义文本上配对；token 为不透明原子，可被包裹）
  s = renderEmphasis(s, ctx, 0);
  return s;
}

/** 图片/链接替换：`![alt](dest)` 与 `[text](dest "title")`（仅行内式） */
function renderLinksAndImages(s: string, ctx: RenderCtx, depth: number): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const isImage = s[i] === '!' && s[i + 1] === '[';
    const isLink = s[i] === '[';
    if (!isImage && !isLink) {
      out += s[i];
      i++;
      continue;
    }
    const bracket = i + (isImage ? 1 : 0);
    let bracketDepth = 0;
    let close = -1;
    for (let j = bracket + 1; j < s.length; j++) {
      const c = s[j];
      if (c === '\\') {
        j++;
        continue;
      }
      if (c === '[') bracketDepth++;
      else if (c === ']') {
        if (bracketDepth === 0) {
          close = j;
          break;
        }
        bracketDepth--;
      }
    }
    if (close === -1 || s[close + 1] !== '(') {
      out += s[i]; // 非行内链接形态（含参考式——v1 不支持）：按普通文本走
      i++;
      continue;
    }
    const inner = s.slice(bracket + 1, close);
    const dest = parseDestination(s, close + 2);
    if (dest === null) {
      out += s[i];
      i++;
      continue;
    }
    const kind = classifyUrl(dest.url);
    if (isImage) {
      const alt = inner.replaceAll('\n', ' ');
      if (kind === 'http' || kind === 'https') {
        out += token(ctx, `<img src="${escapeHtml(dest.url)}" alt="${escapeHtml(alt)}">`);
      } else if (kind === 'relative') {
        const url = ctx.attachmentImageUrl?.(dest.url) ?? null;
        out +=
          url !== null
            ? token(ctx, `<img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}">`)
            : token(
                ctx,
                `<span class="img-attachment" data-attachment="${escapeHtml(dest.url)}">附件图片「${escapeHtml(alt)}」将经鉴权附件通道加载（S4-T4 接入）</span>`,
              );
      } else {
        out += token(ctx, `<span class="img-refused">图片未加载（地址不在白名单）：${escapeHtml(alt)}</span>`);
      }
    } else {
      const innerHtml = depth >= 2 ? escapeHtml(inner) : renderInline(inner, ctx, depth + 1);
      if (kind === 'refused') {
        out += innerHtml; // 拒载：文字保留，不生成锚点
      } else {
        const title = dest.title !== undefined ? ` title="${escapeHtml(dest.title)}"` : '';
        out += token(ctx, `<a href="${escapeHtml(dest.url)}"${title}>${innerHtml}</a>`);
      }
    }
    i = dest.end;
  }
  return out;
}

/** 强调：**强** / *弱* / __强__ / _弱_（_ 要求词边界，避开 snake_case） */
function renderEmphasis(s: string, ctx: RenderCtx, depth: number): string {
  if (depth > 6) return s;
  s = s.replace(/(\*\*|__)(?=\S)([\s\S]+?)(?<=\S)\1/g, (_w, _open: string, inner: string) =>
    token(ctx, `<strong>${renderEmphasis(inner, ctx, depth + 1)}</strong>`),
  );
  s = s.replace(/(?<!\*)\*(?=[^\s*])([^*]+?)(?<=[^\s*])\*(?!\*)/g, (_w, inner: string) =>
    token(ctx, `<em>${renderEmphasis(inner, ctx, depth + 1)}</em>`),
  );
  s = s.replace(/(?<![\w\\])_(?=[^\s_])([^_]+?)(?<=[^\s_])_(?!\w)/g, (_w, inner: string) =>
    token(ctx, `<em>${renderEmphasis(inner, ctx, depth + 1)}</em>`),
  );
  return s;
}

// ── 块级渲染 ────────────────────────────────────────────────────────────────

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*#*[ \t]*$/;
const HR = /^ {0,3}(?:(?:\*[ \t]*){3,}$|(?:-[ \t]*){3,}$|(?:_[ \t]*){3,}$)/;
const QUOTE = /^ {0,3}>/;
const UL_ITEM = /^ {0,3}([-+*])[ \t]+(.*)$/;
const OL_ITEM = /^ {0,3}(\d{1,9})[.)][ \t]+(.*)$/;
const TABLE_DELIM = /^\s*\|? *:?-+:? *(?:\| *:?-+:? *)*\|?\s*$/;
const HTML_BLOCK = /^ {0,3}<[a-zA-Z!/?]/;

function fenceCloseRe(marker: string, len: number): RegExp {
  const ch = marker === '`' ? '`' : '~';
  return new RegExp(`^ {0,3}${ch}{${len},}[ \\t]*$`);
}

/** 表格行切分：`\|` 为字面竖线；首尾整列空且行以 | 包边时去首尾空列 */
function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && line[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (c === '|') {
      cells.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  cells.push(cur);
  if (cells.length > 1 && cells[0].trim() === '' && line.trimStart().startsWith('|')) cells.shift();
  if (cells.length > 1 && cells[cells.length - 1].trim() === '' && line.trimEnd().endsWith('|')) cells.pop();
  return cells;
}

/** 块级行状态机（renderMarkdown 与引用递归共用；返回未代换占位符的块序列） */
function renderBlockLines(lines: readonly string[], ctx: RenderCtx): string[] {
  const out: string[] = [];
  let para: string[] = [];
  const flushPara = (): void => {
    if (para.length === 0) return;
    emitPara(out, para, ctx);
    para = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '') {
      flushPara();
      i++;
      continue;
    }

    // 围栏代码块（内容逐字转义——代码块不做任何二次渲染）
    const fence = FENCE_OPEN.exec(line);
    if (fence !== null && para.length === 0) {
      const info = fence[2].trim();
      const cls = /^[\w+.-]+$/.test(info) ? ` class="language-${escapeHtml(info)}"` : '';
      const closeRe = fenceCloseRe(fence[1][0], fence[1].length);
      const body: string[] = [];
      i++;
      while (i < lines.length && !closeRe.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // 跳过闭合围栏（未闭合则到尾——如实渲染已有内容）
      out.push(`<pre><code${cls}>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      flushPara();
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2] ?? '', ctx, 0)}</h${level}>`);
      i++;
      continue;
    }

    if (HR.test(line)) {
      flushPara();
      out.push('<hr>');
      i++;
      continue;
    }

    // 引用（剥离 > 前缀递归；嵌套引用自然递归）
    if (QUOTE.test(line)) {
      flushPara();
      const quoted: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        quoted.push(lines[i].replace(/^ {0,3}>[ \t]?/, ''));
        i++;
      }
      out.push(`<blockquote>\n${renderBlockLines(quoted, ctx).join('\n')}\n</blockquote>`);
      continue;
    }

    // 平级列表（同族标记开新项；惰性续行并入当前项；另一族标记终止本表）
    const ul = UL_ITEM.exec(line);
    const ol = OL_ITEM.exec(line);
    if ((ul !== null || ol !== null) && para.length === 0) {
      const ordered = ol !== null;
      const items: string[] = [];
      let current: string | null = null;
      while (i < lines.length) {
        const l = lines[i];
        const same = ordered ? OL_ITEM.exec(l) : UL_ITEM.exec(l);
        const other = ordered ? UL_ITEM.exec(l) : OL_ITEM.exec(l);
        if (same !== null) {
          if (current !== null) items.push(current);
          current = same[2];
          i++;
        } else if (
          other === null &&
          current !== null &&
          l.trim() !== '' &&
          !FENCE_OPEN.test(l) &&
          !HEADING.test(l) &&
          !QUOTE.test(l)
        ) {
          current += ` ${l.trim()}`;
          i++;
        } else {
          break;
        }
      }
      if (current !== null) items.push(current);
      const lis = items.map((it) => `  <li>${renderInline(it, ctx, 0)}</li>`).join('\n');
      out.push(ordered ? `<ol>\n${lis}\n</ol>` : `<ul>\n${lis}\n</ul>`);
      continue;
    }

    // GFM 表格：当前行含 | 且下一行是含 | 的分隔行（排除 --- 分隔线歧义）
    if (line.includes('|') && i + 1 < lines.length && lines[i + 1].includes('|') && TABLE_DELIM.test(lines[i + 1])) {
      flushPara();
      const header = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(splitRow(lines[i]));
        i++;
      }
      const th = header.map((h) => `<th>${renderInline(h.trim(), ctx, 0)}</th>`).join('');
      const trs = rows
        .map((r) => header.map((_h, idx) => `<td>${renderInline((r[idx] ?? '').trim(), ctx, 0)}</td>`).join(''))
        .map((tds) => `    <tr>${tds}</tr>`)
        .join('\n');
      out.push(`<table>\n  <thead>\n    <tr>${th}</tr>\n  </thead>\n  <tbody>\n${trs}\n  </tbody>\n</table>`);
      continue;
    }

    // 原始 HTML 块：到空行为止整块走剥离管（内容非 Markdown，不解释）
    if (HTML_BLOCK.test(line)) {
      flushPara();
      const block: string[] = [];
      while (i < lines.length && lines[i].trim() !== '') {
        block.push(lines[i]);
        i++;
      }
      const text = stripRawHtml(block.join('\n'), ctx).trim();
      if (text !== '') out.push(`<p>${renderInline(text, ctx, 0)}</p>`);
      continue;
    }

    para.push(line);
    i++;
  }
  flushPara();
  return out;
}

/** 段落：行内渲染 + 硬换行（源行尾两空格/反斜杠 → <br>） */
function emitPara(out: string[], paraLines: readonly string[], ctx: RenderCtx): void {
  const parts: string[] = [];
  for (let idx = 0; idx < paraLines.length; idx++) {
    let l = paraLines[idx];
    const isLast = idx === paraLines.length - 1;
    let br = false;
    if (!isLast && /[ \t]{2,}$/.test(l)) {
      l = l.replace(/[ \t]+$/, '');
      br = true;
    } else if (!isLast && /\\$/.test(l)) {
      l = l.slice(0, -1);
      br = true;
    }
    parts.push(renderInline(l, ctx, 0));
    if (br) parts.push(token(ctx, '<br>'));
  }
  out.push(`<p>${parts.join('\n')}</p>`);
}

/** 主入口：规范化（BOM/NUL/CRLF）→ 块级 → 占位符统一代换 */
export function renderMarkdown(md: string, opts: RenderOptions = {}): RenderResult {
  const ctx: RenderCtx = { tokens: [], attachmentImageUrl: opts.attachmentImageUrl, stripped: false };
  const src = md
    .replace(/^﻿/, '')
    .replaceAll('\x00', '') // 占位符原子性：输入剔除 NUL
    .replace(/\r\n?/g, '\n');
  const out = renderBlockLines(src.split('\n'), ctx);
  return { html: resolve(out.join('\n'), ctx), strippedHtml: ctx.stripped };
}
