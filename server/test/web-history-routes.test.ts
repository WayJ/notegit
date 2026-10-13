import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seededVault, addEmployee, addMember, repoPathOf, gitOut } from './web-browse-fixtures.ts';
import {
  browseHarness,
  pushHistorySeries,
  pageDiffLines,
  revCommitOid,
} from './web-history-fixtures.ts';

// S5-T1 历史族路由行为（api.md §13 S5-T1 行）：404 反存在性（D-IC-06——无权库
// 与不存在同页同码）、未认证 302、撤权下一请求 404、diff 文本转义（S4-T2 渲染
// 管不变量延伸——diff 内容里的 HTML 不构成标签）、畸形 OID/越界页码如实处理。
// git log/diff 一致性对照在 web-history-consistency.test.ts，此处不重复。

const SERIES = [
  { message: 'c1 建 a', files: { 'docs/a.md': 'a v1\n<script>alert(1)</script>\n' } },
  { message: 'c2 改 a 注入', files: { 'docs/a.md': 'a v2\n<img src=x onerror=alert(1)>\n[链接](javascript:alert(1))\n' } },
];

async function historyVault(slug = 'alpha') {
  const h = await browseHarness();
  const alice = addEmployee(h.db, { username: 'alice' });
  const bob = addEmployee(h.db, { username: 'bob' });
  await seededVault(h, slug, alice, { 'README.md': '# 导航\n' });
  await pushHistorySeries(h, 1, SERIES);
  addMember(h.db, 1, alice, 'reader', alice); // bob 非成员——404 反存在性对照
  return { h, alice, bob, headers: h.session(alice) };
}

test('404 反存在性：无权库与不存在库在 history/路径历史/diff 三路由同状态同体', async () => {
  const { h, bob } = await historyVault('secret');
  try {
    const repo = repoPathOf(h, 1);
    const oid = await revCommitOid(repo, 'refs/heads/main');
    const bobHeaders = h.session(bob);
    for (const [noAccess, nonexistent] of [
      ['/vaults/secret/history', '/vaults/ghost/history'],
      ['/vaults/secret/history/docs/a.md', '/vaults/ghost/history/docs/a.md'],
      [`/vaults/secret/diff/${oid}/docs/a.md`, `/vaults/ghost/diff/${oid}/docs/a.md`],
    ] as const) {
      const a = await h.app.inject({ method: 'GET', url: noAccess, headers: bobHeaders });
      const b = await h.app.inject({ method: 'GET', url: nonexistent, headers: bobHeaders });
      assert.equal(a.statusCode, 404, `${noAccess} 无权访问应 404`);
      assert.equal(b.statusCode, 404, `${nonexistent} 应 404`);
      assert.equal(a.body, b.body, `${noAccess} 与不存在库响应体必须一致（不泄露存在性，D-IC-06）`);
      assert.ok(a.body.includes('404'), '404 页呈现');
    }
  } finally {
    await h.close();
  }
});

test('撤权后历史页下一请求即 404（实时授权，identity §5.2）', async () => {
  const { h, alice, bob } = await historyVault();
  try {
    addMember(h.db, 1, bob, 'reader', alice);
    const bobHeaders = h.session(bob);
    const before = await h.app.inject({ method: 'GET', url: '/vaults/alpha/history', headers: bobHeaders });
    assert.equal(before.statusCode, 200);
    h.db.prepare('DELETE FROM vault_members WHERE vault_id = 1 AND employee_id = ?').run(bob);
    const after = await h.app.inject({ method: 'GET', url: '/vaults/alpha/history', headers: bobHeaders });
    assert.equal(after.statusCode, 404, '撤权下一请求即 404');
  } finally {
    await h.close();
  }
});

test('历史族：未认证一律 302 /login（不泄露任何库信息）', async () => {
  const { h } = await historyVault();
  try {
    const repo = repoPathOf(h, 1);
    const oid = await revCommitOid(repo, 'refs/heads/main');
    for (const p of ['/vaults/alpha/history', '/vaults/alpha/history/docs/a.md', `/vaults/alpha/diff/${oid}/docs/a.md`]) {
      const res = await h.app.inject({ method: 'GET', url: p });
      assert.equal(res.statusCode, 302, `${p} 未认证应 302`);
      assert.equal(res.headers.location, '/login');
    }
  } finally {
    await h.close();
  }
});

