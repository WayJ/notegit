/**
 * S13-T2 文档站预渲染管线测试（E3 / D22 渲染管线复用 / D3 文档源只读 / D2 站内相对链接）。
 *
 * 契约来源：任务合同（master 已定 URL 契约九页映射）+ sprint S13 计划
 * （docs/superpowers/sprints/2026-10-14-S13-plan.md）验收场景 S3/S4。
 * 断言基线全部硬编码于本文件——测试校验的是合同本身，不复述脚本内部常量。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSite, rewriteHref } from '../../scripts/build-site.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** master URL 契约：源 → 产物（九页，两任务共守） */
const CONTRACT = [
  ['docs/user/README.md', 'site/docs/user/README.html'],
  ['docs/user/quickstart.md', 'site/docs/user/quickstart.html'],
  ['docs/user/contributing.md', 'site/docs/user/contributing.html'],
  ['docs/user/permissions.md', 'site/docs/user/permissions.html'],
  ['docs/user/history-boundary.md', 'site/docs/user/history-boundary.html'],
  ['docs/admin/README.md', 'site/docs/admin/README.html'],
  ['deploy/README.md', 'site/docs/deploy/README.html'],
  ['docs/known-limitations.md', 'site/docs/known-limitations.html'],
  ['docs/e2-gui/release-notes-v0.2.0.md', 'site/docs/release-notes-v0.2.0.html'],
];

/** 各文档关键标题（源 h1 原文——render.ts 管线输出的 <h1> 应逐字呈现） */
const KEY_TITLE = new Map([
  ['site/docs/user/README.html', '<h1>Notegit 用户文档（员工视角）</h1>'],
  ['site/docs/user/quickstart.html', '<h1>安装与快速上手（员工视角）</h1>'],
  ['site/docs/user/contributing.html', '<h1>贡献流程：网页与 Git 双通道</h1>'],
  ['site/docs/user/permissions.html', '<h1>权限与撤权边界</h1>'],
  ['site/docs/user/history-boundary.html', '<h1>历史边界：重命名与跨库移动</h1>'],
  ['site/docs/admin/README.html', '<h1>Notegit 管理员手册</h1>'],
  ['site/docs/deploy/README.html', '<h1>Notegit 容器部署（S8-T1 发行包）</h1>'],
  ['site/docs/known-limitations.html', '<h1>已知限制（v0.1 · 2026-10-14）</h1>'],
  ['site/docs/release-notes-v0.2.0.html', '<h1>Notegit v0.2.0 发布说明</h1>'],
]);

/** 递归列目录下全部文件（仓库相对路径，排序保证稳定） */
async function walk(rootRel) {
  const out = [];
  async function rec(abs) {
    for (const name of await readdir(abs, { withFileTypes: true })) {
      const child = join(abs, name.name);
      if (name.isDirectory()) await rec(child);
      else out.push(relative(join(repoRoot, rootRel), child).split('\\').join('/'));
    }
  }
  await rec(join(repoRoot, rootRel));
  out.sort();
  return out;
}

/** 目录树内容指纹（路径序列 + 各文件内容哈希——源只读断言用） */
async function treeHash(rootRel) {
  const files = await walk(rootRel);
  const h = createHash('sha256');
  for (const rel of files) {
    h.update(rel);
    h.update('\0');
    h.update(createHash('sha256').update(await readFile(join(repoRoot, rootRel, rel))).digest());
    h.update('\0');
  }
  return h.digest('hex');
}

let baselineDocsHash;
let baselineDeployHash;

before(async () => {
  baselineDocsHash = await treeHash('docs');
  baselineDeployHash = await treeHash('deploy');
  await buildSite();
});

test('URL 契约：九页产物齐且 site/docs 下无多余文件', async () => {
  const artifacts = await walk('site/docs');
  assert.deepEqual(
    artifacts,
    CONTRACT.map(([, out]) => out.slice('site/docs/'.length)).sort(),
    '产物集合应与 master URL 契约逐项一致',
  );
});

test('渲染输出：各文档关键标题在产物中完整呈现', async () => {
  for (const [out, h1] of KEY_TITLE) {
    const html = await readFile(join(repoRoot, out), 'utf8');
    assert.ok(html.includes(h1), `${out} 应含关键标题 ${h1}`);
    assert.ok(html.startsWith('<!doctype html>'), `${out} 应为完整 HTML 文档`);
    assert.ok(html.includes('<title>'), `${out} 应有页标题`);
  }
});

test('渲染输出：表格与代码块经 render.ts 管线呈现', async () => {
  const releaseNotes = await readFile(join(repoRoot, 'site/docs/release-notes-v0.2.0.html'), 'utf8');
  assert.ok(releaseNotes.includes('<table>'), '发布说明应含表格');
  const quickstart = await readFile(join(repoRoot, 'site/docs/user/quickstart.html'), 'utf8');
  assert.ok(quickstart.includes('<pre><code'), '快速上手应含围栏代码块');
});

