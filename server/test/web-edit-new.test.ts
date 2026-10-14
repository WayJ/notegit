import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { browseHarness, seededVault, addEmployee, addMember, gitOut, repoPathOf, type BrowseHarness } from './web-browse-fixtures.ts';

// S10-T3 站内新建笔记（E2 research §2.3 F-5 / P0-2；sprint D5）：browse 目录页
// 「新建笔记」入口（editor+ 可见，canWriteVault 门——与 T2 写入口同形）→ GET
// /vaults/{slug}/edit/new?dir=<目录> 服务端直出「新建模式」表单（路径输入预填
// 目录前缀、title 必填、正文空、base_commit=默认分支 HEAD）→ 既有 POST
// /api/v1/vaults/{slug}/submissions 提交 → 新文档 view 页（先红后绿）。
//
// 防误覆盖（submissions 对 upsert 语义是覆盖同名——新建直提既有路径属破坏）：
// 新建模式在表单侧校验路径不存在——服务端直出对已存在路径（?path=）返回
// 提示态（不呈现创建表单）；表单页明确标注「将创建新文件」。POST 端点行为
// 不变（D17——呈现层防护不替代端点语义，reader POST 403 由 T2 测试锁定）。
//
// 断言只取包含且有序的关键片段（不断言整页 HTML 全等）。

const GUIDE = '---\ntitle: "指南"\n---\n\n已发布正文。\n';
const NEW_NOTE = '---\ntitle: "站内新建笔记"\n---\n\n新笔记正文（浏览器内闭环）。\n';

interface Fix {
  h: BrowseHarness;
  vaultId: number;
  seedMain: string;
  repoPath: string;
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
    'docs/guide.md': GUIDE,
    'docs/assets/pic.png': 'png-not-really\n',
  });
  addMember(h.db, vaultId, admin, 'admin', admin);
  addMember(h.db, vaultId, editor, 'editor', admin);
  addMember(h.db, vaultId, reader, 'reader', admin);
  const repoPath = repoPathOf(h, vaultId);
  f = {
    h,
    vaultId,
    seedMain: (await gitOut(['--git-dir', repoPath, 'rev-parse', 'refs/heads/main'])).trim(),
    repoPath,
    admin,
    editor,
    reader,
    outsider,
  };
});

after(async () => {
  await f.h.close();
});

function get(who: number, url: string) {
  return f.h.app.inject({ method: 'GET', url, headers: f.h.session(who) });
}

function postSubmissions(who: number, body: Record<string, unknown>) {
  return f.h.app.inject({
    method: 'POST',
    url: '/api/v1/vaults/alpha/submissions',
    headers: { 'content-type': 'application/json', origin: 'http://localhost', ...f.h.session(who) },
    payload: body,
  });
}

async function headMain(): Promise<string> {
  return (await gitOut(['--git-dir', f.repoPath, 'rev-parse', 'main'])).trim();
}

// ── 入口矩阵：browse 目录页「新建笔记」（editor+ 可见，目录上下文传入） ──────

test('browse 新建入口矩阵：admin/editor 见主操作位按钮（coral 主 CTA 类名 + 目录上下文 dir=），reader 不渲染', async () => {
  for (const who of [f.admin, f.editor]) {
    const sub = await get(who, '/vaults/alpha/browse/docs');
    assert.equal(sub.statusCode, 200, sub.body);
    // 主操作位：coral 主 CTA（DESIGN.md button-primary——仅主 CTA 用珊瑚）
    assert.ok(
      sub.body.includes('class="btn btn-primary" href="/vaults/alpha/edit/new?dir=docs"'),
      `who=${who} 新建笔记主按钮在位（目录上下文 dir=docs）`,
    );
    assert.ok(sub.body.includes('>新建笔记</a>'), `who=${who} 按钮文案`);
    // 与既有「上传」入口并存，新建在前（主操作位）
    const newIdx = sub.body.indexOf('/vaults/alpha/edit/new?dir=docs');
    const uploadIdx = sub.body.indexOf('href="/vaults/alpha/upload/docs"');
    assert.ok(uploadIdx !== -1, `who=${who} 上传入口仍在`);
    assert.ok(newIdx < uploadIdx, `who=${who} 新建笔记居主操作位（先于上传）`);

    const root = await get(who, '/vaults/alpha/browse');
    assert.ok(
      root.body.includes('class="btn btn-primary" href="/vaults/alpha/edit/new"'),
      `who=${who} 库根入口（无 dir=库根上下文）`,
    );
  }

  for (const url of ['/vaults/alpha/browse', '/vaults/alpha/browse/docs']) {
    const page = await get(f.reader, url);
    assert.equal(page.statusCode, 200, page.body); // 页面门槛保持 read 成员（D4）
    assert.ok(!page.body.includes('/edit/new'), `reader 不得见新建入口（${url}）`);
    assert.ok(!page.body.includes('新建笔记'), `reader 无新建文案（${url}）`);
    assert.ok(page.body.includes('>只读成员</span>'), `只读徽章同形（${url}）`);
  }
});

