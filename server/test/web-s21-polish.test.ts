import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.ts';
import { newDb, addEmployee } from './credentials-fixtures.ts';
import { browseHarness, seededVault, addMember, type BrowseHarness } from './web-browse-fixtures.ts';
import { adminPage, credentialsPage, layout } from '../src/web/pages.ts';

/**
 * S21-T1 壳与组件破损修复（审计 docs/e7/ux-audit.md A1–A8+B2/B8/B9；决策
 * D40–D43）的渲染断言锁定（sprint D2 清单——行为测试只增不减）：
 *
 * - A1/D41 displayName 单形态：全量接线（各页面顶栏徽章=显示名）＋双槽同名
 *   只渲染单槽；B9 侧栏底部用户卡身份行同文去重。
 * - A2/D40 :empty 守卫：.form-warn/.notice/.op-error/.error-block/.token-view
 *   内容为空时不呈现。
 * - A3/D40 token 容器默认隐藏：admin（邀请/重置）与凭据创建三处 token 区块
 *   默认 hidden，JS 写入才展开（说明文案随容器同显隐）。
 * - A4 favicon：<link rel="icon"> + GET /favicon.ico 200（品牌 spike-mark）。
 * - A5/D43 数据表 .table-scroll 横滚容器（admin/凭据表直断言；首页文档表由
 *   web-workbench-status.test.ts 的表格形态断言随新契约锁定）。
 * - A6/D43 stat 卡 ≤680px 单列（防逐字竖排）。
 * - A8 编辑页「额外字段」label 精简。
 * - B2 页脚登录态去导航（侧栏=唯一桌面导航）。
 * - B8/D42 库卡角色徽章=胶囊 chip（CSS 收回内容宽）。
 */

interface Harness {
  app: ReturnType<typeof buildApp>;
  close(): Promise<void>;
}

// ── A1/D41：顶栏徽章 displayName 单形态 ─────────────────────────────────────

test('A1 双槽同名单槽（真实会话）：badge=用户名、无 nav-user；异名双槽都在', async () => {
  const h = await shellHarness();
  try {
    const db = h.db;
    addEmployee(db, { username: 'pleb' }); // display_name 缺省=pleb（与用户名同名）
    addEmployee(db, { username: 'alice', display_name: '爱丽丝' });
    const pleb = await h.get('/', 1);
    assert.ok(pleb.includes('class="badge">pleb</span>'), '同名：徽章=用户名（回落承载）');
    assert.ok(!pleb.includes('class="nav-user"'), '同名：用户名槽不重复渲染（A1/D41 单形态）');
    assert.ok(pleb.includes('<span class="badge">pleb</span></summary>'), '单槽形态=徽章独占 summary');
    const ali = await h.get('/', 2);
    assert.ok(ali.includes('class="badge">爱丽丝</span>'), '异名：徽章=显示名');
    assert.ok(ali.includes('class="nav-user">alice'), '异名：用户名槽保留');
  } finally {
    await h.close();
  }
});

/** 壳页 harness（自建库，暴露 db 供员工种子直插；无 dataDir——壳形态断言足够） */
async function shellHarness(): Promise<
  Harness & { db: ReturnType<typeof newDb>; get(url: string, employeeId: number): Promise<string> }
> {
  const { randomBytes } = await import('node:crypto');
  const { createSession, DEFAULT_SESSION_TIMEOUTS } = await import('../src/auth/sessions.ts');
  const db = newDb();
  const pepper = { active: { version: 1, key: randomBytes(32) }, retired: [] as never[] };
  const app = buildApp({ db, pepper, bootstrapTokenFile: '/tmp/notegit-s21-polish2.token' });
  await app.ready();
  const now = new Date();
  return {
    app,
    db,
    async get(url: string, employeeId: number) {
      const sid = createSession(db, employeeId, pepper.active.key, now, DEFAULT_SESSION_TIMEOUTS).sid;
      const res = await app.inject({ method: 'GET', url, headers: { cookie: `ngt_sid=${sid}` } });
      assert.equal(res.statusCode, 200, `${url} 应 200（实际 ${res.statusCode}）`);
      return res.body;
    },
    close: async () => {
      await app.close();
      db.close();
    },
  };
}

