import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  browseHarness,
  seededVault,
  addEmployee,
  addMember,
  gitOut,
  repoPathOf,
  type BrowseHarness,
} from './web-browse-fixtures.ts';

// S10-T2 权限感知呈现——rename/delete GET 域角色矩阵（F-2）+ D17 回归锁定。
//
// - reader 手改 URL 直接访问 rename/delete GET → 200 只读态（门槛保持 read
//   成员，D4）：表单禁用、不渲染提交控件 + 「无写权限」标注。
// - reader POST rename/delete 仍 403（呈现层改动不弱化 POST 侧全量鉴权，
//   D17——本文件锁定，与 web-rename-routes.test.ts 既有 403 断言互补）。

interface Fix {
  h: BrowseHarness;
  repoPath: string;
  seedMain: string;
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
  const repoPath = repoPathOf(h, vaultId);
  f = {
    h,
    repoPath,
    seedMain: (await gitOut(['--git-dir', repoPath, 'rev-parse', 'refs/heads/main'])).trim(),
    admin,
    editor,
    reader,
  };
});

after(async () => {
  await f.h.close();
});

beforeEach(async () => {
  await gitOut(['--git-dir', f.repoPath, 'update-ref', 'refs/heads/main', f.seedMain]);
});

test('rename/delete GET 矩阵：admin/editor 表单页可用（输入未禁用、提交控件在位）', async () => {
  for (const who of [f.admin, f.editor]) {
    const rename = await f.h.app.inject({ method: 'GET', url: '/vaults/alpha/rename/docs/guide.md', headers: f.h.session(who) });
    assert.equal(rename.statusCode, 200, rename.body);
    assert.ok(rename.body.includes('name="to"'), `who=${who} 重命名输入在位`);
    assert.ok(!rename.body.includes('disabled'), `who=${who} 重命名输入未禁用`);
    assert.ok(rename.body.includes('保存重命名'), `who=${who} 重命名提交控件在位`);

    const del = await f.h.app.inject({ method: 'GET', url: '/vaults/alpha/delete/docs/guide.md', headers: f.h.session(who) });
    assert.equal(del.statusCode, 200, del.body);
    assert.ok(del.body.includes('确认删除'), `who=${who} 删除提交控件在位`);
  }
});

test('rename GET reader：页面 200 只读态——输入禁用、无「保存重命名」提交控件 + 「无写权限」标注', async () => {
  const page = await f.h.app.inject({ method: 'GET', url: '/vaults/alpha/rename/docs/guide.md', headers: f.h.session(f.reader) });
  assert.equal(page.statusCode, 200, page.body); // 门槛保持 read 成员（D4）
  assert.ok(page.body.includes('>只读成员</span>'), '只读成员徽章');
  assert.ok(page.body.includes('无写权限'), '「无写权限」标注');
  assert.ok(page.body.includes('docs/guide.md'), '原路径上下文仍可见');
  assert.ok(page.body.includes('disabled'), '输入禁用（disabled）');
  assert.ok(!page.body.includes('保存重命名'), '不渲染重命名提交控件');
});

test('delete GET reader：页面 200 只读态——无「确认删除」提交控件 + 只读标注', async () => {
  const page = await f.h.app.inject({ method: 'GET', url: '/vaults/alpha/delete/docs/guide.md', headers: f.h.session(f.reader) });
  assert.equal(page.statusCode, 200, page.body); // 门槛保持 read 成员（D4）
  assert.ok(page.body.includes('>只读成员</span>'), '只读成员徽章');
  assert.ok(page.body.includes('无写权限'), '「无写权限」标注');
  assert.ok(page.body.includes('docs/guide.md'), '将删除路径上下文仍可见');
  assert.ok(!page.body.includes('确认删除'), '不渲染删除提交控件');
  assert.ok(!page.body.includes('type="submit"'), '页面无任何提交控件');
});

/** POST rename（原生表单 + 同源 Origin——与既有 web-rename-routes.test.ts 同形） */
function postRename(who: number, from: string, to: string) {
  return f.h.app.inject({
    method: 'POST',
    url: `/vaults/alpha/rename/${from.split('/').map(encodeURIComponent).join('/')}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://localhost', ...f.h.session(who) },
    payload: `to=${encodeURIComponent(to)}`,
  });
}

function postDelete(who: number, path: string) {
  return f.h.app.inject({
    method: 'POST',
    url: `/vaults/alpha/delete/${path.split('/').map(encodeURIComponent).join('/')}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://localhost', ...f.h.session(who) },
    payload: '',
  });
}

async function treePaths(): Promise<string[]> {
  const out = await gitOut(['--git-dir', f.repoPath, 'ls-tree', '-r', '--name-only', 'refs/heads/main']);
  return out.split('\n').filter((x) => x !== '');
}

test('D17 回归锁定：reader POST rename/delete 仍 403，树与分支不动（呈现层改动不弱化判定）', async () => {
  const rename = await postRename(f.reader, 'docs/guide.md', 'docs/renamed.md');
  assert.equal(rename.statusCode, 403, rename.body);
  const del = await postDelete(f.reader, 'docs/guide.md');
  assert.equal(del.statusCode, 403, del.body);
  assert.deepEqual(await treePaths(), ['README.md', 'docs/guide.md'], '树不动');
  assert.equal((await gitOut(['--git-dir', f.repoPath, 'rev-parse', 'refs/heads/main'])).trim(), f.seedMain, '分支不动');
});
