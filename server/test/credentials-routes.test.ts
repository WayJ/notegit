import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../src/app.ts';
import { CredentialsService } from '../src/credentials/service.ts';
import { loadOrCreatePepper } from '../src/credentials/pepper.ts';
import { displayHint } from '../src/credentials/token.ts';
import { newDb, addEmployee, addVault, addMember, dumpAllText, auditRows } from './credentials-fixtures.ts';

// api.md §4 端点映射 + §2.1 错误信封；identity §3.1 明文仅创建响应一次。
// 认证载体：Authorization: Bearer ngt_…（api.md §1；Web 会话载体随 S2-T3 并行任务落地）。

interface Ctx {
  app: FastifyInstance;
  db: DatabaseSync;
  alice: number;
  bob: number;
  seed: CredentialsService;
  dir: string;
}

async function build(logFile?: string, maxCredentialsPerEmployee?: number): Promise<Ctx> {
  const db = newDb();
  const alice = addEmployee(db, { username: 'alice', is_instance_admin: 1 });
  const bob = addEmployee(db, { username: 'bob' });
  const alpha = addVault(db, 'alpha', alice);
  const beta = addVault(db, 'beta', alice);
  addMember(db, alpha, bob, 'editor', alice);
  addMember(db, beta, bob, 'reader', alice);
  const dir = await mkdtemp(path.join(tmpdir(), 'notegit-routes-'));
  const pepperPath = path.join(dir, 'token-pepper.key');
  const seed = new CredentialsService({ db, pepper: loadOrCreatePepper(pepperPath) });
  const app = buildApp({
    db,
    pepperPath,
    logger: logFile ? { file: logFile, level: 'info' } : false,
    maxCredentialsPerEmployee,
  });
  return { app, db, alice, bob, seed, dir };
}

async function dispose(ctx: Ctx): Promise<void> {
  await ctx.app.close();
  ctx.db.close();
  await rm(ctx.dir, { recursive: true, force: true });
}

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

function inDays(n: number): string {
  return new Date(Date.now() + n * 86_400_000).toISOString();
}

async function seedToken(ctx: Ctx, employeeId: number): Promise<string> {
  return ctx.seed.createCredential(employeeId, { name: 'seed', expires_at: inDays(30) }).token;
}

test('未携带/坏 scheme 的 Authorization → 401 E-AUTH-001 信封（api.md §2.1）', async () => {
  const ctx = await build();
  try {
    const none = await ctx.app.inject({ method: 'GET', url: '/api/v1/credentials' });
    assert.equal(none.statusCode, 401);
    const body = none.json() as { error: { code: string; message: string } };
    assert.equal(body.error.code, 'E-AUTH-001');

    const basic = await ctx.app.inject({ method: 'GET', url: '/api/v1/credentials', headers: { authorization: 'Basic dXNlcjpwdw==' } });
    assert.equal(basic.statusCode, 401);
    assert.equal((basic.json() as { error: { code: string } }).error.code, 'E-AUTH-001');
  } finally {
    await dispose(ctx);
  }
});

test('POST /api/v1/credentials：201 返回明文 token 一次 + 记录字段', async () => {
  const ctx = await build();
  try {
    const bobToken = await seedToken(ctx, ctx.bob);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/credentials',
      headers: bearer(bobToken),
      payload: { name: '本地 Harness', expires_at: inDays(30), scope: { access: 'read', vaults: ['alpha'] } },
    });
    assert.equal(res.statusCode, 201);
    assert.match(res.headers['content-type'] ?? '', /application\/json/);
    const body = res.json() as { token: string; display_hint: string; scope_access: string; scope_vaults: string[] };
    assert.match(body.token, /^ngt_[A-Za-z0-9_-]{43}$/);
    assert.equal(body.display_hint, displayHint(body.token));
    assert.equal(body.scope_access, 'read');
    assert.deepEqual(body.scope_vaults, ['alpha']);
  } finally {
    await dispose(ctx);
  }
});

test('GET /api/v1/credentials：列表无 token 字段；DELETE 撤销后 204、该 token 下一请求 401 E-AUTH-003', async () => {
  const ctx = await build();
  try {
    const bobToken = await seedToken(ctx, ctx.bob);
    const created = await ctx.app.inject({
      method: 'POST', url: '/api/v1/credentials', headers: bearer(bobToken),
      payload: { name: 'c1', expires_at: inDays(5) },
    });
    const cred = created.json() as { id: number; token: string };

    const list = await ctx.app.inject({ method: 'GET', url: '/api/v1/credentials', headers: bearer(cred.token) });
    assert.equal(list.statusCode, 200);
    const listed = list.json() as { credentials: unknown[] };
    assert.equal(listed.credentials.length, 2); // seed + c1
    assert.ok(!JSON.stringify(listed).includes('"token"'));

    const del = await ctx.app.inject({ method: 'DELETE', url: `/api/v1/credentials/${cred.id}`, headers: bearer(bobToken) });
    assert.equal(del.statusCode, 204);

    const after = await ctx.app.inject({ method: 'GET', url: '/api/v1/credentials', headers: bearer(cred.token) });
    assert.equal(after.statusCode, 401);
    const err = after.json() as { error: { code: string; details: { reason: string } } };
    assert.equal(err.error.code, 'E-AUTH-003');
    assert.equal(err.error.details.reason, 'revoked');
  } finally {
    await dispose(ctx);
  }
});

