import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  browseHarness,
  seededVault,
  addMember,
  addEmployee,
  gitOut,
  repoPathOf,
  type BrowseHarness,
} from './web-browse-fixtures.ts';

// S4-T6 草稿 CRUD（api.md §7；breakdown §2.3 S4-T6 行完成标准前两组）：
//
// - 按作者私有：草稿按 (vault, author, path) 存取——同事读他人草稿一律 404
//   （不是自己的现行草稿 = 不存在，D-IC-06 反存在性同判）。
// - 访问时复查库权限：授权层实时查表（identity §5.1 第 2 层）——撤权后
//   列表与访问下一请求即 404（identity §5.2 行 4）。
// - 自动保存不产生 Git 提交：PUT 后仓库 ref 与提交计数逐字不动。
// - 端点形状按 §7：GET 列表/单读（成员）、PUT upsert（editor+）、DELETE（editor+）；
//   路径非法/超限 422 = T2 报告；维护 503 E-MAINT-001（app 级闸门自动覆盖）。
//
// 被测形态：buildApp 全家桶（真实会话 + 真实 bare 仓库）；Git 侧断言走直通
// git（不经生产读面）。员工自增序列：alice=1、bob=2、carol=3、dave=4、maint=5。

const NOW = '2026-10-13T12:00:00.000Z';

interface Fix {
  h: BrowseHarness;
  vaultId: number;
  repoPath: string;
  seedMain: string;
  seedCount: string;
  alice: number;
  bob: number;
  carol: number;
  dave: number;
  close(): Promise<void>;
}

let f: Fix;

before(async () => {
  const h = await browseHarness();
  const alice = addEmployee(h.db, { username: 'alice' });
  const bob = addEmployee(h.db, { username: 'bob' });
  const carol = addEmployee(h.db, { username: 'carol' });
  const dave = addEmployee(h.db, { username: 'dave' });
  const vaultId = await seededVault(h, 'docs', alice, {
    'README.md': '# nav\n',
    'notes/first.md': '---\ntitle: First\n---\nbody\n',
  });
  addMember(h.db, vaultId, alice, 'editor', alice);
  addMember(h.db, vaultId, bob, 'editor', alice);
  addMember(h.db, vaultId, carol, 'reader', alice); // 只读成员：PUT 403 面
  const repoPath = repoPathOf(h, vaultId);
  const seedMain = (await gitOut(['--git-dir', repoPath, 'rev-parse', 'refs/heads/main'])).trim();
  const seedCount = (await gitOut(['--git-dir', repoPath, 'rev-list', '--count', 'refs/heads/main'])).trim();
  f = {
    h, vaultId, repoPath, seedMain, seedCount, alice, bob, carol, dave,
    close: async () => {
      await h.close();
    },
  };
});

after(async () => {
  await f.close();
});

/** 会话 + 同源 Origin（CSRF：会话载体状态改变请求须同源——identity §4） */
function as(employeeId: number): Record<string, string> {
  return { origin: 'http://localhost', ...f.h.session(employeeId) };
}

function put(employeeId: number, path: string, content: string, baseCommit: string | null = f.seedMain) {
  return f.h.app.inject({
    method: 'PUT',
    url: `/api/v1/vaults/docs/drafts/${path.split('/').map(encodeURIComponent).join('/')}`,
    headers: { 'content-type': 'application/json', ...as(employeeId) },
    payload: { content, base_commit: baseCommit },
  });
}

function get(employeeId: number, path: string) {
  return f.h.app.inject({
    method: 'GET',
    url: `/api/v1/vaults/docs/drafts/${path.split('/').map(encodeURIComponent).join('/')}`,
    headers: as(employeeId),
  });
}

function del(employeeId: number, path: string) {
  return f.h.app.inject({
    method: 'DELETE',
    url: `/api/v1/vaults/docs/drafts/${path.split('/').map(encodeURIComponent).join('/')}`,
    headers: as(employeeId),
  });
}

function list(employeeId: number) {
  return f.h.app.inject({ method: 'GET', url: '/api/v1/vaults/docs/drafts', headers: as(employeeId) });
}

const DRAFT_BODY = '---\ntitle: 草稿标题\n---\n正文草稿内容。\n';

// ── 端点基础面（§7 形状） ──

