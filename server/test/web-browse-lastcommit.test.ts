import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  browseHarness,
  seededVault,
  addEmployee,
  addMember,
  gitOut,
  repoPathOf,
  lsTreeSeq,
  pageEntrySeq,
  type BrowseHarness,
} from './web-browse-fixtures.ts';

// S11-T3 目录行最后提交元数据 + browse 头「最近变更」入口（G07/DOD-E2-07）：
// 作者/相对时间（title 绝对时间提示）；条目集与序仍与 git ls-tree 同集同序
// （既有锁定延续）；activity 链接编辑者与读者都可见（读门槛语义）；非成员
// 404 同体不变（D-IC-06）。多作者/可控时间的提交序列由本文件自建 git 直通
// 助手推入（gitOut——不经生产读面）。

let seq = 0;

/** 以指定作者/作者时间推一笔提交（clone→写→commit --date→push 快进） */
async function commitAs(
  h: BrowseHarness,
  vaultId: number,
  author: string,
  date: Date,
  files: Record<string, string>,
): Promise<void> {
  const repoPath = repoPathOf(h, vaultId);
  const work = path.join(h.dataDir, `lc-${vaultId}-${++seq}`);
  await gitOut(['clone', repoPath, work]);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(work, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
  }
  await gitOut(['-C', work, 'add', '.']);
  await gitOut([
    '-C', work,
    '-c', `user.name=${author}`,
    '-c', `user.email=${author}@notegit.test`,
    'commit', `--date=${date.toISOString()}`, '-m', `by ${author}`,
  ]);
  await gitOut(['-C', work, 'push', 'origin', 'HEAD:refs/heads/main']);
  await rm(work, { recursive: true, force: true });
}

/**
 * 两作者两笔提交的种子库：
 * - alice（3 小时 5 秒前）：README.md + assets/logo.txt + docs/getting-started.md
 * - bob（5 秒前）：仅改 docs/getting-started.md
 * 期望根目录元数据：README.md/assets → alice·3 小时前；docs → bob·刚刚（tree
 * 前缀聚合——目录最新触及 = 其下任一路径的最新提交）。
 */
async function metaHarness() {
  const h = await browseHarness();
  const alice = addEmployee(h.db, { username: 'alice' });
  const bob = addEmployee(h.db, { username: 'bob' });
  const carol = addEmployee(h.db, { username: 'carol' });
  const vaultId = await seededVault(h, 'alpha', alice); // 空 bare——全部提交可控
  addMember(h.db, vaultId, alice, 'editor', alice);
  addMember(h.db, vaultId, bob, 'reader', alice);
  await commitAs(h, vaultId, 'alice', new Date(Date.now() - 3 * 3_600_000 - 5_000), {
    'README.md': '# nav\n',
    'docs/getting-started.md': 'v1\n',
    'assets/logo.txt': 'logo\n',
  });
  await commitAs(h, vaultId, 'bob', new Date(Date.now() - 5_000), {
    'docs/getting-started.md': 'v2\n',
  });
  return { h, alice, bob, carol, vaultId };
}

test('目录行：最后提交作者与相对时间（blob 精确路径 / tree 前缀聚合）；title 绝对时间', async () => {
  const { h, alice } = await metaHarness();
  try {
    const page = await h.app.inject({ method: 'GET', url: '/vaults/alpha/browse', headers: h.session(alice) });
    assert.equal(page.statusCode, 200, page.body);
    // li 携带 data-author/data-time（blob=精确路径；tree=子路径前缀最新触及）
    assert.match(page.body, /<li data-type="blob" data-name="README\.md"[^>]*data-author="alice"/, 'README.md → alice（bob 未触及）');
    assert.match(page.body, /<li data-type="tree" data-name="assets"[^>]*data-author="alice"/, 'assets → alice');
    assert.match(page.body, /<li data-type="tree" data-name="docs"[^>]*data-author="bob"/, 'docs → bob（最新触及 docs/ 下路径）');
    // 可见相对时间（次要文本）+ title 绝对时间提示
    assert.ok(page.body.includes('alice · 3 小时前'), 'README/assets 行相对时间');
    assert.ok(page.body.includes('bob · 刚刚'), 'docs 行相对时间');
    assert.match(page.body, /title="\d{4}-\d{2}-\d{2} \d{2}:\d{2}"/, 'title 提示绝对时间');
  } finally {
    await h.close();
  }
});

test('目录行：条目集与序仍与 git ls-tree 同集同序（既有锁定延续——元数据仅附加）', async () => {
  const { h, alice, vaultId } = await metaHarness();
  try {
    const page = await h.app.inject({ method: 'GET', url: '/vaults/alpha/browse', headers: h.session(alice) });
    assert.equal(page.statusCode, 200, page.body);
    assert.deepEqual(pageEntrySeq(page.body), await lsTreeSeq(repoPathOf(h, vaultId), 'main', ''), '根目录同集同序');
    const sub = await h.app.inject({ method: 'GET', url: '/vaults/alpha/browse/docs', headers: h.session(alice) });
    assert.equal(sub.statusCode, 200, sub.body);
    assert.deepEqual(pageEntrySeq(sub.body), await lsTreeSeq(repoPathOf(h, vaultId), 'main', 'docs'), '子目录同集同序');
  } finally {
    await h.close();
  }
});

test('最近变更入口：browse 头链接一行，编辑者与读者都可见（读门槛语义）', async () => {
  const { h, alice, bob } = await metaHarness();
  try {
    const asEditor = await h.app.inject({ method: 'GET', url: '/vaults/alpha/browse', headers: h.session(alice) });
    assert.equal(asEditor.statusCode, 200, asEditor.body);
    assert.ok(asEditor.body.includes('href="/vaults/alpha/activity"'), '编辑者见 activity 链接（URL 正确）');
    assert.ok(asEditor.body.includes('最近变更'), '链接文字');
    const asReader = await h.app.inject({ method: 'GET', url: '/vaults/alpha/browse', headers: h.session(bob) });
    assert.equal(asReader.statusCode, 200, asReader.body);
    assert.ok(asReader.body.includes('href="/vaults/alpha/activity"'), '读者同样见 activity 链接（读门槛）');
    assert.ok(asReader.body.includes('data-author='), '读者同样见最后提交元数据');
  } finally {
    await h.close();
  }
});

test('非成员 404 同体不变（D-IC-06：无权=不存在同页）', async () => {
  const { h, carol } = await metaHarness();
  try {
    const outsider = await h.app.inject({ method: 'GET', url: '/vaults/alpha/browse', headers: h.session(carol) });
    assert.equal(outsider.statusCode, 404);
    const ghost = await h.app.inject({ method: 'GET', url: '/vaults/ghost/browse', headers: h.session(carol) });
    assert.equal(ghost.statusCode, 404);
    assert.equal(outsider.body, ghost.body, '非成员与不存在同体');
  } finally {
    await h.close();
  }
});
