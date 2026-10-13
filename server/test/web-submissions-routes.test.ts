import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { browseHarness, seededVault, addMember, addEmployee, gitOut, pushToVault, repoPathOf, type BrowseHarness } from './web-browse-fixtures.ts';

// S4-T7 提交端点 + base commit 冲突保护（breakdown §2.3 S4-T7 行；架构 §6/§5.4；
// DOD-07；验收场景 S5）：
//
// - POST /api/v1/vaults/{slug}/submissions（api.md §8.2）：走 submit 面
//   （submitEditForm 同源 submitComposedChanges）→ S3-T7 publishWebSubmit——
//   预期旧 commit（CAS）为唯一冲突机制。
// - 冲突两场景：Web×Git 并发（网页编辑中他人经真实 Git 通道 push）与两次网页
//   提交冲突——后提交方被拒（409 E-RES-003，details 含当前 tip 提示刷新）、
//   先前提交不被覆盖、冲突草稿完整保留（active + 逐字内容 + 可恢复）。
// - 成功路径发布结果与直接 push 等价（同内容 → 同 tree；单笔快进提交）。
// - 授权渠道行：未认证 401 / reader 403 E-AUTHZ-001 / 非成员与未知库同 404 同体。

const IDENT_BASE = '---\ntitle: "冲突样例"\n---\n\n冲突正文。\n';

interface Fix {
  h: BrowseHarness;
  vaultId: number;
  repoPath: string;
  seedMain: string;
  seedCount: string;
  alice: number;
  bob: number;
  close(): Promise<void>;
}

let f: Fix;

before(async () => {
  const h = await browseHarness();
  const alice = addEmployee(h.db, { username: 'alice' });
  const bob = addEmployee(h.db, { username: 'bob' });
  const vaultId = await seededVault(h, 'docs', alice, {
    'README.md': '# nav\n',
    'notes/first.md': '---\ntitle: First\n---\nbody\n',
  });
  addMember(h.db, vaultId, alice, 'editor', alice);
  addMember(h.db, vaultId, bob, 'editor', alice);
  const repoPath = repoPathOf(h, vaultId);
  const seedMain = (await gitOut(['--git-dir', repoPath, 'rev-parse', 'refs/heads/main'])).trim();
  const seedCount = (await gitOut(['--git-dir', repoPath, 'rev-list', '--count', 'refs/heads/main'])).trim();
  f = {
    h, vaultId, repoPath, seedMain, seedCount, alice, bob,
    close: async () => {
      await h.close();
    },
  };
});

after(async () => {
  await f.close();
});

beforeEach(async () => {
  await gitOut(['--git-dir', f.repoPath, 'update-ref', 'refs/heads/main', f.seedMain]);
});

/** §7 PUT 保存草稿（真实端点——与编辑页保存按钮同一形状） */
function saveDraft(employeeId: number, path: string, content: string, baseCommit: string | null = f.seedMain) {
  return f.h.app.inject({
    method: 'PUT',
    url: `/api/v1/vaults/docs/drafts/${path.split('/').map(encodeURIComponent).join('/')}`,
    headers: { 'content-type': 'application/json', origin: 'http://localhost', ...f.h.session(employeeId) },
    payload: { content, base_commit: baseCommit },
  });
}

/** §8.2 POST submissions（真实端点——与编辑页提交按钮同一形状） */
function submitPost(
  employeeId: number,
  baseCommit: string | null,
  changes: readonly unknown[],
  message?: string,
) {
  const body: Record<string, unknown> = { base_commit: baseCommit, changes: [...changes] };
  if (message !== undefined) body['message'] = message;
  return f.h.app.inject({
    method: 'POST',
    url: '/api/v1/vaults/docs/submissions',
    headers: { 'content-type': 'application/json', origin: 'http://localhost', ...f.h.session(employeeId) },
    payload: body,
  });
}

function textChange(path: string, content: string) {
  return { path, content };
}

