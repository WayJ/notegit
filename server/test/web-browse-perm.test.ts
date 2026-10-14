import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { browseHarness, seededVault, addEmployee, addMember, type BrowseHarness } from './web-browse-fixtures.ts';

// S10-T2 权限感知呈现——browse 域角色矩阵（E2 research §2.3 F-2：读写不分
// 的入口渲染让读者满屏死按钮——bob 实测看到完整 上传/重命名/删除）。
//
// - 写入口（目录级「上传」、文件行 编辑/重命名/删除）按 canWriteVault 渲染：
//   admin/editor 可见，reader 隐藏（呈现层优化，D17——POST 侧鉴权原样）。
// - reader browse 页仍 200、条目与导航不变（页面门槛保持 read 成员），
//   呈现「只读成员」徽章（DESIGN.md badge-pill 形态）。
// - 编辑链接 = 新入口：指向既有 GET /vaults/{slug}/edit/{path}（D2，editor+
//   可见；非 .md 文件不挂——edit GET 对非 .md 404，不造死链）。
// - 断言只取包含且有序的关键片段（不断言整页 HTML 全等）。

interface Fix {
  h: BrowseHarness;
  admin: number;
  editor: number;
  reader: number;
  outsider: number;
}

let f: Fix;

before(async () => {
  const h = await browseHarness();
  const admin = addEmployee(h.db, { username: 'alice' });
  const editor = addEmployee(h.db, { username: 'erin' });
  const reader = addEmployee(h.db, { username: 'bob' });
  const outsider = addEmployee(h.db, { username: 'dave' }); // 非任何库成员
  const vaultId = await seededVault(h, 'alpha', admin, {
    'README.md': '# nav\n',
    'docs/guide.md': '---\ntitle: 指南\n---\n\n正文。\n',
    'docs/assets/pic.png': 'png-not-really\n',
  });
  addMember(h.db, vaultId, admin, 'admin', admin);
  addMember(h.db, vaultId, editor, 'editor', admin);
  addMember(h.db, vaultId, reader, 'reader', admin);
  f = { h, admin, editor, reader, outsider };
});

after(async () => {
  await f.h.close();
});

/** 三角色同页矩阵断言：写入口按 canWriteVault（admin/editor 有、reader 无） */
test('browse 写入口矩阵：admin/editor 目录页见 上传 + 文件行 编辑/重命名/删除（有序），reader 全无', async () => {
  for (const who of [f.admin, f.editor]) {
    const page = await f.h.app.inject({ method: 'GET', url: '/vaults/alpha/browse/docs', headers: f.h.session(who) });
    assert.equal(page.statusCode, 200, page.body);
    // 目录级上传入口（指向该目录的上传页）
    assert.ok(page.body.includes('href="/vaults/alpha/upload/docs"'), `who=${who} 目录上传入口应可见`);
    // 文件行三写入口，包含且有序：编辑 → 重命名 → 删除
    const editIdx = page.body.indexOf('href="/vaults/alpha/edit/docs/guide.md"');
    const renameIdx = page.body.indexOf('href="/vaults/alpha/rename/docs/guide.md"');
    const deleteIdx = page.body.indexOf('href="/vaults/alpha/delete/docs/guide.md"');
    assert.ok(editIdx !== -1, `who=${who} 编辑链接在位（新入口，D2）`);
    assert.ok(renameIdx !== -1, `who=${who} 重命名链接在位`);
    assert.ok(deleteIdx !== -1, `who=${who} 删除链接在位`);
    assert.ok(editIdx < renameIdx && renameIdx < deleteIdx, `who=${who} 编辑→重命名→删除 有序`);
  }

  const reader = await f.h.app.inject({ method: 'GET', url: '/vaults/alpha/browse/docs', headers: f.h.session(f.reader) });
  assert.equal(reader.statusCode, 200, reader.body); // 页面门槛保持 read 成员（D4）
  assert.ok(!reader.body.includes('href="/vaults/alpha/upload'), 'reader 不得见上传入口');
  assert.ok(!reader.body.includes('href="/vaults/alpha/edit/'), 'reader 不得见编辑链接');
  assert.ok(!reader.body.includes('href="/vaults/alpha/rename/'), 'reader 不得见重命名链接');
  assert.ok(!reader.body.includes('href="/vaults/alpha/delete/'), 'reader 不得见删除链接');
});

test('browse reader：条目与导航不变 + 「只读成员」徽章（页面 200，只读态呈现）', async () => {
  const page = await f.h.app.inject({ method: 'GET', url: '/vaults/alpha/browse', headers: f.h.session(f.reader) });
  assert.equal(page.statusCode, 200, page.body);
  assert.ok(page.body.includes('href="/vaults/alpha/view/README.md"'), '条目阅读链接不变（读者可读）');
  assert.ok(page.body.includes('href="/vaults/alpha/browse/docs"'), '子目录导航不变');
  assert.ok(page.body.includes('>只读成员</span>'), '只读成员徽章（DESIGN.md badge-pill 形态）');
  assert.ok(!page.body.includes('href="/vaults/alpha/upload"'), '库根上传入口对 reader 隐藏');
});

test('browse 编辑链接：README 与 .md 文件在位；非 .md 附件不挂（edit 对非 .md 404——不造死链）', async () => {
  const root = await f.h.app.inject({ method: 'GET', url: '/vaults/alpha/browse', headers: f.h.session(f.editor) });
  assert.ok(root.body.includes('href="/vaults/alpha/edit/README.md"'), 'README.md 编辑链接（豁免页同样可达）');
  const assets = await f.h.app.inject({ method: 'GET', url: '/vaults/alpha/browse/docs/assets', headers: f.h.session(f.editor) });
  assert.ok(assets.body.includes('href="/vaults/alpha/rename/docs/assets/pic.png"'), '附件重命名入口在位');
  assert.ok(assets.body.includes('href="/vaults/alpha/delete/docs/assets/pic.png"'), '附件删除入口在位');
  assert.ok(!assets.body.includes('href="/vaults/alpha/edit/docs/assets/pic.png"'), '非 .md 不挂编辑链接（防死链）');
});

test('browse 非成员 404 同页不变（D-IC-06——权限感知呈现不改变门槛语义）', async () => {
  const out = await f.h.app.inject({ method: 'GET', url: '/vaults/alpha/browse', headers: f.h.session(f.outsider) });
  const ghost = await f.h.app.inject({ method: 'GET', url: '/vaults/ghost/browse', headers: f.h.session(f.outsider) });
  assert.equal(out.statusCode, 404);
  assert.equal(ghost.statusCode, 404);
  assert.equal(out.body, ghost.body, '非成员与未知库同体（反存在性）');
});
