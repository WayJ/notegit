import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browseHarness, seededVault, addEmployee, addMember, gitOut, repoPathOf, type BrowseHarness } from './web-browse-fixtures.ts';

// S4-T3 编辑页路由（breakdown §2.3 S4-T3：六字段表单 + title 必填提示 + 从文件名
// 生成 title + status 下拉防呆 + tags 输入 + 额外字段 + 正文 textarea + 保存/提交
// 调用面形状）。页面 = GET 无写操作（api.md §13/D5：安全判定在 API 侧——编辑页
// 要求 read 成员，写权限在提交时由发布组件 authorization 阶段判定）。鉴权/404
// 反存在性与 browse/view 同判（D-IC-06）。

const SEED: Record<string, string> = {
  'README.md': '# 导航\n',
  'docs/first.md': '---\ntitle: "First 笔记"\nowner: zhangsan\ntags: [人事, 报销]\nstatus: draft\ndepartment: 财务部\n---\n\n# 正文标题\n\n内容。\n',
  'docs/xss.md': '---\ntitle: "><script>alert(1)</script>\n---\n正文',
  'assets/logo.png': 'binary-ish',
  'docs/sub/': '',
};

async function setup() {
  const h = await browseHarness();
  const alice = addEmployee(h.db, { username: 'alice' });
  const bob = addEmployee(h.db, { username: 'bob' });
  const vaultId = await seededVault(h, 'alpha', alice, {
    'README.md': '# 导航\n',
    'docs/first.md': SEED['docs/first.md']!,
    'docs/xss.md': SEED['docs/xss.md']!,
    'assets/logo.png': 'binary-ish',
    'docs/sub/keep.md': '---\ntitle: Keep\n---\nb\n',
  });
  addMember(h.db, vaultId, alice, 'editor', alice);
  addMember(h.db, vaultId, bob, 'reader', alice);
  const seedMain = (await gitOut(['--git-dir', repoPathOf(h, vaultId), 'rev-parse', 'main'])).trim();
  return { h, alice, bob, vaultId, seedMain };
}

function get(h: BrowseHarness, url: string, employeeId: number) {
  return h.app.inject({ method: 'GET', url, headers: h.session(employeeId) });
}

test('编辑页鉴权：未认证 302 /login；无权与不存在同 404 同体（D-IC-06）', async () => {
  const { h, bob } = await setup();
  try {
    const anon = await h.app.inject({ method: 'GET', url: '/vaults/alpha/edit/docs/first.md' });
    assert.equal(anon.statusCode, 302);
    assert.equal(anon.headers.location, '/login');

    const a = await get(h, '/vaults/ghost/edit/docs/first.md', bob); // 不存在
    const b = await h.app.inject({ method: 'GET', url: '/vaults/alpha/edit/docs/first.md' }); // 未认证同 302
    assert.equal(b.statusCode, 302);
    assert.equal(a.statusCode, 404);
    assert.ok(a.body.includes('404'));
  } finally {
    await h.close();
  }
});

test('无权成员（非成员）404：与不存在库同页反存在性', async () => {
  const { h, bob } = await setup();
  try {
    const carol = addEmployee(h.db, { username: 'carol' }); // 非任何库成员
    const noAccess = await get(h, '/vaults/alpha/edit/docs/first.md', carol);
    const nonexistent = await get(h, '/vaults/ghost/edit/docs/first.md', carol);
    assert.equal(noAccess.statusCode, 404);
    assert.equal(nonexistent.statusCode, 404);
    assert.equal(noAccess.body, nonexistent.body, '同体（不泄露存在性）');
  } finally {
    await h.close();
  }
});

test('编辑既有 .md：六字段回填 + 正文 textarea + base commit 嵌入 + W 提示区', async () => {
  const { h, alice, seedMain } = await setup();
  try {
    const res = await get(h, '/vaults/alpha/edit/docs/first.md', alice);
    assert.equal(res.statusCode, 200, res.body);
    // 六字段回填（转义插值）
    assert.ok(res.body.includes('name="title"'), 'title 输入');
    assert.match(res.body, /value="First 笔记"/);
    assert.match(res.body, /value="zhangsan"/);
    assert.match(res.body, /value="人事, 报销"/);
    assert.ok(res.body.includes('name="description"'));
    assert.ok(res.body.includes('name="source"'));
    // status 下拉防呆：仅四选项，当前 draft 选中
    const options = [...res.body.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]);
    assert.deepEqual(options.filter((v, i, a) => a.indexOf(v) === i), ['', 'active', 'draft', 'deprecated'], '下拉仅法定值');
    assert.match(res.body, /<option value="draft" selected>/);
    // 额外字段文本区回填
    assert.ok(res.body.includes('department: 财务部'), 'extra 键原样回填');
    // 正文 textarea
    assert.ok(res.body.includes('name="body"'));
    assert.ok(res.body.includes('# 正文标题'));
    // base commit 嵌入（§7/§8.2 形状共用）
    assert.ok(res.body.includes(seedMain), 'HEAD oid 嵌入为 base commit');
    // W 级温和提示区存在（不阻断）
    assert.ok(res.body.includes('id="form-warn"'));
  } finally {
    await h.close();
  }
});

test('title 必填提示：required + maxlength 属性（浏览器原生防线，服务端 E-FM-003 兜底）', async () => {
  const { h, alice } = await setup();
  try {
    const res = await get(h, '/vaults/alpha/edit/docs/first.md', alice);
    assert.match(res.body, /<input name="title"[^>]*required/);
    assert.match(res.body, /maxlength="200"/);
  } finally {
    await h.close();
  }
});

