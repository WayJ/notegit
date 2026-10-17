import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../src/app.ts';
import { CredentialsService } from '../src/credentials/service.ts';
import { loadOrCreatePepper } from '../src/bootstrap/pepper.ts';
import { newDb, addEmployee, addVault, addMember } from './credentials-fixtures.ts';

// S37 实例管理员库治理端点（api.md §5 增补，dshent 平台授面专用）：
// GET  /api/v1/admin/vaults                      —— 全库概览（slug/name/成员数）
// GET/PUT/DELETE /api/v1/admin/vaults/:slug/members… —— 语义同库管理员端点，权限=实例管理员
// 审计 member.grant/revoke detail 记 via:'admin'。

interface Ctx {
  app: FastifyInstance;
  db: DatabaseSync;
  alice: number; // 实例管理员 + alpha 创建者
  bob: number;   // alpha editor
  carol: number; // 无成员关系
  seed: CredentialsService;
  dir: string;
}

async function build(): Promise<Ctx> {
  const db = newDb();
  const alice = addEmployee(db, { username: 'alice', is_instance_admin: 1 });
  const bob = addEmployee(db, { username: 'bob' });
  const carol = addEmployee(db, { username: 'carol' });
  const alpha = addVault(db, 'alpha', alice);
  addMember(db, alpha, alice, 'admin', alice); // addVault 夹具不建创建者成员行（真实 API 建）——测试显式补
  addMember(db, alpha, bob, 'editor', alice);
  const dir = await mkdtemp(path.join(tmpdir(), 'notegit-gov-'));
  const pepper = await loadOrCreatePepper(path.join(dir, 'token-pepper.key'));
  const seed = new CredentialsService({ db, pepper });
  const bootstrapTokenFile = path.join(dir, 'admin-bootstrap.token');
  await writeFile(bootstrapTokenFile, 'fixture-unused');
  const app = buildApp({ db, pepper, bootstrapTokenFile, logger: false });
  return { app, db, alice, bob, carol, seed, dir };
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

function errOf(res: { json(): unknown }): { code?: string } {
  return ((res.json() as { error?: { code?: string } }).error ?? {}) as { code?: string };
}

test('GET /admin/vaults：实例管理员 200 全库概览；非管理员 403', async () => {
  const ctx = await build();
  try {
    const admin = ctx.seed.createCredential(ctx.alice, { name: 'a', expires_at: inDays(30) }).token;
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/admin/vaults', headers: bearer(admin) });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as { vaults: { id: number; slug: string; name: string; member_count: number }[] };
    assert.equal(body.vaults.length, 1);
    assert.equal(body.vaults[0]!.slug, 'alpha');
    assert.equal(body.vaults[0]!.member_count, 2); // alice(admin)+bob(editor)

    const bobToken = ctx.seed.createCredential(ctx.bob, { name: 'b', expires_at: inDays(30) }).token;
    const forbidden = await ctx.app.inject({ method: 'GET', url: '/api/v1/admin/vaults', headers: bearer(bobToken) });
    assert.equal(forbidden.statusCode, 403);
    assert.equal(errOf(forbidden).code, 'E-AUTHZ-001');
  } finally {
    await dispose(ctx);
  }
});

test('GET /admin/vaults/:slug/members：成员列表；库不存在 404；非管理员 403', async () => {
  const ctx = await build();
  try {
    const admin = ctx.seed.createCredential(ctx.alice, { name: 'a', expires_at: inDays(30) }).token;
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/admin/vaults/alpha/members', headers: bearer(admin) });
    assert.equal(res.statusCode, 200, res.body);
    const members = (res.json() as { members: { username: string; role: string }[] }).members.map((m) => [m.username, m.role]);
    assert.deepEqual(members.sort(), [['alice', 'admin'], ['bob', 'editor']]);

    const missing = await ctx.app.inject({ method: 'GET', url: '/api/v1/admin/vaults/ghost/members', headers: bearer(admin) });
    assert.equal(missing.statusCode, 404);
    assert.equal(errOf(missing).code, 'E-RES-001');

    const bobToken = ctx.seed.createCredential(ctx.bob, { name: 'b', expires_at: inDays(30) }).token;
    const forbidden = await ctx.app.inject({ method: 'GET', url: '/api/v1/admin/vaults/alpha/members', headers: bearer(bobToken) });
    assert.equal(forbidden.statusCode, 403);
  } finally {
    await dispose(ctx);
  }
});

test('PUT/DELETE members（admin 面）：授予即生效、撤权 404 同形态、目标不存在 404', async () => {
  const ctx = await build();
  try {
    const admin = ctx.seed.createCredential(ctx.alice, { name: 'a', expires_at: inDays(30) }).token;
    const grant = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/admin/vaults/alpha/members/carol',
      headers: bearer(admin),
      payload: { role: 'reader' },
    });
    assert.equal(grant.statusCode, 200, grant.body);

    const carolToken = ctx.seed.createCredential(ctx.carol, { name: 'c', expires_at: inDays(30) }).token;
    const visible = await ctx.app.inject({ method: 'GET', url: '/api/v1/vaults/alpha', headers: bearer(carolToken) });
    assert.equal(visible.statusCode, 200);

    const revoke = await ctx.app.inject({
      method: 'DELETE',
      url: '/api/v1/admin/vaults/alpha/members/carol',
      headers: bearer(admin),
    });
    assert.equal(revoke.statusCode, 204);
    const after = await ctx.app.inject({ method: 'GET', url: '/api/v1/vaults/alpha', headers: bearer(carolToken) });
    assert.equal(after.statusCode, 404); // 撤权下一请求生效、与不存在同形态（D-IC-06）

    const ghostTarget = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/admin/vaults/alpha/members/ghost',
      headers: bearer(admin),
      payload: { role: 'reader' },
    });
    assert.equal(ghostTarget.statusCode, 404);
  } finally {
    await dispose(ctx);
  }
});

test('审计：admin 面授予/撤权 detail 记 via:admin', async () => {
  const ctx = await build();
  try {
    const admin = ctx.seed.createCredential(ctx.alice, { name: 'a', expires_at: inDays(30) }).token;
    await ctx.app.inject({ method: 'PUT', url: '/api/v1/admin/vaults/alpha/members/carol', headers: bearer(admin), payload: { role: 'reader' } });
    await ctx.app.inject({ method: 'DELETE', url: '/api/v1/admin/vaults/alpha/members/carol', headers: bearer(admin) });
    const audit = await ctx.app.inject({ method: 'GET', url: '/api/v1/admin/audit?limit=50', headers: bearer(admin) });
    const events = (audit.json() as { events: { event_kind: string; detail: Record<string, unknown> }[] }).events;
    const grant = events.find((e) => e.event_kind === 'member.grant');
    assert.ok(grant, '应有 member.grant 行');
    assert.equal((grant.detail as { via?: string }).via, 'admin');
    const revokeRow = events.find((e) => e.event_kind === 'member.revoke');
    assert.ok(revokeRow, '应有 member.revoke 行');
    assert.equal((revokeRow.detail as { via?: string }).via, 'admin');
  } finally {
    await dispose(ctx);
  }
});
