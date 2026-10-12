import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db/connection.ts';
import { migrate } from '../src/db/migrate.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { loadOrCreatePepper } from '../src/bootstrap/pepper.ts';
import { ensureBootstrapToken } from '../src/bootstrap/token.ts';
import { buildApp, type Subject } from '../src/app.ts';

// 邀请创建账号流程（identity §2/§7.2，api.md §3.1/§3.2）：
// 实例管理员邀请 → 一次性口令重置令牌（明文仅一次）→ 员工设初始口令完成激活。

interface Harness {
  app: ReturnType<typeof buildApp>;
  db: ReturnType<typeof openDatabase>;
  subject: Subject | null;
  close(): Promise<void>;
}

async function makeInitialized(): Promise<Harness> {
  const dir = await mkdtemp(path.join(tmpdir(), 'notegit-inv-'));
  await mkdir(path.join(dir, 'db'), { recursive: true });
  const db = openDatabase(path.join(dir, 'db', 't.sqlite'));
  migrate(db, MIGRATIONS);
  const pepper = await loadOrCreatePepper(path.join(dir, 'keys', 'token-pepper.key'));
  const tokenFile = path.join(dir, 'config', 'admin-bootstrap.token');
  await ensureBootstrapToken(db, pepper, tokenFile, new Date());
  let subject: Subject | null = null;
  const app = buildApp({
    db,
    pepper,
    bootstrapTokenFile: tokenFile,
    hashPassword: async (p) => `stub-hash$${p}`,
    // 统一认证缝（S2-T5）：注入桩绕过载体解析（本套件聚焦邀请流程本身）
    authenticateRequest: () =>
      subject
        ? { ok: true, carrier: 'session', subject, carrierRef: 'session:stub', entry: 'web' }
        : { ok: false, carrier: null, code: 'E-AUTH-001', reason: 'unauthenticated' },
  });
  await app.ready();
  // 先完成 bootstrap 使实例进入已初始化态，并取管理员主体
  const bootToken = await readFile(tokenFile, 'utf8');
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/bootstrap',
    payload: { bootstrap_token: bootToken, username: 'root', display_name: 'Root', password: 'password-123456' },
  });
  assert.equal(res.statusCode, 201);
  const adminId = res.json().employee_id as number;
  subject = { employee_id: adminId, username: 'root', is_instance_admin: true };
  return {
    app,
    db,
    get subject() {
      return subject;
    },
    set subject(s) {
      subject = s;
    },
    close: async () => {
      await app.close();
      db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function invite(h: Harness, username = 'alice', displayName = 'Alice') {
  return h.app.inject({
    method: 'POST',
    url: '/api/v1/admin/employees',
    payload: { username, display_name: displayName },
  });
}

test('邀请全流程：管理员邀请 → 201 一次性令牌（明文仅一次）→ 员工设口令激活', async () => {
  const h = await makeInitialized();
  try {
    const res = await invite(h);
    assert.equal(res.statusCode, 201);
    const { username, password_reset_token } = res.json();
    assert.equal(username, 'alice');
    assert.match(password_reset_token, /^[A-Za-z0-9_-]{43}$/); // 32B base64url（K5）
    // 受邀员工行：无口令哨兵、非管理员、active、invited_by=管理员
    const row = h.db.prepare('SELECT password_hash, is_instance_admin, active, invited_by FROM employees WHERE username = ?').get('alice') as Record<string, unknown>;
    assert.equal(row.password_hash, '!invited-no-password');
    assert.equal(row.is_instance_admin, 0);
    assert.equal(row.active, 1);
    assert.equal(row.invited_by, h.subject?.employee_id);
    // 库内只存哈希：明文令牌不出现在任何表的可读内容里
    const dump = JSON.stringify([
      h.db.prepare('SELECT * FROM one_time_tokens').all(),
      h.db.prepare('SELECT * FROM employees').all(),
    ]);
    assert.ok(!dump.includes(password_reset_token), '明文令牌不得落入存储');
    // 员工设初始口令 → 激活
    const reset = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password-reset',
      payload: { reset_token: password_reset_token, new_password: 'initial-pass-123' },
    });
    assert.equal(reset.statusCode, 204);
    const after = h.db.prepare('SELECT password_hash FROM employees WHERE username = ?').get('alice') as { password_hash: string };
    assert.equal(after.password_hash, 'stub-hash$initial-pass-123');
    const tok = h.db.prepare("SELECT used_at FROM one_time_tokens WHERE purpose='password_reset'").get() as { used_at: string | null };
    assert.ok(tok.used_at !== null);
  } finally {
    await h.close();
  }
});

