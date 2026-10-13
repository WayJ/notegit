import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seededVault, addEmployee, addMember, repoPathOf } from './web-browse-fixtures.ts';
import {
  browseHarness,
  pushHistorySeries,
  gitLogSeq,
  gitDiffOut,
  emptyTreeOid,
  revCommitOid,
  pageCommitSeq,
  pageDiffLines,
  unescapeHtml,
} from './web-history-fixtures.ts';

// S5-T1 一致性比对（breakdown §2.4 S5-T1 完成标准「历史列表与 git log 一致、
// diff 与 git diff 一致（脚本比对）」；sprint S5 场景 S1）。对照面 = 测试另行
// 直通 spawn 的 git log / git diff（web-history-fixtures，不经生产读面）。
// 页面提取走 data 属性 + 转义逆映射，与 S4-T1 lsTreeSeq/pageEntrySeq 同法。

/** 历史页每页条数（与实现 HISTORY_PAGE_SIZE 同值——分页窗口对照所依） */
const PAGE_SIZE = 20;

/** 多文件、多提交序列：a.md 经历创建/两次修改，b.md 创建后被删（历史含删除） */
const SERIES = [
  { message: 'c1 建 a', files: { 'docs/a.md': 'a v1\n' } },
  { message: 'c2 改 a', files: { 'docs/a.md': 'a v2\n第一行\n' } },
  { message: 'c3 建 b', files: { 'docs/b.md': 'b v1\n' } },
  { message: 'c4 再改 a', files: { 'docs/a.md': 'a v3\n第一行\n第二行\n' }, author: { name: 'zhang', email: 'zhang@corp.example' } },
  { message: 'c5 删 b', files: { 'docs/b.md': undefined } },
];

async function seededHistoryVault(slug = 'alpha') {
  const h = await browseHarness();
  const alice = addEmployee(h.db, { username: 'alice' });
  await seededVault(h, slug, alice, { 'README.md': '# 导航\n' }); // 基线 seed 提交
  await pushHistorySeries(h, 1, SERIES);
  addMember(h.db, 1, alice, 'reader', alice);
  return { h, alice, headers: h.session(alice) };
}

