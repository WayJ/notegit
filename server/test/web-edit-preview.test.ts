import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  browseHarness,
  seededVault,
  addEmployee,
  addMember,
  type BrowseHarness,
} from './web-browse-fixtures.ts';

// S12-T1 编辑预览（D2）：服务端安全渲染片段端点（POST body {content} → view
// 渲染管线（web/view/render.ts 只读 import）同一清理通道返回 HTML 片段——非
// 整页）；认证=read 成员门槛（与 edit GET 同判——reader 200、非成员 404 同体、
// 未认证 302）；维护模式放行（只读推导——参照 §8.2 validations 先例）。
//
// 端点注册于守卫前缀之外（POST /edit-preview/{slug}/{path}）：webWriteGuard 按
// /vaults/ 前缀拦非安全方法（web 写操作维护 503），预览是只读推导——不属写
// 操作面，路径落在前缀外即两道维护闸门（/api/v1、/vaults/）之外（S12-T1
// worker ruling：写面不含 write-gate.ts；示例路径 /vaults/{slug}/preview 会
// 被前缀规则拦——偏离示例形状、语义等价）。

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('utf8');

const SEED: Record<string, string> = {
  'README.md': '# 导航\n',
  'docs/first.md': '---\ntitle: "First 笔记"\n---\n\n# 正文标题\n\n内容 **强调** 与 `行内码`。\n\n- 列表一\n- 列表二\n',
  'docs/img.md': '---\ntitle: 图文\n---\n\n# 图文\n\n![logo](../assets/logo.png)\n',
  'assets/logo.png': PNG,
};

async function setup() {
  const h = await browseHarness();
  const alice = addEmployee(h.db, { username: 'alice' });
  const bob = addEmployee(h.db, { username: 'bob' });
  const maint = addEmployee(h.db, { username: 'maint', is_instance_admin: 1 });
  const vaultId = await seededVault(h, 'alpha', alice, SEED);
  addMember(h.db, vaultId, alice, 'editor', alice);
  addMember(h.db, vaultId, bob, 'reader', alice);
  return { h, alice, bob, maint, vaultId };
}

function get(h: BrowseHarness, url: string, employeeId: number) {
  return h.app.inject({ method: 'GET', url, headers: h.session(employeeId) });
}

function postPreview(h: BrowseHarness, slugPath: string, content: string, employeeId: number) {
  return h.app.inject({
    method: 'POST',
    url: `/edit-preview/${slugPath}`,
    headers: { 'content-type': 'application/json', origin: 'http://localhost', ...h.session(employeeId) },
    payload: { content },
  });
}

/** view 页 <article id="doc"> 内层（与预览片段逐字对照的权威侧） */
function articleInner(viewBody: string): string {
  const m = /<article id="doc">\n([\s\S]*?)\n  <\/article>/.exec(viewBody);
  assert.ok(m !== null, 'view 页含 article#doc 正文容器');
  return m[1]!;
}

test('预览注入不可达：script 块/事件属性/危险协议经同一清理通道全清（安全不变量）', async () => {
  const { h, alice } = await setup();
  try {
    const payload = [
      '# 标题',
      '',
      '<script>alert(1)</script>',
      '',
      '<img src=x onerror=alert(1)>',
      '',
      '[点我](javascript:alert(1))',
      '',
      '[混淆](java\tscript:alert(1))',
      '',
      '<div onclick="alert(1)">文本</div>',
      '',
      '正常 **强调** 与 [链接](https://example.com)。',
    ].join('\n');
    const res = await postPreview(h, 'alpha/docs/first.md', payload, alice);
    assert.equal(res.statusCode, 200, res.body);
    assert.ok(!res.body.includes('<script'), 'script 标签不可达');
    assert.ok(!res.body.includes('onerror'), '事件属性不可达');
    assert.ok(!res.body.includes('onclick'), '事件属性不可达（div 剥标签）');
    assert.ok(!res.body.includes('javascript:'), 'javascript: 协议不可达（含制表符混淆）');
    // 正常内容照常渲染（清理不误伤）
    assert.ok(res.body.includes('<strong>强调</strong>'));
    assert.ok(res.body.includes('href="https://example.com"'));
  } finally {
    await h.close();
  }
});

