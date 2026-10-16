import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  browseHarness,
  seededVault,
  addEmployee,
  addMember,
  gitOut,
  repoPathOf,
} from './web-browse-fixtures.ts';
import { pushHistorySeries } from './web-history-fixtures.ts';
import { recordAuditEvent, settleAuditEvent } from '../src/audit/audit.ts';
import { adminPage } from '../src/web/pages.ts';
import { recentDocuments } from '../src/web/workbench/query.ts';

/**
 * S21-T2 结构一致性（审计 docs/e7/ux-audit.md B1/B3–B7/B10；epic ADR D44–D47）
 * 的渲染断言锁定（sprint D2 风格——行为测试只增不减）：
 *
 * - B1 侧栏文库项：登录态侧栏首项=「文库」（/vaults）；browse 族页面当前区
 *   落 vaults；匿名壳（顶栏菜单/页脚）不承载该项。
 * - B3 page-meta 统一：全站页面不再呈现「当前登录：…」裸行；返回链接保留并
 *   落 page-sub quiet 变体。
 * - B4 文档阅读页头：h1=frontmatter title（无标题回落文件名）；元数据条=
 *   负责人/状态/标签/来源＋维护者·相对时间（ISO 只入 title）。
 * - B5 搜索页：表单网格（label 置控件上方）＋标题列=view 链接＋命中字段中文
 *   映射全集（路径/正文在列）。
 * - B6 历史行两段式：主行=短 OID＋主题、次行=作者·相对时间·diff；行内不再
 *   「（Git 元数据）」括注（页脚说明承担）。
 * - B7 跨库最近文档：按路径去重（最新事件＋「N 次发布」微标注）＋与 HEAD 树
 *   求交（已删除文档不再呈现）；recentDocuments 数据面行序保持（D25/D30 不变
 *   ——去重与求交是纯显示层，web/workbench/display.ts）。
 * - B10 维护模式：状态行（开/关＋开启高亮）＋按钮按状态定主次（模板两态直调
 *   ＋真实闸门开关后 /admin 服务端实态渲染）。
 */

// ── B1：侧栏文库项 ──────────────────────────────────────────────────────────

test('B1 侧栏文库项：登录态首项=文库（居查找之前）；匿名壳不承载', async () => {
  const h = await browseHarness();
  try {
    const alice = addEmployee(h.db, { username: 'alice', display_name: '爱丽丝' });
    await seededVault(h, 'alpha', alice, { 'docs/guide.md': '# 指南\n' });
    addMember(h.db, 1, alice, 'editor', alice);
    const home = await (await h.app.inject({ method: 'GET', url: '/', headers: h.session(alice) })).body;
    const sideStart = home.indexOf('class="side-nav"');
    const sideEnd = home.indexOf('</nav>', sideStart);
    const side = home.slice(sideStart, sideEnd);
    assert.ok(side.includes('<a class="side-nav-item" href="/vaults"'), '侧栏含文库项（/vaults）');
    assert.ok(side.includes('<span class="side-nav-text">文库</span>'), '侧栏文库标签');
    assert.ok(
      side.indexOf('<span class="side-nav-text">文库</span>') < side.indexOf('<span class="side-nav-text">查找</span>'),
      '文库居查找之前（主目的地首位）',
    );
    // 匿名壳：顶栏横向菜单与页脚不承载文库（顶栏主 CTA「知识库」已是等价入口）
    const login = await (await h.app.inject({ method: 'GET', url: '/login' })).body;
    assert.ok(!login.includes('<span class="side-nav-text">文库</span>'), '匿名壳无侧栏文库项');
    assert.ok(!login.includes('>文库</a>'), '匿名壳顶栏菜单/页脚不承载文库链接');
    assert.ok(login.includes('class="btn btn-primary" href="/vaults"'), '顶栏主 CTA（知识库）保留');
  } finally {
    await h.close();
  }
});

