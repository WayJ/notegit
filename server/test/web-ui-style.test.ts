import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../src/app.ts';
import { createSession, DEFAULT_SESSION_TIMEOUTS } from '../src/auth/sessions.ts';
import { newDb, addEmployee } from './credentials-fixtures.ts';
import { browseHarness, seededVault, addMember, gitOut, repoPathOf, type BrowseHarness } from './web-browse-fixtures.ts';
import { pushHistorySeries } from './web-history-fixtures.ts';

/**
 * UI-RESTYLE 特征断言（验收「HTML 特征断言测试」形态）：DESIGN.md 视觉契约的
 * 结构落位——共享样式端点、top-nav/页脚壳、token 类名（login 卡 / vault 卡 /
 * 目录列表 / 文档阅读 / 表单卡 / 深色 diff 窗 / 表格包裹层 / 主按钮）。
 * 只断言结构与类名（呈现层）；行为与安全断言在既有 web-* 测试族，不在此重复。
 * S16-T1（DESIGN v2 修订）：v1 字面值断言（米色/珊瑚/衬线 token 族）换 v2 值
 * 并逐处注释「DESIGN v2 修订」；结构/类名断言零改动（S16 D3）。
 */

// ── 样式基础设施：单一共享 CSS（DESIGN.md token 全值） ──────────────────────

test('GET /assets/styles.css：200 text/css，承载 DESIGN.md 设计 token', async () => {
  const db = newDb();
  const pepper = { active: { version: 1, key: randomBytes(32) }, retired: [] as never[] };
  const app = buildApp({ db, pepper, bootstrapTokenFile: '/tmp/notegit-ui-style.token' });
  await app.ready();
  try {
    const res = await app.inject({ method: 'GET', url: '/assets/styles.css' });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] as string, /^text\/css/);
    // DESIGN v2 修订（S16-T1 D3）：v2 token 全值在位（DESIGN.md §1 逐值，oklch 原样转录）
    for (const token of [
      '--page: oklch(0.985 0.001 286.376)', '--canvas: oklch(0.961 0.002 247.84)',
      '--surface: oklch(1 0 0)', '--inset: oklch(0.979 0.002 247.839)',
      '--hover: oklch(0.97 0.002 247.839)', '--line: oklch(0.946 0.003 264.542)',
      '--line-strong: oklch(0.912 0.005 258.326)',
      '--ink: oklch(0.247 0.006 258.361)', '--ink2: oklch(0.506 0.01 264.477)',
      '--ink3: oklch(0.695 0.009 264.505)',
      '--accent: oklch(0.626 0.205 254.947)', '--accent-ink: oklch(0.556 0.187 255.617)',
      '--tint: oklch(0.96 0.019 252.878)',
      '--green: oklch(0.603 0.155 150.883)', '--green-tint: oklch(0.958 0.017 159.118)',
      '--orange: oklch(0.689 0.179 49.902)', '--orange-ink: oklch(0.47 0.13 49.902)',
      '--orange-tint: oklch(0.964 0.021 67.581)', '--error: #c64545',
    ]) {
      assert.ok(res.body.includes(token), `样式应含 token ${token}`);
    }
    // DESIGN v2 修订（DOD-E5-01）：v1 token 零残留（grep 断言——主 CTA→--accent、
    // 卡片底→--surface、分隔→--line、深色代码面→#23272e，v1 名全数退役）
    for (const gone of ['--primary', '--surface-card', '--surface-soft', '--surface-cream-strong',
      '--surface-dark', '--hairline', '--font-display', 'Cormorant', '--accent-teal', '--accent-amber',
      '--on-primary', '--on-dark', '--body-strong', '--muted', '--success', '--warning']) {
      assert.ok(!res.body.includes(gone), `v1 token 应已退役：${gone}`);
    }
    // 编辑表单提交按钮的主按钮样式经作用域选择器（裸形态为直调断言所依）——结构断言不变
    assert.ok(res.body.includes('#edit-form button[type="submit"]'), '编辑提交按钮主按钮样式作用域');
    // DESIGN v2 修订：全站唯一字族 Inter（衬线 display 退役）＋ h1 −0.035em ＋
    // 品牌渐变方片（§1 品牌标记）＋ diff/代码深色面中性化 #23272e
    assert.ok(res.body.includes('--font-body: Inter'));
    assert.ok(res.body.includes('letter-spacing: -0.035em'));
    assert.ok(res.body.includes('linear-gradient(145deg,#1677ff,#53b6ff)'));
    assert.ok(res.body.includes('#23272e'));
  } finally {
    await app.close();
    db.close();
  }
});