/** git diff 原文行序列（去尾空行——对照基线） */
function diffRawLines(out: string): string[] {
  const lines = out.split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

test('库级历史页与 git log 一致（序/短OID/作者/日期/主题，默认分支第一页）', async () => {
  const { h, headers } = await seededHistoryVault();
  try {
    const res = await h.app.inject({ method: 'GET', url: '/vaults/alpha/history', headers });
    assert.equal(res.statusCode, 200, res.body);
    assert.match(res.headers['content-type'] as string, /^text\/html/);

    const page = pageCommitSeq(res.body).map(([oid, author, date, subject]) => [oid, unescapeHtml(author), date, unescapeHtml(subject)]);
    const raw = await gitLogSeq(repoPathOf(h, 1), { limit: PAGE_SIZE });
    assert.deepEqual(page, raw, '页面提交行序列须与 git log 同序同值');
  } finally {
    await h.close();
  }
});

test('路径级历史页与 git log -- 路径 一致（含创建后才有记录与删除提交）', async () => {
  const { h, headers } = await seededHistoryVault();
  try {
    // a.md：c1 建 → c2 改 → c4 再改（c3/c5 不触）
    const aRes = await h.app.inject({ method: 'GET', url: '/vaults/alpha/history/docs/a.md', headers });
    assert.equal(aRes.statusCode, 200, aRes.body);
    const aPage = pageCommitSeq(aRes.body).map((r) => [r[0], unescapeHtml(r[3])]);
    const aRaw = (await gitLogSeq(repoPathOf(h, 1), { path: 'docs/a.md' })).map((r) => [r[0], r[3]]);
    assert.deepEqual(aPage, aRaw, 'a.md 历史须与 git log -- docs/a.md 一致');
    assert.ok(aRaw.length >= 3, 'a.md 至少三笔（建/改/再改）');

    // b.md：c3 建 → c5 删（删除提交在路径历史可见——S4-T5「删除后历史可查」）
    const bRes = await h.app.inject({ method: 'GET', url: '/vaults/alpha/history/docs/b.md', headers });
    assert.equal(bRes.statusCode, 200, bRes.body);
    const bPage = pageCommitSeq(bRes.body).map((r) => [r[0], unescapeHtml(r[3])]);
    const bRaw = (await gitLogSeq(repoPathOf(h, 1), { path: 'docs/b.md' })).map((r) => [r[0], r[3]]);
    assert.deepEqual(bPage, bRaw, 'b.md 历史须与 git log -- docs/b.md 一致');
  } finally {
    await h.close();
  }
});

test('分页：页窗口与 git log --skip 一致，跨页导航链接正确', async () => {
  const h = await browseHarness();
  try {
    const alice = addEmployee(h.db, { username: 'alice' });
    await seededVault(h, 'alpha', alice, { 'README.md': '# 导航\n' });
    // 基线 1 笔 + 系列 22 笔 = 23 笔：页一 20 笔（有下一页）、页二 3 笔（到尾）
    await pushHistorySeries(
      h,
      1,
      Array.from({ length: 22 }, (_, i) => ({ message: `p${String(i + 1).padStart(2, '0')}`, files: { 'docs/a.md': `v${i}\n` } })),
    );
    addMember(h.db, 1, alice, 'reader', alice);
    const headers = h.session(alice);
    const repo = repoPathOf(h, 1);

    const p1 = await h.app.inject({ method: 'GET', url: '/vaults/alpha/history', headers });
    assert.equal(p1.statusCode, 200, p1.body);
    assert.deepEqual(
      pageCommitSeq(p1.body).map((r) => [r[0], unescapeHtml(r[3])]),
      (await gitLogSeq(repo, { skip: 0, limit: PAGE_SIZE })).map((r) => [r[0], r[3]]),
      '页一窗口 = git log -n 20 --skip 0',
    );
    assert.ok(p1.body.includes('rel="next"'), '页一应含下一页链接');
    assert.ok(!p1.body.includes('rel="prev"'), '页一不应含上一页链接');
    assert.ok(p1.body.includes('href="/vaults/alpha/history?page=2"'), '下一页指向 ?page=2');

    const p2 = await h.app.inject({ method: 'GET', url: '/vaults/alpha/history?page=2', headers });
    assert.equal(p2.statusCode, 200, p2.body);
    assert.deepEqual(
      pageCommitSeq(p2.body).map((r) => [r[0], unescapeHtml(r[3])]),
      (await gitLogSeq(repo, { skip: PAGE_SIZE, limit: PAGE_SIZE })).map((r) => [r[0], r[3]]),
      '页二窗口 = git log -n 20 --skip 20',
    );
    assert.ok(p2.body.includes('rel="prev"'), '页二应含上一页链接');
    assert.ok(p2.body.includes('href="/vaults/alpha/history?page=1"'), '上一页指向 ?page=1');
    assert.ok(!p2.body.includes('rel="next"'), '页二为末页，不再有下一页');
  } finally {
    await h.close();
  }
});

test('逐文件 diff 与 git diff 一致（父提交↔目标，修改场景）', async () => {
  const { h, headers } = await seededHistoryVault();
  try {
    const repo = repoPathOf(h, 1);
    const tip = await revCommitOid(repo, 'refs/heads/main'); // c5（未触 a.md——改用 c4）
    const c4 = await revCommitOid(repo, 'refs/heads/main~1'); // c4 再改 a
    const c3 = await revCommitOid(repo, 'refs/heads/main~2'); // c4 的父
    assert.match(tip, /^[0-9a-f]{40}$/);

    const res = await h.app.inject({ method: 'GET', url: `/vaults/alpha/diff/${c4}/docs/a.md`, headers });
    assert.equal(res.statusCode, 200, res.body);
    const lines = pageDiffLines(res.body).map(([, text]) => text);
    assert.deepEqual(lines, diffRawLines(await gitDiffOut(repo, c3, c4, 'docs/a.md')), 'diff 页行序列须与 git diff 原文一致');
    // 行类标注（add/del/meta）与原文前缀相符
    const rows = pageDiffLines(res.body);
    assert.ok(rows.some(([k]) => k === 'add'), '含新增行标注');
    assert.ok(rows.some(([k]) => k === 'del'), '含删除行标注');
    assert.deepEqual(rows[0], ['meta', 'diff --git a/docs/a.md b/docs/a.md'], '首行为 diff --git 元信息');
  } finally {
    await h.close();
  }
});

test('根提交 diff 与 git diff 空树↔提交 一致（文件创建场景）', async () => {
  const { h, headers } = await seededHistoryVault();
  try {
    const repo = repoPathOf(h, 1);
    const c1 = await revCommitOid(repo, 'refs/heads/main~4'); // 系列 c1（其父 = 基线 seed）
    const empty = await emptyTreeOid(repo);
    // README 的创建在基线 seed（根提交）——用基线提交对照空树
    const root = await revCommitOid(repo, `${c1}^`);
    const res = await h.app.inject({ method: 'GET', url: `/vaults/alpha/diff/${root}/README.md`, headers });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(
      pageDiffLines(res.body).map(([, text]) => text),
      diffRawLines(await gitDiffOut(repo, empty, root, 'README.md')),
      '根提交 diff = git diff <空树> <根提交>',
    );
  } finally {
    await h.close();
  }
});

test('删除文件的 diff 与 git diff 一致（父↔删除提交，全删呈现）', async () => {
  const { h, headers } = await seededHistoryVault();
  try {
    const repo = repoPathOf(h, 1);
    const c5 = await revCommitOid(repo, 'refs/heads/main'); // c5 删 b
    const c4 = await revCommitOid(repo, 'refs/heads/main~1');
    const res = await h.app.inject({ method: 'GET', url: `/vaults/alpha/diff/${c5}/docs/b.md`, headers });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(
      pageDiffLines(res.body).map(([, text]) => text),
      diffRawLines(await gitDiffOut(repo, c4, c5, 'docs/b.md')),
      '删除 diff 须与 git diff 一致',
    );
  } finally {
    await h.close();
  }
});
