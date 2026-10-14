import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seededVault, addEmployee, addMember, type BrowseHarness } from './web-browse-fixtures.ts';
import { browseHarness, pushHistorySeries } from './web-history-fixtures.ts';

// S10-T1 历史页链接健康（e2-gui research F-4 / P0-5；sprint S10 D3）：
// - 库级历史行不得再以空 treePath 生成必然 404 的 diff 死链——改为「该提交涉及
//   文件」的逐文件 diff 入口（复用既有 /vaults/{slug}/diff/{oid}/{path} 页面族，
//   不新增端点）；
// - 历史页（库级 + 路径级）渲染出的全部 <a href> 逐一请求后 200/302，零 404
//   （DOD-E2-04 页面侧锁定；对照原则：直连 app.inject 逐 href 复放，不经生产读面）。

const FM = 'title: A\nowner: alice\ndescription: 摘要\nsource: web\n';
const DOC_V1 = `---\n${FM}---\n\na v1\n`;
const DOC_V2 = `---\n${FM}---\n\na v2\n`;
const DOC_V3 = `---\n${FM}---\n\na v3\n`;
const GONE_V1 = `---\ntitle: G\nowner: alice\ndescription: 摘要\nsource: web\n---\n\ngone v1\n`;

/** 四笔种子：c1 建 a/gone/图片附件；c2 改 a + 删 gone；c3 再改 a（多文件提交 + 非 .md 路径样本面） */
const SERIES = [
  { message: 'c1 建文档', files: { 'docs/a.md': DOC_V1, 'docs/gone.md': GONE_V1, 'assets/pic.png': 'png-fixture-bytes' } },
  { message: 'c2 改a删gone', files: { 'docs/a.md': DOC_V2, 'docs/gone.md': undefined } },
  { message: 'c3 再改a', files: { 'docs/a.md': DOC_V3 } },
];

interface LinksFixture {
  h: BrowseHarness;
  alice: number; // editor（成员——canWriteVault 放行）
  bob: number; // reader（成员——read 门槛可达、写入口不渲染）
}

async function linksVault(slug = 'alpha'): Promise<LinksFixture> {
  const h = await browseHarness();
  const alice = addEmployee(h.db, { username: 'alice' });
  const bob = addEmployee(h.db, { username: 'bob' });
  await seededVault(h, slug, alice, { 'README.md': '# 导航\n' });
  await pushHistorySeries(h, 1, SERIES);
  addMember(h.db, 1, alice, 'editor', alice);
  addMember(h.db, 1, bob, 'reader', alice);
  return { h, alice, bob };
}

/** 提取页面全部 <a href>（去重保序）——链接健康断言的遍历面 */
function anchorHrefs(body: string): string[] {
  const hrefs: string[] = [];
  for (const m of body.matchAll(/<a\s[^>]*\bhref="([^"]+)"/g)) {
    if (!hrefs.includes(m[1])) hrefs.push(m[1]);
  }
  return hrefs;
}

/** 逐 href 复放请求：全部 200/302，零 404（失败清单整体报出——哪条链、什么码） */
async function assertAllReachable(h: BrowseHarness, headers: Record<string, string>, pageUrl: string, body: string): Promise<void> {
  const hrefs = anchorHrefs(body);
  assert.ok(hrefs.length > 0, `${pageUrl} 应存在链接（断言遍历面非空）`);
  const dead: string[] = [];
  for (const href of hrefs) {
    const res = await h.app.inject({ method: 'GET', url: href, headers });
    if (res.statusCode !== 200 && res.statusCode !== 302) dead.push(`${href} → ${res.statusCode}`);
  }
  assert.deepEqual(dead, [], `${pageUrl} 渲染出的全部链接可达（200/302，零 404——F-4 死链修复所依）`);
}

// ── 库级历史页（treePath=''）：F-4 死链修复 ─────────────────────────────────

test('库级历史页：库级行为逐文件 diff 入口，editor/reader 两视角全部 href 200/302 零 404', async () => {
  const { h, alice, bob } = await linksVault();
  try {
    for (const who of [alice, bob]) {
      const headers = h.session(who);
      const res = await h.app.inject({ method: 'GET', url: '/vaults/alpha/history', headers });
      assert.equal(res.statusCode, 200, res.body);

      // 修复正向形态：库级行给出「该提交涉及文件」的逐文件 diff 链接（多文件提交 c1 至少含 a.md）
      assert.ok(res.body.includes('>diff docs/a.md</a>'), '库级行逐文件 diff 入口（c1 涉及 docs/a.md）');

      // 死链形态不得再出现：空 treePath 的 /diff/{oid}（尾斜杠收尾——log.ts 空 filePath 一律 404）
      const deadForm = anchorHrefs(res.body).filter((href) => /\/diff\/[0-9a-f]+\/?$/.test(href));
      assert.deepEqual(deadForm, [], '不得再有空 treePath 的 diff 死链');

      await assertAllReachable(h, headers, '/vaults/alpha/history', res.body);
    }
  } finally {
    await h.close();
  }
});

// ── 路径级历史页：编辑入口（S10-T1 F-1）+ 链接健康 ───────────────────────────

test('路径级历史页（.md）：editor 见「编辑此页」入口，全部 href 200/302 零 404', async () => {
  const { h, alice } = await linksVault();
  try {
    const headers = h.session(alice);
    const res = await h.app.inject({ method: 'GET', url: '/vaults/alpha/history/docs/a.md', headers });
    assert.equal(res.statusCode, 200, res.body);
    assert.ok(res.body.includes('href="/vaults/alpha/edit/docs/a.md"'), '编辑入口（canWriteVault 放行——既有 edit 路由）');
    assert.ok(res.body.includes('>编辑此页</a>'), '入口文案');
    await assertAllReachable(h, headers, '/vaults/alpha/history/docs/a.md', res.body);
  } finally {
    await h.close();
  }
});

test('路径级历史页（.md）：reader 不渲染编辑入口，呈现只读徽章', async () => {
  const { h, bob } = await linksVault();
  try {
    const res = await h.app.inject({ method: 'GET', url: '/vaults/alpha/history/docs/a.md', headers: h.session(bob) });
    assert.equal(res.statusCode, 200, res.body);
    assert.ok(!res.body.includes('/vaults/alpha/edit/'), 'reader 不渲染编辑入口（canWriteVault 不放行）');
    assert.ok(res.body.includes('<span class="badge">只读</span>'), '只读徽章如实标注（DESIGN.md badge 形态）');
  } finally {
    await h.close();
  }
});

test('路径级历史页（非 .md 附件）：不渲染编辑入口（edit 表单仅 .md——不产生 404 链接）', async () => {
  const { h, alice } = await linksVault();
  try {
    const headers = h.session(alice);
    const res = await h.app.inject({ method: 'GET', url: '/vaults/alpha/history/assets/pic.png', headers });
    assert.equal(res.statusCode, 200, res.body);
    assert.ok(!res.body.includes('/vaults/alpha/edit/'), '非 .md 路径不渲染编辑入口（edit GET 对非 .md 404——不得生成死链）');
    await assertAllReachable(h, headers, '/vaults/alpha/history/assets/pic.png', res.body);
  } finally {
    await h.close();
  }
});
