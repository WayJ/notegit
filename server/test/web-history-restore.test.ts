import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seededVault, addEmployee, addMember, repoPathOf, gitOut } from './web-browse-fixtures.ts';
import { browseHarness, pushHistorySeries, revCommitOid } from './web-history-fixtures.ts';

// S5-T2 历史版本预览与还原（api.md §13 S5-T2 行；breakdown §2.4 S5-T2 行）：
// - 还原 = 以新提交恢复内容（不删历史；走 S3-T7 发布组件——base commit=当前
//   tip 的 CAS 语义复用 S4-T7 机制）；
// - 完成标准三条：还原后旧版本仍在历史可查；还原产生新提交且审计 old→new
//   成链（vault.web_submit）；还原内容 diff 正确；
// - 预览复用 S4 view 渲染（commit 参数化；S4-T2 安全管不变量）；
// - 404 反存在性（D-IC-06）与未认证 302 同历史族；写权限由发布组件判定。
// 一致性对照原则同 S5-T1：另行直通 spawn git 取期望，绝不经生产读面。

const FM = 'title: A\nowner: alice\ndescription: 摘要\nsource: web\n';
const DOC_V1 = `---\n${FM}---\n\na v1\n`;
const DOC_V2 = `---\n${FM}---\n\na v2\n<img src=x onerror=alert(1)>\n[链接](javascript:alert(1))\n`;
const DOC_V3 = `---\n${FM}---\n\na v3\n`;
const GONE_V1 = `---\ntitle: G\nowner: alice\ndescription: 摘要\nsource: web\n---\n\ngone v1\n`;

/** 三笔种子：c1 建 a/gone；c2 改 a（含注入载荷）+ 删 gone；c3 再改 a + 加 png 附件 */
const SERIES = [
  { message: 'c1 建文档', files: { 'docs/a.md': DOC_V1, 'docs/gone.md': GONE_V1 } },
  { message: 'c2 改a删gone', files: { 'docs/a.md': DOC_V2, 'docs/gone.md': undefined } },
  { message: 'c3 再改a加附件', files: { 'docs/a.md': DOC_V3, 'img/pic.png': 'PNGDATA' } },
];

interface RestoreFixture {
  h: Awaited<ReturnType<typeof browseHarness>>;
  alice: number; // editor（还原者）
  bob: number; // reader
  carol: number; // 局外人（非成员——反存在性对照）
  headers: Record<string, string>;
}

async function restoreVault(slug = 'alpha'): Promise<RestoreFixture> {
  const h = await browseHarness();
  const alice = addEmployee(h.db, { username: 'alice' });
  const bob = addEmployee(h.db, { username: 'bob' });
  const carol = addEmployee(h.db, { username: 'carol' });
  await seededVault(h, slug, alice, { 'README.md': '# 导航\n' });
  await pushHistorySeries(h, 1, SERIES);
  addMember(h.db, 1, alice, 'editor', alice);
  addMember(h.db, 1, bob, 'reader', alice);
  return { h, alice, bob, carol, headers: h.session(alice) };
}