// ── 共享壳：doctype 首位、单 script、样式链接、top-nav 与深色页脚 ───────────

interface Harness {
  app: ReturnType<typeof buildApp>;
  db: DatabaseSync;
  session(employeeId: number): string;
  close(): Promise<void>;
}

async function harness(): Promise<Harness> {
  const db = newDb();
  const pepper = { active: { version: 1, key: randomBytes(32) }, retired: [] as never[] };
  const app = buildApp({ db, pepper, bootstrapTokenFile: '/tmp/notegit-ui-style.token' });
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

test('页面壳：doctype 首位、script 形态（唯一内联块；S12-T3 改造页另恰一个 src 引用）、共享样式链接、top-nav 与深色页脚落位', async () => {
  const h = await harness();
  try {
    addEmployee(h.db, { username: 'alice' });
    // S12-T3：login/credentials 引用共享脚本 /assets/app.js（src 引用+内联块=2）；首页未改造（=1）
    for (const [url, scripts] of [['/login', 2], ['/', 1], ['/credentials', 2]] as const) {
      const res = await h.app.inject({ method: 'GET', url, headers: url === '/login' ? {} : sidCookie(h.session(1)) });
      assert.equal(res.statusCode, 200, url);
      assert.ok(res.body.startsWith('<!doctype html>'), `${url} doctype 首位`);
      assert.equal((res.body.match(/<script/g) ?? []).length, scripts, `${url} script 形态（${scripts === 2 ? 'src 引用+内联块' : '唯一内联块'}）`);
      assert.equal((res.body.match(/<\/script>/g) ?? []).length, scripts, `${url} 闭合标签与开标签同数`);
      assert.equal((res.body.match(/<script>\n/g) ?? []).length, 1, `${url} 唯一内联 script 块`);
      assert.ok(res.body.includes('<link rel="stylesheet" href="/assets/styles.css">'), `${url} 共享样式链接`);
      assert.ok(res.body.includes('class="top-nav"'), `${url} 顶部导航`);
      assert.ok(res.body.includes('class="brand"'), `${url} 字标`);
      // S14 master 裁决（B 方案）修订：横向主菜单仅匿名壳渲染；登录态唯一桌面
      // 导航=侧栏（side-nav）——原「三页均断言 nav-menu」改为分形态断言
      if (url === '/login') {
        assert.ok(res.body.includes('class="nav-menu"'), `${url} 匿名壳保留顶栏主菜单`);
        assert.ok(!res.body.includes('class="side-nav"'), `${url} 匿名壳无侧栏`);
      } else {
        assert.ok(res.body.includes('class="side-nav"'), `${url} 登录态侧栏在位`);
        assert.ok(!res.body.includes('class="nav-menu"'), `${url} 登录态不渲染横向菜单`);
      }
      // DESIGN v2 修订：页脚浅色化——断言仍只锁 site-footer 类在位（结构断言零改动）
      assert.ok(res.body.includes('class="site-footer"'), `${url} 页脚（v2 浅色）`);
    }
  } finally {
    await h.close();
  }
});

test('登录页：居中卡 + 珊瑚主按钮；导航无登录态用户名', async () => {
  const h = await harness();
  try {
    const res = await h.app.inject({ method: 'GET', url: '/login' });
    assert.ok(res.body.includes('class="login-card"'), '居中登录卡');
    assert.ok(res.body.includes('class="btn-primary">登录'), '主按钮（v2 accent 胶囊）承担页面 CTA');
    assert.ok(!res.body.includes('nav-user'), '未登录无登录态');
  } finally {
    await h.close();
  }
});

test('入口页（S14-T3 工作台）：概览三卡 + 登录态导航；普通成员全页无 /admin，管理员导航含管理项', async () => {
  const h = await harness();
  try {
    addEmployee(h.db, { username: 'boss', is_instance_admin: 1 });
    addEmployee(h.db, { username: 'pleb' });
    const plebRes = await h.app.inject({ method: 'GET', url: '/', headers: sidCookie(h.session(2)) });
    assert.ok(plebRes.body.includes('class="stat-grid"'), '概览三卡网格');
    assert.ok(plebRes.body.includes('class="stat-card"'), '概览卡形态');
    assert.ok(plebRes.body.includes('class="nav-user"'), '导航登录态');
    assert.ok(!plebRes.body.includes('/admin'), '普通成员导航与页面均无管理入口');
    const bossRes = await h.app.inject({ method: 'GET', url: '/', headers: sidCookie(h.session(1)) });
    assert.ok(bossRes.body.includes('href="/admin"'), '管理员导航含管理项');
    assert.ok(bossRes.body.includes('class="nav-side"'), '右侧簇（登录态 + 主 CTA）');
  } finally {
    await h.close();
  }
});

test('管理/凭据页：admin-section 分区卡、table-wrap 表格包裹、token-view 一次性令牌深色窗', async () => {
  const h = await harness();
  try {
    const boss = addEmployee(h.db, { username: 'boss', is_instance_admin: 1 });
    const adminRes = await h.app.inject({ method: 'GET', url: '/admin', headers: sidCookie(h.session(boss)) });
    assert.ok(adminRes.body.includes('class="admin-section"'), '分区卡');
    assert.ok(adminRes.body.includes('class="table-wrap"'), '表格包裹层（<768px 不溢出）');
    assert.ok(adminRes.body.includes('class="token-view"'), '一次性令牌深色窗');
    assert.ok(adminRes.body.includes('class="btn-primary"'), '表单主按钮');
    const credRes = await h.app.inject({ method: 'GET', url: '/credentials', headers: sidCookie(h.session(boss)) });
    assert.ok(credRes.body.includes('class="admin-section"'));
    assert.ok(credRes.body.includes('class="token-view"'));
  } finally {
    await h.close();
  }
});

// ── 真实仓库形态：浏览 / 阅读 / 编辑 / 上传 / 重命名 / 历史 / diff ───────────

async function seededVaultHarness(): Promise<{ h: BrowseHarness; alice: number }> {
  const h = await browseHarness();
  const alice = addEmployee(h.db, { username: 'alice' });
  await seededVault(h, 'alpha', alice, {
    'README.md': '# Alpha\n\n目录说明',
    'docs/getting-started.md': '---\ntitle: "入门"\n---\n\n# 入门指南\n\n正文段落。',
  });
  addMember(h.db, 1, alice, 'editor', alice);
  return { h, alice };
}

test('知识库列表：vault-card 卡片网格 + 角色徽章', async () => {
  const { h, alice } = await seededVaultHarness();
  try {
    const res = await h.app.inject({ method: 'GET', url: '/vaults', headers: h.session(alice) });
    assert.ok(res.body.includes('class="vault-grid"'), '卡片网格');
    assert.ok(res.body.includes('class="vault-card"'), '库卡片');
    assert.ok(res.body.includes('class="vault-name"'), '库名（v2 无衬线 600 卡片题）');
    assert.ok(res.body.includes('class="badge">编辑者'), '角色徽章 pill');
  } finally {
    await h.close();
  }
});

test('目录浏览：entries 列表 + type-tag 徽章 + README 导航卡；条目 data 属性保留', async () => {
  const { h, alice } = await seededVaultHarness();
  try {
    const res = await h.app.inject({
      method: 'GET', url: '/vaults/alpha/browse', headers: h.session(alice),
    });
    assert.ok(res.body.includes('class="entries"'), '条目列表');
    assert.ok(res.body.includes('class="type-tag">目录'), '类型徽章');
    assert.ok(res.body.includes('data-type="tree"'), '条目 data-type 保留（一致性所依）');
    assert.ok(res.body.includes('class="readme-card"'), 'README 米色导航卡');
    assert.ok(res.body.includes('aria-label="面包屑"'), '面包屑导航');
  } finally {
    await h.close();
  }
});

test('文档阅读：meta 徽章行 + article#doc 阅读排版容器', async () => {
  const { h, alice } = await seededVaultHarness();
  try {
    const res = await h.app.inject({
      method: 'GET', url: '/vaults/alpha/view/docs/getting-started.md', headers: h.session(alice),
    });
    assert.ok(res.body.includes('class="meta-badges"'), '元信息徽章行');
    assert.ok(/大小：\d+ 字节/.test(res.body), '大小元信息（文本形态保留）');
    assert.ok(res.body.includes('<article id="doc">'), '阅读排版容器（标题/正文排版由 CSS 承担）');
  } finally {
    await h.close();
  }
});

test('编辑页：form-card 表单卡、field-err 行内错误位、珊瑚提交 + 米色描边草稿按钮', async () => {
  const { h, alice } = await seededVaultHarness();
  try {
    const res = await h.app.inject({
      method: 'GET', url: '/vaults/alpha/edit/docs/getting-started.md', headers: h.session(alice),
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.ok(res.body.includes('class="form-card"'), '表单卡');
    assert.ok(res.body.includes('class="field-err" id="err-title"'), '行内错误位（E-码定位渲染落点）');
    assert.ok(res.body.includes('<button type="submit">提交'), '提交按钮（裸形态=直调断言所依）');
    assert.ok(res.body.includes('id="save-draft">保存草稿'), '保存草稿=默认（描边次按钮）');
  } finally {
    await h.close();
  }
});

test('上传/重命名/删除页：form-card + 珊瑚主按钮 + 取消链接', async () => {
  const { h, alice } = await seededVaultHarness();
  try {
    const up = await h.app.inject({
      method: 'GET', url: '/vaults/alpha/upload', headers: h.session(alice),
    });
    assert.ok(up.body.includes('class="form-card"'));
    assert.ok(up.body.includes('class="btn-primary">上传'));
    const ren = await h.app.inject({
      method: 'GET', url: '/vaults/alpha/rename/docs/getting-started.md', headers: h.session(alice),
    });
    assert.ok(ren.body.includes('class="btn-primary">保存重命名'));
    const del = await h.app.inject({
      method: 'GET', url: '/vaults/alpha/delete/docs/getting-started.md', headers: h.session(alice),
    });
    assert.ok(del.body.includes('class="btn-primary">确认删除'));
    assert.ok(del.body.includes('class="warn-block"'), '删除历史保留说明（warning 语义）');
  } finally {
    await h.close();
  }
});

test('历史与 diff：提交行卡列表 + 深色代码窗 diff（data-kind 行类保留）', async () => {
  const h = await browseHarness();
  try {
    const alice = addEmployee(h.db, { username: 'alice' });
    await seededVault(h, 'alpha', alice); // bare init（行 + 空仓库，提交由下方序列推入）
    addMember(h.db, 1, alice, 'reader', alice);
    await pushHistorySeries(h, 1, [
      { message: 'c1 建文档', files: { 'docs/a.md': '---\ntitle: "A"\n---\n\nv1\n' } },
      { message: 'c2 改a', files: { 'docs/a.md': '---\ntitle: "A"\n---\n\nv2 改动行\n' } },
    ]);
    const repo = repoPathOf(h, 1);
    const c2 = (await gitOut(['--git-dir', repo, 'rev-parse', 'HEAD'])).trim();
    const hist = await h.app.inject({
      method: 'GET', url: '/vaults/alpha/history/docs/a.md', headers: h.session(alice),
    });
    assert.ok(hist.body.includes('class="commits"'), '提交列表');
    assert.ok(hist.body.includes('class="commit" data-short='), '提交行卡（data 属性保留）');
    const diff = await h.app.inject({
      method: 'GET', url: `/vaults/alpha/diff/${c2}/docs/a.md`, headers: h.session(alice),
    });
    assert.equal(diff.statusCode, 200, diff.body);
    assert.ok(diff.body.includes('class="diff-body"'), 'diff 深色代码窗');
    assert.ok(diff.body.includes('class="diff-line" data-kind="add"'), '增行类别（行类保留）');
    assert.ok(diff.body.includes('class="diff-line" data-kind="del"'), '删行类别');
  } finally {
    await h.close();
  }
});

test('查找页：search-form 表单行 + 珊瑚查找按钮（空态）', async () => {
  const h = await harness();
  try {
    addEmployee(h.db, { username: 'alice' });
    const res = await h.app.inject({ method: 'GET', url: '/search', headers: sidCookie(h.session(1)) });
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes('class="search-form"'), '表单行');
    assert.ok(res.body.includes('class="btn-primary">查找'), 'accent 查找按钮');
  } finally {
    await h.close();
  }
});

test('引用解析入口：form-card + 珊瑚解析按钮（GET 表单文本形态保留）', async () => {
  const h = await harness();
  try {
    addEmployee(h.db, { username: 'alice' });
    const res = await h.app.inject({ method: 'GET', url: '/cite', headers: sidCookie(h.session(1)) });
    assert.ok(res.body.includes('<form method="get" action="/cite">'), 'GET 表单形态不变');
    assert.ok(res.body.includes('class="form-card"'));
    assert.ok(res.body.includes('class="btn-primary">解析'));
  } finally {
    await h.close();
  }
});

test('404 页：共享壳 + 居中卡', async () => {
  const h = await harness();
  try {
    addEmployee(h.db, { username: 'alice' });
    const res = await h.app.inject({ method: 'GET', url: '/vaults/ghost/browse', headers: sidCookie(h.session(1)) });
    assert.equal(res.statusCode, 404);
    assert.ok(res.body.startsWith('<!doctype html>'));
    assert.ok(res.body.includes('class="center-card"'), '居中 404 卡');
    assert.ok(res.body.includes('class="site-footer"'));
  } finally {
    await h.close();
  }
});