test('B1 browse 族页面当前区落位：侧栏恰 /vaults 一处 aria-current', async () => {
  const h = await browseHarness();
  try {
    const alice = addEmployee(h.db, { username: 'alice', display_name: '爱丽丝' });
    await seededVault(h, 'alpha', alice, { 'docs/guide.md': '---\ntitle: 指南\n---\n\n正文\n' });
    addMember(h.db, 1, alice, 'editor', alice);
    for (const url of [
      '/vaults',
      '/vaults/alpha/browse',
      '/vaults/alpha/view/docs/guide.md',
      '/vaults/alpha/edit/docs/guide.md',
      '/vaults/alpha/history',
      '/vaults/alpha/activity',
    ]) {
      const body = await (await h.app.inject({ method: 'GET', url, headers: h.session(alice) })).body;
      const sideStart = body.indexOf('class="side-nav"');
      const sideEnd = body.indexOf('</nav>', sideStart);
      const sideMarked = [...body.slice(sideStart, sideEnd).matchAll(/href="([^"]+)" aria-current="page"/g)].map((m) => m[1]);
      assert.deepEqual(sideMarked, ['/vaults'], `${url} 侧栏恰一处高亮且为文库（实得 ${JSON.stringify(sideMarked)}）`);
    }
  } finally {
    await h.close();
  }
});

// ── B3：page-meta 统一（去「当前登录」裸行） ─────────────────────────────────

test('B3 page-meta 统一：各页无「当前登录」裸行；返回链接语义保留（page-sub quiet）', async () => {
  const h = await browseHarness();
  try {
    const alice = addEmployee(h.db, { username: 'alice', display_name: '爱丽丝' });
    await seededVault(h, 'alpha', alice, { 'docs/guide.md': '---\ntitle: 指南\n---\n\n正文\n' });
    addMember(h.db, 1, alice, 'editor', alice);
    addEmployee(h.db, { username: 'boss', is_instance_admin: 1 });
    const bossSession = h.session(2);
    for (const [url, backMarker] of [
      ['/vaults', '返回首页'],
      ['/search', '返回首页'],
      ['/drafts', '返回首页'],
      ['/vaults/alpha/history', '返回目录'],
      ['/vaults/alpha/activity', '返回目录'],
      ['/admin', '← 返回'],
      ['/credentials', '← 返回'],
    ] as const) {
      const session = url === '/admin' || url === '/credentials' ? bossSession : h.session(alice);
      const body = await (await h.app.inject({ method: 'GET', url, headers: session })).body;
      assert.ok(!body.includes('当前登录：'), `${url} 无「当前登录」裸行（身份由顶栏承担）`);
      assert.ok(body.includes('page-sub page-sub-quiet'), `${url} 页头副行落 quiet 变体`);
      assert.ok(body.includes(backMarker), `${url} 返回链接语义保留`);
    }
  } finally {
    await h.close();
  }
});

// ── B4：文档阅读页头（h1=标题＋元数据条） ────────────────────────────────────

const FULL_FM_DOC = [
  '---',
  'title: 完整元数据文档',
  'owner: 张三',
  'status: draft',
  'tags:',
  '  - 入门',
  '  - 指南',
  'source: 内部培训材料',
  '---',
  '',
  '# 正文标题',
  '',
  '正文段落。',
].join('\n');