/** POST 还原（会话载体 + CSRF 同源头） */
function postRestore(h: RestoreFixture['h'], url: string, who?: number, extra: Record<string, string> = {}) {
  const headers = { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://localhost', ...extra };
  return h.app.inject({
    method: 'POST',
    url,
    headers,
    ...(who === undefined ? {} : { headers: { ...headers, ...h.session(who) } }),
    payload: '',
  });
}

/** 最后一条 vault.web_submit 审计行 */
function lastWebSubmit(db: RestoreFixture['h']['db']): Record<string, unknown> {
  const rows = db
    .prepare(`SELECT * FROM audit_events WHERE event_kind = 'vault.web_submit' ORDER BY id`)
    .all() as unknown as Record<string, unknown>[];
  assert.ok(rows.length >= 1, '存在 vault.web_submit 审计行');
  return rows.at(-1)!;
}

// ── 完成标准三条：新提交恢复 · 旧版本可查 · 审计成链 · diff 正确 ─────────────

test('还原主路径：以 tip 为父的新提交恢复内容；审计 old→new 成链；diff 与目标版本一致；旧版本仍可查', async () => {
  const { h, alice, headers } = await restoreVault();
  try {
    const repo = repoPathOf(h, 1);
    const tip = await revCommitOid(repo, 'refs/heads/main'); // c3
    const c1 = await revCommitOid(repo, 'refs/heads/main~2'); // a v1 版本

    const res = await postRestore(h, `/vaults/alpha/restore/${c1}/docs/a.md`, alice);
    assert.equal(res.statusCode, 302, res.body);
    assert.equal(res.headers.location, '/vaults/alpha/view/docs/a.md', '成功后回到当前预览页（呈现还原后内容）');

    // 新提交：ref 前进、父 = 原 tip（以新提交还原——不改写历史）
    const newTip = await revCommitOid(repo, 'refs/heads/main');
    assert.notEqual(newTip, tip);
    assert.equal(await revCommitOid(repo, `${newTip}^`), tip, '还原提交以还原时 tip 为父');

    // 审计 old→new 成链（vault.web_submit；主体=认证员工、入口=web）
    const row = lastWebSubmit(h.db);
    assert.equal(row['status'], 'succeeded');
    assert.equal(row['old_commit'], tip, 'old = 还原时 tip');
    assert.equal(row['new_commit'], newTip, 'new = 还原提交（与 ref 实际值一致——链尾核对）');
    assert.equal(row['employee_id'], alice, '主体=认证员工（不信 commit author）');
    assert.equal(row['entry'], 'web');
    assert.equal(row['ref_name'], 'refs/heads/main');

    // diff 正确：新 tip 该路径内容逐字 == 目标版本；↔目标版本 diff 为空
    assert.equal(await gitOut(['--git-dir', repo, 'show', `${newTip}:docs/a.md`]), DOC_V1);
    assert.equal(await gitOut(['--git-dir', repo, 'diff', '--no-color', newTip, c1, '--', 'docs/a.md']), '');

    // 旧版本仍在历史可查：历史页仍列全部旧提交（不删历史），c1 预览仍可达
    const after = await h.app.inject({ method: 'GET', url: '/vaults/alpha/history/docs/a.md', headers });
    assert.equal(after.statusCode, 200);
    assert.ok(after.body.includes('c1 建文档'), 'c1 仍在路径历史');
    assert.ok(after.body.includes('c2 改a删gone'), 'c2 仍在路径历史');
    assert.ok(after.body.includes('还原'), '还原提交出现在历史');
    const prev = await h.app.inject({ method: 'GET', url: `/vaults/alpha/version/${c1}/docs/a.md`, headers });
    assert.equal(prev.statusCode, 200, '还原后旧版本预览仍可查');
  } finally {
    await h.close();
  }
});

test('还原已删除文件：以新提交重建该路径，内容与目标版本一致（删除保留历史 → 可还原）', async () => {
  const { h, alice } = await restoreVault();
  try {
    const repo = repoPathOf(h, 1);
    const c1 = await revCommitOid(repo, 'refs/heads/main~2'); // gone 存在的最后版本
    const gone = await h.app.inject({ method: 'GET', url: '/vaults/alpha/view/docs/gone.md', headers: h.session(alice) });
    assert.equal(gone.statusCode, 404, '前置：tip 上该文件已被删除');

    const res = await postRestore(h, `/vaults/alpha/restore/${c1}/docs/gone.md`, alice);
    assert.equal(res.statusCode, 302, res.body);

    const newTip = await revCommitOid(repo, 'refs/heads/main');
    assert.equal(await gitOut(['--git-dir', repo, 'show', `${newTip}:docs/gone.md`]), GONE_V1);
    assert.equal(await gitOut(['--git-dir', repo, 'diff', '--no-color', newTip, c1, '--', 'docs/gone.md']), '');
    // 删除提交与创建提交都仍在该路径历史（历史未删）
    const hist = await h.app.inject({ method: 'GET', url: '/vaults/alpha/history/docs/gone.md', headers: h.session(alice) });
    assert.equal(hist.statusCode, 200);
    assert.ok(hist.body.includes('c1 建文档') && hist.body.includes('c2 改a删gone'));
  } finally {
    await h.close();
  }
});

// ── 历史版本只读预览（复用 S4 view 渲染，commit 参数化）──────────────────────

test('版本预览参数化：同一文件按 commit 呈现对应版本正文；frontmatter 不入正文；页面标注历史版本与还原入口', async () => {
  const { h, headers } = await restoreVault();
  try {
    const repo = repoPathOf(h, 1);
    const c1 = await revCommitOid(repo, 'refs/heads/main~2');
    const tip = await revCommitOid(repo, 'refs/heads/main');

    const v1 = await h.app.inject({ method: 'GET', url: `/vaults/alpha/version/${c1}/docs/a.md`, headers });
    assert.equal(v1.statusCode, 200, v1.body);
    assert.ok(v1.body.includes('a v1'), '呈现 c1 版本正文');
    assert.ok(!v1.body.includes('a v3'), '不呈现 tip 版本正文');
    assert.ok(!v1.body.includes('owner: alice'), 'frontmatter 不入正文（S4 view 同判）');
    assert.ok(v1.body.includes('历史版本'), '页面标注历史版本');
    assert.ok(v1.body.includes(c1), '页面标注所依 commit OID');
    assert.ok(v1.body.includes(`href="/vaults/alpha/restore/${c1}/docs/a.md"`), '预览页含还原入口');

    const v3 = await h.app.inject({ method: 'GET', url: `/vaults/alpha/version/${tip}/docs/a.md`, headers });
    assert.equal(v3.statusCode, 200, v3.body);
    assert.ok(v3.body.includes('a v3') && !v3.body.includes('a v1'), 'tip 版本预览呈现 tip 正文');
  } finally {
    await h.close();
  }
});

test('版本预览安全（S4-T2 管复用）：载荷不构成标签、事件属性不残留、协议白名单拒 javascript:', async () => {
  const { h, headers } = await restoreVault();
  try {
    const repo = repoPathOf(h, 1);
    const c2 = await revCommitOid(repo, 'refs/heads/main~1'); // 载荷版本
    const res = await h.app.inject({ method: 'GET', url: `/vaults/alpha/version/${c2}/docs/a.md`, headers });
    assert.equal(res.statusCode, 200, res.body);
    const article = res.body.slice(res.body.indexOf('<article'), res.body.indexOf('</article>'));
    assert.ok(article.length > 0, '正文区存在');
    assert.ok(!/<img src=x/i.test(article), '原始 HTML img 不进入输出');
    assert.ok(!/onerror/i.test(article), '事件属性文本不残留');
    assert.ok(!/href="javascript:/i.test(res.body) && !/src="javascript:/i.test(res.body), 'javascript: 协议不可达');
    assert.ok(res.body.includes('a v2'), '正文内容如实呈现');
  } finally {
    await h.close();
  }
});

test('版本预览非 Markdown：图片附件经鉴权附件通道内嵌（blob 寻址——历史 blob 仍在库内）', async () => {
  const { h, headers } = await restoreVault();
  try {
    const repo = repoPathOf(h, 1);
    const c3 = await revCommitOid(repo, 'refs/heads/main');
    const res = await h.app.inject({ method: 'GET', url: `/vaults/alpha/version/${c3}/img/pic.png`, headers });
    assert.equal(res.statusCode, 200, res.body);
    assert.ok(res.body.includes('历史版本'), '同页标注历史版本');
    assert.ok(/<img src="\/vaults\/alpha\/attach\/[0-9a-f]{40,64}\/pic\.png"/.test(res.body), '经附件通道 URL 内嵌');
  } finally {
    await h.close();
  }
});

// ── 反存在性 / 认证 / CSRF / 写权限 ─────────────────────────────────────────

test('反存在性与未知寻址：无权库与不存在库同页同码；未知/非提交 OID、该版本缺失路径一律 404', async () => {
  const { h, headers, carol } = await restoreVault('secret');
  try {
    const repo = repoPathOf(h, 1);
    const c1 = await revCommitOid(repo, 'refs/heads/main~2');
    const carolHeaders = h.session(carol);
    const paths = (oid: string, p: string) => [
      [`/vaults/secret/version/${oid}/${p}`, `/vaults/ghost/version/${oid}/${p}`],
      [`/vaults/secret/restore/${oid}/${p}`, `/vaults/ghost/restore/${oid}/${p}`],
    ] as const;
    for (const [noAccess, nonexistent] of paths(c1, 'docs/a.md')) {
      const a = await h.app.inject({ method: 'GET', url: noAccess, headers: carolHeaders });
      const b = await h.app.inject({ method: 'GET', url: nonexistent, headers: carolHeaders });
      assert.equal(a.statusCode, 404, `${noAccess} 无权应 404`);
      assert.equal(b.statusCode, 404);
      assert.equal(a.body, b.body, '无权与不存在同页同体（D-IC-06）');
    }
    // POST 还原同样反存在性
    const pa = await postRestore(h, `/vaults/secret/restore/${c1}/docs/a.md`, carol);
    const pb = await postRestore(h, `/vaults/ghost/restore/${c1}/docs/a.md`, carol);
    assert.equal(pa.statusCode, 404);
    assert.equal(pb.statusCode, 404);
    assert.equal(pa.body, pb.body, 'POST 无权与不存在同页同体');

    // 成员访问下：未知 OID / 非提交对象 / rev 形态 / 该版本缺失路径 → 404
    const blob = (await gitOut(['--git-dir', repo, 'rev-parse', 'refs/heads/main:docs/a.md'])).trim();
    for (const bad of ['deadbeef', blob, 'HEAD']) {
      const v = await h.app.inject({ method: 'GET', url: `/vaults/secret/version/${bad}/docs/a.md`, headers });
      assert.equal(v.statusCode, 404, `OID「${bad}」预览应 404`);
      const r = await h.app.inject({ method: 'GET', url: `/vaults/secret/restore/${bad}/docs/a.md`, headers });
      assert.equal(r.statusCode, 404, `OID「${bad}」还原页应 404`);
    }
    const later = await h.app.inject({ method: 'GET', url: `/vaults/secret/version/${c1}/img/pic.png`, headers });
    assert.equal(later.statusCode, 404, 'c1 尚不存在的路径（c3 才创建）→ 404');
  } finally {
    await h.close();
  }
});

test('未认证：版本预览与还原页一律 302 /login（不泄露库信息）', async () => {
  const { h } = await restoreVault();
  try {
    const repo = repoPathOf(h, 1);
    const c1 = await revCommitOid(repo, 'refs/heads/main~2');
    for (const p of [`/vaults/alpha/version/${c1}/docs/a.md`, `/vaults/alpha/restore/${c1}/docs/a.md`]) {
      const res = await h.app.inject({ method: 'GET', url: p });
      assert.equal(res.statusCode, 302, `${p} 未认证应 302`);
      assert.equal(res.headers.location, '/login');
    }
  } finally {
    await h.close();
  }
});

test('会话 POST 受 CSRF 同源校验：缺 Origin → 403，ref 不动', async () => {
  const { h, alice } = await restoreVault();
  try {
    const repo = repoPathOf(h, 1);
    const before = await revCommitOid(repo, 'refs/heads/main');
    const c1 = await revCommitOid(repo, 'refs/heads/main~2');
    const res = await h.app.inject({
      method: 'POST',
      url: `/vaults/alpha/restore/${c1}/docs/a.md`,
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...h.session(alice) },
      payload: '',
    });
    assert.equal(res.statusCode, 403, '缺 Origin 的会话 POST 被 CSRF 拒');
    assert.equal(await revCommitOid(repo, 'refs/heads/main'), before, 'ref 不动');
  } finally {
    await h.close();
  }
});

