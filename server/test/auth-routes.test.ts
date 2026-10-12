import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import fastify, { type FastifyInstance } from 'fastify';
import { migrate } from '../src/db/migrate.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { hashPassword } from '../src/auth/password.ts';
import { registerAuth } from '../src/auth/routes.ts';
import { FIXTURE_DDL } from './credentials-fixtures.ts';  // vaults 父表：审计写入（S2-T7 挂接）在 T6 的 0005 前需要

// api.md §3 身份与账号端点行为 + identity §2/§4/§5.2 语义：
// 登录（统一失败文案 / 退避 429 / 未初始化 503）、会话认证、
// 停用零延迟（完成标准 3）、口令重置全会话失效（完成标准 4）。

const BASE = Date.parse('2026-10-12T08:00:00.000Z');

interface TestApp {
  app: FastifyInstance;
  db: DatabaseSync;
  setNow: (ms: number) => void;
  nowMs: () => number;
}

async function buildAuthApp(overrides?: {
  session?: { idleTimeoutMs?: number; absoluteTimeoutMs?: number };
  backoff?: { maxFails?: number; baseDelayMs?: number; maxDelayMs?: number; windowMs?: number };
}): Promise<TestApp> {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db, MIGRATIONS);
  for (const ddl of FIXTURE_DDL) db.exec(ddl);  // audit_events.vault_id 外键父表（合并后 no-op）
  let nowMs = BASE;
  const app = fastify();
  await app.register(registerAuth, {
    db,
    pepper: randomBytes(32),
    now: () => new Date(nowMs),
    ...overrides,
  });
  return {
    app,
    db,
    setNow: (ms) => {
      nowMs = ms;
    },
    nowMs: () => nowMs,
  };
}

async function seedEmployee(
  db: DatabaseSync,
  spec: { username: string; password: string; active?: number; admin?: number },
): Promise<number> {
  const hash = await hashPassword(spec.password);
  db.prepare(
    `INSERT INTO employees (username, display_name, password_hash, is_instance_admin, active, invited_by, created_at, deactivated_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, NULL)`,
  ).run(spec.username, spec.username, hash, spec.admin ?? 0, spec.active ?? 1, '2026-10-01T00:00:00.000Z');
  return (db.prepare('SELECT id FROM employees WHERE username = ?').get(spec.username) as { id: number }).id;
}

function login(app: FastifyInstance, username: string, password: string, ip?: string) {
  return app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password }, remoteAddress: ip });
}

function sidOf(res: { headers: Record<string, unknown> }): string | null {
  const sc = res.headers['set-cookie'];
  const raw = Array.isArray(sc) ? sc.join(';') : (sc as string | undefined);
  const m = raw?.match(/ngt_sid=([^;]+)/);
  return m?.[1] ?? null;
}

function withSid(sid: string | null) {
  return sid === null ? {} : { cookie: `ngt_sid=${sid}` };
}

function err(res: { statusCode: number } & { json(): unknown }): { code?: string; message?: string; details?: { reason?: string } } {
  return ((res.json() as { error?: Record<string, unknown> }).error ?? {}) as { code?: string; message?: string; details?: { reason?: string } };
}

test('登录成功：200 + Set-Cookie ngt_sid（HttpOnly; Secure; SameSite=Lax）+ 新 ID 防固定', async () => {
  const t = await buildAuthApp();
  await seedEmployee(t.db, { username: 'alice', password: 'password-alice-1' });
  const res = await login(t.app, 'alice', 'password-alice-1');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(Object.keys(res.json()).sort(), ['display_name', 'is_instance_admin', 'username']);
  const cookie = (res.headers['set-cookie'] as string) ?? '';
  assert.match(cookie, /ngt_sid=/);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /Secure/i);
  assert.match(cookie, /SameSite=Lax/i);
  const sid1 = sidOf(res);
  const res2 = await login(t.app, 'alice', 'password-alice-1');
  assert.notEqual(sidOf(res2), sid1, '每次登录重发新 ID（会话固定防护，identity §4）');
  await t.app.close();
});

