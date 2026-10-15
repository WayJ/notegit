import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../src/app.ts';
import { createSession, DEFAULT_SESSION_TIMEOUTS } from '../src/auth/sessions.ts';
import { newDb, addEmployee, addVault, addMember } from './credentials-fixtures.ts';
import { editPage, readmeEditPage, newNotePage } from '../src/web/edit/pages.ts';
import { parseDocForForm } from '../src/web/edit/form.ts';

/**
 * S12-T3 共享脚本抽取（D19-A 第一步；sprint D5）：各页重复内联 api() fetch 封装
 * 抽为 GET /assets/app.js（普通 script 全局命名空间 window.ngt——零构建链/零
 * 模块面），login/admin/credentials/edit 四页机械改造引用——**行为零变化**
 * （语义与各页原内联实现逐字一致，本文件以形态断言锁定；页面行为面由既有
 * web-* 测试族全绿承担等价证明）。缓存/Content-Type 与 styles.css 同构
 * （assets.ts 既有约定：短缓存 public, max-age=3600）。
 */

interface Harness {
  app: ReturnType<typeof buildApp>;
  db: DatabaseSync;
  session(employeeId: number): string;
  close(): Promise<void>;
}

async function harness(opts?: { withVault?: boolean }): Promise<Harness & { alice?: number }> {
  const db = newDb();
  const pepper = { active: { version: 1, key: randomBytes(32) }, retired: [] as never[] };
  const app = buildApp({ db, pepper, bootstrapTokenFile: '/tmp/notegit-web-assets-test.token' });
  await app.ready();
  const now = new Date();
  let alice: number | undefined;
  if (opts?.withVault) {
    alice = addEmployee(db, { username: 'alice' });
    const v = addVault(db, 'alpha', alice);
    addMember(db, v, alice, 'editor', alice);
  }
  return {
    app,
    db,
    alice,
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

// ── 资产端点（与 /assets/styles.css 同构的注册面） ──────────────────────────

test('GET /assets/app.js：200 application/javascript + 协商缓存（styles.css 同构约定）', async () => {
  const h = await harness();
  try {
    const res = await h.app.inject({ method: 'GET', url: '/assets/app.js' });
    assert.equal(res.statusCode, 200, res.body);
    assert.match(res.headers['content-type'] as string, /^application\/javascript/);
    // 缓存热修（2026-10-15）：可变内容挂稳定 URL 不得配强缓存（v2 换轨日全体用户
    // 撞 1h 旧 CSS 墙）——改协商缓存：no-cache 每次重验证 + 内容 ETag，命中 304
    assert.equal(res.headers['cache-control'], 'no-cache', '稳定 URL 不配强缓存——重验证');
    assert.match(res.headers.etag as string, /^"[0-9a-f]{64}"$/, '内容 sha256 ETag');
    const res304 = await h.app.inject({
      method: 'GET',
      url: '/assets/app.js',
      headers: { 'if-none-match': res.headers.etag as string },
    });
    assert.equal(res304.statusCode, 304, 'If-None-Match 命中协商 304');
  } finally {
    await h.close();
  }
});

test('GET /assets/styles.css：ETag 协商缓存同构（内容变化→新 ETag→浏览器即时取新）', async () => {
  const h = await harness();
  try {
    const res = await h.app.inject({ method: 'GET', url: '/assets/styles.css' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['cache-control'], 'no-cache');
    assert.match(res.headers.etag as string, /^"[0-9a-f]{64}"$/);
    const miss = await h.app.inject({
      method: 'GET',
      url: '/assets/styles.css',
      headers: { 'if-none-match': '"0000000000000000000000000000000000000000000000000000000000000000"' },
    });
    assert.equal(miss.statusCode, 200, 'ETag 不匹配全量回送');
  } finally {
    await h.close();
  }
});

// ── 语义等价锁（形态断言）：请求组装 / 204 短路 / 两族错误信封 / show ───────
//    两族 = pages.ts 族（login/admin/credentials——message 取向 "code: message"）
//    与 edit 族（err.status/err.data 携带——422/409 分支所依）。抽取以各页现有
//    实现为准，不新增能力（无显式 Origin 头、无 401 跳登录——原内联亦无）。

test('共享脚本语义锁：请求组装/204 短路/两族错误信封/show 与原内联逐字一致；不新增能力', async () => {
  const h = await harness();
  try {
    const res = await h.app.inject({ method: 'GET', url: '/assets/app.js' });
    assert.equal(res.statusCode, 200, res.body);
    const js = res.body;
    // 全局命名空间（普通 script——无模块面/零构建链）
    assert.ok(js.includes('window.ngt'), '全局命名空间 window.ngt');
    assert.ok(!/\bimport\b|\bexport\b/.test(js), '无模块面（普通 script，D19-A 零构建链）');
    // 请求组装（两族共有原文）：无 body → 不带 content-type（GET 形态）；有 body → JSON 头与体
    assert.ok(js.includes('headers: body === undefined ? {} : { \'content-type\': \'application/json\' }'), '请求头组装原文');
    assert.ok(js.includes('body: body === undefined ? undefined : JSON.stringify(body)'), '请求体组装原文');
    // 204 短路（两族各一处——原内联同形）
    assert.equal((js.match(/res\.status === 204/g) ?? []).length, 2, '两族各含 204 短路');
    assert.ok(js.includes('await res.json().catch(() => ({}))'), 'JSON 解析容错回落 {}（两族共有）');
    // pages.ts 族错误信封原文（message 取向）
    assert.ok(
      js.includes("(err.code || res.status) + ': ' + (err.message || JSON.stringify(data))"),
      'pages.ts 族错误信封原文（code: message）',
    );
    // edit 族错误信封原文（结构化：status/data 携带 + message 取向）
    assert.ok(js.includes('e.status = res.status'), 'edit 族 err.status 携带（422/409 分支所依）');
    assert.ok(js.includes('e.data = data'), 'edit 族 err.data 携带（renderReport/409 tip 所依）');
    assert.ok(js.includes('(data.error && data.error.message) || res.status'), 'edit 族 message 构造原文');
    // show（pages.ts 族 FETCH_HELPER 同体件）
    assert.ok(js.includes('el.textContent = text'), 'show：textContent 注入（无 innerHTML）');
    // 不新增能力（原内联无显式 Origin 头、无 401 跳登录——共享化不得顺手加；
    // 断言引号形态=代码用法，注释行文不误伤）
    assert.ok(!js.includes("'Origin'") && !js.includes('"Origin"'), '不显式设 Origin 头（浏览器同源自动携带——原内联行为）');
    assert.ok(!js.includes("'/login'") && !js.includes('"/login"'), '无 401 跳登录（原内联无此能力）');
  } finally {
    await h.close();
  }
});

// ── 四页改造：引用共享脚本 + 去重（不再内联 api 定义） ─────────────────────

/** 页面断言：恰一个共享脚本 src 引用 + 不再内联 api() 定义（抽取到位） */
function assertSharedRef(body: string, label: string): void {
  assert.equal((body.match(/<script src="\/assets\/app\.js"><\/script>/g) ?? []).length, 1, `${label} 恰一个共享脚本 src 引用`);
  assert.ok(!body.includes('async function api('), `${label} 不再内联 api() 定义（去重）`);
  // 内联块仍恰一个（页面特有逻辑保留内联——每页一内联块的既有结构延续）
  assert.equal((body.match(/<script>\n/g) ?? []).length, 1, `${label} 唯一内联 script 块`);
}

test('四页引用：/login /admin /credentials 各含恰一个 src 引用且不再内联 api()；页面特有逻辑保留内联', async () => {
  const h = await harness();
  try {
    const boss = addEmployee(h.db, { username: 'boss', is_instance_admin: 1 });
    const login = await h.app.inject({ method: 'GET', url: '/login' });
    assert.equal(login.statusCode, 200);
    assertSharedRef(login.body, '/login');
    assert.ok(login.body.includes('/api/v1/auth/login'), '页面特有逻辑（登录提交）保留内联');

    const admin = await h.app.inject({ method: 'GET', url: '/admin', headers: sidCookie(h.session(boss)) });
    assert.equal(admin.statusCode, 200);
    assertSharedRef(admin.body, '/admin');
    assert.ok(admin.body.includes('/api/v1/admin/employees'), '页面特有逻辑（员工装载）保留内联');

    const alice = addEmployee(h.db, { username: 'alice' });
    const cred = await h.app.inject({ method: 'GET', url: '/credentials', headers: sidCookie(h.session(alice)) });
    assert.equal(cred.statusCode, 200);
    assertSharedRef(cred.body, '/credentials');
    assert.ok(cred.body.includes('/api/v1/credentials'), '页面特有逻辑（凭据装载）保留内联');
  } finally {
    await h.close();
  }
});

test('edit 域三页（六字段/README 豁免/新建）写者形态引用共享脚本且不再内联 api()；只读态零脚本引用（行为零变化）', () => {
  const vault = { slug: 'alpha', name: 'Alpha' };
  const prefill = parseDocForForm('');
  const viewer = { username: 'alice', is_instance_admin: false };
  const sixField = editPage({ vault, entryPath: 'docs/first.md', mode: 'edit', baseCommit: 'a'.repeat(40), prefill, viewer });
  assertSharedRef(sixField, '六字段编辑页');
  assert.ok(sixField.includes("await api('PUT', DRAFT_URL"), '页面特有调用面保留内联（别名解析共享实现）');
  const readme = readmeEditPage({ vault, entryPath: 'README.md', mode: 'edit', baseCommit: 'a'.repeat(40), body: '# R\n', viewer });
  assertSharedRef(readme, 'README 豁免页');
  const fresh = newNotePage({ vault, dir: 'docs', baseCommit: 'a'.repeat(40), prefill, viewer });
  assertSharedRef(fresh, '新建页');

  // 只读态（canWrite:false）：不携带交互脚本（既有行为）——不引共享脚本
  const ro = editPage({ vault, entryPath: 'docs/first.md', mode: 'edit', baseCommit: 'a'.repeat(40), prefill, viewer, canWrite: false });
  assert.ok(!ro.includes('/assets/app.js'), '只读态不引共享脚本（零脚本行为不变）');
  assert.ok(!ro.includes('async function api('), '只读态无 api 定义');
});
