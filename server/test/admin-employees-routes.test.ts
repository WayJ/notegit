import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../src/app.ts';
import { createSession, DEFAULT_SESSION_TIMEOUTS } from '../src/auth/sessions.ts';
import { newDb } from './credentials-fixtures.ts';
import { randomBytes } from 'node:crypto';

// S2-T8：管理员页消费的两个 api.md §3.1 既有端点（此前未实现，architecture-notes §8.7-3 挂账）：
// GET  /api/v1/admin/employees（员工列表，分页 limit/cursor + next_cursor）
// POST /api/v1/admin/employees/{username}/password-reset（管理员发起 K5 重置令牌，明文仅一次）

interface Harness {
  app: ReturnType<typeof buildApp>;
  db: DatabaseSync;
  employee(username: string, opts?: { admin?: boolean; active?: boolean }): number;
  session(employeeId: number): string;
  close(): Promise<void>;
}

async function harness(): Promise<Harness> {
  const db = newDb();
  const pepper = { active: { version: 1, key: randomBytes(32) }, retired: [] as never[] };
  const app = buildApp({ db, pepper, bootstrapTokenFile: '/tmp/notegit-admin-employees-test.token' });
  await app.ready();
  const now = new Date();
  return {
    app,
    db,
    employee(username, opts) {
      db.prepare(
        `INSERT INTO employees (username, display_name, password_hash, is_instance_admin, active, invited_by, created_at)
         VALUES (?, ?, 'fixture-not-argon2', ?, ?, NULL, ?)`,
      ).run(username, username, opts?.admin ? 1 : 0, opts?.active === false ? 0 : 1, now.toISOString());
      return (db.prepare('SELECT id FROM employees WHERE username = ?').get(username) as { id: number }).id;
    },
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

function errOf(res: { json(): unknown }): { code?: string } {
  return ((res.json() as { error?: { code?: string } }).error ?? {}) as { code?: string };
}

// ── GET /api/v1/admin/employees（api.md §3.1） ──────────────────────────────

test('员工列表：实例管理员 200 {employees:[{username,display_name,active,is_instance_admin,created_at}], next_cursor:null}', async () => {
  const h = await harness();
  try {
    h.employee('boss', { admin: true });
    h.employee('alice');
    h.employee('bob');
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/admin/employees', headers: sidCookie(h.session(1)) });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as { employees: { username: string; display_name: string; active: boolean; is_instance_admin: boolean; created_at: string }[]; next_cursor: unknown };
    assert.equal(body.next_cursor, null);
    assert.deepEqual(
      body.employees.map((e) => ({ username: e.username, active: e.active, is_instance_admin: e.is_instance_admin })),
      [
        { username: 'alice', active: true, is_instance_admin: false },
        { username: 'bob', active: true, is_instance_admin: false },
        { username: 'boss', active: true, is_instance_admin: true },
      ],
    );
    for (const e of body.employees) {
      assert.equal(e.display_name, e.username);
      assert.match(e.created_at, /^\d{4}-\d{2}-\d{2}T/);
    }
  } finally {
    await h.close();
  }
});

test('员工列表：未认证 401；普通成员 403 E-AUTHZ-001', async () => {
  const h = await harness();
  try {
    h.employee('boss', { admin: true });
    h.employee('pleb');
    const anon = await h.app.inject({ method: 'GET', url: '/api/v1/admin/employees' });
    assert.equal(anon.statusCode, 401);
    const pleb = await h.app.inject({ method: 'GET', url: '/api/v1/admin/employees', headers: sidCookie(h.session(2)) });
    assert.equal(pleb.statusCode, 403);
    assert.equal(errOf(pleb).code, 'E-AUTHZ-001');
  } finally {
    await h.close();
  }
});

test('员工列表分页：limit + cursor（不透明游标），页满才给 next_cursor', async () => {
  const h = await harness();
  try {
    h.employee('boss', { admin: true });
    for (const u of ['a1', 'a2', 'a3', 'a4']) h.employee(u);
    const sid = h.session(1);
    const p1 = await h.app.inject({ method: 'GET', url: '/api/v1/admin/employees?limit=2', headers: sidCookie(sid) });
    assert.equal(p1.statusCode, 200);
    const b1 = p1.json() as { employees: { username: string }[]; next_cursor: string | null };
    assert.equal(b1.employees.length, 2);
    assert.equal(b1.employees[0]!.username, 'a1');
    assert.equal(b1.employees[1]!.username, 'a2');
    assert.ok(typeof b1.next_cursor === 'string' && b1.next_cursor.length > 0);
    const p2 = await h.app.inject({
      method: 'GET',
      url: `/api/v1/admin/employees?limit=2&cursor=${encodeURIComponent(b1.next_cursor)}`,
      headers: sidCookie(sid),
    });
    const b2 = p2.json() as { employees: { username: string }[]; next_cursor: string | null };
    assert.equal(b2.employees.length, 2);
    assert.equal(b2.employees[0]!.username, 'a3');
    assert.ok(b2.next_cursor, '整页仍有后续（boss 在 a4 之后）→ 游标非空');
    const p3 = await h.app.inject({
      method: 'GET',
      url: `/api/v1/admin/employees?limit=2&cursor=${encodeURIComponent(b2.next_cursor)}`,
      headers: sidCookie(sid),
    });
    const b3 = p3.json() as { employees: { username: string }[]; next_cursor: string | null };
    assert.deepEqual(b3.employees.map((e) => e.username), ['boss']);
    assert.equal(b3.next_cursor, null);
  } finally {
    await h.close();
  }
});

// ── POST /api/v1/admin/employees/{username}/password-reset（api.md §3.1） ────

test('管理员发起重置：200 {password_reset_token}（明文仅一次，K5）；令牌可消费换新口令并可登录', async () => {
  const h = await harness();
  try {
    const boss = h.employee('boss', { admin: true });
    h.employee('bob');
    const sid = h.session(boss);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/admin/employees/bob/password-reset',
      headers: { ...sidCookie(sid), origin: 'http://localhost' },
    });
    assert.equal(res.statusCode, 200, res.body);
    const { password_reset_token } = res.json() as { password_reset_token: string };
    assert.match(password_reset_token, /^[A-Za-z0-9_-]{43}$/); // 32B base64url（K5）
    // 响应外不落任何存储（明文仅一次；identity §3.1 同源原则）
    const dump = JSON.stringify(h.db.prepare('SELECT * FROM one_time_tokens').all());
    assert.ok(!dump.includes(password_reset_token), '明文令牌不得落入存储');
    // 消费：设新口令（公开端点，api.md §3.2）
    const consume = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password-reset',
      payload: { reset_token: password_reset_token, new_password: 'bob-new-password-123' },
    });
    assert.equal(consume.statusCode, 204, consume.body);
    // 新口令可真实登录（argon2 真实哈希——buildApp 缺省 hashPassword）
    const login = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'bob', password: 'bob-new-password-123' },
    });
    assert.equal(login.statusCode, 200, login.body);
    // 审计：管理员触发（主体=管理员+载体）与消费（主体=目标员工）各一行
    const rows = h.db
      .prepare('SELECT employee_id, credential_ref, entry, detail FROM audit_events WHERE event_kind = ? ORDER BY id')
      .all('employee.password_reset') as { employee_id: number | null; credential_ref: string | null; entry: string; detail: string }[];
    assert.equal(rows.length, 2, '触发 + 消费各一行');
    assert.equal(rows[0]!.employee_id, boss);
    assert.match(rows[0]!.credential_ref!, /^session:\d+$/);
    assert.ok((JSON.parse(rows[0]!.detail) as { username?: string }).username === 'bob');
    assert.equal(rows[1]!.employee_id, 2); // bob（消费行：K5 归属目标员工，credential_ref NULL）
    assert.equal(rows[1]!.credential_ref, null);
  } finally {
    await h.close();
  }
});

