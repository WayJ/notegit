import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../src/app.ts';
import { createSession, DEFAULT_SESSION_TIMEOUTS } from '../src/auth/sessions.ts';
import { newDb, addEmployee } from './credentials-fixtures.ts';
import { browseHarness, seededVault, addMember, type BrowseHarness } from './web-browse-fixtures.ts';

/**
 * S14-T2 应用壳特征断言（形态测试，锁 layout() 的三段壳契约）：
 *
 * - 三段壳：顶栏 `<header class="top-nav">` ＋ `<div class="app-shell">`
 *   （左侧分区导航 `<nav class="side-nav">` ＋ 内容区 `<main>`）＋ 页脚
 *   （DESIGN v2 修订：页脚浅色化——结构断言仍锁 site-footer 在位）。
 * - 侧栏五区（sprint D3/D4）：查找 /search、我的草稿 /drafts、引用解析 /cite、
 *   我的凭据 /credentials、管理 /admin（仅实例管理员）；当前区用 aria-current
 *   高亮——**零 JS**（侧栏不落任何内联脚本，D4）。
 * - 匿名/无导航壳不渲染侧栏（登录页 nav=undefined；403 兜底页同形态）。
 * - 导航可达性零回归（D2）：壳承载的链接集与改造前基线一致（链接零缺失）。
 * - 两档响应式断点（≤1020px 收窄侧栏＋隐藏次要表格列；≤680px 侧栏图标条＋
 *   表格按列优先级隐藏＋页面无横向滚动）在共享 CSS 中在位。
 *
 * 样式断言只锁**规则在位**（不测浏览器布局——无浏览器面）；视觉呈现由
 * web-ui-style.test.ts 的 token 断言与 master 抽检承担。
 */

interface Harness {
  app: ReturnType<typeof buildApp>;
  db: DatabaseSync;
  session(employeeId: number): string;
  close(): Promise<void>;
}

async function harness(): Promise<Harness> {
  const db = newDb();
  const pepper = { active: { version: 1, key: randomBytes(32) }, retired: [] as never[] };
  const app = buildApp({ db, pepper, bootstrapTokenFile: '/tmp/notegit-shell-sidebar.token' });
  await app.ready();
  const now = new Date();
  return {
    app,
    db,
    session(employeeId) {
      return createSession(db, employeeId, pepper.active.key, now, DEFAULT_SESSION_TIMEOUTS).sid;
    },
    close: async () => {
      await app.close();
      db.close();
    },
  };
}

function sidCookie(sid: string): Record<string, string> {
  return { cookie: `ngt_sid=${sid}` };
}

/** 页内 <script> 块数（形态断言：每页恰好一个内联块，src 引用另计——S12-T3 规则） */
function scriptCount(html: string): number {
  return (html.match(/<script/g) ?? []).length;
}

/** 页内链接 href 集合（壳可达性对照用——排序去重，与基线快照同口径） */
function linkSet(html: string): string[] {
  return [...new Set([...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!))].sort();
}

// ── 三段壳结构 ───────────────────────────────────────────────────────────────

test('三段壳：顶栏 → app-shell（侧栏＋内容区）→ 深色页脚，顺序与容器归属正确', async () => {
  const h = await harness();
  try {
    addEmployee(h.db, { username: 'alice' });
    const res = await h.app.inject({ method: 'GET', url: '/', headers: sidCookie(h.session(1)) });
    assert.equal(res.statusCode, 200);
    const body = res.body;
    const iTop = body.indexOf('<header class="top-nav">');
    const iShell = body.indexOf('class="app-shell"');
    const iSide = body.indexOf('class="side-nav"');
    const iMain = body.indexOf('<main>');
    const iFoot = body.indexOf('class="site-footer"');
    assert.ok(iTop >= 0, '顶栏在位');
    assert.ok(iShell >= 0, 'app-shell 容器在位（侧栏＋内容区的共同父）');
    assert.ok(iSide >= 0, '左侧分区导航在位');
    assert.ok(iMain >= 0, '内容区 main 在位');
    assert.ok(iFoot >= 0, '深色页脚在位');
    assert.ok(iTop < iShell && iShell < iFoot, '三段顺序：顶栏 → 壳 → 页脚');
    assert.ok(iSide < iMain, '壳内顺序：侧栏在内容区之前');
    // 侧栏与 main 同处 app-shell 容器内（容器开标签在侧栏之前、闭标签在 main 之后）
    assert.ok(body.indexOf('>', iShell) < iSide, '侧栏在 app-shell 开标签之后');
    assert.ok(body.indexOf('</div>', iMain) > iMain, 'app-shell 在 main 之后闭合');
    // S12 已验收资产不回归：顶栏品牌 / 账户菜单（details 零 JS）/ 主 CTA
    assert.ok(body.includes('class="brand"'), '顶栏字标保留');
    assert.ok(body.includes('<details class="nav-account">'), '顶栏账户菜单保留');
    assert.ok(body.includes('id="logout"'), '顶栏登出控件保留');
    // 主 CTA：首页 active='home' 时由首页自身承担（既有行为），非首页壳顶栏呈现
    const other = await h.app.inject({ method: 'GET', url: '/search', headers: sidCookie(h.session(1)) });
    assert.ok(other.body.includes('class="btn btn-primary" href="/vaults"'), '顶栏主 CTA 保留');
    // 每页恰好一个内联 <script> 块；侧栏不引入任何内联脚本（脚本零新增）
    assert.equal(scriptCount(body), 1, '首页仍唯一内联 script 块');
    const sideMarkup = body.slice(iSide, body.indexOf('</nav>', iSide));
    assert.ok(!sideMarkup.includes('<script'), '侧栏零 JS（D4）');
  } finally {
    await h.close();
  }
});

