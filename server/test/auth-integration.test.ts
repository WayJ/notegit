import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../src/db/migrate.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { buildApp } from '../src/app.ts';
import { hashPassword } from '../src/auth/password.ts';

// 启动接线集成（app.ts SubjectResolver 缝，S2-T2 留给 S2-T3 的注释明示）：
// buildApp(deps) 注册 S2-T3 认证路由，且 T2 的管理员路由（invites）经同一会话
// 存储解析 ngt_sid Cookie——真实载体解析替换 fail-closed 默认（api.md §1）。

async function buildIntegratedApp(): Promise<{ app: ReturnType<typeof buildApp>; db: DatabaseSync }> {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db, MIGRATIONS);
  const app = buildApp({
    db,
    pepper: { active: { version: 1, key: randomBytes(32) }, retired: [] },
    bootstrapTokenFile: '/tmp/notegit-test-bootstrap.token',
  });
  return { app, db };
}

async function seedAdmin(db: DatabaseSync, username: string, admin: 0 | 1): Promise<void> {
  db.prepare(
    `INSERT INTO employees (username, display_name, password_hash, is_instance_admin, active, invited_by, created_at, deactivated_at)
     VALUES (?, ?, ?, ?, 1, NULL, '2026-10-01T00:00:00.000Z', NULL)`,
  ).run(username, username, await hashPassword(`password-${username}`), admin);
}

function sidOf(res: { headers: Record<string, unknown> }): string | null {
  const sc = res.headers['set-cookie'];
  const raw = Array.isArray(sc) ? sc.join(';') : (sc as string | undefined);
  return raw?.match(/ngt_sid=([^;]+)/)?.[1] ?? null;
}

test('集成：buildApp(deps) 挂载 S2-T3 认证路由（/api/v1/auth/login 可用）', async () => {
  const { app, db } = await buildIntegratedApp();
  await seedAdmin(db, 'boss', 1);
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'boss', password: 'password-boss' } });
  assert.equal(res.statusCode, 200, `login 应 200，实际 ${res.statusCode}: ${res.body}`);
  await app.close();
  db.close();
});

test('集成：T2 管理员路由经会话 Cookie 解析主体（替换 fail-closed 缝）', async () => {
  const { app, db } = await buildIntegratedApp();
  await seedAdmin(db, 'boss', 1);
  await seedAdmin(db, 'pleb', 0);
  const bossSid = sidOf(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'boss', password: 'password-boss' } }));
  const plebSid = sidOf(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'pleb', password: 'password-pleb' } }));
  assert.ok(bossSid && plebSid);

  // 无 Cookie → 401（缝的 fail-closed 语义保持）
  const anon = await app.inject({ method: 'POST', url: '/api/v1/admin/employees', payload: { username: 'newbie', display_name: 'New Bee' } });
  assert.equal(anon.statusCode, 401);
  // 管理员会话 → 201（真实主体解析生效，非注入桩）
  const invite = await app.inject({
    method: 'POST', url: '/api/v1/admin/employees',
    headers: { cookie: `ngt_sid=${bossSid}` },
    payload: { username: 'newbie', display_name: 'New Bee' },
  });
  assert.equal(invite.statusCode, 201, `管理员邀请应 201，实际 ${invite.statusCode}: ${invite.body}`);
  // 普通成员会话 → 403
  const forbidden = await app.inject({
    method: 'POST', url: '/api/v1/admin/employees',
    headers: { cookie: `ngt_sid=${plebSid}` },
    payload: { username: 'newbie2', display_name: 'New Bee 2' },
  });
  assert.equal(forbidden.statusCode, 403);
  await app.close();
  db.close();
});

test('集成：停用后 T2 管理路由同会话下一请求拒绝（零延迟跨路由一致；E-AUTH-004 精确细分）', async () => {
  const { app, db } = await buildIntegratedApp();
  await seedAdmin(db, 'boss', 1);
  const sid = sidOf(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'boss', password: 'password-boss' } }));
  db.prepare('UPDATE employees SET active = 0 WHERE username = ?').run('boss');
  const res = await app.inject({
    method: 'POST', url: '/api/v1/admin/employees',
    headers: { cookie: `ngt_sid=${sid}`, origin: 'http://localhost' },
    payload: { username: 'newbie', display_name: 'New Bee' },
  });
  assert.equal(res.statusCode, 401, '停用账号的管理请求应被拒');
  const err = res.json() as { error: { code: string; details: { reason: string } } };
  assert.equal(err.error.code, 'E-AUTH-004', '停用账号应精确 E-AUTH-004（S2-T5 统一缝修复）');
  assert.equal(err.error.details.reason, 'account_disabled');
  await app.close();
  db.close();
});