test('登录失败统一文案 E-AUTH-001：口令错误与用户名不存在响应完全一致', async () => {
  const t = await buildAuthApp();
  await seedEmployee(t.db, { username: 'alice', password: 'password-alice-1' });
  const wrongPw = await login(t.app, 'alice', 'wrong-password-x');
  const noUser = await login(t.app, 'nobody', 'whatever-passy');
  assert.equal(wrongPw.statusCode, 401);
  assert.equal(noUser.statusCode, 401);
  assert.deepEqual(err(wrongPw), { code: 'E-AUTH-001', message: '用户名或口令错误' });
  assert.deepEqual(err(noUser), err(wrongPw), '不区分用户名是否存在（identity §2 统一失败文案）');
  await t.app.close();
});

test('停用账号登录 → 401 E-AUTH-001 统一文案（登录错误映射仅 001/005/503）', async () => {
  const t = await buildAuthApp();
  await seedEmployee(t.db, { username: 'gone', password: 'password-gone-1', active: 0 });
  const res = await login(t.app, 'gone', 'password-gone-1');
  assert.equal(res.statusCode, 401);
  assert.deepEqual(err(res), { code: 'E-AUTH-001', message: '用户名或口令错误' });
  await t.app.close();
});

test('未初始化（employees 空）登录 → 503 E-AUTH-007', async () => {
  const t = await buildAuthApp();
  const res = await login(t.app, 'anyone', 'password-anyone');
  assert.equal(res.statusCode, 503);
  assert.equal(err(res).code, 'E-AUTH-007');
  await t.app.close();
});

test('请求形态错误 → 400 E-RES-004（缺 username / 非 JSON 形态）', async () => {
  const t = await buildAuthApp();
  await seedEmployee(t.db, { username: 'alice', password: 'password-alice-1' });
  const res = await t.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { password: 'x'.repeat(12) } });
  assert.equal(res.statusCode, 400);
  assert.equal(err(res).code, 'E-RES-004');
  await t.app.close();
});

test('连续失败后 429 E-AUTH-005 + Retry-After；无永久锁定：窗口过后正确口令可登录', async () => {
  const t = await buildAuthApp({ backoff: { maxFails: 3, baseDelayMs: 1000, maxDelayMs: 30000, windowMs: 60_000 } });
  await seedEmployee(t.db, { username: 'alice', password: 'password-alice-1' });
  for (let i = 0; i < 4; i++) {
    const r = await login(t.app, 'alice', 'wrong-password-x');
    assert.equal(r.statusCode, 401, `第 ${i + 1} 次失败应为 401`);
  }
  // 第 5 次尝试（即使口令正确）在退避窗口内 → 429 + Retry-After（api.md E-AUTH-005）
  const blocked = await login(t.app, 'alice', 'password-alice-1');
  assert.equal(blocked.statusCode, 429);
  assert.equal(err(blocked).code, 'E-AUTH-005');
  assert.ok(Number(blocked.headers['retry-after']) >= 1, '应带 Retry-After（秒）');
  // 推进假时钟越过锁窗口 → 正确口令登录成功（无永久锁定）
  t.setNow(t.nowMs() + 2000);
  const ok = await login(t.app, 'alice', 'password-alice-1');
  assert.equal(ok.statusCode, 200);
  await t.app.close();
});

test('退避键 = 账号 + IP：同账号换 IP 可正常登录', async () => {
  const t = await buildAuthApp({ backoff: { maxFails: 3, baseDelayMs: 1000, maxDelayMs: 30000, windowMs: 60_000 } });
  await seedEmployee(t.db, { username: 'alice', password: 'password-alice-1' });
  for (let i = 0; i < 6; i++) await login(t.app, 'alice', 'wrong-password-x', '203.0.113.9');
  const otherIp = await login(t.app, 'alice', 'password-alice-1', '198.51.100.7');
  assert.equal(otherIp.statusCode, 200, '不同来源 IP 不连带');
  await t.app.close();
});

