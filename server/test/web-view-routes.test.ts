import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browseHarness, seededVault, addEmployee, addMember } from './web-browse-fixtures.ts';

// S4-T2 预览页路由（breakdown §2.3：Markdown 预览与安全渲染接入
// GET /vaults/{slug}/view/{path}；api.md §13 S4-T2 行）。路由级断言 = XSS 样本集
// 在真实页面端到端全清 + 合法渲染回归 + frontmatter 不入正文 + 非 Markdown/
// 超大如实标注 + 附件图片接口占位。鉴权/404 反存在性/302 browse 由
// web-browse-authz.test.ts 覆盖（路由族行为不变，本文件不重复）。

/** 从页面 HTML 提取正文区（<article id="doc">…</article>——渲染管输出唯一落点） */
function article(body: string): string {
  const m = /<article id="doc">([\s\S]*)<\/article>/.exec(body);
  assert.ok(m !== null, '页面应含 <article id="doc"> 正文区');
  return m[1];
}

// ── XSS 样本集（端到端） ─────────────────────────────────────────────────────

const XSS_DOC = [
  '<script>alert(1)</script>',
  '<iframe src="https://evil.example/x"></iframe>',
  '[点我](javascript:alert(1))',
  '[点我](data:text/html,<b>x</b>)',
  '![x](data:image/svg+xml;base64,PHN2Zy8+)',
  '![x](javascript:alert(1))',
  '<img src=x onerror=alert(1)>',
  '<div onclick="alert(1)">可见文本</div>',
  '<svg onload=alert(1)></svg>',
  '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
  '<!-- <script>alert(1)</script> -->',
  '<ScRiPt>alert(1)</ScRiPt>',
  '正文与 [正常链接](https://ok.example/a) 夹杂。',
].join('\n\n');

test('view 端到端：XSS 样本集整库全清（标签白名单/协议白名单/无载荷外泄）', async () => {
  const h = await browseHarness();
  try {
    const alice = addEmployee(h.db, { username: 'alice' });
    await seededVault(h, 'alpha', alice, { 'docs/xss.md': XSS_DOC });
    addMember(h.db, 1, alice, 'reader', alice);
    const res = await h.app.inject({ method: 'GET', url: '/vaults/alpha/view/docs/xss.md', headers: h.session(alice) });
    assert.equal(res.statusCode, 200, res.body);
    assert.match(res.headers['content-type'] as string, /^text\/html/);

    const art = article(res.body);
    // 危险标签与载荷不可达（转义文本除外——转义后不构成标签形态）
    assert.ok(!/<script/i.test(art) && !/<iframe/i.test(art), 'article 内不得出现 script/iframe 标签');
    assert.ok(!art.includes('alert(1)'), '载荷文本不得外泄（剥离或拒载）');
    assert.ok(!/on[a-zA-Z]+\s*="/.test(art), '事件属性形态不得出现');
    // 协议白名单：article 内全部 href/src 为 http(s) 或无协议
    for (const m of art.matchAll(/\s(?:href|src)="([^"]*)"/g)) {
      const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(m[1]);
      assert.ok(scheme === null || scheme[1].toLowerCase() === 'http' || scheme[1].toLowerCase() === 'https', `非白名单协议：${m[1]}`);
    }
    // 白名单正向不误伤：正常链接保留
    assert.ok(art.includes('href="https://ok.example/a"'), '白名单链接不得被误清');
    // 剥离如实标注
    assert.ok(res.body.includes('剥离'), '页面应如实标注发生了原始 HTML 剥离');
    // 全页脚本唯一：仅页面外壳的空 script（正文渲染不注入脚本）
    assert.equal((res.body.match(/<script/g) ?? []).length, 1, '全页 <script> 仅外壳一处');
  } finally {
    await h.close();
  }
});

// ── 合法渲染回归（端到端） ───────────────────────────────────────────────────

const LEGIT_DOC = [
  '# 部署手册',
  '',
  '## 步骤',
  '',
  '1. 准备环境',
  '2. 执行 `make all`',
  '',
  '> 注意：**先备份**再升级。',
  '',
  '| 阶段 | 命令 |',
  '| --- | --- |',
  '| 构建 | `make build` |',
  '| 发布 | make deploy |',
  '',
  '```bash',
  'make deploy # **不渲染**',
  '```',
  '',
  '架构图：![arch](https://cdn.example.com/arch.png)',
].join('\n');

