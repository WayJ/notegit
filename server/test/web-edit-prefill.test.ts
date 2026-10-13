import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { browseHarness, seededVault, addMember, addEmployee, gitOut, pushToVault, repoPathOf, type BrowseHarness } from './web-browse-fixtures.ts';

// S4-T7 编辑器打开时草稿预填（T6 遗留接页：API 级恢复已有——§7 GET 端点，
// 本任务接页面；T6 notes 移交节「回填时须同时呈现 base_commit 旧值」）：
//
// - 打开编辑器（GET edit 页）：本人现行草稿（active）存在 → 表单回填草稿内容
//   （草稿优先于库内文件内容——作者最新工作）；base commit = 打开时默认分支
//   HEAD（架构 §6「打开编辑器时记录 base commit」——刷新即取新基线）。
// - 回填同时呈现草稿基线旧值与保存时间；草稿基线 ≠ 当前 HEAD（分支已前进）
//   → 如实标注提示核对（直接提交将得到 409 冲突——不静默覆盖）。
// - README 豁免页同款回填（正文）；新建路径 + 草稿 → 回填草稿（不套文件名 title）。
// - 无草稿：现行为不变（文件内容回填、无回填标注）——回归护栏。
// - 按作者私有：他人草稿不影响我的回填。

const DRAFT_CONTENT = '---\ntitle: "草稿标题"\nowner: alice\n---\n\n草稿正文（未发布）。\n';
const FILE_CONTENT = '---\ntitle: "已发布标题"\n---\n\n已发布正文。\n';

