import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browseHarness, seededVault, addEmployee, addMember, repoPathOf, pushToVault, lsTreeSeq, pageEntrySeq } from './web-browse-fixtures.ts';

// S4-T1 目录浏览（breakdown §2.3：多级目录由 Git tree 表达、默认分支实时读；
// 完成标准「目录渲染与 git ls-tree 一致」）。一致性断言：页面条目序列（data 属性
// 提取）=== 另行 spawn 的 `git ls-tree -l -z`（同仓库同 ref）解析序列——不经生产
// 读面。种子含中文与空格文件名（core.quotepath 原始名路径）。

const SEED: Record<string, string> = {
  'README.md': '# 知识库导航\n\n这里是目录说明。\n',
  'docs/first.md': '---\ntitle: First\n---\n正文一\n',
  'docs/second.md': '---\ntitle: Second\n---\n正文二\n',
  'docs/nested/third.md': '---\ntitle: Third\n---\n正文三\n',
  '中文 目录/说明.md': '---\ntitle: 说明\n---\n中文正文\n',
};

async function seeded() {
  const h = await browseHarness();
  const alice = addEmployee(h.db, { username: 'alice' });
  const vaultId = await seededVault(h, 'alpha', alice, SEED);
  addMember(h.db, vaultId, alice, 'editor', alice);
  return { h, alice, vaultId };
}

test('目录浏览：根目录渲染与 git ls-tree 一致（名称/类型/顺序，含中文空格名）', async () => {
  const { h, alice, vaultId } = await seeded();
  try {
    const page = await h.app.inject({ method: 'GET', url: '/vaults/alpha/browse', headers: h.session(alice) });
    assert.equal(page.statusCode, 200, page.body);
    assert.deepEqual(pageEntrySeq(page.body), await lsTreeSeq(repoPathOf(h, vaultId), 'main', ''));
  } finally {
    await h.close();
  }
});

test('目录浏览：多级子目录与 git ls-tree 一致 + 面包屑逐级链接', async () => {
  const { h, alice, vaultId } = await seeded();
  try {
    const page = await h.app.inject({ method: 'GET', url: '/vaults/alpha/browse/docs/nested', headers: h.session(alice) });
    assert.equal(page.statusCode, 200, page.body);
    assert.deepEqual(pageEntrySeq(page.body), await lsTreeSeq(repoPathOf(h, vaultId), 'main', 'docs/nested'));
    // 面包屑：列表 → 库根 → docs → 当前（nested）
    assert.ok(page.body.includes('href="/vaults"'));
    assert.ok(page.body.includes('href="/vaults/alpha/browse"'));
    assert.ok(page.body.includes('href="/vaults/alpha/browse/docs"'));
    assert.ok(page.body.includes('nested'), '当前段名出现');
  } finally {
    await h.close();
  }
});

test('目录浏览：README.md 渲染为目录导航（豁免标注）；无 frontmatter 不报错', async () => {
  const { h, alice } = await seeded();
  try {
    const page = await h.app.inject({ method: 'GET', url: '/vaults/alpha/browse', headers: h.session(alice) });
    assert.equal(page.statusCode, 200, page.body);
    assert.ok(page.body.includes('README.md'), 'README 标注出现');
    assert.ok(page.body.includes('豁免'), '豁免标注出现（架构 §5.2：README 豁免 frontmatter）');
    assert.ok(page.body.includes('这里是目录说明'), 'README 正文渲染');
    // 子目录页同样渲染该层 README？——种子无子层 README，只断言根层不报错即可
  } finally {
    await h.close();
  }
});

test('目录浏览：子目录含 README 时该层渲染自己的 README', async () => {
  const h = await browseHarness();
  try {
    const alice = addEmployee(h.db, { username: 'alice' });
    const vaultId = await seededVault(h, 'alpha', alice, {
      ...SEED,
      'docs/README.md': 'docs 层导航说明\n',
    });
    addMember(h.db, vaultId, alice, 'editor', alice);
    const page = await h.app.inject({ method: 'GET', url: '/vaults/alpha/browse/docs', headers: h.session(alice) });
    assert.equal(page.statusCode, 200, page.body);
    assert.ok(page.body.includes('docs 层导航说明'), '子层 README 渲染');
    assert.ok(!page.body.includes('这里是目录说明'), '不串层渲染根 README');
  } finally {
    await h.close();
  }
});

test('目录浏览实时读：push 新提交后刷新页面即见（默认分支实时、无缓存）', async () => {
  const { h, alice, vaultId } = await seeded();
  try {
    const before = await h.app.inject({ method: 'GET', url: '/vaults/alpha/browse/docs', headers: h.session(alice) });
    assert.ok(before.body.includes('first.md'));
    assert.ok(!before.body.includes('later.md'));

    await pushToVault(h, vaultId, { 'docs/later.md': '---\ntitle: Later\n---\n正文\n' });
    const after = await h.app.inject({ method: 'GET', url: '/vaults/alpha/browse/docs', headers: h.session(alice) });
    assert.equal(after.statusCode, 200);
    assert.ok(after.body.includes('later.md'), 'push 后无需任何动作即见（架构 §6）');
    assert.deepEqual(pageEntrySeq(after.body), await lsTreeSeq(repoPathOf(h, vaultId), 'main', 'docs'));
  } finally {
    await h.close();
  }
});

test('目录浏览：空库（无提交）→ 200 空态页', async () => {
  const h = await browseHarness();
  try {
    const alice = addEmployee(h.db, { username: 'alice' });
    const vaultId = await seededVault(h, 'alpha', alice); // 行 + bare init，无种子提交
    addMember(h.db, vaultId, alice, 'admin', alice);
    const page = await h.app.inject({ method: 'GET', url: '/vaults/alpha/browse', headers: h.session(alice) });
    assert.equal(page.statusCode, 200, page.body);
    assert.ok(page.body.includes('尚无提交'), '空态提示');
  } finally {
    await h.close();
  }
});

test('目录浏览：目录条目链向 browse、文件条目链向 view（含中文空格名的 URL 编码）', async () => {
  const { h, alice } = await seeded();
  try {
    const page = await h.app.inject({ method: 'GET', url: '/vaults/alpha/browse', headers: h.session(alice) });
    assert.ok(
      page.body.includes('href="/vaults/alpha/browse/docs"'),
      '目录条目 → browse 子路径',
    );
    assert.ok(
      page.body.includes('href="/vaults/alpha/view/README.md"'),
      '文件条目 → view 路径',
    );
    assert.ok(
      page.body.includes(`href="/vaults/alpha/browse/${encodeURIComponent('中文 目录')}"`),
      '中文空格目录名逐段编码',
    );
  } finally {
    await h.close();
  }
});

test('目录浏览：不存在的路径与越权路径形态一律 404', async () => {
  const { h, alice } = await seeded();
  try {
    const headers = h.session(alice);
    for (const p of ['/vaults/alpha/browse/nope', '/vaults/alpha/browse/docs/../..', '/vaults/alpha/browse/%2e%2e', '/vaults/alpha/browse/docs//nested']) {
      const res = await h.app.inject({ method: 'GET', url: p, headers });
      assert.equal(res.statusCode, 404, `${p} 应 404`);
    }
  } finally {
    await h.close();
  }
});

test('目录浏览：文件路径经 browse URL 访问 → 404（非目录）', async () => {
  const { h, alice } = await seeded();
  try {
    const res = await h.app.inject({ method: 'GET', url: '/vaults/alpha/browse/docs/first.md', headers: h.session(alice) });
    assert.equal(res.statusCode, 404);
  } finally {
    await h.close();
  }
});
