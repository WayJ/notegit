import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browseHarness, seededVault, addEmployee, addMember } from './web-browse-fixtures.ts';

// S11-T3 README 卡片安全 Markdown 渲染（G07/DOD-E2-07）：复用 view 渲染管线
// （render.ts 清理唯一通道——browse 只读 import，不变更 view 域）；frontmatter
// 剥离不外露（research §2.3 F-8 实测现状：README <pre> 裸奔 frontmatter）；
// 超渲染上限回退 <pre> 原文形态并如实标注。安全不变量：README 卡片与 view 页
// 同一清理管线——script 注入不可达。

/** 含 frontmatter + 标题 + 相对/外链 + 原始 HTML 注入样本的 README */
const MD_README = [
  '---',
  'title: 导航',
  '---',
  '',
  '# 知识库导航',
  '',
  '从这里开始：[入门指南](docs/getting-started.md)，或访问 [官网](https://example.com)。',
  '',
  '段落中 <b>加粗</b> 与 <script>alert(1)</script> 内联注入。',
  '',
].join('\n');

async function readmeHarness(files: Record<string, string>) {
  const h = await browseHarness();
  const alice = addEmployee(h.db, { username: 'alice' });
  await seededVault(h, 'alpha', alice, files);
  addMember(h.db, 1, alice, 'editor', alice);
  return { h, alice };
}

test('README 卡片：frontmatter 剥离不外露；标题/链接渲染为 Markdown 形态', async () => {
  const { h, alice } = await readmeHarness({ ...Object.fromEntries([['README.md', MD_README]]), 'docs/getting-started.md': 'x\n' });
  try {
    const page = await h.app.inject({ method: 'GET', url: '/vaults/alpha/browse', headers: h.session(alice) });
    assert.equal(page.statusCode, 200, page.body);
    // Markdown 形态：标题成标题元素、链接成锚点（现状为 <pre> 纯文本——先红）
    assert.ok(page.body.includes('<h1>知识库导航</h1>'), '标题渲染为 Markdown');
    assert.ok(page.body.includes('href="docs/getting-started.md"'), '相对链接保留（URL 白名单内）');
    assert.ok(page.body.includes('>入门指南</a>'), '链接文字成锚点');
    assert.ok(page.body.includes('href="https://example.com"'), 'http(s) 白名单外链保留');
    // frontmatter 不外露（F-8 现状修复）
    assert.ok(!page.body.includes('title: 导航'), 'frontmatter 字段不外露');
    // 豁免标注延续（既有行为不变）
    assert.ok(page.body.includes('豁免'), '豁免标注延续（架构 §5.2）');
  } finally {
    await h.close();
  }
});

test('README 卡片：与 view 页同一清理管线——script/原始 HTML 注入不可达', async () => {
  const { h, alice } = await readmeHarness({ 'README.md': MD_README });
  try {
    const page = await h.app.inject({ method: 'GET', url: '/vaults/alpha/browse', headers: h.session(alice) });
    assert.equal(page.statusCode, 200, page.body);
    assert.ok(!page.body.includes('alert(1)'), 'script 内容整段剥离（危险容器连内容）');
    assert.ok(!page.body.includes('<script>alert'), '无注入的 script 开标签');
    assert.ok(!page.body.includes('<b>加粗</b>'), '原始 HTML 标签剥离（正文保留）');
    assert.ok(page.body.includes('加粗'), '剥离标签保留正文');
    // 页面唯一 <script> = 外壳脚本（UI-RESTYLE 壳断言语义延续）
    assert.equal((page.body.match(/<script/g) ?? []).length, 1, '仅外壳 script');
  } finally {
    await h.close();
  }
});

test('README 卡片：超渲染上限回退 <pre> 原文形态并如实标注（frontmatter 仍不外露）', async () => {
  // >1MiB：frontmatter + 标题 + 超长正文（entry.size 判超限——渲染上限同 view）
  const oversize = `---\ntitle: 超大\n---\n\n# 大标题\n\n${'A'.repeat(1024 * 1024 + 64)}\n`;
  const { h, alice } = await readmeHarness({ 'README.md': oversize });
  try {
    const page = await h.app.inject({ method: 'GET', url: '/vaults/alpha/browse', headers: h.session(alice) });
    assert.equal(page.statusCode, 200, page.body);
    assert.ok(page.body.includes('超过渲染上限'), '超限如实标注');
    assert.ok(page.body.includes('<pre>'), '回退 <pre> 原文形态');
    assert.ok(page.body.includes('A'.repeat(64)), '原文正文按原文展示（转义纯文本）');
    assert.ok(!page.body.includes('<h1>大标题</h1>'), '超限不做 Markdown 渲染');
    assert.ok(!page.body.includes('title: 超大'), 'frontmatter 仍不外露（剥离先于回退）');
  } finally {
    await h.close();
  }
});