/** 直查 drafts 行（测试对照——不经生产读面） */
function draftRow(employeeId: number, path: string): { status: string; content: string } | undefined {
  return f.h.db
    .prepare('SELECT status, content FROM drafts WHERE vault_id = ? AND employee_id = ? AND path = ?')
    .get(f.vaultId, employeeId, path) as { status: string; content: string } | undefined;
}

async function headMain(): Promise<string> {
  return (await gitOut(['--git-dir', f.repoPath, 'rev-parse', 'refs/heads/main'])).trim();
}

async function commitCount(): Promise<string> {
  return (await gitOut(['--git-dir', f.repoPath, 'rev-list', '--count', 'refs/heads/main'])).trim();
}

// ── 冲突场景一：Web×Git 并发（网页编辑中他人经真实 Git 通道 push）──

test('Web×Git 并发冲突：他人 push 后以过时基线提交 → 409 E-RES-003 含当前 tip、先前提交不覆盖、冲突草稿完整保留', async () => {
  // alice 打开编辑器（基线 seedMain）并保存草稿
  const saved = await saveDraft(f.alice, 'notes/conflict-git.md', IDENT_BASE);
  assert.equal(saved.statusCode, 200, saved.body);

  // 他人经真实 Git 通道（clone→commit→push，pre-receive 同一组件链）推进分支
  await pushToVault(f.h, f.vaultId, { 'notes/from-git.md': '---\ntitle: "Git 推进"\n---\n\ngit\n' });
  const pushedHead = await headMain();
  assert.notEqual(pushedHead, f.seedMain, '前置：分支已被 Git 推进');

  // alice 仍以打开编辑器时的基线提交（仍在库内的真实提交——候选可构造，CAS 旧值不符）
  const res = await submitPost(f.alice, f.seedMain, [textChange('notes/conflict-git.md', IDENT_BASE)]);
  assert.equal(res.statusCode, 409, res.body);
  const body = res.json() as { error: { code: string; message: string; details?: { base_commit?: string; current_head?: string } } };
  assert.equal(body.error.code, 'E-RES-003');
  assert.equal(body.error.details?.base_commit, f.seedMain, 'details 呈现提交时的预期旧 commit');
  assert.equal(body.error.details?.current_head, pushedHead, 'details 携带当前 tip（提示刷新基线）');

  // 先前提交（他人的 push）不被覆盖
  assert.equal(await headMain(), pushedHead, '拒绝发布不覆盖——ref 停留在他人的提交');
  assert.equal(Number(await commitCount()), Number(f.seedCount) + 1, '仅他人一笔新增提交');

  // 冲突草稿完整保留（active + 逐字内容 + 可恢复）
  const row = draftRow(f.alice, 'notes/conflict-git.md');
  assert.equal(row?.status, 'active');
  assert.equal(row?.content, IDENT_BASE, '草稿内容逐字保留');
  const restored = await f.h.app.inject({
    method: 'GET',
    url: '/api/v1/vaults/docs/drafts/notes/conflict-git.md',
    headers: { origin: 'http://localhost', ...f.h.session(f.alice) },
  });
  assert.equal(restored.statusCode, 200, '冲突后草稿仍可恢复（§7）');
});

// ── 冲突场景二：两次网页提交冲突（后提交方被拒）──