test('view 端到端：合法 Markdown（表格/代码块/图片/引用）渲染正常', async () => {
  const h = await browseHarness();
  try {
    const alice = addEmployee(h.db, { username: 'alice' });
    await seededVault(h, 'alpha', alice, { 'docs/deploy.md': LEGIT_DOC });
    addMember(h.db, 1, alice, 'reader', alice);
    const res = await h.app.inject({ method: 'GET', url: '/vaults/alpha/view/docs/deploy.md', headers: h.session(alice) });
    assert.equal(res.statusCode, 200, res.body);
    const art = article(res.body);
    assert.ok(art.includes('<h1>部署手册</h1>'));
    assert.ok(art.includes('<h2>步骤</h2>'));
    assert.ok(art.includes('<ol>'), '有序列表渲染');
    assert.ok(art.includes('<code>make all</code>'), '行内码渲染');
    assert.ok(art.includes('<blockquote>'), '引用渲染');
    assert.ok(art.includes('<strong>先备份</strong>'), '引用内粗体递归渲染');
    assert.ok(art.includes('<table>'), '表格渲染');
    assert.ok(art.includes('<th>阶段</th>'), '表头渲染');
    assert.ok(art.includes('<td><code>make build</code></td>'), '单元格行内码渲染');
    assert.ok(art.includes('<pre><code class="language-bash">make deploy # **不渲染**</code></pre>'), '代码块逐字渲染');
    assert.ok(art.includes('<img src="https://cdn.example.com/arch.png" alt="arch">'), '外链图片渲染');
  } finally {
    await h.close();
  }
});

// ── frontmatter / 非 Markdown / 超大 / 附件占位 ─────────────────────────────

test('view：frontmatter 不入正文（六字段块剥离，正文从闭合 --- 之后渲染）', async () => {
  const h = await browseHarness();
  try {
    const alice = addEmployee(h.db, { username: 'alice' });
    await seededVault(h, 'alpha', alice, {
      'docs/with-fm.md': '---\ntitle: 部署手册\nstatus: draft\n---\n\n正文开始。\n',
    });
    addMember(h.db, 1, alice, 'editor', alice);
    const res = await h.app.inject({ method: 'GET', url: '/vaults/alpha/view/docs/with-fm.md', headers: h.session(alice) });
    assert.equal(res.statusCode, 200);
    const art = article(res.body);
    assert.ok(art.includes('正文开始。'), '正文渲染');
    assert.ok(!art.includes('title: 部署手册'), 'frontmatter 字段不入正文');
    assert.ok(!art.includes('status: draft'), 'frontmatter 块整体不入正文');
    assert.ok(!art.includes('<hr>'), 'frontmatter 的 --- 不得渲染成分隔线');
  } finally {
    await h.close();
  }
});

test('view：frontmatter 未闭合不崩溃，按正文如实渲染（lenient 预览）', async () => {
  const h = await browseHarness();
  try {
    const alice = addEmployee(h.db, { username: 'alice' });
    await seededVault(h, 'alpha', alice, { 'docs/broken.md': '---\ntitle: 半截\n\n正文仍在。\n' });
    addMember(h.db, 1, alice, 'reader', alice);
    const res = await h.app.inject({ method: 'GET', url: '/vaults/alpha/view/docs/broken.md', headers: h.session(alice) });
    assert.equal(res.statusCode, 200, res.body);
    assert.ok(article(res.body).includes('正文仍在。'));
  } finally {
    await h.close();
  }
});

test('view：非 Markdown 如实标注——图片附件经鉴权通道嵌入（S4-T8 直开页收口）', async () => {
  const h = await browseHarness();
  try {
    const alice = addEmployee(h.db, { username: 'alice' });
    await seededVault(h, 'alpha', alice, { 'assets/logo.png': '\x89PNG stub' });
    addMember(h.db, 1, alice, 'reader', alice);
    const res = await h.app.inject({ method: 'GET', url: '/vaults/alpha/view/assets/logo.png', headers: h.session(alice) });
    assert.equal(res.statusCode, 200, res.body);
    assert.ok(res.body.includes('logo.png'), '文件名元信息');
    assert.ok(/大小：\d+ 字节/.test(res.body), '大小元信息');
    assert.ok(res.body.includes('附件'), '图片附件如实标注附件通道');
    // S4-T8：占位退役——直开页以 blob 寻址鉴权 URL 嵌 <img>
    assert.ok(/<img src="\/vaults\/alpha\/attach\/[0-9a-f]{40}\/logo\.png"/.test(res.body), '嵌鉴权附件通道 URL');
    assert.ok(!res.body.includes('<article'), '非 Markdown 不渲染正文区');
  } finally {
    await h.close();
  }
});

