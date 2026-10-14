import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seededVault, addEmployee, addMember, repoPathOf, type BrowseHarness } from './web-browse-fixtures.ts';
import { browseHarness, pushHistorySeries, revCommitOid } from './web-history-fixtures.ts';

// S10-T1 编辑入口·version 页（e2-gui research F-1 / P0-1；sprint S10 D2/D17）：
// - 历史版本预览页提供编辑入口；edit 路由编辑的始终是该文件当前分支内容（HEAD），
//   页面如实标注「编辑当前版本、非此历史版本」——不虚构「编辑此历史快照」；
// - 呈现经 canWriteVault：editor 渲染链接；reader 不渲染、只读徽章。
//   仅 .md 渲染形态提供（edit 表单仅知识 Markdown——非 .md 不产生 404 链接）。

const FM = 'title: A\nowner: alice\ndescription: 摘要\nsource: web\n';
const DOC_V1 = `---\n${FM}---\n\na v1\n`;
const DOC_V2 = `---\n${FM}---\n\na v2\n`;

/** 两笔种子：c1 建 a（历史版本）；c2 改 a（当前 HEAD）——版本页样本面 */
const SERIES = [
  { message: 'c1 建文档', files: { 'docs/a.md': DOC_V1 } },
  { message: 'c2 改a', files: { 'docs/a.md': DOC_V2 } },
];

interface VersionFixture {
  h: BrowseHarness;
  alice: number; // editor
  bob: number; // reader
  c1: string; // docs/a.md v1 提交全 OID
}

async function versionVault(): Promise<VersionFixture> {
  const h = await browseHarness();
  const alice = addEmployee(h.db, { username: 'alice' });
  const bob = addEmployee(h.db, { username: 'bob' });
  await seededVault(h, 'alpha', alice, { 'README.md': '# 导航\n' });
  await pushHistorySeries(h, 1, SERIES);
  addMember(h.db, 1, alice, 'editor', alice);
  addMember(h.db, 1, bob, 'reader', alice);
  const c1 = await revCommitOid(repoPathOf(h, 1), 'refs/heads/main~1'); // seed 之上第一笔（a v1）
  return { h, alice, bob, c1 };
}

test('version 页编辑入口：editor 见「编辑当前版本」且如实标注编辑对象=当前内容非此历史版本', async () => {
  const { h, alice, c1 } = await versionVault();
  try {
    const headers = h.session(alice);
    const res = await h.app.inject({ method: 'GET', url: `/vaults/alpha/version/${c1}/docs/a.md`, headers });
    assert.equal(res.statusCode, 200, res.body);
    assert.ok(res.body.includes('a v1'), '历史版本内容（commit 参数化——sanity）');

    // 编辑入口指向既有 edit 路由；标注如实：编辑打开的是当前分支内容，非此历史快照
    assert.ok(res.body.includes('href="/vaults/alpha/edit/docs/a.md"'), '编辑入口（既有 edit 路由）');
    assert.ok(res.body.includes('>编辑当前版本</a>'), '入口文案（明示编辑对象=当前版本）');
    assert.ok(res.body.includes('非此历史版本'), '如实标注（edit 编辑当前 HEAD——不虚构编辑历史快照）');

    // 链接真实可达
    const edit = await h.app.inject({ method: 'GET', url: '/vaults/alpha/edit/docs/a.md', headers });
    assert.equal(edit.statusCode, 200, edit.body);
  } finally {
    await h.close();
  }
});

test('version 页编辑入口：reader 不渲染编辑链接，呈现只读徽章', async () => {
  const { h, bob, c1 } = await versionVault();
  try {
    const res = await h.app.inject({
      method: 'GET', url: `/vaults/alpha/version/${c1}/docs/a.md`, headers: h.session(bob),
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.ok(res.body.includes('a v1'), '历史版本内容（reader=read 成员，门槛不变）');
    assert.ok(!res.body.includes('/vaults/alpha/edit/'), 'reader 不渲染编辑入口（canWriteVault 不放行）');
    assert.ok(res.body.includes('<span class="badge">只读</span>'), '只读徽章如实标注');
  } finally {
    await h.close();
  }
});
