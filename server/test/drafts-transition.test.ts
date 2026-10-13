import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { browseHarness, seededVault, addMember, gitOut, repoPathOf, type BrowseHarness } from './web-browse-fixtures.ts';
import { submitEditForm } from '../src/web/edit/submit.ts';
import { editPage } from '../src/web/edit/pages.ts';
import type { EditFormFields } from '../src/web/edit/form.ts';

// S4-T6 草稿状态流转（breakdown §2.3 S4-T6 行完成标准第 4 组 + 任务 Change 3/4/6）：
//
// - 正式提交走 T3 submit 面（submitEditForm → S3-T7 publishWebSubmit 唯一发布
//   入口）；发布成功后草稿标已提交（架构 §6「发布后清理或标为已提交」——取
//   「标记」路径：status='committed' + committed_at，行保留可追溯）。
// - 拒绝（校验/冲突）不改变草稿（S3-T7 DraftPreserved「不发布、保留草稿」的
//   存储侧对应：active 原样）。
// - 已提交行不再作为现行草稿出现（列表/读取按 active 过滤——「私有草稿可恢复」
//   指恢复未发布草稿）；同路径再保存重置为 active（覆盖旧稿）。
// - 编辑页保存/提交双按钮接线（T3 定形形状激活）：页面不再含「草稿存储未接入」
//   占位文案，保存/提交语义标注与落地行为一致。

const WHEN = '2026-10-13T12:00:00.000Z';
const IDENT = { name: 'alice', email: 'alice@notegit.test' };

const FIELDS: EditFormFields = {
  title: '流转样例', owner: '', description: '', tags: '', status: '', source: '', extra: '',
};

interface Fix {
  h: BrowseHarness;
  vaultId: number;
  repoPath: string;
  seedMain: string;
  seedCount: string;
  alice: number;
  close(): Promise<void>;
}

let f: Fix;

