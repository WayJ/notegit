#!/usr/bin/env node
/**
 * S13-T2 文档站预渲染管线（E3 / D22 渲染管线复用 / D3 文档源只读 / D2 站内相对链接 /
 * D21 零构建静态站）。渲染真相源：server/src/web/view/render.ts——只读 import
 * renderMarkdown（frontmatter 剥离后的正文经同一安全清理管：标签剥离、URL 协议
 * 白名单、表格/代码块/引用子集），不复制渲染逻辑。
 *
 * frontmatter 剥离是 view/routes.ts bodyAfterFrontmatter 的同规则第三副本
 * （edit/preview.ts 亦持同源副本——仓库既有先例）：本脚本刻意不引 node_modules
 * （notegit-validation 顶层 import 'yaml'，而证明命令 node --test site/test/…
 * 先于 npm ci 运行）。图片相对引用解析不了产品附件通道（静态站无鉴权附件路由）
 * → render.ts 无回调时如实保留占位标注原文。
 *
 * 幂等：产物纯函数于源与映射（无时间戳/无环境掺入）；site/docs 下契约外遗留
 * 产物清除——连跑两次逐字一致。产物入版本库（gh-pages 部署消费）。
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { renderMarkdown } from '../server/src/web/view/render.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 侧栏分组树顺序（用户文档/管理员/部署/已知限制/发布说明——sprint S13 验收 S3 五组） */
const GROUPS = ['用户文档', '管理员', '部署', '已知限制', '发布说明'];

/** 源→产物映射：master 已定 URL 契约（S13-T1/T2 共守，改映射需 master 裁决） */
export const DOC_PAGES = [
  { src: 'docs/user/README.md', out: 'site/docs/user/README.html', group: '用户文档' },
  { src: 'docs/user/quickstart.md', out: 'site/docs/user/quickstart.html', group: '用户文档' },
  { src: 'docs/user/contributing.md', out: 'site/docs/user/contributing.html', group: '用户文档' },
  { src: 'docs/user/permissions.md', out: 'site/docs/user/permissions.html', group: '用户文档' },
  { src: 'docs/user/history-boundary.md', out: 'site/docs/user/history-boundary.html', group: '用户文档' },
  { src: 'docs/admin/README.md', out: 'site/docs/admin/README.html', group: '管理员' },
  { src: 'deploy/README.md', out: 'site/docs/deploy/README.html', group: '部署' },
  { src: 'docs/known-limitations.md', out: 'site/docs/known-limitations.html', group: '已知限制' },
  { src: 'docs/e2-gui/release-notes-v0.2.0.md', out: 'site/docs/release-notes-v0.2.0.html', group: '发布说明' },
];

const OUT_ROOT = 'site/docs'; // 产物根（site/index.html 与 site/assets/** 属并行 T1）
const srcToOut = new Map(DOC_PAGES.map((p) => [p.src, p.out]));

// ── 工具 ─────────────────────────────────────────────────────────────────────

/** 模板静态文本转义（与 render.ts escapeHtml 同五实体规则——本模板自用，
 * 非渲染管复制） */
function escapeHtml(s) {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function unescapeHtml(s) {
  return s
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&');
}

/** frontmatter 剥离——与 server/src/web/view/routes.ts bodyAfterFrontmatter 同规则：
 * 闭合块之后为正文；未闭合按 lenient 跳过首行（构建期不校验，同预览语义）。 */
function bodyAfterFrontmatter(text) {
  const src = text.startsWith('﻿') ? text.slice(1) : text;
  const lines = src.split('\n');
  if (lines.length === 0 || lines[0].trimEnd() !== '---') return text;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trimEnd() === '---') return lines.slice(i + 1).join('\n');
  }
  return lines.slice(1).join('\n');
}

/** 文档标题：正文首个 h1 文本（与 render.ts HEADING 的 h1 形态一致）；缺则回退文件名 */
function docTitle(body, src) {
  for (const line of body.split('\n')) {
    const m = /^ {0,3}#[ \t]+(.*?)[ \t]*#*[ \t]*$/.exec(line);
    if (m !== null) return m[1].trim();
  }
  return posix.basename(src, '.md');
}

/** 产物文件间相对链接：site/docs/user/README.html → quickstart.html / ../admin/README.html */
function relHref(fromOut, toOut) {
  return posix.join(posix.relative(posix.dirname(fromOut), posix.dirname(toOut)), posix.basename(toOut));
}

/**
 * md 互链改写判定：返回新 href；null = 不改（外链/锚点/非 md 资产/映射外仓库路径
 * 均如实保留原文）。
 *
 * @param href    Markdown 渲染产物中的链接目的地（非转义形态）
 * @param srcDir  源文档所在仓库相对目录（如 'docs/user'）
 * @param outDir  产物所在仓库相对目录（如 'site/docs/user'）
 */
