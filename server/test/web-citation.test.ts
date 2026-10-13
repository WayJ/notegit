import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seededVault, addEmployee, addMember, repoPathOf, gitOut } from './web-browse-fixtures.ts';
import { browseHarness, pushHistorySeries, revCommitOid, unescapeHtml } from './web-history-fixtures.ts';

// S5-T6 文档引用规范（breakdown §2.4 S5-T6 行；api.md §13 S5-T6 行）：
// - 引用 = 库 + 路径 + commit 三要素，格式与 S7-T8 harness 指引对齐
//   （docs/harness/README.md 实例工作流节：`v-handbook / docs/getting-started.md @ <commit>`；
//   架构 §7.1「回答引用库、路径和 commit，可对应到 Web 历史」的页面侧落点）；
// - 任意引用可解析到对应历史版本页：/cite 解析入口/深链 → S5-T2 version 路由；
// - 历史/预览页提供三要素复制（纯文本最小实现）；
// - 解析失败给可理解错误（404 反存在性——同因同页、不区分原因不泄露库/树内容）。
// 对照原则同 S5-T1/T2：期望值另行直通 spawn git 取，绝不经生产读面。

const FM = 'title: A\nowner: alice\ndescription: 摘要\nsource: web\n';
const DOC_V1 = `---\n${FM}---\n\na v1\n`;
const DOC_V2 = `---\n${FM}---\n\na v2\n`;
const DOC_V3 = `---\n${FM}---\n\na v3\n`;
const GONE_V1 = `---\ntitle: G\nowner: alice\ndescription: 摘要\nsource: web\n---\n\ngone v1\n`;

/** 三笔种子：c1 建 a/gone；c2 改 a + 删 gone；c3 再改 a（引用解析样本面） */
const SERIES = [
  { message: 'c1 建文档', files: { 'docs/a.md': DOC_V1, 'docs/gone.md': GONE_V1 } },
  { message: 'c2 改a删gone', files: { 'docs/a.md': DOC_V2, 'docs/gone.md': undefined } },
  { message: 'c3 再改a', files: { 'docs/a.md': DOC_V3 } },
];

interface CiteFixture {
  h: Awaited<ReturnType<typeof browseHarness>>;
  alice: number; // editor（成员）
  bob: number; // reader（成员）
  carol: number; // 局外人（非成员——反存在性对照）
}

async function citeVault(slug = 'alpha'): Promise<CiteFixture> {
  const h = await browseHarness();
  const alice = addEmployee(h.db, { username: 'alice' });
  const bob = addEmployee(h.db, { username: 'bob' });
  const carol = addEmployee(h.db, { username: 'carol' });
  await seededVault(h, slug, alice, { 'README.md': '# 导航\n' });
  await pushHistorySeries(h, 1, SERIES);
  addMember(h.db, 1, alice, 'editor', alice);
  addMember(h.db, 1, bob, 'reader', alice);
  return { h, alice, bob, carol };
}

/** GET /cite?c=<引用>（会话载体；引用串整体 URL 编码——深链形态） */
function getCite(h: CiteFixture['h'], citation: string, who?: number) {
  return h.app.inject({
    method: 'GET',
    url: `/cite?c=${encodeURIComponent(citation)}`,
    ...(who === undefined ? {} : { headers: h.session(who) }),
  });
}

/** 页面引用文本提取（class="citation" 的 <code>——复制引用断言所依） */
function citationSeq(body: string): string[] {
  const seq: string[] = [];
  const re = /<code class="citation">([^<]*)<\/code>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) seq.push(unescapeHtml(m[1]));
  return seq;
}

// ── 解析三态一：可解析（三要素 → 对应历史版本页深链） ───────────────────────

test('引用解析·可解析：全 SHA 三要素 302 到对应历史版本页，深链落地为该版本内容', async () => {
  const { h, alice } = await citeVault();
  try {
    const repo = repoPathOf(h, 1);
    const c1 = await revCommitOid(repo, 'refs/heads/main~2'); // a v1 版本
    const res = await getCite(h, `alpha / docs/a.md @ ${c1}`, alice);
    assert.equal(res.statusCode, 302, res.body);
    assert.equal(res.headers.location, `/vaults/alpha/version/${c1}/docs/a.md`, '深链=该路径该提交的 version 页');

    // 深链落地：跟随 302 到达该版本预览页（S5-T2 路由），正文为 v1 而非 tip v3
    const landed = await h.app.inject({ method: 'GET', url: res.headers.location!, headers: h.session(alice) });
    assert.equal(landed.statusCode, 200, landed.body);
    assert.ok(landed.body.includes('a v1'), '落到 c1 版本内容');
    assert.ok(!landed.body.includes('a v3'), '非 tip 内容（commit 参数化）');
  } finally {
    await h.close();
  }
});

