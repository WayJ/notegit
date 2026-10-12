import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../src/web/view/render.ts';

// S4-T2 合法 Markdown 回归集（breakdown §2.3 完成标准：「合法 Markdown（含表格/
// 代码块/图片）渲染正常」）。断言直接锚定期望输出形态（CommonMark/GFM 语义的
// v1 子集——子集清单见 render.ts 模块注释）；防“清理管改写合法内容”回归。

test('标题：# 到 ###### 逐级渲染', () => {
  const { html } = renderMarkdown('# 一级\n\n## 二级\n\n### 三级\n\n#### 四级\n\n##### 五级\n\n###### 六级');
  assert.equal(html, '<h1>一级</h1>\n<h2>二级</h2>\n<h3>三级</h3>\n<h4>四级</h4>\n<h5>五级</h5>\n<h6>六级</h6>');
});

test('段落与行内元素：粗体/斜体/行内码/转义星号/snake_case 不误伤', () => {
  const { html } = renderMarkdown('**加粗** 与 *斜体* 与 __着重__ 与 _下划强调_ 与 `code`。');
  assert.equal(html, '<p><strong>加粗</strong> 与 <em>斜体</em> 与 <strong>着重</strong> 与 <em>下划强调</em> 与 <code>code</code>。</p>');

  const esc = renderMarkdown('\\*不是斜体\\* 与 snake_case_word 保持原样');
  assert.equal(esc.html, '<p>*不是斜体* 与 snake_case_word 保持原样</p>');
});

test('链接：文字递归渲染，title 属性保留', () => {
  const { html } = renderMarkdown('[**部署指南**](https://docs.example.com/setup "指南")');
  assert.equal(html, '<p><a href="https://docs.example.com/setup" title="指南"><strong>部署指南</strong></a></p>');
});

test('列表：无序/有序各成表，惰性续行并入当前项', () => {
  const ul = renderMarkdown('- 一\n- 二\n  二的续行\n- 三');
  assert.equal(ul.html, `<ul>
  <li>一</li>
  <li>二 二的续行</li>
  <li>三</li>
</ul>`);
  const ol = renderMarkdown('1. 第一步\n2. 第二步\n35. 第三步（序号仅样式）');
  assert.equal(ol.html, `<ol>
  <li>第一步</li>
  <li>第二步</li>
  <li>第三步（序号仅样式）</li>
</ol>`);
});

test('引用：内部递归渲染（标题+段落），嵌套引用逐层剥 >', () => {
  const { html } = renderMarkdown('> ## 引用标题\n> 引用正文。\n>\n> > 内层引用');
  assert.ok(html.startsWith('<blockquote>'), html);
  assert.ok(html.includes('<h2>引用标题</h2>'));
  assert.ok(html.includes('<p>引用正文。</p>'));
  assert.ok(html.includes('<blockquote>\n<p>内层引用</p>\n</blockquote>'), '内层引用递归渲染');
});

test('GFM 表格：表头/表体/单元格行内渲染/列数补齐', () => {
  const md = [
    '| 环境 | 说明 | 链接 |',
    '| --- | --- | --- |',
    '| 生产 | **在线** | [入口](https://a.example) |',
    '| 测试 | 缺列补空 | |',
  ].join('\n');
  const { html } = renderMarkdown(md);
  assert.equal(
    html,
    `<table>
  <thead>
    <tr><th>环境</th><th>说明</th><th>链接</th></tr>
  </thead>
  <tbody>
    <tr><td>生产</td><td><strong>在线</strong></td><td><a href="https://a.example">入口</a></td></tr>
    <tr><td>测试</td><td>缺列补空</td><td></td></tr>
  </tbody>
</table>`,
  );
});

test('表格：\\| 转义为字面竖线', () => {
  const { html } = renderMarkdown('| a \\| b | c |\n| --- | --- |\n| 1 | 2 |');
  assert.ok(html.includes('<th>a | b</th>'), html);
});

test('围栏代码块：语言标注成 class，内容逐字转义不做任何二次渲染', () => {
  const md = '```ts\nconst s = "<em>非斜体</em>"; // [x](javascript:alert(1))\n```';
  const { html, strippedHtml } = renderMarkdown(md);
  assert.equal(
    html,
    '<pre><code class="language-ts">const s = &quot;&lt;em&gt;非斜体&lt;/em&gt;&quot;; // [x](javascript:alert(1))</code></pre>',
  );
  assert.ok(!strippedHtml, '代码块内容是展示文本，不触发剥离标注');
});

test('围栏代码块：波浪线围栏与未闭合围栏（到尾如实渲染）', () => {
  const tilde = renderMarkdown('~~~\nplain **text**\n~~~');
  assert.equal(tilde.html, '<pre><code>plain **text**</code></pre>');
  const open = renderMarkdown('```\n未闭合');
  assert.equal(open.html, '<pre><code>未闭合</code></pre>');
});

test('行内码：含 Markdown/HTML/URL 语法逐字展示，不渲染不剥离', () => {
  const { html, strippedHtml } = renderMarkdown('运行 `<b>x</b>` 与 `[t](javascript:alert(1))`');
  assert.equal(html, '<p>运行 <code>&lt;b&gt;x&lt;/b&gt;</code> 与 <code>[t](javascript:alert(1))</code></p>');
  assert.ok(!strippedHtml);
});

test('分隔线与硬换行：---/* * * 成 hr；行尾两空格成 <br>', () => {
  const hr = renderMarkdown('上文\n\n---\n\n* * *\n\n下文');
  assert.ok(hr.html.includes('<hr>'));
  assert.equal(hr.html.match(/<hr>/g)?.length, 2);
  const br = renderMarkdown('第一行  \n第二行');
  assert.equal(br.html, '<p>第一行\n<br>\n第二行</p>');
});

test('中文与多段落：原文文本原样进入输出（实体仅转义五位）', () => {
  const { html } = renderMarkdown('第一段：中文、标点「引号」与 & < > " \'。\n\n第二段。');
  assert.equal(
    html,
    '<p>第一段：中文、标点「引号」与 &amp; &lt; &gt; &quot; &#39;。</p>\n<p>第二段。</p>',
  );
});

test('图片：外链 http(s) 图片生成 img；多块混排整体形态正确', () => {
  const { html } = renderMarkdown('# 架构图\n\n![架构](https://cdn.example.com/arch.png)\n\n详见 [文档](./design.md)。');
  assert.equal(
    html,
    '<h1>架构图</h1>\n<p><img src="https://cdn.example.com/arch.png" alt="架构"></p>\n<p>详见 <a href="./design.md">文档</a>。</p>',
  );
});

test('原始 HTML 的正文保留：剥离标签但可见文本不丢', () => {
  const { html, strippedHtml } = renderMarkdown('<div>标签内正文</div> 与后续段落');
  assert.ok(html.includes('标签内正文'));
  assert.ok(!html.includes('<div'), '标签本身剥离');
  assert.ok(strippedHtml, '如实标记剥离发生');
});