// ── B9：侧栏底部用户卡身份行同文去重 ────────────────────────────────────────

test('B9 侧栏用户卡同文去重：显示名与身份行文案碰撞时身份行不重复渲染', async () => {
  const h = await shellHarness();
  try {
    addEmployee(h.db, { username: 'boss', display_name: '实例管理员', is_instance_admin: 1 });
    addEmployee(h.db, { username: 'alice', display_name: '爱丽丝' });
    const boss = await h.get('/', 1);
    assert.ok(boss.includes('<span class="side-foot-name">实例管理员</span>'), '姓名=显示名');
    assert.ok(!boss.includes('side-foot-role'), '同文碰撞：身份行不重复渲染（B9）');
    const ali = await h.get('/', 2);
    assert.ok(ali.includes('<span class="side-foot-role">成员</span>'), '无碰撞：身份行保留');
  } finally {
    await h.close();
  }
});

// ── A1 全量接线：各页面顶栏徽章=显示名（审计 A1 的 10 处调用点回归） ─────────

test('A1 displayName 全量接线：库族/查找/草稿/管理各页顶栏徽章=显示名（爱丽丝）', async () => {
  const h = await browseHarness();
  try {
    const alice = addEmployee(h.db, { username: 'alice', display_name: '爱丽丝' });
    await seededVault(h, 'alpha', alice, {
      'README.md': '# Alpha',
      'docs/guide.md': '---\ntitle: "入门"\n---\n\n# 入门指南\n',
    });
    addMember(h.db, 1, alice, 'editor', alice);
    const pages = [
      '/vaults',
      '/vaults/alpha/browse',
      '/vaults/alpha/view/docs/guide.md',
      '/vaults/alpha/edit/docs/guide.md',
      '/vaults/alpha/history',
      '/vaults/alpha/activity',
      '/search?q=guide',
      '/drafts',
      '/cite',
    ];
    for (const url of pages) {
      const res = await h.app.inject({ method: 'GET', url, headers: h.session(alice) });
      assert.equal(res.statusCode, 200, `${url} 应 200（实际 ${res.statusCode}）`);
      assert.ok(
        res.body.includes('class="badge">爱丽丝</span>'),
        `${url} 顶栏徽章=显示名（A1 全量接线）`,
      );
    }
  } finally {
    await h.close();
  }
});

test('A1 displayName 接线：admin/credentials 页（viewer 附显示名）', async () => {
  const admin = adminPage({ username: 'boss', display_name: '库主管', is_instance_admin: true });
  assert.ok(admin.includes('class="badge">库主管</span>'), 'admin 页徽章=显示名');
  assert.ok(admin.includes('class="nav-user">boss'), 'admin 页用户名槽保留（异名）');
  const cred = credentialsPage({ username: 'boss', display_name: '库主管', is_instance_admin: true });
  assert.ok(cred.includes('class="badge">库主管</span>'), 'credentials 页徽章=显示名');
});

// ── A2/D40：:empty 守卫 ─────────────────────────────────────────────────────

test('A2 :empty 守卫：四类提示/警示/错误条与 token 窗空内容不呈现', async () => {
  const h = await browseHarness();
  try {
    const css = await (await h.app.inject({ method: 'GET', url: '/assets/styles.css' })).body;
    for (const cls of ['.form-warn:empty', '.notice:empty', '.op-error:empty', '.error-block:empty', 'pre.token-view:empty']) {
      assert.ok(css.includes(cls), `${cls} 守卫规则在位`);
    }
    assert.ok(
      /\.form-warn:empty, \.warn-block:empty, \.notice:empty,[\s\S]*?\.op-error:empty, \.error-block:empty, pre\.token-view:empty \{ display: none; \}/.test(css),
      ':empty 守卫统一 display:none',
    );
  } finally {
    await h.close();
  }
});

// ── A3/D40：token 容器默认隐藏 ──────────────────────────────────────────────