test('引用解析·可解析：缩写 commit 同样解析并归一为全 SHA（与 version 寻址面同判）', async () => {
  const { h, alice } = await citeVault();
  try {
    const repo = repoPathOf(h, 1);
    const c1 = await revCommitOid(repo, 'refs/heads/main~2');
    const res = await getCite(h, `alpha / docs/a.md @ ${c1.slice(0, 10)}`, alice);
    assert.equal(res.statusCode, 302, res.body);
    assert.equal(res.headers.location, `/vaults/alpha/version/${c1}/docs/a.md`, '缩写归一为全 SHA 深链');
  } finally {
    await h.close();
  }
});

test('引用解析·回环：路径历史页任一行的复制引用经 /cite 落到该行版本页', async () => {
  const { h, alice } = await citeVault();
  try {
    const page = await h.app.inject({ method: 'GET', url: '/vaults/alpha/history/docs/a.md', headers: h.session(alice) });
    assert.equal(page.statusCode, 200, page.body);
    const cites = citationSeq(page.body);
    assert.ok(cites.length >= 3, `路径历史每行附引用（实得 ${cites.length}）`);
    for (const cite of cites) {
      const res = await getCite(h, cite, alice);
      assert.equal(res.statusCode, 302, `${cite} 应可解析`);
      assert.match(res.headers.location as string, /^\/vaults\/alpha\/version\/[0-9a-f]{40}\/docs\/a\.md$/);
    }
  } finally {
    await h.close();
  }
});

// ── 解析三态二：格式失败（非三要素形态 → 可理解错误，不触库判定） ─────────────

test('引用解析·格式失败：非三要素形态 404 且给出期望格式说明（各畸形同页）', async () => {
  const { h, alice } = await citeVault();
  try {
    const malformed = [
      'alpha / docs/a.md',            // 缺 commit
      'alpha @ 4c55b7a0d1e2f3a4',     // 缺路径分隔
      '随便一句话',                    // 整体非引用形态
      'alpha / docs/a.md @ XYZ12345', // commit 非 hex 形态
      'Alpha / docs/a.md @ 4c55b7a0', // 库 slug 非 slug 形态（大写）
    ];
    let first = '';
    for (const raw of malformed) {
      const res = await getCite(h, raw, alice);
      assert.equal(res.statusCode, 404, `${raw} 应 404`);
      assert.ok(res.body.includes('库 / 路径 @ commit'), `${raw} 错误页给出期望格式`);
      if (first === '') first = res.body;
      else assert.equal(res.body, first, '格式失败同页同文（可理解且一致）');
    }
  } finally {
    await h.close();
  }
});

// ── 解析三态三：存在性失败（反存在性——同页同码不区分原因） ───────────────────

test('引用解析·存在性失败：成员视角未知提交/缺失路径/树路径同页 404（不区分原因）', async () => {
  const { h, alice } = await citeVault();
  try {
    const repo = repoPathOf(h, 1);
    const c1 = await revCommitOid(repo, 'refs/heads/main~2');
    const tip = await revCommitOid(repo, 'refs/heads/main');
    const unresolvable = [
      `alpha / docs/a.md @ ${'d'.repeat(40)}`, // 未知 commit（hex 形态合法）
      `alpha / docs/gone.md @ ${tip}`,         // 该版本处路径已删除
      `alpha / never.md @ ${c1}`,              // 从未存在的路径
      `alpha / docs @ ${c1}`,                  // 树路径（非 blob——version 寻址面同判）
    ];
    let first = '';
    for (const raw of unresolvable) {
      const res = await getCite(h, raw, alice);
      assert.equal(res.statusCode, 404, `${raw} 应 404`);
      assert.ok(res.body.includes('引用'), '错误页可理解（说明引用未能解析）');
      if (first === '') first = res.body;
      else assert.equal(res.body, first, `${raw} 与首个失败同页同文（反存在性——不区分原因）`);
    }
    // 与格式失败的错误页可区分（两类失败可理解：格式错 vs 解析不到）
    const fmt = await getCite(h, '随便一句话', alice);
    assert.notEqual(fmt.body, first, '格式失败与存在性失败页面不同（各自可理解）');
  } finally {
    await h.close();
  }
});

