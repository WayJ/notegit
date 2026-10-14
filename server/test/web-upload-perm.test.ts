import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { browseHarness, seededVault, addEmployee, addMember, type BrowseHarness } from './web-browse-fixtures.ts';

// S10-T2 权限感知呈现——upload GET 域角色矩阵（F-2：bob 实测可打开完整上传
// 表单，POST 才 403）。D4 裁决：reader 手改 URL 直接访问 upload GET 页 →
// 页面可达（门槛保持 read 成员，404 语义不变）但呈现只读态——表单控件禁用、
// 不渲染提交控件 + 「无写权限」标注；admin/editor 表单照常可用。

interface Fix {
  h: BrowseHarness;
  admin: number;
  editor: number;
  reader: number;
}

let f: Fix;

before(async () => {
  const h = await browseHarness();
  const admin = addEmployee(h.db, { username: 'alice' });
  const editor = addEmployee(h.db, { username: 'erin' });
  const reader = addEmployee(h.db, { username: 'bob' });
  const vaultId = await seededVault(h, 'alpha', admin, {
    'README.md': '# nav\n',
    'docs/guide.md': '---\ntitle: 指南\n---\n\n正文。\n',
  });
  addMember(h.db, vaultId, admin, 'admin', admin);
  addMember(h.db, vaultId, editor, 'editor', admin);
  addMember(h.db, vaultId, reader, 'reader', admin);
  f = { h, admin, editor, reader };
});

after(async () => {
  await f.h.close();
});

test('upload GET 矩阵：admin/editor 表单可用（提交控件 + 交互脚本在位）', async () => {
  for (const who of [f.admin, f.editor]) {
    const page = await f.h.app.inject({ method: 'GET', url: '/vaults/alpha/upload/docs', headers: f.h.session(who) });
    assert.equal(page.statusCode, 200, page.body);
    assert.ok(page.body.includes('type="file"'), `who=${who} 文件选择控件在位`);
    assert.ok(page.body.includes('type="submit"'), `who=${who} 上传提交控件在位`);
    assert.ok(!page.body.includes('>只读成员</span>'), `who=${who} 不呈现只读徽章`);
  }
});

test('upload GET reader：页面 200 只读态——控件禁用、无提交控件、无交互脚本 + 「无写权限」标注', async () => {
  const page = await f.h.app.inject({ method: 'GET', url: '/vaults/alpha/upload/docs', headers: f.h.session(f.reader) });
  assert.equal(page.statusCode, 200, page.body); // 门槛保持 read 成员（D4：不改为 404/403）
  assert.ok(page.body.includes('>只读成员</span>'), '只读成员徽章');
  assert.ok(page.body.includes('无写权限'), '「无写权限」标注');
  assert.ok(page.body.includes('docs'), '目标目录上下文仍呈现');
  assert.ok(!page.body.includes('type="submit"'), '不得渲染提交控件');
  assert.ok(!page.body.includes("getElementById('upload-form')"), '只读态不携带交互脚本（脚本绑定空元素会报错）');
  assert.ok(page.body.includes('disabled'), '表单控件禁用（disabled）');
});