test('A3 token 区块默认隐藏：admin 两处（邀请/重置）与凭据一处 hidden，写入才展开', async () => {
  const h = await shellHarness();
  try {
    addEmployee(h.db, { username: 'boss', is_instance_admin: 1 });
    const admin = await h.get('/admin', 1);
    assert.equal(admin.split('class="token-block"').length - 1, 2, 'admin 页恰两个 token 区块（邀请+重置）');
    assert.ok(admin.includes('<div class="token-block" hidden>'), 'token 区块默认 hidden');
    assert.ok(/<div class="token-block" hidden>[\s\S]*?<pre id="invite-token"/.test(admin), '邀请说明文案随容器同显隐');
    assert.ok(/<div class="token-block" hidden>[\s\S]*?<pre id="reset-token"/.test(admin), '重置说明文案随容器同显隐');
    assert.ok(admin.includes('revealToken'), '写入即展开脚本在位');
    const cred = await h.get('/credentials', 1);
    assert.equal(cred.split('class="token-block"').length - 1, 1, '凭据页恰一个 token 区块');
    assert.ok(/<div class="token-block" hidden>[\s\S]*?<pre id="cred-token"/.test(cred), '凭据说明文案随容器同显隐');
    assert.ok(cred.includes('revealToken'), '凭据页写入即展开脚本在位');
  } finally {
    await h.close();
  }
});

// ── A7：admin 成员表空态隐藏表头 ────────────────────────────────────────────

test('A7 成员与角色管理：未加载时表头不裸露（包裹层默认 hidden，加载后才呈现）', async () => {
  const h = await shellHarness();
  try {
    addEmployee(h.db, { username: 'boss', is_instance_admin: 1 });
    const admin = await h.get('/admin', 1);
    assert.ok(
      /<div class="table-wrap table-scroll" id="members-table-wrap" hidden>/.test(admin),
      '成员表包裹层默认 hidden（A7 空态不裸表头）',
    );
    assert.ok(admin.includes(`document.getElementById('members-table-wrap').hidden = false`), '加载成功后才呈现表头');
  } finally {
    await h.close();
  }
});

// ── A4：favicon ─────────────────────────────────────────────────────────────

test('A4 favicon：<link rel="icon"> 在壳头；GET /favicon.ico 200 image/x-icon（ICO 魔数）', async () => {
  const h = await browseHarness();
  try {
    const res = await h.app.inject({ method: 'GET', url: '/favicon.ico' });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] as string, /image\/x-icon/);
    assert.equal(res.rawPayload[0], 0x00, 'ICO 魔数 reserved=0');
    assert.equal(res.rawPayload[2], 0x01, 'ICO 魔数 type=1（icon）');
    assert.ok(res.rawPayload.length > 100, '非空图标字节');
    const home = await (await h.app.inject({ method: 'GET', url: '/login' })).body;
    assert.ok(home.includes('<link rel="icon" href="/favicon.ico">'), '壳头 icon 链接在位');
  } finally {
    await h.close();
  }
});

// ── A5/D43 + A6/D43：表格横滚容器与 stat 卡单列（CSS 面） ────────────────────

test('A5/D43 数据表统一 .table-scroll：admin 两表横滚包裹在位（模板+CSS）', async () => {
  const sh = await shellHarness();
  try {
    addEmployee(sh.db, { username: 'boss', is_instance_admin: 1 });
    const admin = await sh.get('/admin', 1);
    assert.equal(admin.split('class="table-wrap table-scroll"').length - 1, 2, 'admin 页两表（员工/成员）均横滚包裹');
    const cred = await sh.get('/credentials', 1);
    assert.ok(cred.includes('class="table-wrap table-scroll"'), '凭据表同样包裹');
    const css = await (await sh.app.inject({ method: 'GET', url: '/assets/styles.css' })).body;
    assert.ok(/\.table-scroll \{ overflow-x: auto; \}/.test(css), '.table-scroll 横滚容器');
    assert.ok(/\.table-scroll table \{ min-width: max-content; \}/.test(css), '表格列按内容定宽（不压缩折行）');
  } finally {
    await sh.close();
  }
});

