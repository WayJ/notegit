import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../src/db/migrate.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { buildApp } from '../src/app.ts';
import { createSession, DEFAULT_SESSION_TIMEOUTS } from '../src/auth/sessions.ts';
import { hashPassword } from '../src/auth/password.ts';

// S25 反代就绪（E9 D53/D54；部署报告 2026-10-16 附项 1/3）：
// - trustProxy：显式白名单经 buildApp deps 传入后，req.protocol 在可信代理链上取
//   X-Forwarded-Proto——TLS 终结反代（架构 §10 定稿形态）下 CSRF 同源判定以浏览器
//   实际协议为准（否则 req.protocol 恒 http、全站写操作被 E-AUTH-006 拒绝）；
//   未配置时代理头不参与判定（现行为锁定，信任边界显式化——禁宽松 true）。
// - cookie Secure 开关：NOTEGIT_COOKIE_SECURE 默认开（现行为锁定）；仅精确 '0'
//   关闭（纯 HTTP 本地/内网试用形态，禁生产——identity §安全代价在案）。
//   login 发放与 401 清除两路径同规则（单源化前的四处发放点全收敛）。

// 会话夹具取当前时刻：请求路径按真实墙钟校验 idle 7d，冻结历史日期建会话会随
// 时间过期（同 csrf.test.ts 时间炸弹教训）——创建时刻须贴近墙钟。
const NOW = new Date();

interface Ctx {
  app: FastifyInstance;
  db: DatabaseSync;
  sid: string;
  close(): Promise<void>;
}

async function build(opts: { trustProxy?: FastifyServerOptions['trustProxy'] } = {}): Promise<Ctx> {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db, MIGRATIONS);
  const pepper = { active: { version: 1, key: randomBytes(32) }, retired: [] as never[] };
  const hash = await hashPassword('password-bob-123');
  db.prepare(
    `INSERT INTO employees (username, display_name, password_hash, is_instance_admin, active, invited_by, created_at)
     VALUES ('bob', 'bob', ?, 1, 1, NULL, ?)`,
  ).run(hash, NOW.toISOString());
  const bobId = (db.prepare('SELECT id FROM employees WHERE username = ?').get('bob') as { id: number }).id;
  const sid = createSession(db, bobId, pepper.active.key, NOW, DEFAULT_SESSION_TIMEOUTS).sid;
  const dir = await mkdtemp(path.join(tmpdir(), 'notegit-s25-'));
  const bootstrapTokenFile = path.join(dir, 'admin-bootstrap.token');
  await writeFile(bootstrapTokenFile, 'fixture-unused');
  const app = buildApp({ db, pepper, bootstrapTokenFile, trustProxy: opts.trustProxy });
  return {
    app,
    db,
    sid,
    close: async () => {
      await app.close();
      db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function login(ctx: Ctx): Promise<{ status: number; setCookie: string }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: 'bob', password: 'password-bob-123' },
  });
  const sc = res.headers['set-cookie'];
  return { status: res.statusCode, setCookie: Array.isArray(sc) ? sc.join('\n') : (sc ?? '') };
}

/** 反代形态写请求：X-Forwarded-Proto + Origin 参与的 logout inject（remoteAddress=可信白名单内；
 *  host 显式无端口——https 目标下 ：80 不是默认端口、归一化不剥离，会伪造异源假象） */
async function logoutViaProxy(ctx: Ctx, o: { xfp: string; origin: string; sid?: string }): Promise<number> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/logout',
    remoteAddress: '127.0.0.1',
    headers: {
      host: 'localhost',
      'x-forwarded-proto': o.xfp,
      origin: o.origin,
      ...(o.sid !== undefined ? { cookie: `ngt_sid=${o.sid}` } : {}),
    },
  });
  return res.statusCode;
}