test('GET /me：有效会话 200；无 Cookie → 401 E-AUTH-001', async () => {
  const t = await buildAuthApp();
  await seedEmployee(t.db, { username: 'alice', password: 'password-alice-1' });
  const sid = sidOf(await login(t.app, 'alice', 'password-alice-1'));
  assert.ok(sid);
  const me = await t.app.inject({ method: 'GET', url: '/api/v1/me', headers: withSid(sid) });
  assert.equal(me.statusCode, 200);
  assert.deepEqual(me.json(), { username: 'alice', display_name: 'alice', is_instance_admin: false, active: true });
  const anon = await t.app.inject({ method: 'GET', url: '/api/v1/me' });
  assert.equal(anon.statusCode, 401);
  assert.equal(err(anon).code, 'E-AUTH-001');
  await t.app.close();
});

test('会话过期：idle 超时后 401 E-AUTH-001（identity §4 滑动窗口判定）', async () => {
  const t = await buildAuthApp({ session: { idleTimeoutMs: 60_000, absoluteTimeoutMs: 24 * 3600_000 } });
  await seedEmployee(t.db, { username: 'alice', password: 'password-alice-1' });
  const sid = sidOf(await login(t.app, 'alice', 'password-alice-1'));
  t.setNow(t.nowMs() + 61_000);
  const res = await t.app.inject({ method: 'GET', url: '/api/v1/me', headers: withSid(sid) });
  assert.equal(res.statusCode, 401);
  assert.equal(err(res).code, 'E-AUTH-001');
  await t.app.close();
});

test('会话过期：absolute 超时后 401（不断续期也逃不掉）', async () => {
  const t = await buildAuthApp({ session: { idleTimeoutMs: 60_000, absoluteTimeoutMs: 120_000 } });
  await seedEmployee(t.db, { username: 'alice', password: 'password-alice-1' });
  const sid = sidOf(await login(t.app, 'alice', 'password-alice-1'));
  // 每 30s 活跃一次（保持 idle 存活），越过 absolute 上限
  for (let i = 0; i < 5; i++) {
    t.setNow(t.nowMs() + 30_000);
    const r = await t.app.inject({ method: 'GET', url: '/api/v1/me', headers: withSid(sid) });
    if (i < 3) assert.equal(r.statusCode, 200, `第 ${i + 1} 次活跃请求应 200`);
    else assert.equal(r.statusCode, 401, `越过 absolute 上限后应 401`);
  }
  await t.app.close();
});

test('完成标准 3 —— 停用零延迟：PATCH active:false 后该会话下一请求 401 E-AUTH-004，行未删除（逐请求查库）', async () => {
  const t = await buildAuthApp();
  await seedEmployee(t.db, { username: 'boss', password: 'password-boss-1', admin: 1 });
  const targetId = await seedEmployee(t.db, { username: 'victim', password: 'password-victim' });
  const bossSid = sidOf(await login(t.app, 'boss', 'password-boss-1'));
  const victimSid = sidOf(await login(t.app, 'victim', 'password-victim'));
  // 停用前目标会话有效
  const before = await t.app.inject({ method: 'GET', url: '/api/v1/me', headers: withSid(victimSid) });
  assert.equal(before.statusCode, 200);
  // 管理员停用
  const patch = await t.app.inject({
    method: 'PATCH',
    url: '/api/v1/admin/employees/victim',
    headers: withSid(bossSid),
    payload: { active: false },
  });
  assert.equal(patch.statusCode, 204);
  assert.equal(
    (t.db.prepare('SELECT deactivated_at FROM employees WHERE id = ?').get(targetId) as { deactivated_at: string | null }).deactivated_at,
    new Date(t.nowMs()).toISOString(),
    'deactivated_at 记录停用时间',
  );
  // 零延迟：同一会话下一请求立即被登出（E-AUTH-004，identity §5.2）
  const after = await t.app.inject({ method: 'GET', url: '/api/v1/me', headers: withSid(victimSid) });
  assert.equal(after.statusCode, 401);
  assert.equal(err(after).code, 'E-AUTH-004');
  assert.equal(err(after).details?.reason, 'account_disabled');
  assert.match((after.headers['set-cookie'] as string) ?? '', /ngt_sid=;?\s*.*Max-Age=0|ngt_sid=;\s/, '登出应清除 Cookie');
  // 会话行仍在（生效来自认证层逐请求查 active，而非删除行——storage-model §4 authn.session）
  const rows = t.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE employee_id = ?').get(targetId) as { n: number };
  assert.equal(rows.n, 1, '停用不删除会话行（零延迟语义来自逐请求检查）');
  // 其他账号不受影响
  const bossStill = await t.app.inject({ method: 'GET', url: '/api/v1/me', headers: withSid(bossSid) });
  assert.equal(bossStill.statusCode, 200);
  // 重新启用后该会话恢复可用（行未删、账号回 active）
  await t.app.inject({ method: 'PATCH', url: '/api/v1/admin/employees/victim', headers: withSid(bossSid), payload: { active: true } });
  const revived = await t.app.inject({ method: 'GET', url: '/api/v1/me', headers: withSid(victimSid) });
  assert.equal(revived.statusCode, 200, '重新启用后会话行仍在且账号 active，会话恢复');
  await t.app.close();
});