test('A6/D43 stat 卡防逐字竖排：≤680px 单列堆叠 + 值/标签整词换行语义', async () => {
  const h = await browseHarness();
  try {
    const css = await (await h.app.inject({ method: 'GET', url: '/assets/styles.css' })).body;
    assert.ok(/@media \(max-width: 680px\)[\s\S]*?\.stat-grid \{[^}]*grid-template-columns: 1fr;/.test(css), '≤680px stat 卡单列');
    assert.ok(/\.stat-value \{[^}]*overflow-wrap: break-word;/s.test(css), '值整词换行');
    assert.ok(/\.stat-label \{[^}]*overflow-wrap: break-word;/s.test(css), '标签整词换行');
  } finally {
    await h.close();
  }
});

// ── A8：编辑页「额外字段」label 精简 ────────────────────────────────────────

test('A8 编辑页「额外字段」label 精简为单行短文案（无 code 片段/长括号说明）', async () => {
  const h = await browseHarness();
  try {
    const alice = addEmployee(h.db, { username: 'alice', display_name: '爱丽丝' });
    await seededVault(h, 'alpha', alice, { 'docs/guide.md': '# 指南\n' });
    addMember(h.db, 1, alice, 'editor', alice);
    const edit = await (
      await h.app.inject({ method: 'GET', url: '/vaults/alpha/edit/docs/guide.md', headers: h.session(alice) })
    ).body;
    assert.ok(edit.includes('额外字段（YAML，每行 key: value）'), 'label=精简文案');
    assert.ok(!edit.includes('允许标量/列表/映射'), '旧长括号说明退场');
    assert.ok(!edit.includes('安全 YAML 值，每行 <code>key: value</code>'), '旧 code 片段形态退场');
  } finally {
    await h.close();
  }
});

// ── B2：页脚登录态去导航 ────────────────────────────────────────────────────

test('B2 页脚登录态去导航：登录态仅品牌+fine print；匿名壳保留三项链接', async () => {
  const h = await shellHarness();
  try {
    addEmployee(h.db, { username: 'pleb' });
    const home = await h.get('/', 1);
    assert.ok(home.includes('class="site-footer"'), '页脚在位');
    assert.ok(!home.includes('site-footer-links'), '登录态页脚不渲染导航（B2——侧栏唯一承担）');
    assert.ok(home.includes('class="foot-fine"'), 'fine print 保留');
    const login = await (await h.app.inject({ method: 'GET', url: '/login' })).body;
    assert.ok(login.includes('site-footer-links'), '匿名壳（登录页）页脚导航保留');
    assert.ok(login.includes('href="/search"') && login.includes('href="/cite"') && login.includes('href="/credentials"'), '三项链接齐备');
  } finally {
    await h.close();
  }
});

// ── B8/D42：库卡角色徽章=胶囊 chip ──────────────────────────────────────────

test('B8/D42 库卡角色徽章：胶囊 chip 类名在位，CSS 收回内容宽（不再通栏灰条）', async () => {
  const h = await browseHarness();
  try {
    const alice = addEmployee(h.db, { username: 'alice', display_name: '爱丽丝' });
    await seededVault(h, 'alpha', alice, { 'README.md': '# A' });
    addMember(h.db, 1, alice, 'editor', alice);
    const list = await (
      await h.app.inject({ method: 'GET', url: '/vaults', headers: h.session(alice) })
    ).body;
    assert.ok(/<a class="vault-card"[\s\S]*?<span class="badge">编辑者<\/span>/.test(list), '库卡角色=badge 胶囊 chip（§5）');
    const css = await (await h.app.inject({ method: 'GET', url: '/assets/styles.css' })).body;
    assert.ok(/\.vault-card \.badge \{ align-self: flex-start; \}/.test(css), '列向卡内徽章收回内容宽（D42）');
    assert.ok(/\.badge \{[^}]*border-radius: var\(--r-pill\)/s.test(css), 'badge 基形=胶囊 token（§3）');
  } finally {
    await h.close();
  }
});

// ── layout 壳：favicon 链接零脚本漂移（形态不破坏唯一内联 script 契约） ──────

test('layout 壳：icon 链接与样式链接同在 head，不新增 script 面', async () => {
  const page = layout('t', '<p>x</p>', '', undefined);
  assert.ok(page.includes('<link rel="icon" href="/favicon.ico">'));
  assert.ok(page.includes('<link rel="stylesheet" href="/assets/styles.css">'));
  assert.equal((page.match(/<script/g) ?? []).length, 1, '匿名壳恰一个内联 script 块');
});
