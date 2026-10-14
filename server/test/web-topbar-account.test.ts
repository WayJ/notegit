import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../src/app.ts';
import { createSession, DEFAULT_SESSION_TIMEOUTS } from '../src/auth/sessions.ts';
import { newDb, addEmployee, addVault, addMember } from './credentials-fixtures.ts';
import { citeUnresolvablePage, diffPage, versionPage } from '../src/web/history/pages.ts';

/**
 * S12-T2 顶栏账户菜单（G09；research F-9「登出仅首页」/P1-7 竞品通用顶栏形态）：
 * 全站共享布局右上=用户名+display_name 徽章+下拉（details 零 JS 形态）：我的凭据 /
 * 管理（仅实例管理员）/ 退出登录（调既有 POST /api/v1/auth/logout 后跳 /login）；
 * 顶栏新增「我的草稿」入口（authenticated 全员可见）；首页原有退出按钮移除
 * （登出控件随顶栏全域可用——id="logout" 由顶栏承担）；登录页无账户位。
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
  const app = buildApp({ db, pepper, bootstrapTokenFile: '/tmp/notegit-web-topbar-account.token' });
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

/** 单页 <script> 计数（外壳唯一脚本——顶栏脚本并入同一块） */
function scriptCount(body: string): number {
  return (body.match(/<script/g) ?? []).length;
}

// ── 三角色矩阵 ──────────────────────────────────────────────────────────────

test('匿名：GET / 302 /login；登录页 200 无顶栏账户位（无菜单/登出/草稿入口）', async () => {
  const h = await harness();
  try {
    const anon = await h.app.inject({ method: 'GET', url: '/' });
    assert.equal(anon.statusCode, 302);
    assert.equal(anon.headers.location, '/login');

    const login = await h.app.inject({ method: 'GET', url: '/login' });
    assert.equal(login.statusCode, 200);
    assert.ok(!login.body.includes('nav-account'), '登录页无顶栏账户位');
    assert.ok(!login.body.includes('退出登录'), '登录页无登出入口');
    assert.ok(!login.body.includes('id="logout"'), '登录页无登出控件');
    assert.ok(!login.body.includes('href="/drafts"'), '「我的草稿」仅认证后可见');
  } finally {
    await h.close();
  }
});

test('普通成员：顶栏账户菜单（用户名+display_name 徽章+下拉），全页无 /admin', async () => {
  const h = await harness();
  try {
    addEmployee(h.db, { username: 'alice', display_name: '爱丽丝' });
    const res = await h.app.inject({ method: 'GET', url: '/', headers: sidCookie(h.session(1)) });
    assert.equal(res.statusCode, 200);
    // 账户位：details 零 JS 下拉 + 用户名 + display_name 徽章（DESIGN.md badge token）
    assert.ok(res.body.includes('<details class="nav-account">'), '顶栏账户菜单（details 零 JS 形态）');
    assert.ok(res.body.includes('class="badge">爱丽丝'), 'display_name 徽章（DESIGN.md badge-pill token）');
    assert.ok(res.body.includes('class="nav-user">alice'), '用户名落位');
    // 下拉内容：凭据链接 + 登出控件；管理项不出现（普通成员）
    assert.ok(res.body.includes('href="/credentials"'), '下拉含我的凭据链接');
    assert.ok(res.body.includes('id="logout"'), '登出控件在顶栏（原首页按钮移除后由顶栏承担）');
    assert.ok(res.body.includes('退出登录'), '登出文案');
    assert.ok(res.body.includes("'/api/v1/auth/logout'"), '登出调既有 logout 端点');
    assert.ok(!res.body.includes('/admin'), '普通成员全页无管理入口（下拉亦然）');
    // 「我的草稿」顶栏入口（authenticated 全员可见）
    assert.ok(res.body.includes('href="/drafts"'), '顶栏「我的草稿」入口');
    // 顶栏脚本并入外壳唯一 <script> 块
    assert.equal(scriptCount(res.body), 1, '唯一 <script>（顶栏脚本不另开块）');
  } finally {
    await h.close();
  }
});

