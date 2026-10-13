import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browseHarness, seededVault, addEmployee, addMember, gitOut, repoPathOf, type BrowseHarness } from './web-browse-fixtures.ts';

// S4-T8 T4 遗留收口（T4 notes 移交节：「把 attach URL 用于直开页展示（及上传
// UI 页）留给 T7/T8 整合」；breakdown §2.3 S4-T8 行 3）：
// - 上传 UI 页：GET /vaults/{slug}/upload[/{dir}]（目录上传入口；fetch 直发
//   octet-stream——T4 契约形态，不引 multipart）；
// - 目录页/编辑页上传入口；
// - 附件直开页嵌入：图片文件预览页出 <img>（鉴权附件通道 URL——blob 寻址）。

interface Ctx {
  h: BrowseHarness;
  repoPath: string;
}

async function setup(): Promise<Ctx> {
  const h = await browseHarness();
  const alice = addEmployee(h.db, { username: 'alice' });
  addEmployee(h.db, { username: 'carol' });
  const vaultId = await seededVault(h, 'alpha', alice, {
    'README.md': '# nav\n',
    'docs/guide.md': '---\ntitle: 指南\n---\n\n正文。\n',
    'docs/assets/pic.png': 'png-not-really\n',
  });
  addMember(h.db, vaultId, alice, 'editor', alice);
  return { h, repoPath: repoPathOf(h, vaultId) };
}

test('上传 UI 页：成员 GET 根/子目录 200，携带端点与传输契约标记', async () => {
  const { h } = await setup();
  try {
    const root = await h.app.inject({ method: 'GET', url: '/vaults/alpha/upload', headers: h.session(1) });
    assert.equal(root.statusCode, 200, root.body);
    assert.ok(root.body.includes('/vaults/alpha/upload'), '页内脚本 POST 端点标记');
    assert.ok(root.body.includes('application/octet-stream'), '传输契约（唯一内容类型）标注');
    assert.ok(root.body.includes('type="file"'), '文件选择控件');

    const sub = await h.app.inject({ method: 'GET', url: '/vaults/alpha/upload/docs/assets', headers: h.session(1) });
    assert.equal(sub.statusCode, 200, sub.body);
    assert.ok(sub.body.includes('docs/assets'), '目标目录上下文呈现');
  } finally {
    await h.close();
  }
});

test('上传 UI 页：未认证 302 /login；非成员与未知库 404（D-IC-06）', async () => {
  const { h } = await setup();
  try {
    const anon = await h.app.inject({ method: 'GET', url: '/vaults/alpha/upload' });
    assert.equal(anon.statusCode, 302);
    assert.equal(anon.headers['location'], '/login');
    const outsider = await h.app.inject({ method: 'GET', url: '/vaults/alpha/upload', headers: h.session(2) });
    assert.equal(outsider.statusCode, 404);
    assert.equal(outsider.headers['content-type'], 'text/html; charset=utf-8');
    const unknown = await h.app.inject({ method: 'GET', url: '/vaults/ghost/upload', headers: h.session(1) });
    assert.equal(unknown.statusCode, 404);
    // 反存在性：非成员与未知库同体
    assert.equal(outsider.body, unknown.body);
  } finally {
    await h.close();
  }
});

test('目录页：库根与子目录均有上传入口（指向对应目录的上传页）', async () => {
  const { h } = await setup();
  try {
    const root = await h.app.inject({ method: 'GET', url: '/vaults/alpha/browse', headers: h.session(1) });
    assert.equal(root.statusCode, 200);
    assert.ok(root.body.includes('href="/vaults/alpha/upload"'), '库根上传入口');
    const sub = await h.app.inject({ method: 'GET', url: '/vaults/alpha/browse/docs', headers: h.session(1) });
    assert.ok(sub.body.includes('href="/vaults/alpha/upload/docs"'), '子目录上传入口');
  } finally {
    await h.close();
  }
});

test('编辑页：六字段页与 README 页均有上传附件入口（指向文档所在目录的上传页）', async () => {
  const { h } = await setup();
  try {
    const edit = await h.app.inject({ method: 'GET', url: '/vaults/alpha/edit/docs/guide.md', headers: h.session(1) });
    assert.equal(edit.statusCode, 200);
    assert.ok(edit.body.includes('href="/vaults/alpha/upload/docs"'), '六字段页上传附件入口（父目录）');
    const readme = await h.app.inject({ method: 'GET', url: '/vaults/alpha/edit/README.md', headers: h.session(1) });
    assert.equal(readme.statusCode, 200);
    assert.ok(readme.body.includes('href="/vaults/alpha/upload"'), 'README 页上传附件入口（库根）');
  } finally {
    await h.close();
  }
});

test('附件直开页：图片文件预览页以鉴权附件通道 URL 嵌 <img>（T4 占位退役）', async () => {
  const { h, repoPath } = await setup();
  try {
    // blob OID：ls-tree 对照取（不经生产读面）
    const out = await gitOut(['--git-dir', repoPath, 'ls-tree', 'refs/heads/main', 'docs/assets/pic.png']);
    const oid = out.split(/\s/)[2]!;
    assert.match(oid, /^[0-9a-f]{40}$/);

    const res = await h.app.inject({ method: 'GET', url: '/vaults/alpha/view/docs/assets/pic.png', headers: h.session(1) });
    assert.equal(res.statusCode, 200, res.body);
    const expectSrc = `/vaults/alpha/attach/${oid}/pic.png`;
    assert.ok(
      res.body.includes(`<img src="${expectSrc}"`),
      `直开页应嵌鉴权附件 URL <img src="${expectSrc}">`,
    );
    assert.ok(!res.body.includes('S4-T4 接入，接口已定'), 'T4 占位文案应退役');
  } finally {
    await h.close();
  }
});
