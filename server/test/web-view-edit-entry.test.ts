import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browseHarness, seededVault, addEmployee, addMember } from './web-browse-fixtures.ts';

// S10-T1 编辑入口·view 页（e2-gui research F-1 / P0-1；sprint S10 D2/D17）：
// - view 页主操作位提供「编辑此页」链接，指向既有 GET /vaults/{slug}/edit/{path}
//   （不新增端点），≤1 跳到编辑表单（DOD-E2-01）；
// - 呈现经共享判定点 canWriteVault（role-gate.ts——authorize('write') 薄委托）：
//   editor 渲染链接；reader 不渲染编辑入口，以只读徽章如实标注（DESIGN.md badge
//   形态）。安全语义零变化：POST 侧鉴权不动（D17），页面门槛保持 read 成员。

const SEED: Record<string, string> = {
  'README.md': '# 导航\n',
  'docs/first.md': '---\ntitle: First\n---\n正文一\n',
};

test('view 页编辑入口：editor 主操作位见「编辑此页」（既有 edit 路由，GET 200）', async () => {
  const h = await browseHarness();
  try {
    const alice = addEmployee(h.db, { username: 'alice' });
    await seededVault(h, 'alpha', alice, SEED);
    addMember(h.db, 1, alice, 'editor', alice);
    const headers = h.session(alice);

    const res = await h.app.inject({ method: 'GET', url: '/vaults/alpha/view/docs/first.md', headers });
    assert.equal(res.statusCode, 200, res.body);

    // 关键片段有序：页头 → 编辑入口（主操作位，btn-primary 主 CTA 形态） → 正文容器
    const headAt = res.body.indexOf('<div class="page-head">');
    const editAt = res.body.indexOf('href="/vaults/alpha/edit/docs/first.md"');
    const docAt = res.body.indexOf('<article id="doc">');
    assert.ok(headAt >= 0 && docAt > headAt, '页面结构基线（页头/正文容器）');
    assert.ok(editAt > headAt && editAt < docAt, '编辑入口位于页头与正文之间的主操作位');
    assert.ok(res.body.includes('class="btn btn-primary" href="/vaults/alpha/edit/docs/first.md">编辑此页</a>'), '主 CTA 形态与入口文案');

    // 链接真实可达：editor GET edit 表单 200（≤1 跳，DOD-E2-01）
    const edit = await h.app.inject({ method: 'GET', url: '/vaults/alpha/edit/docs/first.md', headers });
    assert.equal(edit.statusCode, 200, edit.body);
  } finally {
    await h.close();
  }
});

test('view 页编辑入口：reader 不渲染编辑链接，呈现只读徽章', async () => {
  const h = await browseHarness();
  try {
    const alice = addEmployee(h.db, { username: 'alice' });
    const bob = addEmployee(h.db, { username: 'bob' });
    await seededVault(h, 'alpha', alice, SEED);
    addMember(h.db, 1, alice, 'editor', alice);
    addMember(h.db, 1, bob, 'reader', alice);

    const res = await h.app.inject({ method: 'GET', url: '/vaults/alpha/view/docs/first.md', headers: h.session(bob) });
    assert.equal(res.statusCode, 200, res.body); // reader 是 read 成员——页面门槛不变
    assert.ok(!res.body.includes('/vaults/alpha/edit/'), 'reader 不渲染编辑入口（canWriteVault 不放行）');
    assert.ok(res.body.includes('<span class="badge">只读</span>'), '只读徽章如实标注（DESIGN.md badge 形态）');
  } finally {
    await h.close();
  }
});