// ── 侧栏五区与 active 高亮 ──────────────────────────────────────────────────

test('侧栏五区：查找/我的草稿/引用解析/我的凭据/管理（href 与顶栏入口一致）', async () => {
  const h = await harness();
  try {
    addEmployee(h.db, { username: 'boss', is_instance_admin: 1 });
    const res = await h.app.inject({ method: 'GET', url: '/', headers: sidCookie(h.session(1)) });
    const side = res.body.slice(res.body.indexOf('class="side-nav"'), res.body.indexOf('</nav>'));
    assert.ok(side.length > 0, '侧栏在位');
    for (const href of ['/search', '/drafts', '/cite', '/credentials', '/admin']) {
      assert.ok(side.includes(`href="${href}"`), `侧栏含 ${href} 入口`);
    }
    for (const label of ['查找', '我的草稿', '引用解析', '我的凭据', '管理']) {
      assert.ok(side.includes(`<span class="side-nav-text">${label}</span>`), `侧栏含「${label}」标签`);
    }
    // 侧栏导航可访问名（导航 landmark 命名——零 JS 无障碍落位）
    assert.ok(res.body.includes('aria-label="分区导航"'), '侧栏为命名导航 landmark');
    assert.ok(scriptCount(res.body) === 1, '侧栏五区不新增脚本');
  } finally {
    await h.close();
  }
});

test('当前区高亮：aria-current 逐区正确（查找/草稿/引用解析/凭据/管理）', async () => {
  const h = await harness();
  try {
    addEmployee(h.db, { username: 'boss', is_instance_admin: 1 });
    const cases: readonly [string, string][] = [
      ['/search', '/search'],
      ['/drafts', '/drafts'],
      ['/cite', '/cite'],
      ['/credentials', '/credentials'],
      ['/admin', '/admin'],
    ];
    for (const [url, href] of cases) {
      const res = await h.app.inject({ method: 'GET', url, headers: sidCookie(h.session(1)) });
      assert.equal(res.statusCode, 200, url);
      // B 方案后登录态无横向菜单——匹配须属性序无关（侧栏链接 class 在 href 前）
      const marked = [...res.body.matchAll(/<a[^>]*href="([^"]+)" aria-current="page"/g)].map((m) => m[1]);
      assert.ok(marked.includes(href), `${url} 当前区高亮 ${href}（实得 ${JSON.stringify(marked)}）`);
      const sideStart = res.body.indexOf('class="side-nav"');
      const sideEnd = res.body.indexOf('</nav>', sideStart);
      const sideMarked = [...res.body.slice(sideStart, sideEnd).matchAll(/href="([^"]+)" aria-current="page"/g)]
        .map((m) => m[1]);
      assert.deepEqual(sideMarked, [href], `${url} 侧栏恰一处高亮且为当前区`);
    }
  } finally {
    await h.close();
  }
});

test('管理项仅实例管理员可见：普通成员全页任何位置不得出现 /admin', async () => {
  const h = await harness();
  try {
    addEmployee(h.db, { username: 'boss', is_instance_admin: 1 });
    addEmployee(h.db, { username: 'pleb' });
    const pleb = await h.app.inject({ method: 'GET', url: '/', headers: sidCookie(h.session(2)) });
    assert.ok(!pleb.body.includes('/admin'), '普通成员页面任何位置无 /admin（含侧栏）');
    const boss = await h.app.inject({ method: 'GET', url: '/', headers: sidCookie(h.session(1)) });
    const side = boss.body.slice(boss.body.indexOf('class="side-nav"'), boss.body.indexOf('</nav>'));
    assert.ok(side.includes('href="/admin"'), '实例管理员侧栏含管理入口');
  } finally {
    await h.close();
  }
});