test('过期 token → 401 E-AUTH-002（reason 可与撤销区分）', async () => {
  const ctx = await build();
  try {
    const bobToken = await seedToken(ctx, ctx.bob);
    ctx.db.prepare('UPDATE credentials SET expires_at = ? WHERE employee_id = ?').run('2020-01-01T00:00:00.000Z', ctx.bob);
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/credentials', headers: bearer(bobToken) });
    assert.equal(res.statusCode, 401);
    const err = res.json() as { error: { code: string; details: { reason: string } } };
    assert.equal(err.error.code, 'E-AUTH-002');
    assert.equal(err.error.details.reason, 'expired');
  } finally {
    await dispose(ctx);
  }
});

test('DELETE 他人凭据 / 不存在 id / 非数字 id → 404 E-RES-001 / 404 / 400 E-RES-004', async () => {
  const ctx = await build();
  try {
    const bobToken = await seedToken(ctx, ctx.bob);
    const aliceCred = ctx.seed.createCredential(ctx.alice, { name: 'a', expires_at: inDays(5) });

    const foreign = await ctx.app.inject({ method: 'DELETE', url: `/api/v1/credentials/${aliceCred.record.id}`, headers: bearer(bobToken) });
    assert.equal(foreign.statusCode, 404);
    assert.equal((foreign.json() as { error: { code: string } }).error.code, 'E-RES-001');

    const missing = await ctx.app.inject({ method: 'DELETE', url: '/api/v1/credentials/999999', headers: bearer(bobToken) });
    assert.equal(missing.statusCode, 404);

    const badId = await ctx.app.inject({ method: 'DELETE', url: '/api/v1/credentials/not-a-number', headers: bearer(bobToken) });
    assert.equal(badId.statusCode, 400);
    assert.equal((badId.json() as { error: { code: string } }).error.code, 'E-RES-004');
  } finally {
    await dispose(ctx);
  }
});

test('POST 校验经路由呈现：缺 name 400、超上限 409 E-RES-005、超 90 天 422 E-RES-007、未知 slug 422', async () => {
  const ctx = await build(undefined, 2);
  try {
    const bobToken = await seedToken(ctx, ctx.bob); // seed 已占 1/2

    const noName = await ctx.app.inject({ method: 'POST', url: '/api/v1/credentials', headers: bearer(bobToken), payload: { expires_at: inDays(1) } });
    assert.equal(noName.statusCode, 400);
    assert.equal((noName.json() as { error: { code: string } }).error.code, 'E-RES-004');

    const c1 = await ctx.app.inject({ method: 'POST', url: '/api/v1/credentials', headers: bearer(bobToken), payload: { name: 'c1', expires_at: inDays(1) } });
    assert.equal(c1.statusCode, 201);
    const over = await ctx.app.inject({ method: 'POST', url: '/api/v1/credentials', headers: bearer(bobToken), payload: { name: 'c2', expires_at: inDays(1) } });
    assert.equal(over.statusCode, 409);
    assert.equal((over.json() as { error: { code: string } }).error.code, 'E-RES-005');

    const tooFar = await ctx.app.inject({ method: 'POST', url: '/api/v1/credentials', headers: bearer(bobToken), payload: { name: 'x', expires_at: inDays(91) } });
    assert.equal(tooFar.statusCode, 422);
    assert.equal((tooFar.json() as { error: { code: string } }).error.code, 'E-RES-007');

    const ghost = await ctx.app.inject({ method: 'POST', url: '/api/v1/credentials', headers: bearer(bobToken), payload: { name: 'x', expires_at: inDays(1), scope: { vaults: ['ghost'] } } });
    assert.equal(ghost.statusCode, 422);
    assert.equal((ghost.json() as { error: { code: string } }).error.code, 'E-RES-007');
  } finally {
    await dispose(ctx);
  }
});

