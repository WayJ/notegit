import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../src/app.ts';
import { createSession, DEFAULT_SESSION_TIMEOUTS } from '../src/auth/sessions.ts';
import { newDb, addEmployee } from './credentials-fixtures.ts';

// S2-T8 最小页面（架构 §6 完整 Web 整理属 S4；「最小」=可用即可，无样式、无路由框架）：
// GET /login（登录表单）、GET /（入口页——管理入口仅实例管理员可见）、GET /admin（管理页
// 外壳）、GET /credentials（自助凭据页外壳）。数据经页面内 fetch 调 api.md 既有端点
// （同源 POST 自动带 Origin——T5 CSRF 守卫兼容）；页面路由本身 GET 免 CSRF。

interface Harness {
  app: ReturnType<typeof buildApp>;
  db: DatabaseSync;
  session(employeeId: number): string;
  close(): Promise<void>;
}

async function harness(): Promise<Harness> {
  const db = newDb();
  const pepper = { active: { version: 1, key: randomBytes(32) }, retired: [] as never[] };
  const app = buildApp({ db, pepper, bootstrapTokenFile: '/tmp/notegit-web-pages-test.token' });
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

// ── GET /login ──────────────────────────────────────────────────────────────

test('/login：公开 200 text/html，含登录表单与 fetch 同源提交脚本', async () => {
  const h = await harness();
  try {
    const res = await h.app.inject({ method: 'GET', url: '/login' });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] as string, /^text\/html/);
    assert.ok(res.body.includes('/api/v1/auth/login'), '登录脚本应调 api.md §3 login 端点');
    assert.ok(res.body.includes('name="username"'));
    assert.ok(res.body.includes('name="password"'));
  } finally {
    await h.close();
  }
});

// ── GET /（入口页：管理入口可见性 = 验收断言「普通成员看不到管理入口」） ──────

test('/ 未认证 → 302 /login', async () => {
  const h = await harness();
  try {
    const res = await h.app.inject({ method: 'GET', url: '/' });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/login');
  } finally {
    await h.close();
  }
});

test('/ 普通成员：200，含凭据页入口，不含管理入口（/admin 不出现在页面任何位置）', async () => {
  const h = await harness();
  try {
    addEmployee(h.db, { username: 'pleb' });
    const res = await h.app.inject({ method: 'GET', url: '/', headers: sidCookie(h.session(1)) });
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes('/credentials'), '自助凭据入口对全体员工可见');
    assert.ok(!res.body.includes('/admin'), '普通成员不得看到管理入口');
    assert.ok(res.body.includes('pleb'), '服务端渲染当前用户名');
  } finally {
    await h.close();
  }
});

test('/ 实例管理员：200，含管理入口与凭据页入口', async () => {
  const h = await harness();
  try {
    addEmployee(h.db, { username: 'boss', is_instance_admin: 1 });
    const res = await h.app.inject({ method: 'GET', url: '/', headers: sidCookie(h.session(1)) });
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes('/admin'), '实例管理员应看到管理入口');
    assert.ok(res.body.includes('/credentials'));
  } finally {
    await h.close();
  }
});

test('/ 停用账号会话：302 /login（零延迟语义在页面入口同样生效）', async () => {
  const h = await harness();
  try {
    const emp = addEmployee(h.db, { username: 'gone' });
    const sid = h.session(emp);
    h.db.prepare('UPDATE employees SET active = 0 WHERE id = ?').run(emp);
    const res = await h.app.inject({ method: 'GET', url: '/', headers: sidCookie(sid) });
    assert.equal(res.statusCode, 302);
  } finally {
    await h.close();
  }
});

// ── GET /admin（管理页：外壳 + 分区；数据由页面 fetch 既有端点装载） ─────────