test('PATCH 权限与目标：非管理员 403 E-AUTHZ-001；未知用户 404 E-RES-001', async () => {
  const t = await buildAuthApp();
  await seedEmployee(t.db, { username: 'boss', password: 'password-boss-1', admin: 1 });
  await seedEmployee(t.db, { username: 'pleb', password: 'password-pleb-12' });
  const bossSid = sidOf(await login(t.app, 'boss', 'password-boss-1'));
  const plebSid = sidOf(await login(t.app, 'pleb', 'password-pleb-12'));
  const forbidden = await t.app.inject({
    method: 'PATCH', url: '/api/v1/admin/employees/pleb', headers: withSid(plebSid), payload: { active: false },
  });
  assert.equal(forbidden.statusCode, 403);
  assert.equal(err(forbidden).code, 'E-AUTHZ-001');
  const missing = await t.app.inject({
    method: 'PATCH', url: '/api/v1/admin/employees/ghost', headers: withSid(bossSid), payload: { active: false },
  });
  assert.equal(missing.statusCode, 404);
  assert.equal(err(missing).code, 'E-RES-001');
  await t.app.close();
});

test('完成标准 4 —— 重置口令后全部会话 401、行删除、旧口令失效、新口令可登录', async () => {
  const t = await buildAuthApp();
  await seedEmployee(t.db, { username: 'alice', password: 'password-alice-1' });
  const sidA = sidOf(await login(t.app, 'alice', 'password-alice-1'));
  const sidB = sidOf(await login(t.app, 'alice', 'password-alice-1'));
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/v1/me/password',
    headers: withSid(sidA),
    payload: { current_password: 'password-alice-1', new_password: 'password-alice-2' },
  });
  assert.equal(res.statusCode, 204);
  // 全部会话（含发起变更的 A 与另一会话 B）下一请求 401（identity §2）
  for (const [label, sid] of [['A', sidA], ['B', sidB]] as const) {
    const r = await t.app.inject({ method: 'GET', url: '/api/v1/me', headers: withSid(sid) });
    assert.equal(r.statusCode, 401, `会话 ${label} 应已失效`);
    assert.equal(err(r).code, 'E-AUTH-001');
  }
  // 会话行被 DELETE（storage-model §3.3：重置 = DELETE WHERE employee_id）
  const n = (t.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n;
  assert.equal(n, 0);
  // 旧口令失败、新口令成功
  assert.equal((await login(t.app, 'alice', 'password-alice-1')).statusCode, 401);
  assert.equal((await login(t.app, 'alice', 'password-alice-2')).statusCode, 200);
  await t.app.close();
});