test('链接改写：映射内 md 互链改写为站内相对 html（跨目录按映射表）', async () => {
  const userIndex = await readFile(join(repoRoot, 'site/docs/user/README.html'), 'utf8');
  // 同目录 md → 同名 html
  for (const href of ['quickstart.html', 'contributing.html', 'permissions.html', 'history-boundary.html']) {
    assert.ok(userIndex.includes(`href="${href}"`), `user/README 应含 href="${href}"`);
  }
  // 跨目录：../admin/README.md → ../admin/README.html
  assert.ok(userIndex.includes('href="../admin/README.html"'));
  // 源里 ../../deploy/README.md（docs/user 视角）映射到站内 site/docs/deploy/ → ../deploy/README.html
  assert.ok(userIndex.includes('href="../deploy/README.html"'));
  assert.ok(userIndex.includes('href="../known-limitations.html"'));
  // 站内相对：嵌套页返首页/样式为 ../../，顶层为 ../
  assert.ok(userIndex.includes('href="../../index.html"'));
  assert.ok(userIndex.includes('href="../../docs.css"'));

  const quickstart = await readFile(join(repoRoot, 'site/docs/user/quickstart.html'), 'utf8');
  assert.ok(
    quickstart.includes('href="contributing.html#冲突处理"'),
    '锚点应随改写保留',
  );

  const known = await readFile(join(repoRoot, 'site/docs/known-limitations.html'), 'utf8');
  assert.ok(known.includes('href="user/history-boundary.html"'));
  assert.ok(known.includes('href="deploy/README.html"'));
  assert.ok(known.includes('href="../index.html"'));

  const admin = await readFile(join(repoRoot, 'site/docs/admin/README.html'), 'utf8');
  assert.ok(admin.includes('href="../user/README.html"'));
  assert.ok(admin.includes('href="../user/permissions.html"'));
  assert.ok(admin.includes('href="../deploy/README.html"'));
});

test('链接改写：映射外仓库路径改写为 GitHub blob（站内零死链），外链保留', async () => {
  // 2026-10-14 master 修正：未映射仓库路径原样保留在静态站上是死链——改写 blob URL
  const known = await readFile(join(repoRoot, 'site/docs/known-limitations.html'), 'utf8');
  assert.ok(known.includes('href="https://github.com/WayJ/notegit/blob/main/docs/s1/selection.md"'));
  assert.ok(known.includes('href="https://github.com/WayJ/notegit/blob/main/docs/superpowers/roadmaps/2026-10-12-notegit-v01.md"'));
  const quickstart = await readFile(join(repoRoot, 'site/docs/user/quickstart.html'), 'utf8');
  assert.ok(quickstart.includes('href="https://github.com/WayJ/notegit/blob/main/cli/README.md"'));
  assert.ok(quickstart.includes('href="https://github.com/WayJ/notegit/blob/main/docs/harness/agent-guide.md"'));
  const admin = await readFile(join(repoRoot, 'site/docs/admin/README.html'), 'utf8');
  assert.ok(admin.includes('href="https://github.com/WayJ/notegit/blob/main/docs/credentials-ops.md"'));
});

test('链接改写单元：rewriteHref 外链/锚点不动、未映射→GitHub blob、映射内换算相对路径', () => {
  const F = (href, srcDir, outDir) => rewriteHref(href, srcDir, outDir);
  // 外链（含以 .md 结尾的外链）与纯锚点：不改
  assert.equal(F('https://example.com/x.md', 'docs/user', 'site/docs/user'), null);
  assert.equal(F('http://a.b/c', 'docs/user', 'site/docs/user'), null);
  assert.equal(F('mailto:a@b.c', 'docs/user', 'site/docs/user'), null);
  assert.equal(F('#anchor', 'docs/user', 'site/docs/user'), null);
  // 未入映射表的仓库路径：改写为 GitHub blob 绝对 URL（站内零死链——2026-10-14 master 修正原「不动」策略）
  assert.equal(F('contracts/api.md', 'docs', 'site/docs'), 'https://github.com/WayJ/notegit/blob/main/docs/contracts/api.md');
  assert.equal(F('../../cli/README.md', 'docs/admin', 'site/docs/admin'), 'https://github.com/WayJ/notegit/blob/main/cli/README.md');
  // 非映射资产（任意扩展名，仓库内路径）：同改写 blob URL
  assert.equal(F('img/a.png', 'docs/user', 'site/docs/user'), 'https://github.com/WayJ/notegit/blob/main/docs/user/img/a.png');
  // 映射内：同目录、跨目录、锚点保留
  assert.equal(F('quickstart.md', 'docs/user', 'site/docs/user'), 'quickstart.html');
  assert.equal(F('contributing.md#冲突处理', 'docs/user', 'site/docs/user'), 'contributing.html#冲突处理');
  assert.equal(F('../admin/README.md', 'docs/user', 'site/docs/user'), '../admin/README.html');
  assert.equal(F('../../deploy/README.md', 'docs/user', 'site/docs/user'), '../deploy/README.html');
  assert.equal(F('../known-limitations.md', 'docs/user', 'site/docs/user'), '../known-limitations.html');
  assert.equal(F('user/history-boundary.md', 'docs', 'site/docs'), 'user/history-boundary.html');
});

test('页模板：五组导航、当前页标记、返回首页与站点页头', async () => {
  const page = await readFile(join(repoRoot, 'site/docs/user/README.html'), 'utf8');
  for (const group of ['用户文档', '管理员', '部署', '已知限制', '发布说明']) {
    assert.ok(page.includes(`>${group}<`), `侧栏应含分组「${group}」`);
  }
  assert.ok(page.includes('aria-current="page"'), '当前页导航项应有 aria-current');
  assert.ok(page.includes('返回首页'));
  assert.ok(page.includes('Notegit</a>'), '站点页头产品名');
});

test('幂等：同输入连跑两次产物逐字一致', async () => {
  const before = new Map();
  for (const [, out] of CONTRACT) before.set(out, await readFile(join(repoRoot, out)));
  await buildSite();
  for (const [, out] of CONTRACT) {
    assert.deepEqual(
      await readFile(join(repoRoot, out)),
      before.get(out),
      `${out} 二次构建应逐字一致`,
    );
  }
});

test('源只读：构建前后 docs/ 与 deploy/ 无改动', async () => {
  assert.equal(await treeHash('docs'), baselineDocsHash, 'docs/ 构建后应无改动');
  assert.equal(await treeHash('deploy'), baselineDeployHash, 'deploy/ 构建后应无改动');
});
