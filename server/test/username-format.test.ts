import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../src/app.ts';
import { createSession, DEFAULT_SESSION_TIMEOUTS } from '../src/auth/sessions.ts';
import { newDb } from './credentials-fixtures.ts';
import { ensureBootstrapToken } from '../src/bootstrap/token.ts';
import { randomBytes } from 'node:crypto';

// S37：username 显式格式校验（identity 契约 §2 补记）——裸名或 name@workspace 带域形态。
// 校验落点：POST /api/v1/admin/employees（邀请创建）与 POST /api/v1/auth/bootstrap。

interface Harness {
  app: ReturnType<typeof buildApp>;
  db: DatabaseSync;
  employee(username: string, opts?: { admin?: boolean }): number;
  session(employeeId: number): string;
  adminSid: string;
  close(): Promise<void>;
}

async function harness(): Promise<Harness> {
  const db = newDb();
  const pepper = { active: { version: 1, key: randomBytes(32) }, retired: [] as never[] };
  const app = buildApp({ db, pepper, bootstrapTokenFile: '/tmp/notegit-username-format-test.token' });
  await app.ready();
  const now = new Date();
  const employee = (username: string, opts?: { admin?: boolean }): number => {
    db.prepare(
      `INSERT INTO employees (username, display_name, password_hash, is_instance_admin, active, invited_by, created_at)
       VALUES (?, ?, 'fixture-not-argon2', ?, 1, NULL, ?)`,
    ).run(username, username, opts?.admin ? 1 : 0, now.toISOString());
    return (db.prepare('SELECT id FROM employees WHERE username = ?').get(username) as { id: number }).id;
  };
  const session = (employeeId: number): string => createSession(db, employeeId, pepper.active.key, now, DEFAULT_SESSION_TIMEOUTS).sid;
  const adminSid = session(employee('boss', { admin: true }));
  return { app, db, employee, session, adminSid, close: async () => { await app.close(); db.close(); } };
}

function sidCookie(sid: string): Record<string, string> {
  return { cookie: `ngt_sid=${sid}`, origin: 'http://localhost' };
}

function errOf(res: { json(): unknown }): { code?: string } {
  return ((res.json() as { error?: { code?: string } }).error ?? {}) as { code?: string };
}

async function invite(h: Harness, username: string): Promise<{ status: number; code?: string }> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/v1/admin/employees',
    headers: sidCookie(h.adminSid),
    payload: { username, display_name: '任意名' },
  });
  return { status: res.statusCode, code: errOf(res).code };
}

test('合法形态：存量裸名与新带域名均 201', async () => {
  const h = await harness();
  try {
    const bare = await invite(h, 'reader2');
    assert.equal(bare.status, 201);
    const dotted = await invite(h, 'a.b_c-d');
    assert.equal(dotted.status, 201);
    const domain = await invite(h, 'm42@company-a');
    assert.equal(domain.status, 201);
  } finally {
    await h.close();
  }
});

test('非法形态：大写/空格/连续@/前导点杠下划线/超长 → 400 E-RES-004', async () => {
  const h = await harness();
  try {
    for (const bad of ['Alice', 'm42@Company-A', 'm 42', 'a@b@c', '.lead', '-lead', '_lead', 'm42@', '@company-a', 'm42@-bad', 'x'.repeat(65)]) {
      const r = await invite(h, bad);
      assert.equal(r.status, 400, `username=${JSON.stringify(bad)} 应 400，实际 ${r.status}`);
      assert.equal(r.code, 'E-RES-004');
    }
  } finally {
    await h.close();
  }
});

test('带域形态边界：local 21 字符（首+20）内合法，超出 400', async () => {
  const h = await harness();
  try {
    const ok = await invite(h, `${'a'.repeat(21)}@${'d'.repeat(40)}`);
    assert.equal(ok.status, 201);
    const bad = await invite(h, `${'a'.repeat(22)}@${'d'.repeat(40)}`);
    assert.equal(bad.status, 400);
  } finally {
    await h.close();
  }
});

test('bootstrap 同一校验：非法 username → 400 E-RES-004', async () => {
  const db = newDb();
  const pepper = { active: { version: 1, key: randomBytes(32) }, retired: [] as never[] };
  const tokenFile = '/tmp/notegit-username-format-bootstrap.token';
  const { rmSync } = await import('node:fs');
  rmSync(tokenFile, { force: true });
  const app = buildApp({ db, pepper, bootstrapTokenFile: tokenFile });
  await ensureBootstrapToken(db, pepper, tokenFile, new Date());
  await app.ready();
  try {
    const { readFile } = await import('node:fs/promises');
    const token = (await readFile(tokenFile, 'utf8')).trim();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/bootstrap',
      payload: { bootstrap_token: token, username: 'Bad Name', display_name: 'x', password: 'a'.repeat(16) },
    });
    assert.equal(res.statusCode, 400, res.body);
    assert.equal(errOf(res).code, 'E-RES-004');
  } finally {
    await app.close();
    db.close();
    rmSync(tokenFile, { force: true });
  }
});