test('重置令牌单次：重放与错误令牌 → 401 E-AUTH-001；不改动口令', async () => {
  const h = await makeInitialized();
  try {
    const res = await invite(h, 'bob', 'Bob');
    const token = res.json().password_reset_token as string;
    const ok = await h.app.inject({ method: 'POST', url: '/api/v1/auth/password-reset', payload: { reset_token: token, new_password: 'good-pass-12345' } });
    assert.equal(ok.statusCode, 204);
    const replay = await h.app.inject({ method: 'POST', url: '/api/v1/auth/password-reset', payload: { reset_token: token, new_password: 'other-pass-6789' } });
    assert.equal(replay.statusCode, 401);
    assert.equal(replay.json().error.code, 'E-AUTH-001');
    const wrong = await h.app.inject({ method: 'POST', url: '/api/v1/auth/password-reset', payload: { reset_token: 'nonsense-token', new_password: 'good-pass-12345' } });
    assert.equal(wrong.statusCode, 401);
    const hash = h.db.prepare('SELECT password_hash FROM employees WHERE username = ?').get('bob') as { password_hash: string };
    assert.equal(hash.password_hash, 'stub-hash$good-pass-12345');
  } finally {
    await h.close();
  }
});

test('邀请权限：未认证 → 401 E-AUTH-001；非实例管理员 → 403 E-AUTHZ-001', async () => {
  const h = await makeInitialized();
  try {
    const adminId = h.subject?.employee_id as number;
    h.subject = null;
    const anon = await invite(h, 'x1', 'X');
    assert.equal(anon.statusCode, 401);
    assert.equal(anon.json().error.code, 'E-AUTH-001');
    // 受邀员工（非管理员）不能发起邀请
    h.subject = { employee_id: adminId, username: 'root', is_instance_admin: true };
    const invited = await invite(h, 'pleb', 'Pleb');
    assert.equal(invited.statusCode, 201);
    h.subject = { employee_id: 999, username: 'pleb', is_instance_admin: false };
    const forbidden = await invite(h, 'x2', 'X');
    assert.equal(forbidden.statusCode, 403);
    assert.equal(forbidden.json().error.code, 'E-AUTHZ-001');
    assert.equal(adminId >= 1, true);
  } finally {
    await h.close();
  }
});

test('邀请输入：重复用户名 → 409 E-RES-002；缺字段 → 400 E-RES-004', async () => {
  const h = await makeInitialized();
  try {
    assert.equal((await invite(h, 'dup', 'D')).statusCode, 201);
    const dup = await invite(h, 'dup', 'D2');
    assert.equal(dup.statusCode, 409);
    assert.equal(dup.json().error.code, 'E-RES-002');
    const missing = await h.app.inject({ method: 'POST', url: '/api/v1/admin/employees', payload: { username: 'no-display' } });
    assert.equal(missing.statusCode, 400);
    assert.equal(missing.json().error.code, 'E-RES-004');
  } finally {
    await h.close();
  }
});

test('重置口令策略不满足 → 422 E-AUTH-008 且令牌未消耗（可重试）', async () => {
  const h = await makeInitialized();
  try {
    const token = (await invite(h, 'carol', 'Carol')).json().password_reset_token as string;
    const bad = await h.app.inject({ method: 'POST', url: '/api/v1/auth/password-reset', payload: { reset_token: token, new_password: 'short' } });
    assert.equal(bad.statusCode, 422);
    assert.equal(bad.json().error.code, 'E-AUTH-008');
    const retry = await h.app.inject({ method: 'POST', url: '/api/v1/auth/password-reset', payload: { reset_token: token, new_password: 'proper-pass-123' } });
    assert.equal(retry.statusCode, 204);
  } finally {
    await h.close();
  }
});