test('diff 文本转义：diff 内容中的 HTML/脚本载荷不构成标签（S4-T2 管不变量）', async () => {
  const { h, headers } = await historyVault();
  try {
    const repo = repoPathOf(h, 1);
    const c2 = await revCommitOid(repo, 'refs/heads/main'); // c2 注入载荷
    const res = await h.app.inject({ method: 'GET', url: `/vaults/alpha/diff/${c2}/docs/a.md`, headers });
    assert.equal(res.statusCode, 200, res.body);

    const rows = pageDiffLines(res.body);
    assert.ok(rows.some(([, text]) => text.includes('<script>alert(1)</script>')), '载荷内容如实呈现（对照面——还原转义后可见）');
    // 转义断言：diff 区（span 内文，转义形态）不含任何原始 '<'——标签形态不可达
    const rawSpanTexts = [...res.body.matchAll(/<span class="diff-line" data-kind="\w+">([^<]*)<\/span>/g)].map((m) => m[1]);
    assert.ok(rawSpanTexts.length > 0, 'diff 区存在已渲染行');
    assert.ok(rawSpanTexts.every((t) => !t.includes('<')), 'diff 区行内不得出现原始标签形态');
    assert.ok(res.body.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'script 载荷以转义形态呈现');
    assert.ok(res.body.includes('&lt;img src=x onerror=alert(1)&gt;'), 'img/事件属性载荷以转义形态呈现');
    // 全页脚本唯一：仅页面外壳的空 script（diff 渲染不注入脚本）
    assert.equal((res.body.match(/<script/g) ?? []).length, 1, '全页 <script> 仅外壳一处');
    // URL 协议载荷不以链接形态生成（diff 是纯文本呈现——无 href/src 指向 javascript:）
    assert.ok(!/href="javascript:/i.test(res.body) && !/src="javascript:/i.test(res.body));
  } finally {
    await h.close();
  }
});

test('历史页主体呈现：认证员工视角 + commit 作者仅元数据标注', async () => {
  const { h, headers, alice } = await historyVault();
  try {
    const res = await h.app.inject({ method: 'GET', url: '/vaults/alpha/history', headers });
    assert.equal(res.statusCode, 200, res.body);
    assert.ok(res.body.includes('alice'), '页面呈现当前认证员工视角');
    assert.ok(res.body.includes('Git 元数据'), 'commit 作者列标注为 Git 元数据');
    assert.ok(res.body.includes('认证'), '页面注明操作主体以认证/审计为准（DOD-03）');
    assert.ok(typeof alice === 'number');
  } finally {
    await h.close();
  }
});

test('畸形与未知 OID：非 hex/不存在提交/非提交对象一律 404', async () => {
  const { h, headers } = await historyVault();
  try {
    const repo = repoPathOf(h, 1);
    // blob OID 直取（不带 ^{commit} 剥离——非提交对象正是本用例）
    const blob = (await gitOut(['--git-dir', repo, 'rev-parse', '--verify', 'refs/heads/main:docs/a.md'])).trim();
    for (const bad of ['zzzz', 'deadbeef', blob, 'HEAD']) {
      const res = await h.app.inject({ method: 'GET', url: `/vaults/alpha/diff/${bad}/docs/a.md`, headers });
      assert.equal(res.statusCode, 404, `OID「${bad}」应 404`);
    }
  } finally {
    await h.close();
  }
});

test('空库历史页：200 空态呈现（成员已确认——非 404，如实区分无内容与无权）', async () => {
  const h = await browseHarness();
  try {
    const alice = addEmployee(h.db, { username: 'alice' });
    await seededVault(h, 'empty', alice); // 仅 init bare——默认分支 unborn
    addMember(h.db, 1, alice, 'reader', alice);
    const res = await h.app.inject({ method: 'GET', url: '/vaults/empty/history', headers: h.session(alice) });
    assert.equal(res.statusCode, 200, res.body);
    assert.ok(res.body.includes('尚无提交'), '空库如实标注尚无提交');
    const pathRes = await h.app.inject({ method: 'GET', url: '/vaults/empty/history/docs/a.md', headers: h.session(alice) });
    assert.equal(pathRes.statusCode, 200, pathRes.body);
    assert.ok(pathRes.body.includes('尚无提交'), '空库路径历史同空态');
  } finally {
    await h.close();
  }
});

test('无记录路径与越界页码：200 空态呈现（路径可能从未存在——不冒充 404 也不泄露）', async () => {
  const { h, headers } = await historyVault();
  try {
    const never = await h.app.inject({ method: 'GET', url: '/vaults/alpha/history/nope/never.md', headers });
    assert.equal(never.statusCode, 200, never.body);
    assert.ok(never.body.includes('没有提交记录'), '从未存在的路径如实空态');

    const beyond = await h.app.inject({ method: 'GET', url: '/vaults/alpha/history?page=99', headers });
    assert.equal(beyond.statusCode, 200, beyond.body);
    assert.ok(!beyond.body.includes('rel="next"'), '越界页码不再有下一页');

    const badPage = await h.app.inject({ method: 'GET', url: '/vaults/alpha/history?page=abc', headers });
    assert.equal(badPage.statusCode, 200, badPage.body);
    assert.ok(!badPage.body.includes('rel="prev"'), '非法页码归一为第一页');
  } finally {
    await h.close();
  }
});

test('该提交未修改该路径：diff 空态如实呈现（200，非 404）', async () => {
  const { h, headers } = await historyVault();
  try {
    const repo = repoPathOf(h, 1);
    const c2 = await revCommitOid(repo, 'refs/heads/main'); // c2 只触 docs/a.md
    const res = await h.app.inject({ method: 'GET', url: `/vaults/alpha/diff/${c2}/README.md`, headers });
    assert.equal(res.statusCode, 200, res.body);
    assert.ok(res.body.includes('未修改'), '未触及路径如实标注空 diff');
    assert.equal(pageDiffLines(res.body).length, 0, '无 diff 行');
  } finally {
    await h.close();
  }
});