test('预览与 view 同渲染（同内容逐字一致）：普通文档 + 含仓库相对图片文档（附件通道两遍法同构）', async () => {
  const { h, alice } = await setup();
  try {
    for (const path of ['docs/first.md', 'docs/img.md']) {
      const view = await get(h, `/vaults/alpha/view/${encodeURIComponent('docs')}/${encodeURIComponent(path.slice('docs/'.length))}`, alice);
      assert.equal(view.statusCode, 200, view.body);
      const frag = await postPreview(h, `alpha/${path}`, SEED[path]!, alice);
      assert.equal(frag.statusCode, 200, frag.body);
      assert.equal(frag.body.trim(), articleInner(view.body).trim(), `${path}：预览片段与 view 正文逐字一致`);
    }
    // 图片场景确已走附件通道（对照一致性不因占位而「巧合通过」）
    const imgView = await get(h, `/vaults/alpha/view/${encodeURIComponent('docs')}/${encodeURIComponent('img.md')}`, alice);
    assert.match(articleInner(imgView.body).trim(), /^<h1>[\s\S]*<img src="\/vaults\/alpha\/attach\//, 'view 侧图片已解析为附件 URL');
  } finally {
    await h.close();
  }
});

test('门槛与同判：read 成员（reader）200；非成员与不存在库 404 同体；未认证 302 /login', async () => {
  const { h, alice, bob } = await setup();
  try {
    const reader = await postPreview(h, 'alpha/docs/first.md', '# hi\n', bob);
    assert.equal(reader.statusCode, 200, 'read 成员门槛（与 edit GET 同判）');
    assert.ok(reader.body.includes('<h1>hi</h1>'), '片段正常渲染');

    const carol = addEmployee(h.db, { username: 'carol' }); // 非任何库成员
    const noAccess = await postPreview(h, 'alpha/docs/first.md', '# hi\n', carol);
    const nonexistent = await postPreview(h, 'ghost/docs/first.md', '# hi\n', carol);
    assert.equal(noAccess.statusCode, 404);
    assert.equal(nonexistent.statusCode, 404);
    assert.equal(noAccess.body, nonexistent.body, '同体（不泄露存在性——D-IC-06）');

    const anon = await h.app.inject({
      method: 'POST',
      url: '/edit-preview/alpha/docs/first.md',
      headers: { 'content-type': 'application/json', origin: 'http://localhost' },
      payload: { content: '# hi\n' },
    });
    assert.equal(anon.statusCode, 302, '未认证同 edit GET：302 /login');
    assert.equal(anon.headers.location, '/login');
  } finally {
    await h.close();
  }
});

test('维护模式放行（只读推导——§8.2 validations 先例）：预览 200；写操作照常 503（闸门确实开启）', async () => {
  const { h, alice, maint } = await setup();
  try {
    const toggle = (method: 'POST' | 'DELETE') =>
      h.app.inject({
        method,
        url: '/api/v1/admin/maintenance',
        headers: { origin: 'http://localhost', ...h.session(maint) },
        payload: method === 'POST' ? {} : undefined,
      });
    assert.equal((await toggle('POST')).statusCode, 204, '开启维护');
    try {
      const frag = await postPreview(h, 'alpha/docs/first.md', '# 维护中预览\n', alice);
      assert.equal(frag.statusCode, 200, '维护中预览放行（只读推导）');
      assert.ok(frag.body.includes('维护中预览'), '片段照常渲染');

      const write = await h.app.inject({
        method: 'POST',
        url: '/vaults/alpha/upload/assets/x.png',
        headers: { 'content-type': 'application/octet-stream', origin: 'http://localhost', ...h.session(alice) },
        payload: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      });
      assert.equal(write.statusCode, 503, '对照：web 写操作维护中仍 503（闸门确实开启）');
    } finally {
      assert.equal((await toggle('DELETE')).statusCode, 204, '关闭维护');
    }
  } finally {
    await h.close();
  }
});

test('片段形态与护栏：非整页（无 doctype/html）；超渲染上限 413；请求形态错误 400', async () => {
  const { h, alice } = await setup();
  try {
    const frag = await postPreview(h, 'alpha/docs/first.md', '# x\n', alice);
    assert.ok(!frag.body.includes('<!doctype'), '非整页');
    assert.ok(!frag.body.includes('<html'), '非整页');
    assert.match(frag.headers['content-type'] as string, /^text\/html/);

    const big = await postPreview(h, 'alpha/docs/first.md', 'x'.repeat(1024 * 1024 + 1), alice);
    assert.equal(big.statusCode, 413, big.body);

    const badShape = await h.app.inject({
      method: 'POST',
      url: '/edit-preview/alpha/docs/first.md',
      headers: { 'content-type': 'application/json', origin: 'http://localhost', ...h.session(alice) },
      payload: { nope: 1 },
    });
    assert.equal(badShape.statusCode, 400, badShape.body);
  } finally {
    await h.close();
  }
});

test('编辑页预览接线（JS 形态 + 双栏布局）：PREVIEW_URL fetch 交换预览栏；textarea 左/预览右；窄屏折叠切换', async () => {
  const { h, alice, bob } = await setup();
  try {
    const res = await get(h, '/vaults/alpha/edit/docs/first.md', alice);
    assert.equal(res.statusCode, 200, res.body);
    // 预览端点常量与交换（fetch → 预览栏 innerHTML——片段经服务端同一清理通道）
    assert.ok(res.body.includes('const PREVIEW_URL ='), '预览端点常量');
    assert.ok(res.body.includes('"/edit-preview/alpha/docs/first.md"'), '端点=片段端点（守卫前缀外只读推导）');
    assert.ok(res.body.includes('const PREVIEW_DEBOUNCE_MS ='), '防抖常量（页顶可调）');
    assert.ok(res.body.includes("addEventListener('input'"), '正文输入驱动预览刷新');
    assert.ok(res.body.includes("getElementById('preview-pane')"), '预览栏元素交换');
    // 双栏布局与窄屏折叠（页作用域样式引用 DESIGN.md token——assets/ 属 T3 不动）
    assert.ok(res.body.includes('id="preview-pane"'), '预览栏容器');
    assert.ok(res.body.includes('edit-dual'), '双栏布局类');
    assert.ok(res.body.includes('@media'), '窄屏断点折叠');
    assert.ok(res.body.includes('var(--'), '样式引用 token（不内联 hex）');
    assert.ok(res.body.includes('id="preview-toggle"'), '窄屏切换控件');

    const ro = await get(h, '/vaults/alpha/edit/docs/first.md', bob);
    assert.ok(!ro.body.includes('PREVIEW_URL'), '只读态不携带预览接线');
    assert.ok(!ro.body.includes('id="preview-pane"'), '只读态无预览栏交互（只读呈现不含双栏）');
  } finally {
    await h.close();
  }
});