test('管理员发起重置：未认证 401；普通成员 403；目标不存在 404 E-RES-001', async () => {
  const h = await harness();
  try {
    const boss = h.employee('boss', { admin: true });
    h.employee('pleb');
    const anon = await h.app.inject({ method: 'POST', url: '/api/v1/admin/employees/pleb/password-reset' });
    assert.equal(anon.statusCode, 401);
    const pleb = await h.app.inject({
      method: 'POST',
      url: '/api/v1/admin/employees/pleb/password-reset',
      headers: { ...sidCookie(h.session(2)), origin: 'http://localhost' },
    });
    assert.equal(pleb.statusCode, 403);
    const missing = await h.app.inject({
      method: 'POST',
      url: '/api/v1/admin/employees/nobody/password-reset',
      headers: { ...sidCookie(h.session(boss)), origin: 'http://localhost' },
    });
    assert.equal(missing.statusCode, 404);
    assert.equal(errOf(missing).code, 'E-RES-001');
  } finally {
    await h.close();
  }
});

test('重置消费后该账号全部会话失效（api.md §3.2；T2 遗留欠账）', async () => {
  const h = await harness();
  try {
    const boss = h.employee('boss', { admin: true });
    h.employee('bob');
    // bob 两个在途会话（device A/B）
    const sidA = h.session(2);
    const sidB = h.session(2);
    // 管理员发起重置 → bob 消费
    const reset = await h.app.inject({
      method: 'POST',
      url: '/api/v1/admin/employees/bob/password-reset',
      headers: { ...sidCookie(h.session(boss)), origin: 'http://localhost' },
    });
    const { password_reset_token } = reset.json() as { password_reset_token: string };
    const consume = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password-reset',
      payload: { reset_token: password_reset_token, new_password: 'another-password-456' },
    });
    assert.equal(consume.statusCode, 204);
    // 两个旧会话下一请求均 401（会话行已删）
    for (const sid of [sidA, sidB]) {
      const res = await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: sidCookie(sid) });
      assert.equal(res.statusCode, 401, `旧会话 ${sid.slice(0, 8)}… 应失效`);
    }
    assert.equal((h.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE employee_id = 2').get() as { n: number }).n, 0);
    // 管理员自身会话不受影响
    const bossStill = await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: sidCookie(h.session(boss)) });
    assert.equal(bossStill.statusCode, 200);
  } finally {
    await h.close();
  }
});