test('完成标准 4 —— 口令变更写面仅 employees/sessions（访问凭据不自动撤销）', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db, MIGRATIONS);
  for (const ddl of FIXTURE_DDL) db.exec(ddl);  // audit_events.vault_id 外键父表（合并后 no-op）
  const stmts: string[] = [];
  const recordedDb = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'prepare' || prop === 'exec') {
        return (sql: string, ...rest: unknown[]) => {
          stmts.push(sql);
          return (target[prop] as (s: string, ...r: unknown[]) => unknown).apply(target, [sql, ...rest]);
        };
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  let nowMs = BASE;
  const app = fastify();
  await app.register(registerAuth, { db: recordedDb, pepper: randomBytes(32), now: () => new Date(nowMs) });
  const hash = await hashPassword('password-alice-1');
  db.prepare(
    `INSERT INTO employees (username, display_name, password_hash, is_instance_admin, active, invited_by, created_at, deactivated_at)
     VALUES ('alice', 'alice', ?, 0, 1, NULL, '2026-10-01T00:00:00.000Z', NULL)`,
  ).run(hash);
  const sid = sidOf(await login(app, 'alice', 'password-alice-1'));
  const before = stmts.length;
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/me/password',
    headers: withSid(sid),
    payload: { current_password: 'password-alice-1', new_password: 'password-alice-2' },
  });
  assert.equal(res.statusCode, 204);
  const writes = stmts.slice(before).filter((s) => /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(s));
  assert.ok(writes.length >= 2, `应至少含 UPDATE employees 与 DELETE FROM sessions，实际：${writes.join(' | ')}`);
  for (const w of writes) {
    assert.match(
      w,
      /^(INSERT\s+INTO\s+|UPDATE\s+(?:OR\s+\w+\s+)?|DELETE\s+FROM\s+)(employees|sessions)\b/i,
      `口令变更写面应仅 employees/sessions（token 域不连带撤销），实际：${w}`,
    );
  }
  await app.close();
  db.close();
});

test('口令变更：current 错误 → 401 E-AUTH-001 统一文案；新口令策略不符 → 422 E-AUTH-008', async () => {
  const t = await buildAuthApp();
  await seedEmployee(t.db, { username: 'alice', password: 'password-alice-1' });
  const sid = sidOf(await login(t.app, 'alice', 'password-alice-1'));
  const wrong = await t.app.inject({
    method: 'POST', url: '/api/v1/me/password', headers: withSid(sid),
    payload: { current_password: 'wrong-current-pw', new_password: 'password-alice-2' },
  });
  assert.equal(wrong.statusCode, 401);
  assert.deepEqual(err(wrong), { code: 'E-AUTH-001', message: '用户名或口令错误' });
  const tooShort = await t.app.inject({
    method: 'POST', url: '/api/v1/me/password', headers: withSid(sid),
    payload: { current_password: 'password-alice-1', new_password: 'short' },
  });
  assert.equal(tooShort.statusCode, 422);
  assert.equal(err(tooShort).code, 'E-AUTH-008');
  // 两次失败均未变更：原口令仍可登录出新会话
  const re = await login(t.app, 'alice', 'password-alice-1');
  assert.equal(re.statusCode, 200);
  await t.app.close();
});

test('logout：204、会话行删除、后续 401（不撤销 token——token 域随 S2-T4 落地）', async () => {
  const t = await buildAuthApp();
  await seedEmployee(t.db, { username: 'alice', password: 'password-alice-1' });
  const sid = sidOf(await login(t.app, 'alice', 'password-alice-1'));
  const out = await t.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: withSid(sid) });
  assert.equal(out.statusCode, 204);
  assert.equal((t.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n, 0);
  const after = await t.app.inject({ method: 'GET', url: '/api/v1/me', headers: withSid(sid) });
  assert.equal(after.statusCode, 401);
  await t.app.close();
});

test('会话滑动续期：活跃请求更新 last_seen_at（identity §4 idle_timeout 滑动）', async () => {
  const t = await buildAuthApp({ session: { idleTimeoutMs: 60_000, absoluteTimeoutMs: 24 * 3600_000 } });
  await seedEmployee(t.db, { username: 'alice', password: 'password-alice-1' });
  const sid = sidOf(await login(t.app, 'alice', 'password-alice-1'));
  t.setNow(t.nowMs() + 30_000);
  const r = await t.app.inject({ method: 'GET', url: '/api/v1/me', headers: withSid(sid) });
  assert.equal(r.statusCode, 200);
  const row = t.db.prepare(
    'SELECT last_seen_at FROM sessions s JOIN employees e ON e.id = s.employee_id WHERE s.sid_hash = (SELECT sid_hash FROM sessions ORDER BY id LIMIT 1)',
  ).get() as { last_seen_at: string };
  assert.equal(row.last_seen_at, new Date(t.nowMs()).toISOString(), 'last_seen_at 应随活跃请求推进');
  await t.app.close();
});