// ── 匿名 / 无导航壳：无侧栏 ─────────────────────────────────────────────────

test('匿名壳无侧栏：登录页（nav=undefined）与 403/404 兜底页保持无侧栏形态', async () => {
  const h = await harness();
  try {
    addEmployee(h.db, { username: 'pleb' });
    const login = await h.app.inject({ method: 'GET', url: '/login' });
    assert.equal(login.statusCode, 200);
    assert.ok(!login.body.includes('class="side-nav"'), '登录页无侧栏');
    assert.ok(login.body.includes('<main>'), '登录页内容区仍在');
    // 403 兜底页（普通成员访问 /admin）——无导航壳形态
    const forbidden = await h.app.inject({ method: 'GET', url: '/admin', headers: sidCookie(h.session(1)) });
    assert.equal(forbidden.statusCode, 403);
    assert.ok(!forbidden.body.includes('class="side-nav"'), '403 页无侧栏');
    // 404（无权库=不存在同页）——同形态
    const missing = await h.app.inject({ method: 'GET', url: '/vaults/ghost/browse', headers: sidCookie(h.session(1)) });
    assert.equal(missing.statusCode, 404);
    assert.ok(!missing.body.includes('class="side-nav"'), '404 页无侧栏');
    // 未认证 302 /login 不回归
    const anon = await h.app.inject({ method: 'GET', url: '/' });
    assert.equal(anon.statusCode, 302);
    assert.equal(anon.headers.location, '/login');
  } finally {
    await h.close();
  }
});

// ── 导航可达性零回归（D2：链接集与改造前基线一致） ────────────────────────────

test('导航可达性：各页链接集与改造前基线一致（壳新增链接零缺失、href 零变化）', async () => {
  const h = await harness();
  try {
    addEmployee(h.db, { username: 'boss', is_instance_admin: 1 });
    const sid = sidCookie(h.session(1));
    // 基线快照（.agents/notes/2026-10-15-S14-shell-baseline.json）中 admin 角色各页
    // 的壳级链接集——顶栏入口 ＋ 账户菜单 ＋ 主 CTA ＋ 页脚，改造后须逐条仍在
    const expected = new Set([
      '/', '/assets/styles.css', '/search', '/cite', '/drafts', '/credentials', '/admin', '/vaults',
    ]);
    for (const url of ['/', '/search', '/drafts', '/cite', '/credentials', '/vaults', '/admin']) {
      const res = await h.app.inject({ method: 'GET', url, headers: sid });
      assert.equal(res.statusCode, 200, url);
      const links = new Set(linkSet(res.body));
      for (const href of expected) {
        assert.ok(links.has(href), `${url} 基线链接 ${href} 未丢失`);
      }
    }
  } finally {
    await h.close();
  }
});

test('侧栏在库内页同样在位（active=知识库区，侧栏五区不受库内页影响）', async () => {
  const b: BrowseHarness = await browseHarness();
  try {
    const alice = addEmployee(b.db, { username: 'alice' });
    await seededVault(b, 'alpha', alice, { 'README.md': '# Alpha\n' });
    addMember(b.db, 1, alice, 'editor', alice);
    const res = await b.app.inject({
      method: 'GET', url: '/vaults/alpha/browse', headers: b.session(alice),
    });
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes('class="side-nav"'), '库内页侧栏在位');
    const side = res.body.slice(res.body.indexOf('class="side-nav"'), res.body.indexOf('</nav>'));
    for (const href of ['/search', '/drafts', '/cite', '/credentials']) {
      assert.ok(side.includes(`href="${href}"`), `库内页侧栏含 ${href}`);
    }
    assert.ok(!side.includes('/admin'), '普通成员库内页侧栏无管理项');
    // 基线：库内页的既有链接零缺失
    const links = new Set(linkSet(res.body));
    for (const href of ['/', '/search', '/cite', '/drafts', '/credentials', '/vaults', '/vaults/alpha/browse', '/vaults/alpha/upload']) {
      assert.ok(links.has(href), `库内页基线链接 ${href} 未丢失`);
    }
  } finally {
    await b.close();
  }
});

// ── 两档响应式断点（DOD-E4-07 份额） ─────────────────────────────────────────