test('B4 文档页 h1=frontmatter title；元数据条=负责人/状态/标签/来源＋维护者·相对时间（ISO 只入 title）', async () => {
  const h = await browseHarness();
  try {
    const alice = addEmployee(h.db, { username: 'alice', display_name: '爱丽丝' });
    await seededVault(h, 'alpha', alice, { 'docs/full.md': FULL_FM_DOC, 'README.md': '# 导航\n' });
    addMember(h.db, 1, alice, 'reader', alice);
    const body = await (
      await h.app.inject({ method: 'GET', url: '/vaults/alpha/view/docs/full.md', headers: h.session(alice) })
    ).body;
    assert.ok(body.includes('<h1>完整元数据文档</h1>'), 'h1=frontmatter title（非文件名）');
    assert.ok(body.includes('<title>完整元数据文档 — alpha — Notegit</title>'), '页面 title 同源（标题优先）');
    assert.ok(!body.includes('<h1>full.md</h1>'), '文件名不再充当 h1');
    assert.ok(body.includes('class="meta-badges doc-meta"'), '文档元数据条形态');
    assert.ok(body.includes('状态：草稿</span>'), '状态徽章（frontmatter status 映射）');
    assert.ok(body.includes('负责人：张三</span>'), '负责人徽章');
    assert.ok(body.includes('>入门</span>'), '标签 chips');
    assert.ok(body.includes('来源：内部培训材料</span>'), '来源徽章');
    // 维护者·更新时间：最后触及提交（seed 提交作者=seed）·相对时间；ISO 只在 title
    assert.ok(body.includes('seed 维护 · '), '维护者徽章（最后触及提交作者）');
    assert.ok(/title="最后触及提交 [^"]*（派生自 Git 提交记录/.test(body), '绝对时间只入 title（含可填写属性注记）');
    assert.ok(!/>20\d\d-\d\d-\d\dT\d\d:\d\d/.test(body), '可见文本不呈现 ISO 时间戳');
  } finally {
    await h.close();
  }
});

test('B4 无标题回落文件名；无 frontmatter 文件保持基础元信息行（如实不虚构）', async () => {
  const h = await browseHarness();
  try {
    const alice = addEmployee(h.db, { username: 'alice', display_name: '爱丽丝' });
    await seededVault(h, 'alpha', alice, { 'README.md': '# 导航\n' });
    addMember(h.db, 1, alice, 'reader', alice);
    const body = await (
      await h.app.inject({ method: 'GET', url: '/vaults/alpha/view/README.md', headers: h.session(alice) })
    ).body;
    assert.ok(body.includes('<h1>README.md</h1>'), '无标题如实回落文件名');
    assert.ok(body.includes('class="meta-badges"><span class="badge">文件</span>'), '无 frontmatter=基础元信息行（无状态/负责人虚构）');
    assert.ok(!body.includes('状态：现行</span>'), '无 frontmatter 不虚构状态徽章');
  } finally {
    await h.close();
  }
});

// ── B5：搜索表单网格＋标题链接＋命中字段中文映射 ─────────────────────────────

