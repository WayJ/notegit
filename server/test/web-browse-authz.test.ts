import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browseHarness, seededVault, addEmployee, addMember } from './web-browse-fixtures.ts';

// S4-T1 无权 404 反存在性（breakdown §2.3 完成标准「无权库 URL 直接访问 404（与
// 不存在一致）」——D-IC-06 页面形态：无权与不存在同状态码同响应体，不泄露库
// 存在性）+ 预览占位路由族行为。

const SEED: Record<string, string> = {
  'README.md': '# 导航\n',
  'docs/first.md': '---\ntitle: First\n---\n正文一\n',
};

test('404 反存在性：无权库与不存在库在 browse/view/库根三路由同状态同体', async () => {
  const h = await browseHarness();
  try {
    const alice = addEmployee(h.db, { username: 'alice' });
    const bob = addEmployee(h.db, { username: 'bob' });
    await seededVault(h, 'secret', alice, SEED); // 存在但 bob 非成员
    addMember(h.db, 1, alice, 'admin', alice);
    const bobHeaders = h.session(bob);

    for (const [noAccess, nonexistent] of [
      ['/vaults/secret/browse', '/vaults/ghost/browse'],
      ['/vaults/secret/browse/docs', '/vaults/ghost/browse/docs'],
      ['/vaults/secret/view/docs/first.md', '/vaults/ghost/view/docs/first.md'],
      ['/vaults/secret', '/vaults/ghost'],
    ] as const) {
      const a = await h.app.inject({ method: 'GET', url: noAccess, headers: bobHeaders });
      const b = await h.app.inject({ method: 'GET', url: nonexistent, headers: bobHeaders });
      assert.equal(a.statusCode, 404, `${noAccess} 无权访问应 404`);
      assert.equal(b.statusCode, 404, `${nonexistent} 应 404`);
      assert.equal(a.body, b.body, `${noAccess} 与不存在库响应体必须一致（不泄露存在性，D-IC-06）`);
      assert.ok(a.body.includes('404'), '404 页呈现');
    }
  } finally {
    await h.close();
  }
});

test('404 反存在性：撤权后下一请求即 404（实时授权，identity §5.2）', async () => {
  const h = await browseHarness();
  try {
    const alice = addEmployee(h.db, { username: 'alice' });
    const bob = addEmployee(h.db, { username: 'bob' });
    await seededVault(h, 'alpha', alice, SEED);
    addMember(h.db, 1, alice, 'admin', alice);
    addMember(h.db, 1, bob, 'reader', alice);
    const bobHeaders = h.session(bob);

    const before = await h.app.inject({ method: 'GET', url: '/vaults/alpha/browse', headers: bobHeaders });
    assert.equal(before.statusCode, 200);

    h.db.prepare('DELETE FROM vault_members WHERE vault_id = 1 AND employee_id = ?').run(bob);
    const after = await h.app.inject({ method: 'GET', url: '/vaults/alpha/browse', headers: bobHeaders });
    assert.equal(after.statusCode, 404, '撤权下一请求即 404');
  } finally {
    await h.close();
  }
});

test('浏览族：未认证一律 302 /login（不泄露任何库信息）', async () => {
  const h = await browseHarness();
  try {
    const alice = addEmployee(h.db, { username: 'alice' });
    await seededVault(h, 'alpha', alice, SEED);
    addMember(h.db, 1, alice, 'admin', alice);
    for (const p of ['/vaults/alpha', '/vaults/alpha/browse', '/vaults/alpha/browse/docs', '/vaults/alpha/view/docs/first.md']) {
      const res = await h.app.inject({ method: 'GET', url: p });
      assert.equal(res.statusCode, 302, `${p} 未认证应 302`);
      assert.equal(res.headers.location, '/login');
    }
  } finally {
    await h.close();
  }
});

test('库根 GET /vaults/{slug}：成员 → 302 目录浏览 canonical URL', async () => {
  const h = await browseHarness();
  try {
    const alice = addEmployee(h.db, { username: 'alice' });
    await seededVault(h, 'alpha', alice, SEED);
    addMember(h.db, 1, alice, 'admin', alice);
    const res = await h.app.inject({ method: 'GET', url: '/vaults/alpha', headers: h.session(alice) });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/vaults/alpha/browse');
  } finally {
    await h.close();
  }
});

test('预览占位：blob → 200 占位页（名称/大小/占位标注）；tree → 302 browse；缺失 → 404', async () => {
  const h = await browseHarness();
  try {
    const alice = addEmployee(h.db, { username: 'alice' });
    await seededVault(h, 'alpha', alice, SEED);
    addMember(h.db, 1, alice, 'editor', alice);
    const headers = h.session(alice);

    const blob = await h.app.inject({ method: 'GET', url: '/vaults/alpha/view/docs/first.md', headers });
    assert.equal(blob.statusCode, 200, blob.body);
    assert.ok(blob.body.includes('first.md'));
    assert.ok(blob.body.includes('占位'), '如实标注占位（安全渲染属 S4-T2）');
    assert.ok(/大小：\d+ 字节/.test(blob.body), '展示大小元信息');

    const tree = await h.app.inject({ method: 'GET', url: '/vaults/alpha/view/docs', headers });
    assert.equal(tree.statusCode, 302);
    assert.equal(tree.headers.location, '/vaults/alpha/browse/docs');

    const missing = await h.app.inject({ method: 'GET', url: '/vaults/alpha/view/nope.md', headers });
    assert.equal(missing.statusCode, 404);
  } finally {
    await h.close();
  }
});