// ── GET /vaults/{slug}/edit/new：角色矩阵 × 表单形态 ─────────────────────────

test('edit/new writer 表单：新建笔记标注 + 路径输入预填目录前缀 + title 必填 + 正文空 + base commit 嵌入 + 提交控件', async () => {
  const page = await get(f.editor, '/vaults/alpha/edit/new?dir=docs');
  assert.equal(page.statusCode, 200, page.body);
  assert.ok(page.body.includes('新建笔记'), '页面明确标注「新建笔记」');
  // 路径输入：预填目录前缀 docs/；行内错误位（路径问题/已存在阻断落点）
  assert.match(page.body, /<input name="path"[^>]*value="docs\/"/, '路径输入预填目录前缀');
  assert.ok(page.body.includes('id="err-path"'), '路径行内错误位');
  // title 必填（浏览器原生 required；服务端 E-FM-003 兜底）+ 既有映射槽复用
  assert.match(page.body, /<input name="title"[^>]*required/);
  assert.ok(page.body.includes('id="err-title"'), 'E-FM-003 字段定位槽复用（err-title）');
  // 正文空（无既有内容回填）
  assert.match(page.body, /<textarea name="body"[^>]*><\/textarea>/, '正文 textarea 空');
  // base commit = 当前默认分支 HEAD（编辑页既有嵌入逻辑）
  assert.ok(page.body.includes(f.seedMain), 'HEAD oid 嵌入为 base commit');
  // 写者控件（提交=珊瑚主按钮（#edit-form 作用域）、保存草稿）
  assert.ok(page.body.includes('<button type="submit">'));
  assert.ok(page.body.includes('id="save-draft"'));
  assert.ok(!page.body.includes('disabled'), '写者字段未禁用');
  // 防误覆盖契约文案：将创建新文件
  assert.ok(page.body.includes('将创建新文件'), '「将创建新文件」标注');
});

test('edit/new 库根形态：无 dir → 路径输入预填空（库根上下文）', async () => {
  const page = await get(f.editor, '/vaults/alpha/edit/new');
  assert.equal(page.statusCode, 200, page.body);
  assert.match(page.body, /<input name="path"[^>]*value=""/, '库根无目录前缀');
});

test('edit/new 三角色矩阵：reader 200 只读态（禁用、无提交控件），非成员 404 同页', async () => {
  const page = await get(f.reader, '/vaults/alpha/edit/new?dir=docs');
  assert.equal(page.statusCode, 200, page.body); // 门槛保持 read 成员（与 T2 edit GET 同形 D4）
  assert.ok(page.body.includes('>只读成员</span>'), '只读成员徽章');
  assert.ok(page.body.includes('无写权限'), '「无写权限」标注');
  assert.ok(page.body.includes('disabled'), '字段禁用（含路径输入）');
  assert.ok(!page.body.includes('<button type="submit">'), '不渲染提交控件');
  assert.ok(!page.body.includes('id="save-draft"'), '不渲染保存草稿控件');

  const outsider = await get(f.outsider, '/vaults/alpha/edit/new');
  const ghost = await get(f.outsider, '/vaults/ghost/edit/new');
  assert.equal(outsider.statusCode, 404);
  assert.equal(ghost.statusCode, 404);
  assert.equal(outsider.body, ghost.body, '非成员与未知库同体（D-IC-06）');
});

// ── 新建闭环：GET 表单 → POST submissions 201 → 新路径 view 200 ──────────────

test('新建闭环：GET 表单 → 既有 submissions POST 201（报告 pass）→ 新路径 view 200 + blob 落库', async () => {
  const form = await get(f.editor, '/vaults/alpha/edit/new?dir=docs');
  assert.equal(form.statusCode, 200, form.body);

  const res = await postSubmissions(f.editor, {
    base_commit: f.seedMain,
    message: 'Web 新建：docs/created-by-web.md',
    changes: [{ path: 'docs/created-by-web.md', content: NEW_NOTE }],
  });
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json() as { commit: string; branch: string; report: { result: string } };
  assert.ok(typeof body.commit === 'string' && body.commit !== '', '201 信封含 commit');

  const view = await get(f.editor, '/vaults/alpha/view/docs/created-by-web.md');
  assert.equal(view.statusCode, 200, view.body);
  assert.ok(view.body.includes('新笔记正文'), 'view 页呈现新正文');

  // 落库对照（直通 git，不经生产读面）：HEAD 处 blob = 提交内容
  const blob = await gitOut(['--git-dir', f.repoPath, 'cat-file', 'blob', 'main:docs/created-by-web.md']);
  assert.ok(blob.includes('title: "站内新建笔记"'), 'frontmatter 落库');
  assert.equal(await headMain(), body.commit, '默认分支 ref 前进到新提交');
});