async function clearCookieOf(ctx: Ctx): Promise<{ status: number; setCookie: string }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/logout',
    // 同源 Origin 必带：携带会话 Cookie 的写请求先过 CSRF 闸门（无效 sid 亦然），
    // 否则 403 拦截在认证之前、到不了 401 清 Cookie 路径（rejectAuth）
    headers: { cookie: 'ngt_sid=invalid', origin: 'http://localhost' },
  });
  const sc = res.headers['set-cookie'];
  return { status: res.statusCode, setCookie: Array.isArray(sc) ? sc.join('\n') : (sc ?? '') };
}

// ── trustProxy 三态矩阵 ───────────────────────────────────────────────────────

test('默认回归：未配置 trustProxy 时 X-Forwarded-Proto 不参与判定（https Origin 判异源 403）', async () => {
  const ctx = await build();
  try {
    const status = await logoutViaProxy(ctx, { xfp: 'https', origin: 'https://localhost', sid: ctx.sid });
    assert.equal(status, 403, '代理头默认不被信任：请求目标仍按连接协议 http 判定');
  } finally {
    await ctx.close();
  }
});

test('trustProxy 显式配置 + XFP=https + 同源 https Origin → 放行（反代 TLS 形态修复）', async () => {
  const ctx = await build({ trustProxy: ['127.0.0.1'] });
  try {
    const status = await logoutViaProxy(ctx, { xfp: 'https', origin: 'https://localhost', sid: ctx.sid });
    assert.equal(status, 204, `可信代理下应以 XFP https 判同源放行`);
  } finally {
    await ctx.close();
  }
});

test('trustProxy 配置下异源 Origin 仍 403（信任代理不放宽同源语义）', async () => {
  const ctx = await build({ trustProxy: ['127.0.0.1'] });
  try {
    const status = await logoutViaProxy(ctx, { xfp: 'https', origin: 'https://evil.example', sid: ctx.sid });
    assert.equal(status, 403);
  } finally {
    await ctx.close();
  }
});

test('trustProxy 配置 + XFP=http + http Origin → 放行（明文反代形态，XFP 按原值参与判定）', async () => {
  const ctx = await build({ trustProxy: ['127.0.0.1'] });
  try {
    const status = await logoutViaProxy(ctx, { xfp: 'http', origin: 'http://localhost', sid: ctx.sid });
    assert.equal(status, 204);
  } finally {
    await ctx.close();
  }
});

// ── cookie Secure 两形态 × 两路径 ─────────────────────────────────────────────

test('默认：login Set-Cookie 含 Secure/HttpOnly/SameSite=Lax（现行为锁定）', async () => {
  const ctx = await build();
  try {
    const { status, setCookie } = await login(ctx);
    assert.equal(status, 200);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
  } finally {
    await ctx.close();
  }
});

test('默认：401 清 Cookie 路径含 Secure + Max-Age=0（现行为锁定）', async () => {
  const ctx = await build();
  try {
    const { status, setCookie } = await clearCookieOf(ctx);
    assert.equal(status, 401);
    assert.match(setCookie, /Max-Age=0/);
    assert.match(setCookie, /Secure/);
  } finally {
    await ctx.close();
  }
});

test("NOTEGIT_COOKIE_SECURE=0：login Set-Cookie 去 Secure、保留 HttpOnly/SameSite=Lax", async () => {
  const ctx = await build();
  try {
    process.env.NOTEGIT_COOKIE_SECURE = '0';
    const { status, setCookie } = await login(ctx);
    assert.equal(status, 200);
    assert.doesNotMatch(setCookie, /Secure/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
  } finally {
    delete process.env.NOTEGIT_COOKIE_SECURE;
    await ctx.close();
  }
});

test('NOTEGIT_COOKIE_SECURE=0：401 清 Cookie 路径同样无 Secure', async () => {
  const ctx = await build();
  try {
    process.env.NOTEGIT_COOKIE_SECURE = '0';
    const { status, setCookie } = await clearCookieOf(ctx);
    assert.equal(status, 401);
    assert.doesNotMatch(setCookie, /Secure/);
    assert.match(setCookie, /Max-Age=0/);
  } finally {
    delete process.env.NOTEGIT_COOKIE_SECURE;
    await ctx.close();
  }
});