interface Fix {
  h: BrowseHarness;
  vaultId: number;
  repoPath: string;
  seedMain: string;
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
    'notes/published.md': FILE_CONTENT,
  });
  addMember(h.db, vaultId, alice, 'editor', alice);
  addMember(h.db, vaultId, bob, 'editor', alice);
  const repoPath = repoPathOf(h, vaultId);
  const seedMain = (await gitOut(['--git-dir', repoPath, 'rev-parse', 'refs/heads/main'])).trim();
  f = {
    h, vaultId, repoPath, seedMain, alice, bob,
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
  // 每用例独立草稿（同路径各自成稿——UNIQUE(vault,author,path)，测试互不污染）
  f.h.db.exec('DELETE FROM drafts');
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

function editPage(employeeId: number, path: string) {
  return f.h.app.inject({
    method: 'GET',
    url: `/vaults/docs/edit/${path.split('/').map(encodeURIComponent).join('/')}`,
    headers: f.h.session(employeeId),
  });
}

test('既有文件 + 本人现行草稿：表单回填草稿（草稿优先），base=当前 HEAD，呈现草稿基线旧值与保存时间', async () => {
  const saved = await saveDraft(f.alice, 'notes/published.md', DRAFT_CONTENT);
  assert.equal(saved.statusCode, 200, saved.body);
  const updatedAt = (saved.json() as { updated_at: string }).updated_at;

  const page = await editPage(f.alice, 'notes/published.md');
  assert.equal(page.statusCode, 200);
  assert.ok(page.body.includes('value="草稿标题"'), 'title 回填草稿值（非库内已发布标题）');
  assert.ok(!page.body.includes('value="已发布标题"'), '草稿优先于文件内容');
  assert.ok(page.body.includes('草稿正文（未发布）。'), '正文回填草稿');
  assert.ok(page.body.includes(`base commit：<code>${f.seedMain}</code>`), '页面基线 = 打开时 HEAD（架构 §6）');
  assert.ok(page.body.includes('已回填你保存的草稿'), '回填如实标注');
  assert.ok(page.body.includes(`草稿基线 <code>${f.seedMain}</code>`), '呈现草稿 base_commit 旧值（T6 移交）');
  assert.ok(page.body.includes(updatedAt), '呈现草稿保存时间');
  assert.ok(!page.body.includes('<strong>分支已前进</strong>'), '基线一致时无过时提示（409 页内脚本文案不含此形态）');
});

test('草稿基线过时（分支已前进）：base=最新 HEAD、回填仍为草稿、含「分支已前进」提示与旧基线值', async () => {
  await saveDraft(f.alice, 'notes/published.md', DRAFT_CONTENT); // 基线 seedMain
  await pushToVault(f.h, f.vaultId, { 'notes/by-other.md': '---\ntitle: "他人先行"\n---\n\nx\n' });
  const newHead = (await gitOut(['--git-dir', f.repoPath, 'rev-parse', 'refs/heads/main'])).trim();

  const page = await editPage(f.alice, 'notes/published.md');
  assert.equal(page.statusCode, 200);
  assert.ok(page.body.includes(`base commit：<code>${newHead}</code>`), '刷新打开即取最新基线（重提走最新 CAS 旧值）');
  assert.ok(page.body.includes('value="草稿标题"'), '过时草稿仍回填（内容不丢）');
  assert.ok(page.body.includes('<strong>分支已前进</strong>'), '过时如实标注（提示核对——直接提交将 409）');
  assert.ok(page.body.includes(`草稿基线 <code>${f.seedMain}</code>`), '旧基线值同时呈现（对照当前 HEAD）');
});

test('新建路径 + 草稿：回填草稿内容（不套文件名生成 title）', async () => {
  await saveDraft(f.alice, 'notes/newcomer.md', DRAFT_CONTENT);
  const page = await editPage(f.alice, 'notes/newcomer.md');
  assert.equal(page.statusCode, 200);
  assert.ok(page.body.includes('value="草稿标题"'), '新建模式回填草稿 title');
  assert.ok(page.body.includes('草稿正文（未发布）。'), '新建模式回填草稿正文');
  assert.ok(!page.body.includes('标题已从文件名生成'), '有草稿时不呈现文件名生成标注（title 来自草稿）');
});

test('README 豁免页 + 草稿：正文回填草稿 + 回填标注（base=当前 HEAD）', async () => {
  const readmeDraft = '# 导航草稿\n\n草稿版 README。\n';
  await saveDraft(f.alice, 'README.md', readmeDraft);
  const page = await editPage(f.alice, 'README.md');
  assert.equal(page.statusCode, 200);
  assert.ok(page.body.includes('草稿版 README。'), 'README 正文回填草稿（非已发布正文）');
  assert.ok(!page.body.includes('# nav'), '草稿优先（已发布导航正文不回填）');
  assert.ok(page.body.includes(`base commit：<code>${f.seedMain}</code>`));
  assert.ok(page.body.includes('已回填你保存的草稿'), 'README 页同款回填标注');
});

test('无草稿回归：文件内容回填、无回填标注（S4-T3 现行为不变）', async () => {
  const page = await editPage(f.alice, 'notes/published.md');
  assert.equal(page.statusCode, 200);
  assert.ok(page.body.includes('value="已发布标题"'), '无草稿回填库内文件内容');
  assert.ok(!page.body.includes('已回填你保存的草稿'), '无回填标注');
  assert.ok(page.body.includes(`base commit：<code>${f.seedMain}</code>`));
});

test('按作者私有：他人草稿不影响我的编辑页（bob 回填自己的草稿，alice 不受影响）', async () => {
  await saveDraft(f.bob, 'notes/published.md', '---\ntitle: "Bob 的草稿"\n---\n\nbob 草稿。\n');

  const bobPage = await editPage(f.bob, 'notes/published.md');
  assert.ok(bobPage.body.includes('value="Bob 的草稿"'), 'bob 看到自己的草稿');

  const alicePage = await editPage(f.alice, 'notes/published.md');
  assert.ok(alicePage.body.includes('value="已发布标题"'), 'alice 不受 bob 草稿影响（作者私有，§7 同判）');
  assert.ok(!alicePage.body.includes('Bob 的草稿'));
});