test('只读成员可预览可看确认页，但不可还原：组件拒绝 403 同页提示、ref 不动、审计记 rejected', async () => {
  const { h, bob, headers } = await restoreVault();
  try {
    const repo = repoPathOf(h, 1);
    const c1 = await revCommitOid(repo, 'refs/heads/main~2');
    const bobHeaders = h.session(bob);
    const page = await h.app.inject({ method: 'GET', url: `/vaults/alpha/restore/${c1}/docs/a.md`, headers: bobHeaders });
    assert.equal(page.statusCode, 200, '确认页门槛=read 成员（写权限由发布组件判定）');
    const prev = await h.app.inject({ method: 'GET', url: `/vaults/alpha/version/${c1}/docs/a.md`, headers: bobHeaders });
    assert.equal(prev.statusCode, 200, '版本预览门槛=read 成员');

    const before = await revCommitOid(repo, 'refs/heads/main');
    const res = await postRestore(h, `/vaults/alpha/restore/${c1}/docs/a.md`, bob);
    assert.equal(res.statusCode, 403, '只读成员还原被拒（组件 branch-rules）');
    assert.equal(await revCommitOid(repo, 'refs/heads/main'), before, 'ref 不动');
    const row = lastWebSubmit(h.db);
    assert.equal(row['status'], 'rejected', '拒绝如实入审计');
    assert.ok(res.body.includes('403') || res.body.includes('还原'), '同页呈现拒绝提示');
  } finally {
    await h.close();
  }
});