test('PUT 保存草稿：200 {updated_at}，GET 回读 {content, base_commit, updated_at} 一致', async () => {
  const res = await put(f.alice, 'notes/first.md', DRAFT_BODY);
  assert.equal(res.statusCode, 200, res.body);
  const saved = res.json();
  assert.equal(typeof saved.updated_at, 'string', '响应键 updated_at（§7）');
  assert.ok((saved.updated_at as string).length > 0);

  const back = await get(f.alice, 'notes/first.md');
  assert.equal(back.statusCode, 200);
  const draft = back.json();
  assert.deepEqual(Object.keys(draft).sort(), ['base_commit', 'content', 'updated_at'], '§7 单读响应键');
  assert.equal(draft.content, DRAFT_BODY, '草稿全文逐字保存（含 frontmatter 文本）');
  assert.equal(draft.base_commit, f.seedMain, 'base_commit 原样保存（T7 冲突保护的对照输入）');
});

test('未认证：PUT/列表 401（E-AUTH-001）', async () => {
  const r1 = await f.h.app.inject({
    method: 'PUT',
    url: '/api/v1/vaults/docs/drafts/notes/first.md',
    headers: { 'content-type': 'application/json', origin: 'http://localhost' },
    payload: { content: 'x', base_commit: null },
  });
  assert.equal(r1.statusCode, 401);
  assert.equal(r1.json().error.code, 'E-AUTH-001');
  const r2 = await f.h.app.inject({ method: 'GET', url: '/api/v1/vaults/docs/drafts' });
  assert.equal(r2.statusCode, 401);
});

test('列表：仅返回自己的现行草稿（{drafts:[{path, base_commit, updated_at}]}）', async () => {
  await put(f.alice, 'notes/first.md', DRAFT_BODY);
  await put(f.alice, 'notes/second.md', '---\ntitle: 二\n---\n2\n');
  const res = await list(f.alice);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(Array.isArray(body.drafts));
  const paths = (body.drafts as { path: string }[]).map((d) => d.path).sort();
  assert.deepEqual(paths, ['notes/first.md', 'notes/second.md']);
  for (const d of body.drafts as Record<string, unknown>[]) {
    assert.deepEqual(Object.keys(d).sort(), ['base_commit', 'path', 'updated_at'], '§7 列表项键');
  }
});

test('同路径再保存 = 覆盖旧稿（每作者每路径一份现行草稿，upsert）', async () => {
  await put(f.alice, 'notes/first.md', DRAFT_BODY);
  const again = await put(f.alice, 'notes/first.md', '---\ntitle: 改\n---\n新内容\n');
  assert.equal(again.statusCode, 200);
  const back = await get(f.alice, 'notes/first.md');
  assert.equal(back.json().content, '---\ntitle: 改\n---\n新内容\n');
  const rows = await list(f.alice);
  assert.equal((rows.json().drafts as { path: string }[]).filter((d) => d.path === 'notes/first.md').length, 1);
});

// ── 完成标准 1：同事读取他人草稿 404（按作者私有） ──

test('作者私有：同事（同库 editor）读他人草稿 404、列表不含他人草稿', async () => {
  await put(f.alice, 'notes/first.md', DRAFT_BODY);
  const direct = await get(f.bob, 'notes/first.md');
  assert.equal(direct.statusCode, 404, '同事读他人草稿 = 404（按作者私有）');
  assert.equal(direct.json().error.code, 'E-RES-001');
  const bobList = await list(f.bob);
  assert.equal(bobList.statusCode, 200);
  assert.deepEqual((bobList.json().drafts as { path: string }[]).map((d) => d.path), [], 'bob 列表不含 alice 草稿');
});

test('作者私有：同路径各自成稿互不覆盖（bob 保存不影响 alice 内容）', async () => {
  await put(f.alice, 'notes/first.md', DRAFT_BODY);
  const bobSave = await put(f.bob, 'notes/first.md', '---\ntitle: bob 稿\n---\nbob\n');
  assert.equal(bobSave.statusCode, 200, '同库同路径他人保存 = 自己的草稿行');
  const aliceBack = await get(f.alice, 'notes/first.md');
  assert.equal(aliceBack.json().content, DRAFT_BODY, 'alice 草稿不受 bob 保存影响');
  const bobBack = await get(f.bob, 'notes/first.md');
  assert.equal(bobBack.json().content, '---\ntitle: bob 稿\n---\nbob\n');
});

// ── 完成标准 2：撤权后草稿列表与访问被拒 ──