test('view：非 Markdown 非图片类型同样如实标注（不渲染正文区）', async () => {
  const h = await browseHarness();
  try {
    const alice = addEmployee(h.db, { username: 'alice' });
    await seededVault(h, 'alpha', alice, { 'notes.txt': 'plain text' });
    addMember(h.db, 1, alice, 'reader', alice);
    const res = await h.app.inject({ method: 'GET', url: '/vaults/alpha/view/notes.txt', headers: h.session(alice) });
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes('不提供'), '如实标注不提供预览');
    assert.ok(!res.body.includes('<article'), '不渲染正文区');
  } finally {
    await h.close();
  }
});

test('view：超过渲染上限的 .md 只出元信息与如实标注（正文不渲染）', async () => {
  const h = await browseHarness();
  try {
    const alice = addEmployee(h.db, { username: 'alice' });
    const big = '# 大文档\n\n' + 'x'.repeat(1024 * 1024 + 64);
    await seededVault(h, 'alpha', alice, { 'docs/big.md': big });
    addMember(h.db, 1, alice, 'reader', alice);
    const res = await h.app.inject({ method: 'GET', url: '/vaults/alpha/view/docs/big.md', headers: h.session(alice) });
    assert.equal(res.statusCode, 200, res.body);
    assert.ok(res.body.includes('big.md'));
    assert.ok(res.body.includes('过大'), '如实标注过大');
    assert.ok(!res.body.includes('<article'), '正文不渲染');
    assert.ok(res.body.length < 100 * 1024, '页面不得把超大正文搬进输出');
  } finally {
    await h.close();
  }
});

test('view：仓库相对图片引用 → 鉴权附件通道（S4-T4 已接线：在库出 <img>，缺库保占位）', async () => {
  const h = await browseHarness();
  try {
    const alice = addEmployee(h.db, { username: 'alice' });
    await seededVault(h, 'alpha', alice, {
      'docs/guide.md': '登录界面：![登录](shots/login.png)\n缺失：![缺](shots/gone.png)\n',
      'docs/shots/login.png': 'png-stub',
    });
    addMember(h.db, 1, alice, 'reader', alice);
    const res = await h.app.inject({ method: 'GET', url: '/vaults/alpha/view/docs/guide.md', headers: h.session(alice) });
    assert.equal(res.statusCode, 200, res.body);
    const art = article(res.body);
    // 在库附件：blob 寻址鉴权 URL（40 hex OID——URL 不可枚举），不直出仓库路径
    assert.match(art, /<img src="\/vaults\/alpha\/attach\/[0-9a-f]{40}\/login\.png" alt="登录">/);
    assert.ok(!/<img [^>]*shots/.test(art), '不得直出仓库相对路径为 src');
    // 缺库引用：保留占位标注（携带 Markdown 原始引用路径）
    assert.ok(art.includes('class="img-attachment"'), '缺失引用占位标注形态');
    assert.ok(art.includes('data-attachment="shots/gone.png"'), '占位携带原始引用路径');
  } finally {
    await h.close();
  }
});

test('view：目录浏览页文件条目链接到预览页（链路连续）', async () => {
  const h = await browseHarness();
  try {
    const alice = addEmployee(h.db, { username: 'alice' });
    await seededVault(h, 'alpha', alice, { 'README.md': '# 导航\n', 'docs/first.md': '正文\n' });
    addMember(h.db, 1, alice, 'reader', alice);
    const page = await h.app.inject({ method: 'GET', url: '/vaults/alpha/browse/docs', headers: h.session(alice) });
    assert.equal(page.statusCode, 200);
    assert.ok(page.body.includes('href="/vaults/alpha/view/docs/first.md"'), '目录条目链接预览页');
  } finally {
    await h.close();
  }
});