// ── 防误覆盖：已存在路径提示态 + 新路径确认态 + 探测契约 ─────────────────────

test('已存在路径防护：?path= 既有文件 → 200 提示态（不呈现创建表单）+ 编辑既有链接', async () => {
  const page = await get(f.editor, '/vaults/alpha/edit/new?dir=docs&path=docs/guide.md');
  assert.equal(page.statusCode, 200, page.body);
  assert.ok(page.body.includes('已存在'), '如实标注路径已存在');
  assert.ok(page.body.includes('href="/vaults/alpha/edit/docs/guide.md"'), '引导到既有文件编辑页');
  assert.ok(!page.body.includes('id="edit-form"'), '不呈现创建表单（防误覆盖）');
  assert.ok(page.body.includes('新建笔记'), '仍处新建语境（页面标注）');
});

test('新路径确认态：?path= 不存在路径 → 创建表单预填完整路径 + 「将创建新文件：<路径>」', async () => {
  const page = await get(f.editor, '/vaults/alpha/edit/new?dir=docs&path=docs/fresh-note.md');
  assert.equal(page.statusCode, 200, page.body);
  assert.match(page.body, /<input name="path"[^>]*value="docs\/fresh-note\.md"/, '路径输入预填确认路径');
  assert.ok(page.body.includes('将创建新文件：docs/fresh-note.md'), '对新路径提示「将创建新文件」');
  assert.ok(page.body.includes('id="edit-form"'), '创建表单在位');
});

test('路径族同判：?path= 非 .md → 404（表单仅知识 Markdown）；畸形 dir → 404', async () => {
  const nonMd = await get(f.editor, '/vaults/alpha/edit/new?path=docs/assets/pic.png');
  assert.equal(nonMd.statusCode, 404);
  const badDir = await get(f.editor, '/vaults/alpha/edit/new?dir=../etc');
  assert.equal(badDir.statusCode, 404);
});

test('HEAD view 探测契约（表单前置校验所依）：既有 .md 200 / 缺失路径 404', async () => {
  const existing = await f.h.app.inject({ method: 'HEAD', url: '/vaults/alpha/view/docs/guide.md', headers: f.h.session(f.editor) });
  assert.equal(existing.statusCode, 200);
  const missing = await f.h.app.inject({ method: 'HEAD', url: '/vaults/alpha/view/docs/never-created.md', headers: f.h.session(f.editor) });
  assert.equal(missing.statusCode, 404);
});

// ── title 缺失 422：表单定位复用既有 E-FM-003 映射（报告带字段与行定位） ─────

test('title 缺失 422：报告 E-FM-003 落 title 字段含行定位（err-title 槽消费的映射复用），ref 不动', async () => {
  const before = await headMain(); // 基线取当前 tip（前序闭环测试已使分支前进）
  const res = await postSubmissions(f.editor, {
    base_commit: before,
    changes: [{ path: 'docs/no-title.md', content: '---\n---\n\n缺题正文\n' }],
  });
  assert.equal(res.statusCode, 422, res.body);
  const report = res.json() as {
    files: { path: string; issues: { code: string; severity: string; field?: string; line?: number }[] }[];
  };
  const issues = report.files.find((x) => x.path === 'docs/no-title.md')?.issues ?? [];
  const e = issues.find((i) => i.code === 'E-FM-003');
  assert.ok(e !== undefined, `E-FM-003 在报告（实际：${JSON.stringify(issues)}）`);
  assert.equal(e.severity, 'error');
  assert.equal(e.field, 'title', '字段定位=title（表单 err-title 槽复用既有映射）');
  assert.ok(typeof e.line === 'number' && e.line >= 2, '行定位在位');
  assert.equal(await headMain(), before, '校验拒绝不得移动 ref');
});

// ── 草稿联动：?path= 确认态回填本人现行草稿（既有回填逻辑同构） ────────────────

test('草稿联动：?path= 确认态回填本人草稿（保存的半成品不丢）', async () => {
  const put = await f.h.app.inject({
    method: 'PUT',
    url: '/api/v1/vaults/alpha/drafts/docs/half-written.md',
    headers: { 'content-type': 'application/json', origin: 'http://localhost', ...f.h.session(f.editor) },
    payload: { content: '---\ntitle: "半成品"\n---\n\n写了一半。\n', base_commit: f.seedMain },
  });
  assert.equal(put.statusCode, 200, put.body);

  const page = await get(f.editor, '/vaults/alpha/edit/new?dir=docs&path=docs/half-written.md');
  assert.equal(page.statusCode, 200, page.body);
  assert.ok(page.body.includes('已回填你保存的草稿'), '草稿回填标注');
  assert.ok(page.body.includes('写了一半'), '草稿内容进表单');
  assert.ok(page.body.includes('将创建新文件：docs/half-written.md'), '确认态标注仍在');
});
