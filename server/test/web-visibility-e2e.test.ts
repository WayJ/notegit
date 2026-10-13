import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  browseHarness,
  seededVault,
  addEmployee,
  addMember,
  gitOut,
  pushToVault,
  repoPathOf,
  lsTreeSeq,
  pageEntrySeq,
  type BrowseHarness,
} from './web-browse-fixtures.ts';

// S4-T8 Web×Git 双向可见端到端（breakdown §2.3 S4-T8 完成标准 1/2；S4 plan 验收
// 场景 S1——DOD-06 核心收口）：
// - Git→Web：push 后刷新网页即见新内容（默认分支实时读——无需任何额外动作）；
// - Web→Git：网页发布后 `git clone` 抽样比对——网页看到的已发布内容 == clone
//   后文件（内容全等：逐文件字节 + tree OID 全等 + 页面呈现一致）。

interface Ctx {
  h: BrowseHarness;
  vaultId: number;
  repoPath: string;
  alice: number;
}

async function setup(files: Record<string, string>): Promise<Ctx> {
  const h = await browseHarness();
  const alice = addEmployee(h.db, { username: 'alice' });
  const vaultId = await seededVault(h, 'alpha', alice, files);
  addMember(h.db, vaultId, alice, 'editor', alice);
  return { h, vaultId, repoPath: repoPathOf(h, vaultId), alice };
}

test('双向可见 Git→Web：push 后刷新网页即见新内容（无需额外动作）', async () => {
  const { h, repoPath } = await setup({
    'README.md': '# 导航 v1\n',
    'docs/guide.md': '---\ntitle: 指南\n---\n\n指南正文 v1。\n',
  });
  try {
    // 真实 Git 通道 push（clone→写→commit→push）：新增知识文档 + README 更新
    await pushToVault(h, 1, {
      'notes/new-doc.md': '---\ntitle: 新文档\n---\n\nGit 推送的新正文（可见性标记 8f3a）。\n',
      'README.md': '# 导航 v2（push 后刷新可见）\n',
    });

    // 刷新库根目录页：新目录 notes/ 出现，与 ls-tree 同集同序
    const root = await h.app.inject({ method: 'GET', url: '/vaults/alpha/browse', headers: h.session(1) });
    assert.equal(root.statusCode, 200, root.body);
    assert.deepEqual(pageEntrySeq(root.body), await lsTreeSeq(repoPath, 'main', ''), '目录条目与 git ls-tree 一致');
    assert.ok(root.body.includes('notes'), 'push 后新目录可见');
    assert.ok(root.body.includes('导航 v2'), 'README 更新即时反映（目录导航实时渲染）');

    // 子目录页 + 预览页：新文档正文可见
    const notes = await h.app.inject({ method: 'GET', url: '/vaults/alpha/browse/notes', headers: h.session(1) });
    assert.ok(notes.body.includes('new-doc.md'), '子目录页见新文件');
    const view = await h.app.inject({ method: 'GET', url: '/vaults/alpha/view/notes/new-doc.md', headers: h.session(1) });
    assert.equal(view.statusCode, 200, view.body);
    assert.ok(view.body.includes('Git 推送的新正文'), '预览页见 push 的新正文');
    assert.ok(view.body.includes('可见性标记 8f3a'), '正文内容一致（标记断言）');
  } finally {
    await h.close();
  }
});

test('双向可见 Web→Git：网页发布后 clone 抽样比对——内容全等', async () => {
  const { h, repoPath, alice } = await setup({
    'README.md': '# 导航\n',
    'docs/guide.md': '---\ntitle: 指南\n---\n\n指南正文 v1。\n',
  });
  const work = path.join(h.dataDir, 'clone-check');
  try {
    // 网页发布（编辑页「提交」的同一端点与载荷形态）：改既有 + 增新文档
    const head = (await gitOut(['--git-dir', repoPath, 'rev-parse', 'refs/heads/main'])).trim();
    const edited = '---\ntitle: 指南\n---\n\n指南正文 v2（网页发布标记 c71d）。\n';
    const added = '---\ntitle: 网页发布新文档\n---\n\n仅经网页发布（标记 e5b9）。\n';
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/vaults/alpha/submissions',
      headers: { 'content-type': 'application/json', origin: 'http://localhost', ...h.session(alice) },
      payload: {
        base_commit: head,
        message: 'Web 发布（双向可见）',
        changes: [
          { path: 'docs/guide.md', content: edited },
          { path: 'docs/published-via-web.md', content: added },
        ],
      },
    });
    assert.equal(res.statusCode, 201, res.body);

    // git clone 真实仓库（抽样比对基准）
    await gitOut(['clone', repoPath, work]);

    // 1. 文件集全等：clone 工作区文件 == 网页可见文件（目录页递归采样）
    const cloneFiles = (await gitOut(['-C', work, 'ls-files'])).split('\n').filter((x) => x !== '').sort();
    assert.deepEqual(cloneFiles, ['README.md', 'docs/guide.md', 'docs/published-via-web.md']);
    const root = await h.app.inject({ method: 'GET', url: '/vaults/alpha/browse', headers: h.session(1) });
    const docs = await h.app.inject({ method: 'GET', url: '/vaults/alpha/browse/docs', headers: h.session(1) });
    const webVisible = [
      ...pageEntrySeq(root.body).map((s) => s.split(' ').slice(1).join(' ')),
      ...pageEntrySeq(docs.body).map((s) => `docs/${s.split(' ').slice(1).join(' ')}`),
    ]
      .filter((name) => name !== 'docs') // 目录条目本身不是文件
      .sort();
    assert.deepEqual(webVisible, cloneFiles, '网页目录可见文件集 == clone 文件集');

    // 2. 内容全等（逐文件字节）：clone 文件 == 网页发布的精确内容
    assert.equal(await readFile(path.join(work, 'docs', 'guide.md'), 'utf8'), edited, 'guide.md 全等');
    assert.equal(await readFile(path.join(work, 'docs', 'published-via-web.md'), 'utf8'), added, '新文档全等');
    assert.equal(await readFile(path.join(work, 'README.md'), 'utf8'), '# 导航\n', '未变更文件不动');

    // 3. tree OID 全等（T7 等价断言形态）：clone HEAD tree == 服务端 HEAD tree
    const serverTree = (await gitOut(['--git-dir', repoPath, 'rev-parse', 'HEAD^{tree}'])).trim();
    const cloneTree = (await gitOut(['-C', work, 'rev-parse', 'HEAD^{tree}'])).trim();
    assert.equal(serverTree, cloneTree, 'tree OID 全等（内容等价锚点）');

    // 4. 网页看到 == clone 得到：预览页呈现发布正文
    const view = await h.app.inject({ method: 'GET', url: '/vaults/alpha/view/docs/guide.md', headers: h.session(1) });
    assert.ok(view.body.includes('网页发布标记 c71d'), '网页预览即发布后内容');
    const viewNew = await h.app.inject({
      method: 'GET',
      url: '/vaults/alpha/view/docs/published-via-web.md',
      headers: h.session(1),
    });
    assert.ok(viewNew.body.includes('仅经网页发布'), '新增文档网页即时可见');
  } finally {
    await rm(work, { recursive: true, force: true });
    await h.close();
  }
});