test('撤权：移除成员关系后列表/单读/保存下一请求即 404（identity §5.2 行 4）', async () => {
  await put(f.alice, 'notes/first.md', DRAFT_BODY);
  f.h.db.prepare('DELETE FROM vault_members WHERE vault_id = ? AND employee_id = ?').run(f.vaultId, f.alice);
  assert.equal((await list(f.alice)).statusCode, 404, '撤权后草稿列表 404');
  assert.equal((await get(f.alice, 'notes/first.md')).statusCode, 404, '撤权后草稿访问 404');
  const save = await put(f.alice, 'notes/first.md', 'x');
  assert.equal(save.statusCode, 404, '撤权后保存 404');
  assert.equal(save.json().error.code, 'E-RES-001');
  // 恢复成员（后续用例不受影响）
  addMember(f.h.db, f.vaultId, f.alice, 'editor', f.alice);
});

// ── 完成标准 3：仅保存草稿后 git log 无新提交 ──

test('Git 无痕：保存草稿后 ref 与提交计数逐字不动（自动保存不产生 Git 版本）', async () => {
  for (const r of [
    await put(f.alice, 'notes/first.md', DRAFT_BODY),
    await put(f.alice, 'notes/second.md', '---\ntitle: 二\n---\n2\n'),
    await put(f.bob, 'notes/first.md', '---\ntitle: bob\n---\nb\n'),
  ]) {
    assert.equal(r.statusCode, 200, '前置：保存成功（否则本测试不构成对保存行为的断言）');
  }
  const head = (await gitOut(['--git-dir', f.repoPath, 'rev-parse', 'refs/heads/main'])).trim();
  const count = (await gitOut(['--git-dir', f.repoPath, 'rev-list', '--count', 'refs/heads/main'])).trim();
  assert.equal(head, f.seedMain, '草稿保存不得移动默认分支 ref');
  assert.equal(count, f.seedCount, '草稿保存不得产生新提交（git log 无新条目）');
});

// ── 角色与库边界（§7 权限注记） ──

test('reader 成员：列表/单读 200（成员门槛），PUT/DELETE 403 E-AUTHZ-001（editor+）', async () => {
  await put(f.alice, 'notes/first.md', DRAFT_BODY);
  assert.equal((await list(f.carol)).statusCode, 200, '列表门槛=成员（reader 可见自己的——现为空）');
  assert.equal((await get(f.carol, 'notes/first.md')).statusCode, 404, 'carol 无自己的草稿 = 404（非 403）');
  const save = await put(f.carol, 'notes/first.md', 'x');
  assert.equal(save.statusCode, 403, 'reader 保存草稿 403（§7 editor+）');
  assert.equal(save.json().error.code, 'E-AUTHZ-001');
  const rm = await del(f.carol, 'notes/first.md');
  assert.equal(rm.statusCode, 403, 'reader 删除草稿 403');
  assert.equal(rm.json().error.code, 'E-AUTHZ-001');
});

test('非成员与未知库：一律 404 E-RES-001（D-IC-06 反存在性）', async () => {
  assert.equal((await list(f.dave)).statusCode, 404);
  const save = await put(f.dave, 'notes/first.md', 'x');
  assert.equal(save.statusCode, 404);
  assert.equal(save.json().error.code, 'E-RES-001');
  const anonVault = await f.h.app.inject({
    method: 'GET',
    url: '/api/v1/vaults/ghost/drafts',
    headers: as(f.alice),
  });
  assert.equal(anonVault.statusCode, 404, '未知库同 404（不泄露存在性）');
});

// ── 422：路径非法 / 超限（T2 报告形状，§7「E-PATH-001 等」） ──

test('路径非法：422 = T2 报告（scope=web-submit、result=fail、E-PATH-001、rulesVersion）', async () => {
  // 反斜杠段经 %5C 编码进路由（../ 会被路由层归一化——到达不了校验面）
  const res = await put(f.alice, 'notes/bad\\name.md', 'x');
  assert.equal(res.statusCode, 422, res.body);
  const report = res.json();
  assert.equal(report.scope, 'web-submit');
  assert.equal(report.result, 'fail');
  assert.equal(report.exitCode, 1);
  assert.equal(typeof report.rulesVersion, 'string');
  assert.equal(report.files[0].path, 'notes/bad\\name.md', '报告 files 归因被拒路径');
  const issues = (report.files as { issues: { code: string; severity: string }[] }[])[0].issues;
  assert.equal(issues[0].code, 'E-PATH-001');
  assert.equal(issues[0].severity, 'error');
  // 无草稿行落库（被拒路径不进存储）
  assert.equal((await get(f.alice, 'notes/bad\\name.md')).statusCode, 404);
});

