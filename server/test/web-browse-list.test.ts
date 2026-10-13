import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browseHarness, seededVault, addEmployee, addMember } from './web-browse-fixtures.ts';

// S4-T1 有权库列表页（breakdown §2.3：库列表实时查权限；两员工不同成员集差异
// 断言）。列表 = 服务端渲染（D5 极简：服务端模板 + escapeHtml 唯一插值通道），
// 数据面复用 GET /api/v1/vaults 同一判定（仅当前员工成员关系的库，架构 §4.2
// 「未授权的库不进入列表」）。页面路由 GET 免 CSRF（安全方法）。

test('库列表：两员工不同成员集 → 各自仅见有权库（差异断言）', async () => {
  const h = await browseHarness();
  try {
    const alice = addEmployee(h.db, { username: 'alice' });
    const bob = addEmployee(h.db, { username: 'bob' });
    const alpha = await seededVault(h, 'alpha', alice);
    const beta = await seededVault(h, 'beta', alice);
    addMember(h.db, alpha, alice, 'admin', alice);
    addMember(h.db, beta, alice, 'editor', alice);
    addMember(h.db, beta, bob, 'reader', alice);

    const alicePage = await h.app.inject({ method: 'GET', url: '/vaults', headers: h.session(alice) });
    assert.equal(alicePage.statusCode, 200, alicePage.body);
    assert.match(alicePage.headers['content-type'] as string, /^text\/html/);
    assert.ok(alicePage.body.includes('alpha'), 'alice 应见 alpha');
    assert.ok(alicePage.body.includes('beta'), 'alice 应见 beta');

    const bobPage = await h.app.inject({ method: 'GET', url: '/vaults', headers: h.session(bob) });
    assert.equal(bobPage.statusCode, 200, bobPage.body);
    assert.ok(bobPage.body.includes('beta'), 'bob 应见 beta');
    assert.ok(!bobPage.body.includes('alpha'), 'bob 不得见 alpha（无权库不进列表，架构 §4.2）');
  } finally {
    await h.close();
  }
});

test('库列表：每行链接到该库目录浏览入口 /vaults/{slug}/browse', async () => {
  const h = await browseHarness();
  try {
    const alice = addEmployee(h.db, { username: 'alice' });
    await seededVault(h, 'alpha', alice);
    addMember(h.db, 1, alice, 'admin', alice);
    const page = await h.app.inject({ method: 'GET', url: '/vaults', headers: h.session(alice) });
    assert.equal(page.statusCode, 200);
    assert.ok(page.body.includes('href="/vaults/alpha/browse"'), '列表行应链接目录浏览入口');
  } finally {
    await h.close();
  }
});

test('库列表实时性：撤权后下一请求即消失（实时查库、无缓存，D-IC-05）', async () => {
  const h = await browseHarness();
  try {
    const alice = addEmployee(h.db, { username: 'alice' });
    const bob = addEmployee(h.db, { username: 'bob' });
    await seededVault(h, 'alpha', alice);
    addMember(h.db, 1, alice, 'admin', alice);
    addMember(h.db, 1, bob, 'reader', alice);

    const before = await h.app.inject({ method: 'GET', url: '/vaults', headers: h.session(bob) });
    assert.ok(before.body.includes('alpha'));

    h.db.prepare('DELETE FROM vault_members WHERE vault_id = 1 AND employee_id = ?').run(bob);
    const after = await h.app.inject({ method: 'GET', url: '/vaults', headers: h.session(bob) });
    assert.equal(after.statusCode, 200);
    assert.ok(!after.body.includes('alpha'), '撤权下一请求即从列表消失（identity §5.2 行 4）');
  } finally {
    await h.close();
  }
});

test('库列表：未认证 → 302 /login（页面统一引导，不泄露内容）', async () => {
  const h = await browseHarness();
  try {
    const res = await h.app.inject({ method: 'GET', url: '/vaults' });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/login');
  } finally {
    await h.close();
  }
});

test('库列表：vault 名含 HTML 时被转义（escapeHtml 唯一插值通道）', async () => {
  const h = await browseHarness();
  try {
    const alice = addEmployee(h.db, { username: 'alice' });
    h.db.prepare(
      `INSERT INTO vaults (slug, name, created_by, created_at) VALUES ('alpha', '<script>alert(1)</script>', ?, ?)`,
    ).run(alice, new Date().toISOString());
    addMember(h.db, 1, alice, 'admin', alice);
    const page = await h.app.inject({ method: 'GET', url: '/vaults', headers: h.session(alice) });
    assert.equal(page.statusCode, 200);
    assert.ok(!page.body.includes('<script>alert(1)</script>'), '原生 HTML 不得落页');
    assert.ok(page.body.includes('&lt;script&gt;'), '应以转义形态展示');
  } finally {
    await h.close();
  }
});