test('两次网页提交冲突：后提交方 409、先前提交不被覆盖、冲突草稿保留、先提交方草稿按 §7 流转', async () => {
  // 两人各自打开编辑器（同一基线 seedMain）并保存草稿
  assert.equal((await saveDraft(f.bob, 'notes/two-web.md', '---\ntitle: "Bob 先提交"\n---\n\nbob\n')).statusCode, 200);
  assert.equal((await saveDraft(f.alice, 'notes/two-web-late.md', IDENT_BASE)).statusCode, 200);

  // bob 先提交 → 201
  const first = await submitPost(f.bob, f.seedMain, [textChange('notes/two-web.md', '---\ntitle: "Bob 先提交"\n---\n\nbob\n')]);
  assert.equal(first.statusCode, 201, first.body);
  const firstBody = first.json() as { commit: string; branch: string };
  const winnerHead = await headMain();
  assert.equal(firstBody.commit, winnerHead, '201 commit = 发布后 HEAD');
  assert.equal(firstBody.branch, 'main');

  // alice 后提交（基线已过时）→ 409
  const second = await submitPost(f.alice, f.seedMain, [textChange('notes/two-web-late.md', IDENT_BASE)]);
  assert.equal(second.statusCode, 409, second.body);
  const secondBody = second.json() as { error: { code: string; details?: { current_head?: string } } };
  assert.equal(secondBody.error.code, 'E-RES-003');
  assert.equal(secondBody.error.details?.current_head, winnerHead, '当前 tip = 先提交方的 commit');

  // 先前提交（bob 的）不被覆盖；alice 草稿保留；bob 草稿标已提交（T6 挂点经端点生效）
  assert.equal(await headMain(), winnerHead, '先前提交不被覆盖');
  assert.equal(draftRow(f.alice, 'notes/two-web-late.md')?.status, 'active', '后提交方冲突草稿保留');
  assert.equal(draftRow(f.alice, 'notes/two-web-late.md')?.content, IDENT_BASE, '冲突草稿逐字保留');
  assert.equal(draftRow(f.bob, 'notes/two-web.md')?.status, 'committed', '先提交方本人草稿标已提交（§7 状态流转）');
});

// ── 成功路径：发布结果与直接 push 等价 ──

test('成功路径等价：同一内容经 submissions 发布与直接 push 的 tree 一致（单笔快进提交）', async () => {
  const EQUIV = '---\ntitle: "等价样例"\n---\n\n等价正文。\n';

  // Web 路径：POST submissions
  const web = await submitPost(f.alice, f.seedMain, [textChange('notes/equiv.md', EQUIV)]);
  assert.equal(web.statusCode, 201, web.body);
  const webHead = (web.json() as { commit: string }).commit;
  const webTree = (await gitOut(['--git-dir', f.repoPath, 'rev-parse', `${webHead}^{tree}`])).trim();
  const webParent = (await gitOut(['--git-dir', f.repoPath, 'rev-parse', `${webHead}^`])).trim();
  assert.equal(webParent, f.seedMain, '单笔提交、父 = 打开编辑器时的基线（快进）');
  const webLs = await gitOut(['--git-dir', f.repoPath, 'ls-tree', '-r', webHead]);

  // 回退基线后走真实 Git 通道推送同一内容
  await gitOut(['--git-dir', f.repoPath, 'update-ref', 'refs/heads/main', f.seedMain]);
  await pushToVault(f.h, f.vaultId, { 'notes/equiv.md': EQUIV });
  const pushHead = await headMain();
  const pushTree = (await gitOut(['--git-dir', f.repoPath, 'rev-parse', `${pushHead}^{tree}`])).trim();
  const pushLs = await gitOut(['--git-dir', f.repoPath, 'ls-tree', '-r', pushHead]);

  assert.equal(webTree, pushTree, '两入口同一内容 → 同一 tree（路径/模式/内容全等）');
  assert.equal(webLs, pushLs, 'ls-tree -r 全等（blob 寻址一致）');
});

test('成功响应形状：201 {commit, branch, report}——report 为 T2 报告（scope=web-submit、pass、含 rulesVersion）', async () => {
  const res = await submitPost(f.alice, f.seedMain, [textChange('notes/shape.md', IDENT_BASE)], '提交说明样例');
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json() as {
    commit: string;
    branch: string;
    report: { scope: string; result: string; rulesVersion: string; summary: { errorCount: number } };
  };
  assert.equal(body.commit, await headMain(), 'commit = 发布后 HEAD');
  assert.equal(body.branch, 'main', 'v1 仅默认分支（api.md §8.3）');
  assert.equal(body.report.scope, 'web-submit');
  assert.equal(body.report.result, 'pass');
  assert.equal(body.report.summary.errorCount, 0);
  assert.equal(typeof body.report.rulesVersion, 'string', '报告携带 rulesVersion（T2）');
});

