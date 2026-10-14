import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browseHarness, seededVault, addEmployee, addMember, gitOut, repoPathOf, type BrowseHarness } from './web-browse-fixtures.ts';

// S12-T1 草稿自动保存（D3）：编辑页内定时器（默认 30s，页面顶部可配常量）+
// 失焦触发，调既有 §7 drafts PUT（body 含 content+base_commit——沿用 composeDoc）；
// 状态行如实呈现（已保存 HH:MM / 保存失败重试提示——非阻断）。README 豁免页与
// 新建页（edit/new）同样支持。fetch 层以 JS 形态断言锁定（脚本含定时器与端点
// URL）；行为级保证以端点侧为准（页面携带的 URL 真实可用——同源会话+Origin）。

const DOC = '---\ntitle: "First 笔记"\n---\n\n# 正文标题\n\n内容。\n';

async function setup() {
  const h = await browseHarness();
  const alice = addEmployee(h.db, { username: 'alice' });
  const bob = addEmployee(h.db, { username: 'bob' });
  const vaultId = await seededVault(h, 'alpha', alice, {
    'README.md': '# 导航\n',
    'docs/first.md': DOC,
  });
  addMember(h.db, vaultId, alice, 'editor', alice);
  addMember(h.db, vaultId, bob, 'reader', alice);
  const seedMain = (await gitOut(['--git-dir', repoPathOf(h, vaultId), 'rev-parse', 'main'])).trim();
  return { h, alice, bob, vaultId, seedMain };
}

function get(h: BrowseHarness, url: string, employeeId: number) {
  return h.app.inject({ method: 'GET', url, headers: h.session(employeeId) });
}

/** JS 形态断言集：间隔常量（页面顶部可配）+ 定时器 + 失焦触发 + 状态行 + 端点 URL */
function assertAutosaveShape(body: string, urlNeedle: string, label: string): void {
  assert.ok(body.includes('const AUTOSAVE_INTERVAL_MS ='), `${label}：间隔常量（可配——页面顶部）`);
  assert.match(body, /const AUTOSAVE_INTERVAL_MS = \d+/, `${label}：常量形态`);
  assert.ok(body.includes('setInterval(autosaveNow, AUTOSAVE_INTERVAL_MS)'), `${label}：定时器引用常量`);
  assert.ok(body.includes("addEventListener('focusout'"), `${label}：失焦触发`);
  assert.ok(body.includes('id="autosave-status"'), `${label}：状态行元素`);
  assert.ok(body.includes('草稿已自动保存'), `${label}：已保存呈现`);
  assert.ok(body.includes('自动保存失败'), `${label}：失败提示（非阻断）`);
  assert.ok(body.includes(urlNeedle), `${label}：drafts PUT 端点 URL`);
}

test('自动保存 JS 形态（六字段编辑页）：可配间隔常量 + 定时器/失焦触发 + drafts PUT 端点 + 状态行', async () => {
  const { h, alice } = await setup();
  try {
    const res = await get(h, '/vaults/alpha/edit/docs/first.md', alice);
    assert.equal(res.statusCode, 200, res.body);
    assertAutosaveShape(res.body, '/api/v1/vaults/alpha/drafts/docs/first.md', '六字段编辑页');
    // 自动保存沿用既有组装面（composeDoc——含 frontmatter 全文）与 base_commit
    assert.match(res.body, /api\('PUT', DRAFT_URL, \{ content: composeDoc\(\), base_commit: BASE \}\)/);
  } finally {
    await h.close();
  }
});

test('自动保存 JS 形态（README 豁免页 + 新建页）：同样支持（D3）', async () => {
  const { h, alice } = await setup();
  try {
    const readme = await get(h, '/vaults/alpha/edit/README.md', alice);
    assert.equal(readme.statusCode, 200, readme.body);
    assertAutosaveShape(readme.body, '/api/v1/vaults/alpha/drafts/README.md', 'README 豁免页');

    const page = await get(h, '/vaults/alpha/edit/new', alice);
    assert.equal(page.statusCode, 200, page.body);
    assertAutosaveShape(page.body, '/api/v1/vaults/alpha/drafts/', '新建页');
  } finally {
    await h.close();
  }
});

test('reader 只读态不携带自动保存脚本与状态行（无写入口——既有形态延续）', async () => {
  const { h, bob } = await setup();
  try {
    const res = await get(h, '/vaults/alpha/edit/docs/first.md', bob);
    assert.equal(res.statusCode, 200, res.body);
    assert.ok(!res.body.includes('AUTOSAVE_INTERVAL_MS'), '只读态无自动保存定时器');
    assert.ok(!res.body.includes('id="autosave-status"'), '只读态无自动保存状态行');
  } finally {
    await h.close();
  }
});

test('页面携带的 drafts PUT 端点真实可用（端点侧行为锁定：会话+Origin PUT → 200；本人可回读）', async () => {
  const { h, alice, seedMain } = await setup();
  try {
    const page = await get(h, '/vaults/alpha/edit/docs/first.md', alice);
    const m = /const DRAFT_URL = "([^"]+)"/.exec(page.body);
    assert.ok(m !== null, '页面脚本嵌入 DRAFT_URL 常量');
    const draftUrl = m[1]!;
    const content = '---\ntitle: 自动保存\n---\n自动保存正文\n';
    const put = await h.app.inject({
      method: 'PUT',
      url: draftUrl,
      headers: { 'content-type': 'application/json', origin: 'http://localhost', ...h.session(alice) },
      payload: { content, base_commit: seedMain },
    });
    assert.equal(put.statusCode, 200, put.body);
    assert.ok(typeof (put.json() as { updated_at: string }).updated_at === 'string', '200 {updated_at}');

    const back = await h.app.inject({ method: 'GET', url: draftUrl, headers: h.session(alice) });
    assert.equal(back.statusCode, 200, back.body);
    assert.equal((back.json() as { content: string }).content, content, '草稿按作者私有回读一致');
  } finally {
    await h.close();
  }
});