test('B5 搜索表单网格：field 包裹、label 置控件上方左对齐；CSS 网格三列在位', async () => {
  const h = await browseHarness();
  try {
    const alice = addEmployee(h.db, { username: 'alice', display_name: '爱丽丝' });
    const v = await seededVault(h, 'mine', alice, { 'README.md': '# r\n' });
    addMember(h.db, v, alice, 'reader', alice);
    h.db
      .prepare(
        `INSERT INTO search_index (vault_id, path, commit_oid, title, tags, summary, body, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(v, 'docs/x.md', 'c1', 'Guide', '[]', '摘要', '', new Date().toISOString());
    const body = await (
      await h.app.inject({ method: 'GET', url: '/search?q=guide', headers: h.session(alice) })
    ).body;
    assert.ok(/<form method="get" action="\/search" class="search-form">[\s\S]*?<div class="field">/.test(body), 'field 包裹层（网格列位承载）');
    assert.ok(
      /<div class="field">\s*<label for="q">[^<]+<\/label>\s*<input type="search"/.test(body),
      'label 置控件上方（关键词字段）',
    );
    assert.ok(
      /<div class="field">\s*<label for="vault">[^<]+<\/label>\s*<select id="vault"/.test(body),
      'label 置控件上方（库字段）',
    );
    const css = await (await h.app.inject({ method: 'GET', url: '/assets/styles.css' })).body;
    assert.ok(/\.search-form \{[\s\S]*?display: grid;/.test(css), '表单网格布局（DESIGN.md §5 搜索表单）');
    // 标题列=链接（指向 view）；路径列降为次要文本
    assert.ok(/<td><a href="\/vaults\/mine\/view\/docs\/x\.md">Guide<\/a><\/td>/.test(body), '标题列=链接（view 路径）');
    assert.ok(/<td class="col-tertiary">docs\/x\.md<\/td>/.test(body), '路径列=次要文本（不再重复承载链接）');
    // 命中字段中文映射：title 单命中→「标题」（q=guide 只出现在 title）
    assert.ok(/data-matched="title"[\s\S]*?<td>标题<\/td>/.test(body), '命中字段中文映射（title→标题）');
  } finally {
    await h.close();
  }
});

test('B5 命中字段中文映射全集：path→路径、body→正文（内部字段名不出现在结果表）', async () => {
  const h = await browseHarness();
  try {
    const alice = addEmployee(h.db, { username: 'alice', display_name: '爱丽丝' });
    const v = await seededVault(h, 'mine', alice, { 'README.md': '# r\n' });
    addMember(h.db, v, alice, 'reader', alice);
    const ins = h.db.prepare(
      `INSERT INTO search_index (vault_id, path, commit_oid, title, tags, summary, body, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // uniqpathx 只在路径出现；uniqbodyx 只在正文出现——两行各自命中单字段
    ins.run(v, 'docs/uniqpathx.md', 'c1', '标题甲', '[]', '', '正文乙', new Date().toISOString());
    ins.run(v, 'docs/other.md', 'c1', '标题乙', '[]', '', 'uniqbodyx 正文', new Date().toISOString());
    const body = await (
      await h.app.inject({ method: 'GET', url: '/search?q=uniqpathx', headers: h.session(alice) })
    ).body;
    assert.ok(/data-matched="path"[\s\S]*?<td>路径<\/td>/.test(body), 'path 命中→「路径」中文映射');
    const body2 = await (
      await h.app.inject({ method: 'GET', url: '/search?q=uniqbodyx', headers: h.session(alice) })
    ).body;
    assert.ok(/data-matched="body"[\s\S]*?<td>正文<\/td>/.test(body2), 'body 命中→「正文」中文映射');
  } finally {
    await h.close();
  }
});

// ── B6：历史行两段式 ────────────────────────────────────────────────────────

test('B6 历史行两段式：主行=短OID＋主题；次行=作者·相对时间（ISO 只入 title）·链接；无逐行「（Git 元数据）」', async () => {
  const h = await browseHarness();
  try {
    const alice = addEmployee(h.db, { username: 'alice', display_name: '爱丽丝' });
    await seededVault(h, 'alpha', alice, { 'README.md': '# 导航\n' });
    await pushHistorySeries(h, 1, [{ message: 'c1 改动说明', files: { 'docs/a.md': 'a\n' } }]);
    addMember(h.db, 1, alice, 'reader', alice);
    const body = await (
      await h.app.inject({ method: 'GET', url: '/vaults/alpha/history', headers: h.session(alice) })
    ).body;
    // 主行：短 OID（等宽 code）＋提交主题；次行：作者 · 相对时间 + diff 链接
    assert.ok(/<div class="commit-main"><code class="commit-oid">[0-9a-f]{7,}<\/code> <span class="commit-subject">c1 改动说明<\/span><\/div>/.test(body), '主行=短 OID＋提交主题');
    assert.ok(/<div class="commit-meta"><span title="\d{4}-\d{2}-\d{2}T[^"]*">[^<]* · (刚刚|\d+ 分钟前|\d+ 小时前|\d+ 天前|\d{4}-\d{2}-\d{2})<\/span>/.test(body), '次行=作者·相对时间（title=ISO 绝对时间）');
    assert.ok(!body.includes('（Git 元数据）'), '行内不再「（Git 元数据）」括注');
    assert.ok((body.match(/Git 元数据/g) ?? []).length === 1, 'Git 元数据说明恰一处（页级 AUTHOR_NOTE）');
    // data-* 属性序列保留（一致性断言提取所依——fixtures pageCommitSeq 兼容）
    assert.ok(/<li class="commit" data-short="[^"]*" data-author="[^"]*" data-date="[^"]*" data-oid="[^"]*" data-email="[^"]*" data-subject="[^"]*">/.test(body), '提交行 data-* 属性序列保留');
  } finally {
    await h.close();
  }
});

// ── B7：跨库最近文档去重＋HEAD 树求交（纯显示层） ────────────────────────────

let wbSeedSeq = 0;

/** 按生产形状落一笔成功发布审计行（与 web-workbench-home.test.ts 同法） */
function seedPublish(
  h: Awaited<ReturnType<typeof browseHarness>>,
  input: { employeeId: number; vaultId: number; occurredAt: string; newCommit: string },
): void {
  recordAuditEvent(h.db, {
    occurredAt: input.occurredAt,
    actorKind: 'employee',
    subject: { employeeId: input.employeeId, carrierRef: `session:${input.employeeId}`, entry: 'git' },
    eventKind: 'vault.push',
    vaultId: input.vaultId,
    refName: 'refs/heads/main',
    oldCommit: null,
    newCommit: input.newCommit,
    status: 'pending',
    detail: { pushId: `s21t2-${++wbSeedSeq}` },
  });
  const id = Number((h.db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id);
  settleAuditEvent(h.db, id, 'succeeded');
}

async function headOf(h: Awaited<ReturnType<typeof browseHarness>>, vaultId: number): Promise<string> {
  return (await gitOut(['--git-dir', repoPathOf(h, vaultId), 'rev-parse', 'refs/heads/main'])).trim();
}

test('B7 最近文档：按路径去重（最新＋「N 次发布」）＋与 HEAD 树求交（已删文档出局）；数据面行序保持', async () => {
  const h = await browseHarness();
  try {
    const alice = addEmployee(h.db, { username: 'alice', display_name: '爱丽丝' });
    const v = await seededVault(h, 'dedup', alice, { 'docs/a.md': 'a v1\n', 'docs/b.md': 'b v1\n' });
    addMember(h.db, v, alice, 'editor', alice);
    const c0 = await headOf(h, v); // 种子：建 a+b
    await pushHistorySeries(h, v, [{ message: 'touch a', files: { 'docs/a.md': 'a v2\n' } }]);
    const c1 = await headOf(h, v); // 改 a
    await pushHistorySeries(h, v, [{ message: 'del b', files: { 'docs/b.md': undefined } }]);
    const c2 = await headOf(h, v); // 删 b——HEAD 树此后只有 docs/a.md
    seedPublish(h, { employeeId: alice, vaultId: v, occurredAt: '2026-10-15T01:00:00.000Z', newCommit: c0 });
    seedPublish(h, { employeeId: alice, vaultId: v, occurredAt: '2026-10-15T02:00:00.000Z', newCommit: c1 });
    seedPublish(h, { employeeId: alice, vaultId: v, occurredAt: '2026-10-15T03:00:00.000Z', newCommit: c2 });

    // 数据面（D25/D30 不变）：recentDocuments 原始行仍含 b.md 历史行与 a.md 重复行
    // ——去重与求交只发生在显示层。注：git 对「仅删除」的 tip 提交在 --diff-filter=d
    // 下会跳到最近一笔有非删除变更的提交（既有派生行为，本任务冻结不改——显示层
    // 求交不受其影响），故 a.md 原始行数按 ≥2 宽松断言。
    const raw = await recentDocuments(h.db, alice, 20, { dataDir: h.dataDir });
    const rawPaths = raw.map((r) => `${r.vaultSlug}:${r.path}`);
    assert.ok(rawPaths.includes('dedup:docs/b.md'), '数据面仍含已删路径的历史事件行（去重是显示层）');
    assert.ok(rawPaths.filter((p) => p === 'dedup:docs/a.md').length >= 2, '数据面 a.md 重复行存在（多笔触及事件）');

    // 显示面：去重（最新保留＋次数）＋HEAD 求交（b.md 出局）
    const body = await (await h.app.inject({ method: 'GET', url: '/', headers: h.session(alice) })).body;
    const rows = [...body.matchAll(/<tr data-vault="([^"]*)" data-path="([^"]*)" data-commit="([^"]*)"/g)].map(
      (m) => `${m[1]}:${m[2]}:${m[3]}`,
    );
    const aRows = rows.filter((r) => r.startsWith('dedup:docs/a.md:'));
    assert.equal(aRows.length, 1, `a.md 恰一行（去重后保留最新事件锚点——实得 ${JSON.stringify(rows)}）`);
    assert.ok(!body.includes('docs/b.md'), '已删除文档（b.md）不再呈现（HEAD 树求交——审计 C1）');
    assert.ok(/(\d+) 次发布/.test(body) && body.includes('次发布'), '重复发布微标注在位（窗口内多次触及）');
  } finally {
    await h.close();
  }
});

// ── B10：维护模式状态指示 ───────────────────────────────────────────────────

test('B10 维护模式状态指示：两态模板（关=正常运行/开=维护中高亮）＋按钮按状态定主次', () => {
  const off = adminPage({ username: 'boss', display_name: '库主管', is_instance_admin: true });
  assert.ok(off.includes('当前状态：<strong id="maint-state-text">正常运行</strong>'), '缺省态=正常运行');
  assert.ok(!off.includes('maint-status is-on'), '关闭态不高亮');
  assert.ok(/<button id="maint-on" type="button" class="btn-primary">开启维护模式<\/button>/.test(off), '关闭态：开启=主按钮');
  assert.ok(/<button id="maint-off" type="button">关闭维护模式<\/button>/.test(off), '关闭态：关闭=次按钮');
  assert.ok(!off.includes('docs/credentials-ops.md') && !off.includes('任务 notes') && !off.includes('DOD-03'), '无内部文档/任务注记引用');
  assert.ok(off.includes('updateMaintUi'), '切换后状态行本地同步脚本在位');

  const on = adminPage({ username: 'boss', display_name: '库主管', is_instance_admin: true }, { maintenanceOn: true });
  assert.ok(on.includes('维护中（写入已暂停）'), '开启态=维护中');
  assert.ok(on.includes('class="maint-status is-on"'), '开启态高亮');
  assert.ok(/<button id="maint-on" type="button">开启维护模式<\/button>/.test(on), '开启态：开启=次按钮');
  assert.ok(/<button id="maint-off" type="button" class="btn-primary">关闭维护模式<\/button>/.test(on), '开启态：关闭=主按钮');
});

test('B10 维护模式状态位：真实闸门开关后 /admin 服务端实态渲染（开=维护中→关=正常运行）', async () => {
  const h = await browseHarness();
  try {
    const boss = addEmployee(h.db, { username: 'boss', is_instance_admin: 1 });
    const toggle = (method: 'POST' | 'DELETE') =>
      h.app.inject({
        method,
        url: '/api/v1/admin/maintenance',
        headers: { origin: 'http://localhost', ...h.session(boss) },
        payload: method === 'POST' ? {} : undefined,
      });
    const before = await (await h.app.inject({ method: 'GET', url: '/admin', headers: h.session(boss) })).body;
    assert.ok(before.includes('正常运行'), '初始态=正常运行');
    assert.equal((await toggle('POST')).statusCode, 204, '开启维护');
    const during = await (await h.app.inject({ method: 'GET', url: '/admin', headers: h.session(boss) })).body;
    assert.ok(during.includes('维护中（写入已暂停）'), '开启后 /admin 呈现维护中');
    assert.ok(during.includes('class="maint-status is-on"'), '开启态高亮在位');
    assert.equal((await toggle('DELETE')).statusCode, 204, '关闭维护');
    const after = await (await h.app.inject({ method: 'GET', url: '/admin', headers: h.session(boss) })).body;
    assert.ok(after.includes('正常运行'), '关闭后恢复正常运行');
  } finally {
    await h.close();
  }
});