test('引用解析·反存在性：非成员与未知库同页同码（D-IC-06——不泄露库存在性）', async () => {
  const { h, alice, carol } = await citeVault();
  try {
    const repo = repoPathOf(h, 1);
    const c1 = await revCommitOid(repo, 'refs/heads/main~2');
    const carolValid = await getCite(h, `alpha / docs/a.md @ ${c1}`, carol); // 有库无权
    const carolGhost = await getCite(h, `ghost / docs/a.md @ ${c1}`, carol); // 库不存在
    const aliceGhost = await getCite(h, `ghost / docs/a.md @ ${c1}`, alice); // 成员视角未知库
    for (const res of [carolValid, carolGhost, aliceGhost]) assert.equal(res.statusCode, 404, '一律 404');
    assert.equal(carolValid.body, carolGhost.body, '非成员：有库与无库同页（D-IC-06）');
    assert.equal(carolGhost.body, aliceGhost.body, '未知库：不同主体同页（D-IC-06）');
  } finally {
    await h.close();
  }
});

// ── 解析入口与门槛 ───────────────────────────────────────────────────────────

test('引用解析入口：GET /cite 呈现粘贴表单与三要素格式说明（无 JS 最小入口）', async () => {
  const { h, alice } = await citeVault();
  try {
    for (const url of ['/cite', '/cite?c=', '/cite?c=%20%20']) {
      const res = await h.app.inject({ method: 'GET', url, headers: h.session(alice) });
      assert.equal(res.statusCode, 200, `${url} 入口页 200（空输入回表单不报错）`);
      assert.ok(res.body.includes('<form method="get" action="/cite">'), `${url} GET 表单`);
      assert.ok(res.body.includes('name="c"'), `${url} 输入框 name=c`);
      assert.ok(res.body.includes('库 / 路径 @ commit'), `${url} 格式说明`);
    }
  } finally {
    await h.close();
  }
});

test('引用解析门槛：未认证 302 /login（与页面族同缝；GET 免 CSRF）', async () => {
  const { h } = await citeVault();
  try {
    const repo = repoPathOf(h, 1);
    const c1 = await revCommitOid(repo, 'refs/heads/main~2');
    for (const url of ['/cite', `/cite?c=${encodeURIComponent(`alpha / docs/a.md @ ${c1}`)}`]) {
      const res = await h.app.inject({ method: 'GET', url });
      assert.equal(res.statusCode, 302, `${url} 未认证 302`);
      assert.equal(res.headers.location, '/login');
    }
  } finally {
    await h.close();
  }
});

// ── 复制引用（三要素纯文本——与 harness 指引格式对齐） ────────────────────────

test('复制引用·版本预览页：呈现该版本三要素引用（纯文本，格式=harness 指引）', async () => {
  const { h, alice } = await citeVault();
  try {
    const repo = repoPathOf(h, 1);
    const c1 = await revCommitOid(repo, 'refs/heads/main~2');
    const page = await h.app.inject({ method: 'GET', url: `/vaults/alpha/version/${c1}/docs/a.md`, headers: h.session(alice) });
    assert.equal(page.statusCode, 200, page.body);
    assert.deepEqual(citationSeq(page.body), [`alpha / docs/a.md @ ${c1}`], '唯一引用=库/路径/全 SHA 三要素');
  } finally {
    await h.close();
  }
});

test('复制引用·路径级历史页：每行附该提交三要素（与 git log 同序）；库级不提供', async () => {
  const { h, alice } = await citeVault();
  try {
    const repo = repoPathOf(h, 1);
    // 直通 git 取期望（全 SHA 序列——绝不经生产读面）
    const oids = (await gitOut(['--git-dir', repo, 'log', '--format=%H', 'refs/heads/main', '--', 'docs/a.md']))
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '');
    assert.ok(oids.length >= 3, '样本面：a.md 至少三笔');

    const pathPage = await h.app.inject({ method: 'GET', url: '/vaults/alpha/history/docs/a.md', headers: h.session(alice) });
    assert.equal(pathPage.statusCode, 200, pathPage.body);
    assert.deepEqual(citationSeq(pathPage.body), oids.map((oid) => `alpha / docs/a.md @ ${oid}`), '行引用与 git log 同序同值');

    const vaultPage = await h.app.inject({ method: 'GET', url: '/vaults/alpha/history', headers: h.session(alice) });
    assert.equal(vaultPage.statusCode, 200, vaultPage.body);
    assert.equal(citationSeq(vaultPage.body).length, 0, '库级历史无路径上下文，不提供三要素引用');
  } finally {
    await h.close();
  }
});