before(async () => {
  const h = await browseHarness();
  const alice = 1; // addEmployee 自增起始（web-browse-fixtures 建库序列）
  const bob = 2;
  const { addEmployee } = await import('./web-browse-fixtures.ts');
  addEmployee(h.db, { username: 'alice' });
  addEmployee(h.db, { username: 'bob' });
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
    h, vaultId, repoPath, seedMain, seedCount, alice,
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

/** §7 PUT 保存草稿（走真实端点——与编辑页保存按钮同一形状） */
function saveDraft(path: string, content: string, baseCommit: string | null = f.seedMain) {
  return f.h.app.inject({
    method: 'PUT',
    url: `/api/v1/vaults/docs/drafts/${path.split('/').map(encodeURIComponent).join('/')}`,
    headers: { 'content-type': 'application/json', origin: 'http://localhost', ...f.h.session(f.alice) },
    payload: { content, base_commit: baseCommit },
  });
}

function readDraft(path: string) {
  return f.h.app.inject({
    method: 'GET',
    url: `/api/v1/vaults/docs/drafts/${path.split('/').map(encodeURIComponent).join('/')}`,
    headers: { origin: 'http://localhost', ...f.h.session(f.alice) },
  });
}

/** 直查 drafts 行（测试对照——不经生产读面） */
function draftRow(path: string): { status: string; committed_at: string | null; content: string } | undefined {
  return f.h.db
    .prepare('SELECT status, committed_at, content FROM drafts WHERE vault_id = ? AND employee_id = ? AND path = ?')
    .get(f.vaultId, f.alice, path) as { status: string; committed_at: string | null; content: string } | undefined;
}

function submit(path: string, over: Record<string, unknown> = {}) {
  return submitEditForm({
    db: f.h.db,
    dataDir: f.h.dataDir,
    subject: { employeeId: f.alice, carrierRef: 'session:1' },
    vaultSlug: 'docs',
    branch: 'main',
    path,
    fields: { ...FIELDS },
    body: '正文。',
    baseCommit: f.seedMain,
    identity: IDENT,
    committedAt: WHEN,
    occurredAt: WHEN,
    ...over,
  });
}

async function headMain(): Promise<string> {
  return (await gitOut(['--git-dir', f.repoPath, 'rev-parse', 'refs/heads/main'])).trim();
}

async function commitCount(): Promise<string> {
  return (await gitOut(['--git-dir', f.repoPath, 'rev-list', '--count', 'refs/heads/main'])).trim();
}

// ── 完成标准 4：正式提交后草稿状态流转且 Git 有对应提交 ──

test('正式提交成功：草稿 active → committed（committed_at 置位）、Git 多一笔、不再可恢复/列出', async () => {
  const saved = await saveDraft('notes/flow.md', '---\ntitle: 流程\n---\n草稿正文\n');
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(draftRow('notes/flow.md')?.status, 'active');

  const out = await submit('notes/flow.md');
  assert.equal(out.publish.kind, 'published', '正式提交走 T3 submit 面 → 发布组件');

  const row = draftRow('notes/flow.md');
  assert.equal(row?.status, 'committed', '发布成功后草稿标已提交（架构 §6）');
  assert.equal(row?.committed_at, WHEN, 'committed_at = 标记时间（注入时钟确定性）');
  assert.notEqual(await headMain(), f.seedMain, 'Git ref 前进');
  assert.equal(Number(await commitCount()), Number(f.seedCount) + 1, 'git log 恰多一笔提交');
  assert.equal((await readDraft('notes/flow.md')).statusCode, 404, '已提交草稿不再可恢复（active 过滤）');
  const listed = await f.h.app.inject({
    method: 'GET',
    url: '/api/v1/vaults/docs/drafts',
    headers: { origin: 'http://localhost', ...f.h.session(f.alice) },
  });
  assert.equal(
    ((listed.json().drafts as { path: string }[]) ?? []).some((d) => d.path === 'notes/flow.md'),
    false,
    '已提交草稿不出现在列表',
  );
});

test('校验拒绝：草稿保持 active 原样（不发布、保留草稿——S3-T7 DraftPreserved 存储侧）', async () => {
  await saveDraft('notes/reject.md', '---\ntitle: 拒绝\n---\n草稿\n');
  const out = await submit('notes/reject.md', { fields: { ...FIELDS, title: '' } }); // E-FM-003 阻断
  assert.equal(out.publish.kind, 'rejected');
  if (out.publish.kind !== 'rejected') return;
  assert.equal(out.publish.stage, 'validation');
  const row = draftRow('notes/reject.md');
  assert.equal(row?.status, 'active', '校验拒绝后草稿仍为现行草稿');
  assert.equal(row?.committed_at, null);
  assert.equal(row?.content, '---\ntitle: 拒绝\n---\n草稿\n', '草稿内容逐字保留');
  assert.equal(await headMain(), f.seedMain, '不发布');
  assert.equal((await readDraft('notes/reject.md')).statusCode, 200, '拒绝后草稿仍可恢复');
});

test('冲突拒绝（base-commit）：草稿保持 active（DOD-07 冲突草稿保留）', async () => {
  // alice 打开编辑器（基线 seedMain）并保存草稿；他人先行推进分支后 alice 提交
  // ——过时基线（仍在库内的真实提交）候选可构造，CAS 旧值不符 → base-commit 拒绝
  await saveDraft('notes/conflict.md', '---\ntitle: 冲突\n---\n草稿\n');
  const bob = await submitEditForm({
    db: f.h.db,
    dataDir: f.h.dataDir,
    subject: { employeeId: 2, carrierRef: 'session:2' },
    vaultSlug: 'docs',
    branch: 'main',
    path: 'notes/other.md', // bob 提交另一路径——分支前进，alice 的基线过时
    fields: { ...FIELDS, title: 'Bob 先行' },
    body: 'bob 正文。',
    baseCommit: f.seedMain,
    identity: { name: 'bob', email: 'bob@notegit.test' },
    committedAt: WHEN,
    occurredAt: WHEN,
  });
  assert.equal(bob.publish.kind, 'published');

  const out = await submit('notes/conflict.md'); // baseCommit=打开编辑器时的 seedMain（现过时）
  assert.equal(out.publish.kind, 'rejected');
  if (out.publish.kind !== 'rejected') return;
  assert.equal(out.publish.stage, 'base-commit', 'CAS 旧值不符在 base-commit 阶段拒绝');
  const row = draftRow('notes/conflict.md');
  assert.equal(row?.status, 'active', '冲突草稿完整保留（刷新基线后可重提——不静默覆盖）');
  assert.equal(row?.content, '---\ntitle: 冲突\n---\n草稿\n');
  assert.equal((await readDraft('notes/conflict.md')).statusCode, 200, '冲突后草稿仍可恢复');
  assert.notEqual(await headMain(), f.seedMain, '先前提交（bob 的）不被覆盖');
});

test('已提交后同路径再保存：重置 active（每作者每路径一份现行草稿，覆盖旧稿）', async () => {
  await saveDraft('notes/again.md', '---\ntitle: 一\n---\n1\n');
  await submit('notes/again.md');
  assert.equal(draftRow('notes/again.md')?.status, 'committed');

  const again = await saveDraft('notes/again.md', '---\ntitle: 二\n---\n2\n');
  assert.equal(again.statusCode, 200, '已提交后可再保存（新一轮编辑）');
  const row = draftRow('notes/again.md');
  assert.equal(row?.status, 'active', '再保存重置为现行草稿');
  assert.equal(row?.committed_at, null, 'committed_at 清空');
  assert.equal(row?.content, '---\ntitle: 二\n---\n2\n');
  const rows = f.h.db
    .prepare('SELECT COUNT(*) AS n FROM drafts WHERE vault_id = ? AND employee_id = ? AND path = ?')
    .get(f.vaultId, f.alice, 'notes/again.md') as { n: number };
  assert.equal(rows.n, 1, '同路径仍只有一行（UNIQUE 约束 + upsert 语义）');
});

test('无草稿时提交：标记为无操作（幂等，不报错）', async () => {
  const out = await submit('notes/nodraft.md');
  assert.equal(out.publish.kind, 'published');
  assert.equal(draftRow('notes/nodraft.md'), undefined, '无草稿则无行——markCommitted 为 no-op');
});

test('他人提交不标记我的草稿（按作者私有——仅提交者本人的草稿流转）', async () => {
  await saveDraft('notes/mine.md', '---\ntitle: 我的\n---\n我的草稿\n');
  const out = await submitEditForm({
    db: f.h.db,
    dataDir: f.h.dataDir,
    subject: { employeeId: 2, carrierRef: 'session:2' }, // bob 提交同一路径
    vaultSlug: 'docs',
    branch: 'main',
    path: 'notes/mine.md',
    fields: { ...FIELDS },
    body: 'bob 的正文。',
    baseCommit: f.seedMain,
    identity: { name: 'bob', email: 'bob@notegit.test' },
    committedAt: WHEN,
    occurredAt: WHEN,
  });
  assert.equal(out.publish.kind, 'published');
  const row = draftRow('notes/mine.md');
  assert.equal(row?.status, 'active', 'bob 的提交不流转 alice 的草稿（作者私有）');
  assert.equal(row?.content, '---\ntitle: 我的\n---\n我的草稿\n', 'alice 草稿完整保留（其 base 已过时——T7 冲突面）');
});

// ── 编辑页双按钮接线（T3 定形形状激活——页面文案与落地行为一致） ──

test('编辑页：保存/提交双按钮在位，不再含「草稿存储未接入」占位文案', () => {
  const page = editPage({
    vault: { slug: 'docs', name: 'Docs' },
    entryPath: 'notes/first.md',
    mode: 'edit',
    baseCommit: f.seedMain,
    prefill: {
      fields: { title: 'First', owner: '', description: '', tags: '', status: '', source: '' },
      extra: '',
      body: 'body\n',
    },
  });
  assert.ok(page.includes('id="save-draft"'), '保存草稿按钮在位');
  assert.ok(/<button type="submit">/.test(page), '提交按钮在位');
  assert.ok(!page.includes('草稿存储未接入'), 'T6 落地后不再呈现存储未接入文案');
  assert.ok(page.includes('不产生 Git 版本'), '保存=草稿（不产生 Git 版本）语义标注在位');
  assert.ok(page.includes('drafts/notes/first.md'), '保存按钮指向 §7 PUT URL（draftPutUrl 形状）');
});