test('实例管理员：下拉含管理页链接', async () => {
  const h = await harness();
  try {
    addEmployee(h.db, { username: 'boss', is_instance_admin: 1 });
    const res = await h.app.inject({ method: 'GET', url: '/', headers: sidCookie(h.session(1)) });
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes('<details class="nav-account">'), '账户菜单');
    assert.ok(res.body.includes('href="/admin"'), '实例管理员下拉含管理页链接');
  } finally {
    await h.close();
  }
});

// ── 登出链（顶栏登出 → 既有端点 → 会话失效） ────────────────────────────────

test('顶栏登出链：POST /api/v1/auth/logout 204 → 旧会话访问 /drafts 与 / 均 302 /login', async () => {
  const h = await harness();
  try {
    const alice = addEmployee(h.db, { username: 'alice' });
    const sid = h.session(alice);
    const out = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { ...sidCookie(sid), origin: 'http://localhost' }, // 同源 fetch 形态（CSRF 链）
    });
    assert.equal(out.statusCode, 204, 'logout 端点幂等语义不变');
    for (const url of ['/drafts', '/']) {
      const res = await h.app.inject({ method: 'GET', url, headers: sidCookie(sid) });
      assert.equal(res.statusCode, 302, `${url} 旧会话失效 → 302`);
      assert.equal(res.headers.location, '/login');
    }
  } finally {
    await h.close();
  }
});

// ── 首页微调：原退出按钮移除（顶栏取代），布局其余保留 ──────────────────────

test('首页：原独立退出按钮移除（登出控件唯一=顶栏）；身份卡与入口卡布局保留', async () => {
  const h = await harness();
  try {
    addEmployee(h.db, { username: 'alice' });
    const res = await h.app.inject({ method: 'GET', url: '/', headers: sidCookie(h.session(1)) });
    assert.equal(res.statusCode, 200);
    assert.equal((res.body.match(/id="logout"/g) ?? []).length, 1, '登出控件唯一（顶栏一处）');
    assert.ok(!res.body.includes('logout-msg'), '原首页登出提示位移除');
    assert.ok(res.body.includes('class="card-grid"'), '入口卡片网格保留');
    assert.ok(res.body.includes('class="feature-card"'), 'feature-card 形态保留');
    assert.ok(res.body.includes('class="nav-side"'), '右侧簇（账户菜单 + 主 CTA）');
  } finally {
    await h.close();
  }
});

// ── 既有页面布局回归（顶栏加入后各页仍 200 且关键元素在位） ─────────────────

test('布局回归：/vaults /credentials /search /cite /admin 各页 200，关键元素在位，账户位与唯一 script 保持', async () => {
  const h = await harness();
  try {
    const alice = addEmployee(h.db, { username: 'alice' });
    const boss = addEmployee(h.db, { username: 'boss', is_instance_admin: 1 });
    const cases: { url: string; sid: number; marker: string; note: string }[] = [
      { url: '/vaults', sid: alice, marker: '知识库', note: '库列表页' },
      { url: '/credentials', sid: alice, marker: 'id="cred-form"', note: '凭据页表单' },
      { url: '/search', sid: alice, marker: 'class="search-form"', note: '查找页表单' },
      { url: '/cite', sid: alice, marker: 'class="form-card"', note: '引用解析页表单' },
      { url: '/admin', sid: boss, marker: 'class="admin-section"', note: '管理页分区卡' },
    ];
    for (const c of cases) {
      const res = await h.app.inject({ method: 'GET', url: c.url, headers: sidCookie(h.session(c.sid)) });
      assert.equal(res.statusCode, 200, `${c.url} 200`);
      assert.ok(res.body.includes(c.marker), `${c.note}关键元素在位`);
      assert.ok(res.body.includes('<details class="nav-account">'), `${c.url} 顶栏账户位`);
      assert.equal(scriptCount(res.body), 1, `${c.url} 唯一 <script>`);
    }
  } finally {
    await h.close();
  }
});