test('管理员代管：非管理员 403 E-AUTHZ-001；管理员可列/撤他人凭据；未知员工 404；代管撤销审计记 detail', async () => {
  const ctx = await build();
  try {
    const bobToken = await seedToken(ctx, ctx.bob);
    const aliceToken = await seedToken(ctx, ctx.alice);
    const bobCred = ctx.seed.createCredential(ctx.bob, { name: 'for-admin', expires_at: inDays(5) });

    const forbidden = await ctx.app.inject({ method: 'GET', url: '/api/v1/admin/employees/bob/credentials', headers: bearer(bobToken) });
    assert.equal(forbidden.statusCode, 403);
    assert.equal((forbidden.json() as { error: { code: string } }).error.code, 'E-AUTHZ-001');

    const listed = await ctx.app.inject({ method: 'GET', url: '/api/v1/admin/employees/bob/credentials', headers: bearer(aliceToken) });
    assert.equal(listed.statusCode, 200);
    const rows = (listed.json() as { credentials: { id: number }[] }).credentials;
    assert.ok(rows.some((r) => r.id === bobCred.record.id));

    const revoked = await ctx.app.inject({ method: 'DELETE', url: `/api/v1/admin/employees/bob/credentials/${bobCred.record.id}`, headers: bearer(aliceToken) });
    assert.equal(revoked.statusCode, 204);
    const after = await ctx.app.inject({ method: 'GET', url: '/api/v1/credentials', headers: bearer(bobToken) });
    assert.equal(after.statusCode, 200); // bob 自己的 seed token 仍有效（凭据互不连带，identity §1）
    const revokes = auditRows(ctx.db, 'credential.revoke');
    assert.equal(revokes.length, 1);
    assert.equal(revokes[0]!.employee_id, ctx.alice, '主体=认证员工（管理员）');
    assert.ok(revokes[0]!.detail.includes('bob'), 'detail 记代管目标');

    const unknown = await ctx.app.inject({ method: 'GET', url: '/api/v1/admin/employees/ghost/credentials', headers: bearer(aliceToken) });
    assert.equal(unknown.statusCode, 404);
    assert.equal((unknown.json() as { error: { code: string } }).error.code, 'E-RES-001');
  } finally {
    await dispose(ctx);
  }
});

test('明文扫描：真实遍历全部响应、日志文件与全库转储——token 明文仅出现在唯一一次创建响应', async () => {
  const ctx = await build();
  const logFile = path.join(ctx.dir, 'server.log');
  try {
    // 重建带文件日志的应用（build 的 logger 指向 logFile）
    await ctx.app.close();
    const app = buildApp({ db: ctx.db, pepperPath: path.join(ctx.dir, 'token-pepper.key'), logger: { file: logFile, level: 'info' } });
    ctx.app = app;

    const bobToken = await seedToken(ctx, ctx.bob); // token A：作为 Bearer 使用
    const aliceToken = await seedToken(ctx, ctx.alice);

    // token B：经 API 创建（其明文应且仅应出现在这一个响应里）
    const created = await app.inject({
      method: 'POST', url: '/api/v1/credentials', headers: bearer(bobToken),
      payload: { name: 'scan-target', expires_at: inDays(10), scope: { access: 'read', vaults: ['alpha'] } },
    });
    assert.equal(created.statusCode, 201);
    const tokenB = (created.json() as { token: string }).token;
    const createdId = (created.json() as { id: number }).id;

    // 覆盖面：列表、代管列表、撤销、错误路径、健康检查
    const responses: string[] = [];
    const calls = [
      { method: 'GET', url: '/api/v1/credentials', headers: bearer(bobToken) },
      { method: 'GET', url: '/api/v1/admin/employees/bob/credentials', headers: bearer(aliceToken) },
      { method: 'DELETE', url: `/api/v1/credentials/${createdId}`, headers: bearer(bobToken) },
      { method: 'GET', url: '/api/v1/credentials', headers: bearer(tokenB) }, // 已撤销 → 401 响应体
      { method: 'GET', url: '/api/v1/credentials' }, // 未认证 → 401 响应体
      { method: 'GET', url: '/healthz' },
    ] as const;
    for (const call of calls) {
      const res = await app.inject(call);
      responses.push(`${res.statusCode} ${res.body}`);
    }

    await app.close();
    const log = await readFile(logFile, 'utf8');
    assert.ok(log.length > 0, '日志文件应有内容（扫描才是真实遍历）');
    assert.ok(log.includes('incoming request'), 'fastify 访问日志应在场');

    for (const [i, body] of responses.entries()) {
      assert.ok(!body.includes(tokenB), `响应 ${i} 不得含创建后的 token 明文`);
      assert.ok(!body.includes(bobToken), `响应 ${i} 不得含 Bearer 凭据明文`);
    }
    // 日志：不含任何 ngt_ 材料与明文（identity §3.1/§8.1 凭据不进日志）
    assert.ok(!log.includes(tokenB), '日志不得含 token 明文');
    assert.ok(!log.includes(bobToken), '日志不得含 Bearer 凭据明文');
    assert.ok(!log.includes('ngt_'), '日志不得含任何 ngt_ 材料（含前缀）');
    // 全库：所有表所有行不含明文
    const dump = dumpAllText(ctx.db);
    assert.ok(!dump.includes(tokenB));
    assert.ok(!dump.includes(bobToken));
    // display_hint 只有前缀+前2字符+…+末4位，不含中段（master 2026-10-12 裁定附加断言）
    const hint = displayHint(tokenB);
    assert.ok(!hint.includes(tokenB.slice(6, -4)));
    assert.ok(dump.includes(hint));
  } finally {
    await dispose(ctx);
  }
});