// ── 页面入口（历史页「还原到此版本」按钮最小可用）────────────────────────────

test('路径级历史页每行附预览与还原入口；库级历史页不出现还原入口（还原=路径域操作）', async () => {
  const { h, headers } = await restoreVault();
  try {
    const repo = repoPathOf(h, 1);
    const c1 = await revCommitOid(repo, 'refs/heads/main~2');
    const pathHist = await h.app.inject({ method: 'GET', url: '/vaults/alpha/history/docs/a.md', headers });
    assert.equal(pathHist.statusCode, 200);
    assert.ok(
      pathHist.body.includes(`href="/vaults/alpha/version/${c1}/docs/a.md"`),
      '历史行附版本预览链接',
    );
    assert.ok(
      pathHist.body.includes(`href="/vaults/alpha/restore/${c1}/docs/a.md"`),
      '历史行附「还原到此版本」入口',
    );
    assert.ok(pathHist.body.includes('还原到此版本'), '入口文案可见');

    const libHist = await h.app.inject({ method: 'GET', url: '/vaults/alpha/history', headers });
    assert.equal(libHist.statusCode, 200);
    assert.ok(!libHist.body.includes('还原到此版本'), '库级历史页不提供还原入口（无路径上下文）');
  } finally {
    await h.close();
  }
});

test('还原确认页：呈现目标路径与版本、新提交语义标注（不删历史）、POST 表单与取消入口', async () => {
  const { h, headers } = await restoreVault();
  try {
    const repo = repoPathOf(h, 1);
    const c1 = await revCommitOid(repo, 'refs/heads/main~2');
    const res = await h.app.inject({ method: 'GET', url: `/vaults/alpha/restore/${c1}/docs/a.md`, headers });
    assert.equal(res.statusCode, 200, res.body);
    assert.ok(res.body.includes('docs/a.md'), '呈现目标路径');
    assert.ok(res.body.includes(c1), '呈现目标版本 commit');
    assert.ok(res.body.includes('新提交'), '标注以新提交还原');
    assert.ok(res.body.includes('不删除历史') || res.body.includes('历史保留'), '标注不删历史');
    assert.ok(
      res.body.includes(`<form method="post" action="/vaults/alpha/restore/${c1}/docs/a.md"`),
      '确认表单 POST 到还原端点',
    );
    assert.ok(res.body.includes('还原到此版本'), '表单按钮文案');
  } finally {
    await h.close();
  }
});