// ── 批准扩展（coordinator 2026-10-14）：cite 族与 history/upload/rename 域
//    状态页/深页补账户位（edit/ 域状态页本次不动——T1 并行持有，§13 待办记录） ──

test('cite 族：入口页与格式错误页（认证渲染）顶栏账户位', async () => {
  const h = await harness();
  try {
    const alice = addEmployee(h.db, { username: 'alice' });
    const entry = await h.app.inject({ method: 'GET', url: '/cite', headers: sidCookie(h.session(alice)) });
    assert.equal(entry.statusCode, 200);
    assert.ok(entry.body.includes('<details class="nav-account">'), '/cite 入口页账户位（导航目的地）');
    const bad = await h.app.inject({ method: 'GET', url: '/cite?c=nope', headers: sidCookie(h.session(alice)) });
    assert.equal(bad.statusCode, 404);
    assert.ok(bad.body.includes('引用格式无法解析'), '格式错误页形态');
    assert.ok(bad.body.includes('<details class="nav-account">'), '格式错误页（404 形态）账户位');
  } finally {
    await h.close();
  }
});

test('citeUnresolvablePage/diffPage/versionPage 模板：带 viewer 落账户位（角色分呈）；无 viewer 兼容渲染', () => {
  const member = { username: 'alice', is_instance_admin: false };
  const boss = { username: 'boss', is_instance_admin: true };
  const unresolvable = citeUnresolvablePage(member);
  assert.ok(unresolvable.includes('<details class="nav-account">'), 'unresolvable 页账户位');
  assert.ok(!unresolvable.includes('/admin'), '普通成员无管理链接');
  assert.ok(citeUnresolvablePage(boss).includes('href="/admin"'), '实例管理员含管理链接');
  const diff = diffPage({
    vault: { slug: 'alpha', name: 'Alpha' },
    commitOid: '0'.repeat(40),
    treePath: 'docs/a.md',
    diff: '+1',
    viewer: member,
  });
  assert.ok(diff.includes('<details class="nav-account">'), 'diff 页账户位');
  assert.ok(!diff.includes('/admin'));
  const version = versionPage({
    vault: { slug: 'alpha', name: 'Alpha' },
    commitOid: '0'.repeat(40),
    treePath: 'docs/a.md',
    sizeBytes: 8,
    body: { kind: 'no-preview' },
    viewer: boss,
  });
  assert.ok(version.includes('<details class="nav-account">'), '历史版本页账户位');
  assert.ok(version.includes('href="/admin"'), '实例管理员含管理链接');
  // 无 viewer 兼容（旧调用形态不崩、无账户位——渐进接线不破坏既有调用方）
  for (const bare of [citeUnresolvablePage(), diffPage({ vault: { slug: 'a', name: 'A' }, commitOid: '0'.repeat(40), treePath: 'x.md', diff: '' })]) {
    assert.ok(!bare.includes('nav-account'), '无 viewer 形态不落账户位（不虚构登录态）');
  }
});

test('状态页（存储未挂接形态）：history/upload/rename 状态页认证渲染顶栏账户位', async () => {
  const h = await harness();
  try {
    const alice = addEmployee(h.db, { username: 'alice' });
    const v = addVault(h.db, 'alpha', alice);
    addMember(h.db, v, alice, 'editor', alice);
    for (const url of ['/vaults/alpha/history', '/vaults/alpha/upload', '/vaults/alpha/rename/docs/a.md']) {
      const res = await h.app.inject({ method: 'GET', url, headers: sidCookie(h.session(alice)) });
      assert.equal(res.statusCode, 200, `${url} 200`);
      assert.ok(res.body.includes('内容暂不可用'), `${url} 状态页形态`);
      assert.ok(res.body.includes('<details class="nav-account">'), `${url} 状态页账户位`);
      assert.equal(scriptCount(res.body), 1, `${url} 唯一 <script>`);
    }
  } finally {
    await h.close();
  }
});