test('/admin 未认证 → 302 /login；普通成员 → 403（页面层兜底，操作仍由 API 授权）', async () => {
  const h = await harness();
  try {
    const boss = addEmployee(h.db, { username: 'boss', is_instance_admin: 1 });
    addEmployee(h.db, { username: 'pleb' });
    const anon = await h.app.inject({ method: 'GET', url: '/admin' });
    assert.equal(anon.statusCode, 302);
    const pleb = await h.app.inject({ method: 'GET', url: '/admin', headers: sidCookie(h.session(2)) });
    assert.equal(pleb.statusCode, 403);
    const bossRes = await h.app.inject({ method: 'GET', url: '/admin', headers: sidCookie(h.session(boss)) });
    assert.equal(bossRes.statusCode, 200);
  } finally {
    await h.close();
  }
});

test('/admin 管理员：200，含员工管理/邀请/建库/成员角色/维护模式各分区与对应端点调用', async () => {
  const h = await harness();
  try {
    const boss = addEmployee(h.db, { username: 'boss', is_instance_admin: 1 });
    const res = await h.app.inject({ method: 'GET', url: '/admin', headers: sidCookie(h.session(boss)) });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] as string, /^text\/html/);
    const endpoints = [
      '/api/v1/admin/employees',            // 员工列表 + 邀请 + 停用/启用 + 重置口令
      '/api/v1/admin/employees/',           // PATCH /password-reset 路径前缀
      '/api/v1/vaults',                     // 建库 + 我的库（成员管理入口）
      '/api/v1/vaults/',                    // 成员管理 GET/PUT/DELETE …/members
      '/api/v1/admin/maintenance',          // 维护模式开关（T7 端点）
    ];
    for (const ep of endpoints) {
      assert.ok(res.body.includes(ep), `管理页脚本应调用 ${ep}`);
    }
  } finally {
    await h.close();
  }
});

// ── GET /credentials（自助凭据页） ──────────────────────────────────────────

test('/credentials 未认证 → 302；员工 → 200，含创建表单与列表/撤销（调 api.md §4 端点）', async () => {
  const h = await harness();
  try {
    addEmployee(h.db, { username: 'alice' });
    const anon = await h.app.inject({ method: 'GET', url: '/credentials' });
    assert.equal(anon.statusCode, 302);
    const res = await h.app.inject({ method: 'GET', url: '/credentials', headers: sidCookie(h.session(1)) });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] as string, /^text\/html/);
    assert.ok(res.body.includes('/api/v1/credentials'), '列表/创建/撤销均走 api.md §4 既有端点');
    assert.ok(res.body.includes('name="name"'));
    assert.ok(res.body.includes('name="expires_at"'), '到期必填（identity §3.5）');
  } finally {
    await h.close();
  }
});

// ── CSRF 兼容（Change 第 5 点：页面 fetch same-origin ↔ T5 守卫） ────────────

test('页面语境的会话写请求：带 Origin（同源 fetch 行为）→ 放行；缺 Origin/Referer → 403 E-AUTH-006', async () => {
  const h = await harness();
  try {
    const alice = addEmployee(h.db, { username: 'alice' });
    const sid = h.session(alice);
    // 同源 fetch：浏览器对非安全方法自动带 Origin（页面脚本的请求形态）
    const sameOrigin = await h.app.inject({
      method: 'POST', url: '/api/v1/credentials',
      headers: { ...sidCookie(sid), origin: 'http://localhost' },
      payload: { name: 'page-created', expires_at: new Date(Date.now() + 86_400_000).toISOString() },
    });
    assert.equal(sameOrigin.statusCode, 201, sameOrigin.body);
    // 无同源头（非浏览器形态）→ T5 守卫拒绝（E-AUTH-006）
    const hostile = await h.app.inject({
      method: 'DELETE', url: '/api/v1/credentials/1',
      headers: sidCookie(sid),
    });
    assert.equal(hostile.statusCode, 403);
    const err = hostile.json() as { error: { code: string } };
    assert.equal(err.error.code, 'E-AUTH-006');
  } finally {
    await h.close();
  }
});
