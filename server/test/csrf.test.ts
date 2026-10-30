import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../src/db/migrate.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { buildApp } from '../src/app.ts';
import { createSession, DEFAULT_SESSION_TIMEOUTS } from '../src/auth/sessions.ts';
import { hashPassword } from '../src/auth/password.ts';

// CSRF 同源校验（identity §4 + api.md §1 定稿；E-AUTH-006）：
// 凡会话 Cookie 认证的状态改变请求（非 GET/HEAD/OPTIONS）校验同源——Origin 头
// （缺失时回退 Referer 的 origin 部分）与请求目标（scheme+host+port）同源；
// 回退链终点（两者皆缺失）无法确立同源 → 403。Bearer（Authorization 头）豁免。

// 会话夹具取当前时刻：请求路径（app.inject）按真实墙钟校验 idle 7d，冻结历史
// 日期建会话会随时间过期（idle 窗越过冻结点即全量 401 误红）——创建时刻须贴近墙钟。
const NOW = new Date();

interface Ctx {
  app: FastifyInstance;
  db: DatabaseSync;
  bobId: number;
  sid: string;
  close(): Promise<void>;
}

async function build(): Promise<Ctx> {
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
  const dir = await mkdtemp(path.join(tmpdir(), 'notegit-csrf-'));
  const bootstrapTokenFile = path.join(dir, 'admin-bootstrap.token');
  await writeFile(bootstrapTokenFile, 'fixture-unused');
  const app = buildApp({ db, pepper, bootstrapTokenFile });
  return {
    app,
    db,
    bobId,
    sid,
    close: async () => {
      await app.close();
      db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** 目标写端点：会话载体写（logout 删除会话行）；用 admin/employees 或 logout 均可 */
function writeReq(sid: string | null, origin?: string, referer?: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (sid !== null) headers['cookie'] = `ngt_sid=${sid}`;
  if (origin !== undefined) headers['origin'] = origin;
  if (referer !== undefined) headers['referer'] = referer;
  return headers;
}

async function logout(ctx: Ctx, headers: Record<string, string>): Promise<{ statusCode: number; body: string }> {
  const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers });
  return { statusCode: res.statusCode, body: res.body };
}

test('Cookie 写请求 + 同源 Origin → 放行（到达处理器，logout 204）', async () => {
  const ctx = await build();
  try {
    const res = await logout(ctx, writeReq(ctx.sid, 'http://localhost'));
    assert.equal(res.statusCode, 204, `同源应放行，实际 ${res.statusCode}: ${res.body}`);
  } finally {
    await ctx.close();
  }
});

test('Cookie 写请求 + 跨源 Origin → 403 E-AUTH-006（不泄露更多）', async () => {
  const ctx = await build();
  try {
    const res = await logout(ctx, writeReq(ctx.sid, 'https://evil.example'));
    assert.equal(res.statusCode, 403);
    const err = JSON.parse(res.body) as { error: { code: string } };
    assert.equal(err.error.code, 'E-AUTH-006');
  } finally {
    await ctx.close();
  }
});

test('回退链：Origin 缺失 → 同源 Referer 放行；跨源 Referer 拒绝', async () => {
  const ctx = await build();
  try {
    const sameReferer = await logout(ctx, writeReq(ctx.sid, undefined, 'http://localhost/api/v1/some-page'));
    assert.equal(sameReferer.statusCode, 204, `同源 Referer 应放行，实际 ${sameReferer.statusCode}`);
    const crossReferer = await logout(ctx, writeReq(ctx.sid, undefined, 'https://evil.example/attack'));
    assert.equal(crossReferer.statusCode, 403);
    const crossRefererPort = await logout(ctx, writeReq(ctx.sid, undefined, 'http://localhost:8080/page'));
    assert.equal(crossRefererPort.statusCode, 403, '端口不同即不同源');
  } finally {
    await ctx.close();
  }
});

test('回退链终点：Origin 与 Referer 皆缺失 → 403 E-AUTH-006（无法确立同源即拒绝）', async () => {
  const ctx = await build();
  try {
    const res = await logout(ctx, writeReq(ctx.sid));
    assert.equal(res.statusCode, 403);
    const err = JSON.parse(res.body) as { error: { code: string } };
    assert.equal(err.error.code, 'E-AUTH-006');
  } finally {
    await ctx.close();
  }
});

test('默认端口归一：Origin http://localhost 与 Host localhost:80 同源', async () => {
  const ctx = await build();
  try {
    const res = await logout(ctx, writeReq(ctx.sid, 'http://localhost:80'));
    assert.equal(res.statusCode, 204, '显式默认端口应与省略端口同源');
  } finally {
    await ctx.close();
  }
});

test('豁免面：Bearer（Authorization 头）写请求不校验 Origin；安全方法（GET）放行；无 Cookie 写请求放行', async () => {
  const ctx = await build();
  try {
    // Authorization 头在场 = 显式凭据，不依赖环境 Cookie（api.md §1）——无 Origin 也放行
    const basic = await ctx.app.inject({
      method: 'POST', url: '/api/v1/auth/logout',
      headers: { authorization: 'Basic dXNlcjpwdw==', ...writeReq(ctx.sid) },
    });
    assert.equal(basic.statusCode, 401, '豁免 CSRF 后由认证层接管（Basic 非 Bearer → E-AUTH-001）');
    assert.equal((basic.json() as { error: { code: string } }).error.code, 'E-AUTH-001');
    // 安全方法不校验（GET /me 无 Origin 照常工作）
    const me = await ctx.app.inject({ method: 'GET', url: '/api/v1/me', headers: writeReq(ctx.sid) });
    assert.equal(me.statusCode, 200);
    // 无 Cookie 的写请求（如登录）不适用（非会话 Cookie 认证）
    const login = await ctx.app.inject({
      method: 'POST', url: '/api/v1/auth/login', payload: { username: 'bob', password: 'password-bob-123' },
    });
    assert.equal(login.statusCode, 200, `无 Cookie 写请求应放行，实际 ${login.statusCode}: ${login.body}`);
  } finally {
    await ctx.close();
  }
});

test('失效 Cookie 的写请求仍先过 CSRF（携带 ngt_sid 即受校验，不因会话失效而绕过）', async () => {
  const ctx = await build();
  try {
    const stale = 'totally-bogus-sid-value';
    const crossOrigin = await logout(ctx, { ...writeReq(stale), origin: 'https://evil.example' });
    assert.equal(crossOrigin.statusCode, 403, '跨源 + Cookie：无论会话有效性，先拒 CSRF');
    const noOrigin = await logout(ctx, writeReq(stale));
    assert.equal(noOrigin.statusCode, 403, '回退链终点同样先拒（会话失效与否不影响 CSRF 判定）');
  } finally {
    await ctx.close();
  }
});