test('草稿超长：422 = T2 报告 E-LIMIT-001（maxDocumentBytes，storage-model「大字段超长控制」）', async () => {
  const big = `---\ntitle: 大\n---\n${'x'.repeat(1048576)}`; // 默认 maxDocumentBytes = 1 MiB
  const res = await put(f.alice, 'notes/big.md', big);
  assert.equal(res.statusCode, 422, res.body);
  const report = res.json();
  const issues = (report.files as { issues: { code: string; limitKey?: string; limit?: number }[] }[])[0].issues;
  assert.equal(issues[0].code, 'E-LIMIT-001');
  assert.equal(issues[0].limitKey, 'validation.limits.maxDocumentBytes');
  assert.equal(issues[0].limit, 1048576);
});

test('请求形态：content 缺失 / base_commit 类型错 → 400 E-RES-004', async () => {
  const noContent = await f.h.app.inject({
    method: 'PUT',
    url: '/api/v1/vaults/docs/drafts/notes/first.md',
    headers: { 'content-type': 'application/json', ...as(f.alice) },
    payload: { base_commit: null },
  });
  assert.equal(noContent.statusCode, 400);
  assert.equal(noContent.json().error.code, 'E-RES-004');
  const badBase = await f.h.app.inject({
    method: 'PUT',
    url: '/api/v1/vaults/docs/drafts/notes/first.md',
    headers: { 'content-type': 'application/json', ...as(f.alice) },
    payload: { content: 'x', base_commit: 42 },
  });
  assert.equal(badBase.statusCode, 400);
  assert.equal(badBase.json().error.code, 'E-RES-004');
});

// ── DELETE 与维护闸门 ──

test('DELETE：204 后 GET 404，再 DELETE 404（现行草稿删除幂等面）', async () => {
  await put(f.alice, 'notes/del.md', DRAFT_BODY);
  assert.equal((await del(f.alice, 'notes/del.md')).statusCode, 204);
  assert.equal((await get(f.alice, 'notes/del.md')).statusCode, 404);
  assert.equal((await del(f.alice, 'notes/del.md')).statusCode, 404, '无现行草稿可删 = 404');
  // 他人草稿不可删：对 bob 而言 alice 的草稿不存在——删除只作用于自己的行
  await put(f.alice, 'notes/alice-only.md', DRAFT_BODY);
  assert.equal((await del(f.bob, 'notes/alice-only.md')).statusCode, 404, 'bob 无自己的草稿 = 404（alice 的不受影响）');
  assert.equal((await get(f.alice, 'notes/alice-only.md')).statusCode, 200, 'alice 草稿原样保留');
});

test('维护模式：PUT/DELETE 503 E-MAINT-001，读路径放行（backup §3 矩阵 web/api 行）', async () => {
  await put(f.alice, 'notes/first.md', DRAFT_BODY);
  const admin = addEmployee(f.h.db, { username: 'maint', is_instance_admin: 1 });
  const on = await f.h.app.inject({
    method: 'POST',
    url: '/api/v1/admin/maintenance',
    headers: { origin: 'http://localhost', ...f.h.session(admin) },
    payload: {},
  });
  assert.equal(on.statusCode, 204, on.body);
  try {
    const save = await put(f.alice, 'notes/first.md', 'x');
    assert.equal(save.statusCode, 503);
    assert.equal(save.json().error.code, 'E-MAINT-001');
    assert.equal(save.json().error.details.maintenance, true);
    assert.equal((await del(f.alice, 'notes/first.md')).statusCode, 503);
    assert.equal((await list(f.alice)).statusCode, 200, '维护中读放行（列表仍可读）');
    assert.equal((await get(f.alice, 'notes/first.md')).statusCode, 200, '维护中读放行（单读仍可读）');
  } finally {
    const off = await f.h.app.inject({
      method: 'DELETE',
      url: '/api/v1/admin/maintenance',
      headers: { origin: 'http://localhost', ...f.h.session(admin) },
    });
    assert.equal(off.statusCode, 204);
  }
  assert.equal((await put(f.alice, 'notes/first.md', DRAFT_BODY)).statusCode, 200, '解除维护后保存恢复');
});

// 时间注入断言占位（NOW 供服务层 now 注入缝的将来测试；本文件走真实时钟只断言非空）
void NOW;
