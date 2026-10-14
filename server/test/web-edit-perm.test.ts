import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { browseHarness, seededVault, addEmployee, addMember, gitOut, repoPathOf, type BrowseHarness } from './web-browse-fixtures.ts';

// S10-T2 权限感知呈现——edit GET 域角色矩阵（F-2：bob 实测看到全套编辑表单，
// POST 才 403）。D4 裁决：reader GET edit → 只读态（输入禁用 + 只读标注），
// 不渲染「保存草稿/提交」控件；正文可看不可改；本人草稿回填逻辑不动（「我的」
// 草稿是 read 成员可用的既有能力——回填照常，仅不可改）。
// D17 回归锁定：reader POST submissions 仍 403（呈现层改动不弱化 POST 鉴权）。

const FILE_CONTENT = '---\ntitle: 指南\n---\n\n已发布正文。\n';
const DRAFT_CONTENT = '---\ntitle: "读者旧草稿"\n---\n\n草稿正文（编辑期保存）。\n';

interface Fix {
  h: BrowseHarness;
  vaultId: number;
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
    'docs/guide.md': FILE_CONTENT,
  });
  addMember(h.db, vaultId, admin, 'admin', admin);
  addMember(h.db, vaultId, editor, 'editor', admin);
  addMember(h.db, vaultId, reader, 'reader', admin);
  const repoPath = repoPathOf(h, vaultId);
  f = {
    h,
    vaultId,
    seedMain: (await gitOut(['--git-dir', repoPath, 'rev-parse', 'refs/heads/main'])).trim(),
    admin,
    editor,
    reader,
  };
});

after(async () => {
  await f.h.close();
});

function getEdit(who: number, path: string) {
  return f.h.app.inject({
    method: 'GET',
    url: `/vaults/alpha/edit/${path.split('/').map(encodeURIComponent).join('/')}`,
    headers: f.h.session(who),
  });
}

test('edit GET 矩阵：admin/editor 六字段页可用（保存草稿/提交控件、输入未禁用、上传附件入口）', async () => {
  for (const who of [f.admin, f.editor]) {
    const page = await getEdit(who, 'docs/guide.md');
    assert.equal(page.statusCode, 200, page.body);
    assert.ok(page.body.includes('id="save-draft"'), `who=${who} 保存草稿控件在位`);
    assert.ok(page.body.includes('<button type="submit">'), `who=${who} 提交控件在位`);
    assert.ok(!page.body.includes('disabled'), `who=${who} 输入未禁用`);
    assert.ok(page.body.includes('上传附件'), `who=${who} 上传附件入口在位`);
    assert.ok(!page.body.includes('>只读成员</span>'), `who=${who} 不呈现只读徽章`);
  }
});

test('edit GET reader：页面 200 只读态——字段禁用、无保存草稿/提交控件、正文可看、无上传附件入口', async () => {
  const page = await getEdit(f.reader, 'docs/guide.md');
  assert.equal(page.statusCode, 200, page.body); // 门槛保持 read 成员（D4：不改为 404/403）
  assert.ok(page.body.includes('>只读成员</span>'), '只读成员徽章');
  assert.ok(page.body.includes('无写权限'), '「无写权限」标注');
  assert.ok(page.body.includes('已发布正文'), '正文可看（内容回填不变）');
  assert.ok(page.body.includes('disabled'), '字段禁用（disabled）');
  assert.ok(!page.body.includes('id="save-draft"'), '不渲染保存草稿控件');
  assert.ok(!page.body.includes('<button type="submit">'), '不渲染提交控件');
  assert.ok(!page.body.includes('上传附件'), '写入口（上传附件）对 reader 隐藏');
  assert.ok(!page.body.includes("getElementById('save-draft')"), '只读态不携带交互脚本（脚本绑定空元素会报错）');
});

test('edit GET reader README 豁免页：只读态（正文 textarea 禁用、无提交控件）', async () => {
  const page = await getEdit(f.reader, 'README.md');
  assert.equal(page.statusCode, 200, page.body);
  assert.ok(page.body.includes('>只读成员</span>'), '只读成员徽章');
  assert.ok(page.body.includes('disabled'), '正文 textarea 禁用');
  assert.ok(!page.body.includes('id="save-draft"'), '不渲染保存草稿控件');
  assert.ok(!page.body.includes('<button type="submit">'), '不渲染提交控件');
});

test('edit GET reader 新建路径：仍 200 新建模式，呈只读态（门槛语义不变）', async () => {
  const page = await getEdit(f.reader, 'docs/newcomer.md');
  assert.equal(page.statusCode, 200, page.body);
  assert.ok(page.body.includes('>只读成员</span>'), '只读成员徽章');
  assert.ok(!page.body.includes('<button type="submit">'), '新建模式同样不渲染提交控件');
});

test('「我的」草稿不受影响：reader 本人既有草稿仍回填呈现（可看不可改）', async () => {
  // 直接落 drafts 行模拟 reader 编辑期（角色降级前）保存的草稿——存储面不动
  const now = new Date().toISOString();
  f.h.db
    .prepare(
      `INSERT INTO drafts (vault_id, employee_id, path, content, base_commit, status, created_at, updated_at)
       VALUES (?, ?, 'docs/guide.md', ?, ?, 'active', ?, ?)`,
    )
    .run(f.vaultId, f.reader, DRAFT_CONTENT, f.seedMain, now, now);

  const page = await getEdit(f.reader, 'docs/guide.md');
  assert.equal(page.statusCode, 200, page.body);
  assert.ok(page.body.includes('已回填你保存的草稿'), '草稿回填标注在位（回填逻辑不动）');
  assert.ok(page.body.includes('读者旧草稿'), '草稿内容优先回填（草稿优先于库内文件）');
  assert.ok(!page.body.includes('已发布正文'), '库内文件内容被草稿覆盖（既有语义）');
  assert.ok(page.body.includes('disabled'), '回填后仍只读（可看不可改）');
  assert.ok(!page.body.includes('id="save-draft"'), '不渲染保存草稿控件');
});

test('D17 回归锁定：reader POST submissions 仍 403 E-AUTHZ-001（呈现层改动不弱化 POST 鉴权）', async () => {
  const res = await f.h.app.inject({
    method: 'POST',
    url: '/api/v1/vaults/alpha/submissions',
    headers: { 'content-type': 'application/json', origin: 'http://localhost', ...f.h.session(f.reader) },
    payload: {
      base_commit: f.seedMain,
      changes: [{ path: 'docs/guide.md', content: FILE_CONTENT }],
    },
  });
  assert.equal(res.statusCode, 403, res.body);
  assert.equal((res.json() as { error: { code: string } }).error.code, 'E-AUTHZ-001');
});