test('冲突后刷新基线重提闭环：409 → 以最新 HEAD 为基线重提 → 201（父 = 先提交方）', async () => {
  await pushToVault(f.h, f.vaultId, { 'notes/refresh-git.md': '---\ntitle: "先行"\n---\n\nx\n' });
  const winnerHead = await headMain();
  const stale = await submitPost(f.alice, f.seedMain, [textChange('notes/refresh.md', IDENT_BASE)]);
  assert.equal(stale.statusCode, 409);

  // 编辑器刷新（重开）→ 取最新基线（页面回填草稿见 web-edit-prefill 测试）
  const fresh = await submitPost(f.alice, winnerHead, [textChange('notes/refresh.md', IDENT_BASE)]);
  assert.equal(fresh.statusCode, 201, fresh.body);
  const freshHead = (fresh.json() as { commit: string }).commit;
  const parent = (await gitOut(['--git-dir', f.repoPath, 'rev-parse', `${freshHead}^`])).trim();
  assert.equal(parent, winnerHead, '重提以先提交方为父（快进、不覆盖）');
});

// ── 校验拒绝：422 = T2 报告（非信封）──

test('校验拒绝 422：body 直接是 T2 报告（E-FM-003 定位），草稿保留、不发布', async () => {
  await saveDraft(f.alice, 'notes/no-title.md', '---\ntitle: "有题"\n---\n\n草稿\n');
  const res = await submitPost(f.alice, f.seedMain, [textChange('notes/no-title.md', '---\n---\n\n缺题正文\n')]);
  assert.equal(res.statusCode, 422, res.body);
  const report = res.json() as {
    scope: string;
    result: string;
    rulesVersion: string;
    files: { path: string; issues: { code: string; severity: string }[] }[];
    error?: unknown;
  };
  assert.equal(report.scope, 'web-submit');
  assert.equal(report.result, 'fail');
  assert.equal(report.error, undefined, 'T2 报告非信封（无 error 键）');
  const issues = report.files.find((x) => x.path === 'notes/no-title.md')?.issues ?? [];
  assert.ok(issues.some((i) => i.code === 'E-FM-003' && i.severity === 'error'), '缺 title 阻断（E-FM-003）');
  assert.equal(draftRow(f.alice, 'notes/no-title.md')?.status, 'active', '校验拒绝不动草稿');
  assert.equal(await headMain(), f.seedMain, '不发布');
});

// ── 授权渠道行（api.md §8.2）──

test('鉴权：未认证 401 E-AUTH-001；reader 403 E-AUTHZ-001；非成员与未知库同 404 同体（D-IC-06）', async () => {
  const anon = await f.h.app.inject({
    method: 'POST',
    url: '/api/v1/vaults/docs/submissions',
    headers: { 'content-type': 'application/json', origin: 'http://localhost' },
    payload: { base_commit: f.seedMain, changes: [textChange('notes/a.md', IDENT_BASE)] },
  });
  assert.equal(anon.statusCode, 401);
  assert.equal((anon.json() as { error: { code: string } }).error.code, 'E-AUTH-001');

  addMember(f.h.db, f.vaultId, addEmployee(f.h.db, { username: 'reader' }), 'reader', f.alice);
  const readerId = f.h.db.prepare("SELECT id FROM employees WHERE username = 'reader'").get() as { id: number };
  const reader = await submitPost(readerId.id, f.seedMain, [textChange('notes/a.md', IDENT_BASE)]);
  assert.equal(reader.statusCode, 403, reader.body);
  assert.equal((reader.json() as { error: { code: string } }).error.code, 'E-AUTHZ-001');

  const outsiderId = addEmployee(f.h.db, { username: 'carol' }); // 非任何库成员
  const outsider = await submitPost(outsiderId, f.seedMain, [textChange('notes/a.md', IDENT_BASE)]);
  const ghost = await f.h.app.inject({
    method: 'POST',
    url: '/api/v1/vaults/ghost/submissions',
    headers: { 'content-type': 'application/json', origin: 'http://localhost', ...f.h.session(f.alice) },
    payload: { base_commit: f.seedMain, changes: [textChange('notes/a.md', IDENT_BASE)] },
  });
  assert.equal(outsider.statusCode, 404);
  assert.equal(ghost.statusCode, 404);
  assert.equal(outsider.body, ghost.body, '非成员与不存在库同体（不泄露存在性）');
});