export function rewriteHref(href, srcDir, outDir) {
  if (href === '' || href.startsWith('#')) return null; // 纯锚点
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) return null; // 外链（http/https/mailto/…）
  const hashAt = href.indexOf('#');
  const path = hashAt === -1 ? href : href.slice(0, hashAt);
  const anchor = hashAt === -1 ? '' : href.slice(hashAt);
  if (path === '') return null;
  const target = posix.normalize(posix.join(srcDir, path));
  if (target.startsWith('..')) return null; // 越出仓库根
  const out = srcToOut.get(target);
  if (out !== undefined) {
    return posix.join(posix.relative(outDir, posix.dirname(out)), posix.basename(out)) + anchor;
  }
  // 未入映射表的仓库路径（契约/手册/选型/数据文件等源互链，任意扩展名）：站内无此页——改写为 GitHub
  // blob 绝对 URL（锚点 GitHub 形态一致），站内零死链（DOD-E3-02；2026-10-14 master
  // 修正：原「原样保留」在静态站上是死链）。路径分支=main（源文档随仓库演进）。
  return `https://github.com/WayJ/notegit/blob/main/${target}${anchor}`;
}

/** 在渲染产物 HTML 上应用 md→html 改写（仅 href 属性；未改写值逐字节保留） */
function rewriteLinks(html, srcDir, outDir) {
  return html.replace(/href="([^"]*)"/g, (whole, escaped) => {
    const next = rewriteHref(unescapeHtml(escaped), srcDir, outDir);
    return next === null ? whole : `href="${escapeHtml(next)}"`;
  });
}

// ── 页模板 ───────────────────────────────────────────────────────────────────

/** 侧栏分组树 HTML（当前页标记 aria-current） */
function navTreeHtml(pages, pageOut) {
  const sections = GROUPS.map((group) => {
    const items = pages
      .filter((p) => p.group === group)
      .map(
        (p) =>
          `        <li><a${p.out === pageOut ? ' aria-current="page" class="current"' : ''} href="${escapeHtml(
            relHref(pageOut, p.out),
          )}">${escapeHtml(p.title)}</a></li>`,
      )
      .join('\n');
    return `      <section class="nav-group">
        <h2>${escapeHtml(group)}</h2>
        <ul>
${items}
        </ul>
      </section>`;
  }).join('\n');
  return `      <nav class="docs-nav-tree" aria-label="文档导航">
${sections}
      </nav>`;
}

/** 文档页模板：站点页头（产品名链首页）+ 左侧导航 + 正文 + 返回首页（D2 全相对） */
function pageHtml({ title, bodyHtml, navHtml, outDir }) {
  const prefix = posix.relative(outDir, 'site'); // → '..' / '../..'
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Notegit 文档</title>
<link rel="stylesheet" href="${prefix}/docs.css">
</head>
<body>
<header class="site-header">
  <div class="site-header-inner">
    <a class="brand" href="${prefix}/index.html">Notegit</a>
    <a class="back-home" href="${prefix}/index.html">返回首页</a>
  </div>
</header>
<div class="docs-layout">
  <details class="docs-nav" open>
    <summary class="docs-nav-toggle">文档导航</summary>
${navHtml}
  </details>
  <main class="docs-main">
    <article class="doc-article">
${bodyHtml}
    </article>
  </main>
</div>
</body>
</html>
`;
}

// ── 构建 ─────────────────────────────────────────────────────────────────────

/** 递归列出目录下全部文件（相对目录的 posix 路径，排序稳定） */
async function walk(rootRel) {
  const out = [];
  async function rec(abs) {
    for (const d of await readdir(abs, { withFileTypes: true })) {
      const child = join(abs, d.name);
      if (d.isDirectory()) await rec(child);
      else out.push(child);
    }
  }
  await rec(join(repoRoot, rootRel));
  return out.sort();
}

/**
 * 构建文档站：读源（只读）→ frontmatter 剥离 → render.ts 渲染 → md 互链改写 →
 * 页模板 → 写 site/docs/**；清除契约外遗留产物（幂等集合语义）。
 */
export async function buildSite() {
  // 1) 读源定标题（先全量后渲染——侧栏需要全部页标题）
  const pages = [];
  for (const p of DOC_PAGES) {
    const raw = await readFile(join(repoRoot, p.src), 'utf8');
    const body = bodyAfterFrontmatter(raw);
    pages.push({ ...p, title: docTitle(body, p.src), body });
  }
  // 2) 渲染 + 改写 + 模板
  const artifacts = pages.map((page) => {
    const { html } = renderMarkdown(page.body);
    const bodyHtml = rewriteLinks(html, posix.dirname(page.src), posix.dirname(page.out));
    return { out: page.out, html: pageHtml({ title: page.title, bodyHtml, navHtml: navTreeHtml(pages, page.out), outDir: posix.dirname(page.out) }) };
  });
  // 3) 落盘 + 清理契约外产物
  for (const a of artifacts) {
    const abs = join(repoRoot, a.out);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, a.html);
  }
  const keep = new Set(artifacts.map((a) => resolve(repoRoot, a.out)));
  const outRootAbs = join(repoRoot, OUT_ROOT);
  for (const f of await walk(OUT_ROOT)) {
    if (!keep.has(f)) await rm(f, { force: true });
  }
  return { pages: artifacts.length, root: outRootAbs };
}

// CLI 入口（node scripts/build-site.mjs；被测试 import 时不执行）
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { pages } = await buildSite();
  console.log(`build-site: ${pages} 个文档页 → ${OUT_ROOT}/`);
}