test('新建 .md（路径不存在）：title 从文件名生成（提交前可改）+ 新建标注', async () => {
  const { h, alice, seedMain } = await setup();
  try {
    const res = await get(h, '/vaults/alpha/edit/docs/差旅报销制度.md', alice);
    assert.equal(res.statusCode, 200, res.body);
    assert.match(res.body, /value="差旅报销制度"/, 'title 自文件名生成（去扩展名）');
    assert.ok(res.body.includes('新建'), '新建模式标注');
    assert.ok(res.body.includes(seedMain), 'base commit 仍嵌入（提交需 CAS 旧值）');
    // title 是可修改的输入框（非只读）
    assert.ok(!/<input name="title"[^>]*readonly/.test(res.body));
  } finally {
    await h.close();
  }
});

test('status 下拉防呆：无自由文本状态入口（非法值只能经 extra 注入——校验双保险兜底）', async () => {
  const { h, alice } = await setup();
  try {
    const res = await get(h, '/vaults/alpha/edit/docs/first.md', alice);
    assert.ok(res.body.includes('<select name="status">'));
    // 页面不存在 status 文本输入（防呆=选项封闭集）
    assert.ok(!/<input[^>]*name="status"/.test(res.body));
  } finally {
    await h.close();
  }
});

test('非 .md 路径 404（表单仅知识 Markdown；附件/图片属 T4 域）', async () => {
  const { h, alice } = await setup();
  try {
    const res = await get(h, '/vaults/alpha/edit/assets/logo.png', alice);
    assert.equal(res.statusCode, 404);
  } finally {
    await h.close();
  }
});

test('README.md：豁免语义——仅正文编辑（无六字段表单）+ 豁免标注', async () => {
  const { h, alice } = await setup();
  try {
    const res = await get(h, '/vaults/alpha/edit/README.md', alice);
    assert.equal(res.statusCode, 200, res.body);
    assert.ok(!res.body.includes('name="title"'), 'README 豁免 frontmatter——不呈现元数据表单');
    assert.ok(res.body.includes('name="body"'), '正文 textarea 仍在');
    assert.ok(res.body.includes('豁免'), '豁免如实标注');
  } finally {
    await h.close();
  }
});

test('目录路径 302 → browse（与 view 族同判）', async () => {
  const { h, alice } = await setup();
  try {
    const res = await get(h, '/vaults/alpha/edit/docs/sub', alice);
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/vaults/alpha/browse/docs/sub');
  } finally {
    await h.close();
  }
});

test('回填转义：frontmatter 值含标签脚本不外泄（escapeHtml 唯一插值通道）', async () => {
  const { h, alice } = await setup();
  try {
    const res = await get(h, '/vaults/alpha/edit/docs/xss.md', alice);
    assert.equal(res.statusCode, 200, res.body);
    assert.ok(!res.body.includes('<script>alert(1)'), 'title 原文不得构成标签');
    assert.ok(res.body.includes('&lt;script&gt;'), '转义后呈现');
    // S12-T3：写者形态编辑页 = 共享脚本 src 引用 + 内联块（恰两处，注入面不得多出）
    assert.equal((res.body.match(/<script/g) ?? []).length, 2, '全页 <script> 恰两处（src 引用+内联块）');
  } finally {
    await h.close();
  }
});

test('保存/提交调用面形状：§7 草稿 PUT 与 §8.2 提交 POST 的 URL 与 base_commit 键', async () => {
  const { h, alice } = await setup();
  try {
    const res = await get(h, '/vaults/alpha/edit/docs/first.md', alice);
    // §7：PUT /api/v1/vaults/{slug}/drafts/{path}（存储 S4-T6 落地——形状先定）
    assert.ok(res.body.includes('/api/v1/vaults/alpha/drafts/docs/first.md'), '草稿 PUT URL');
    assert.ok(res.body.includes("'PUT'"), '草稿保存方法=PUT');
    assert.ok(res.body.includes('base_commit'), '§7 请求体键');
    // §8.2：POST /api/v1/vaults/{slug}/submissions
    assert.ok(res.body.includes('/api/v1/vaults/alpha/submissions'), '提交 POST URL');
    assert.ok(/changes:/.test(res.body), '§8.2 变更清单键');
  } finally {
    await h.close();
  }
});

test('脚本字面量插值防逃逸：路径含 </script> 不破出脚本块（新建路径直达表单）', async () => {
  const { h, alice } = await setup();
  try {
    const res = await get(h, '/vaults/alpha/edit/docs/x%3C/script%3E%3Cscript%3Ealert(1)%3C/script%3E.md', alice);
    assert.equal(res.statusCode, 200, res.body);
    // S12-T3：恰两处（共享脚本 src 引用+内联块）——用户路径不得破出成第三处
    assert.equal((res.body.match(/<script/g) ?? []).length, 2, '不得破出（src 引用+内联块恰两处）');
    assert.equal((res.body.match(/<\/script>/g) ?? []).length, 2, '闭合标签恰两处');
    assert.ok(res.body.includes('\\u003c'), '路径以 \\u003c 转义嵌入脚本字面量');
    assert.ok(res.body.includes('&lt;script&gt;alert(1)'), '标题处仅以转义文本呈现（非可执行形态）');
  } finally {
    await h.close();
  }
});

test('只读成员亦见表单（页面 read 门槛；写权限由提交时发布组件判定——D5 安全判定在 API 侧）', async () => {
  const { h, bob } = await setup();
  try {
    const res = await get(h, '/vaults/alpha/edit/docs/first.md', bob);
    assert.equal(res.statusCode, 200, res.body);
  } finally {
    await h.close();
  }
});