// ── 请求形态（400 E-RES-004）──

test('请求形态 400 E-RES-004：空 changes／双形态／缺 path／缺 base_commit 键', async () => {
  const cases: { label: string; body: Record<string, unknown> }[] = [
    { label: '空 changes', body: { base_commit: f.seedMain, changes: [] } },
    { label: '双形态（content+delete）', body: { base_commit: f.seedMain, changes: [{ path: 'a.md', content: 'x', delete: true }] } },
    { label: '缺 path', body: { base_commit: f.seedMain, changes: [{ content: 'x' }] } },
    { label: '缺 base_commit 键', body: { changes: [textChange('a.md', IDENT_BASE)] } },
    { label: 'base_commit 非 SHA 形状', body: { base_commit: 'main', changes: [textChange('a.md', IDENT_BASE)] } },
    { label: '库外 OID', body: { base_commit: '0123456789012345678901234567890123456789', changes: [textChange('a.md', IDENT_BASE)] } },
    { label: '非法 base64', body: { base_commit: f.seedMain, changes: [{ path: 'a.png', content_base64: '!!not-base64!!' }] } },
  ];
  for (const c of cases) {
    const res = await f.h.app.inject({
      method: 'POST',
      url: '/api/v1/vaults/docs/submissions',
      headers: { 'content-type': 'application/json', origin: 'http://localhost', ...f.h.session(f.alice) },
      payload: c.body,
    });
    assert.equal(res.statusCode, 400, `${c.label}：${res.body}`);
    assert.equal((res.json() as { error: { code: string } }).error.code, 'E-RES-004', c.label);
  }
  assert.equal(await headMain(), f.seedMain, '形态拒绝不产生任何提交');
});

// ── 维护模式（app 级闸门自动覆盖 /api/v1 非安全方法）──

test('维护中：POST submissions 503 E-MAINT-001（maintenance 标志），HEAD 不动', async () => {
  const maint = addEmployee(f.h.db, { username: 'maint', is_instance_admin: 1 });
  const on = await f.h.app.inject({
    method: 'POST',
    url: '/api/v1/admin/maintenance',
    headers: { origin: 'http://localhost', ...f.h.session(maint) },
    payload: {},
  });
  assert.equal(on.statusCode, 204, '开启维护（实例管理员会话）');
  try {
    const res = await submitPost(f.alice, f.seedMain, [textChange('notes/maint.md', IDENT_BASE)]);
    assert.equal(res.statusCode, 503, res.body);
    const body = res.json() as { error: { code: string; details?: { maintenance?: boolean } } };
    assert.equal(body.error.code, 'E-MAINT-001');
    assert.equal(body.error.details?.maintenance, true);
    assert.equal(await headMain(), f.seedMain, '维护拒绝不发布');
  } finally {
    const off = await f.h.app.inject({
      method: 'DELETE',
      url: '/api/v1/admin/maintenance',
      headers: { origin: 'http://localhost', ...f.h.session(maint) },
    });
    assert.equal(off.statusCode, 204, '关闭维护');
  }
});