test('两档断点在共享 CSS 中在位：≤1020px 收窄侧栏＋隐藏次要表格列；≤680px 图标条＋列优先级隐藏＋无横向滚动', async () => {
  const h = await harness();
  try {
    const res = await h.app.inject({ method: 'GET', url: '/assets/styles.css' });
    assert.equal(res.statusCode, 200);
    const css = res.body;
    assert.ok(css.includes('@media (max-width: 1020px)'), '≤1020px 档在位');
    assert.ok(css.includes('@media (max-width: 680px)'), '≤680px 档在位');

    const mid = css.slice(css.indexOf('@media (max-width: 1020px)'), css.indexOf('@media (max-width: 680px)'));
    assert.ok(mid.includes('.side-nav'), '≤1020px 作用于侧栏（收窄）');
    assert.ok(mid.includes('.col-secondary'), '≤1020px 隐藏次要表格列');

    const narrow = css.slice(css.indexOf('@media (max-width: 680px)'));
    assert.ok(narrow.includes('.side-nav'), '≤680px 作用于侧栏（收成图标条）');
    assert.ok(narrow.includes('.col-tertiary'), '≤680px 表格按列优先级隐藏');
    assert.ok(/overflow-x:\s*hidden/.test(narrow), '≤680px 页面无横向滚动');

    // 既有 <768px 表格横滚兜底保留（不回归）
    assert.ok(css.includes('@media (max-width: 767px)'), '既有 <768px 兜底档保留');
    assert.ok(/\.table-wrap \{[^}]*overflow-x:\s*auto/.test(css), '表格包裹层横滚保留');
  } finally {
    await h.close();
  }
});

test('侧栏与两档断点样式零内联 hex、零第四表面色（只引用既有 DESIGN token）', async () => {
  const h = await harness();
  try {
    const res = await h.app.inject({ method: 'GET', url: '/assets/styles.css' });
    const css = res.body;
    // 侧栏区块（自 .side-nav 起到第一个响应式档为止）零 hex/rgba 字面量
    const sideStart = css.indexOf('.app-shell');
    assert.ok(sideStart > 0, 'app-shell 样式块在位');
    const sideBlock = css.slice(sideStart, css.indexOf('@media (max-width: 1020px)'));
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(sideBlock), '侧栏样式零内联 hex');
    assert.ok(!/rgba?\(/.test(sideBlock), '侧栏样式零内联 rgb/rgba');
    // DESIGN v2 修订（S16-T1 D3）：侧栏 token 族换 v2 名——canvas 底/line 右缘/
    // ink3 分区标签与辅助文字/ink2 控件字/tint 当前项底/accent-ink 当前项字
    for (const token of ['var(--canvas)', 'var(--line)', 'var(--ink3)', 'var(--ink2)', 'var(--tint)', 'var(--accent-ink)']) {
      assert.ok(sideBlock.includes(token), `侧栏样式引用 token ${token}`);
    }
    // DESIGN v2 修订：v1 token 退役——coral 主色/米色卡/发丝线不入侧栏
    // （单 accent 纪律：当前项=tint 底＋accent-ink 字，非主色底）
    assert.ok(!sideBlock.includes('var(--primary)'), '侧栏不用 v1 coral 主色（单 accent 纪律）');
    assert.ok(!sideBlock.includes('var(--surface-card)'), '侧栏不用 v1 米色卡');
    assert.ok(!sideBlock.includes('var(--hairline)'), '侧栏不用 v1 发丝线');
  } finally {
    await h.close();
  }
});

// ── master 裁决（B 方案，2026-10-15）：登录态唯一桌面导航=侧栏，匿名壳保留顶栏菜单 ──

test('B 方案：登录态壳不渲染顶栏横向主菜单（侧栏为唯一桌面导航），匿名壳保留原菜单', async () => {
  const h = await harness();
  try {
    addEmployee(h.db, { username: 'alice' });
    // 登录态页：侧栏在位、横向 nav-menu 不再渲染（桌面导航不重复两处）
    for (const url of ['/', '/credentials', '/search'] as const) {
      const res = await h.app.inject({ method: 'GET', url, headers: sidCookie(h.session(1)) });
      assert.equal(res.statusCode, 200, url);
      assert.ok(res.body.includes('class="side-nav"'), `${url} 侧栏在位`);
      assert.ok(!res.body.includes('class="nav-menu"'), `${url} 登录态不渲染顶栏横向菜单`);
      // 顶栏品牌与账户菜单仍在（S12 资产不回归）
      assert.ok(res.body.includes('class="brand"'), `${url} 品牌在位`);
      assert.ok(res.body.includes('class="nav-account"'), `${url} 账户菜单在位`);
    }
    // 匿名壳（登录页）：横向菜单保留（基线 /login 链接集 6 条不变）
    const login = await h.app.inject({ method: 'GET', url: '/login' });
    assert.ok(login.body.includes('class="nav-menu"'), '/login 匿名壳保留顶栏菜单');
    assert.ok(!login.body.includes('class="side-nav"'), '/login 无侧栏');
  } finally {
    await h.close();
  }
});
