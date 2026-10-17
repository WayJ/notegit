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

// S37 管理员代签（api.md §4 增补）+ 凭据 origin 标记（列表/审计透出）。
// POST /api/v1/admin/employees/:username/credentials：实例管理员为任意员工代签，
// 凭据归属该员工、scope 校验同自助（§3.4 只能收窄）；origin='admin_delegated'。

interface Ctx {
  app: FastifyInstance;
  db: DatabaseSync;
  alice: number; // 实例管理员
  bob: number;   // 普通员工（alpha=editor、beta=reader）
  seed: CredentialsService;
  dir: string;
}

async function build(): Promise<Ctx> {
  const db = newDb();
  const alice = addEmployee(db, { username: 'alice', is_instance_admin: 1 });
  const bob = addEmployee(db, { username: 'bob' });
  const alpha = addVault(db, 'alpha', alice);
  const beta = addVault(db, 'beta', alice);
  addMember(db, alpha, bob, 'editor', alice);
  addMember(db, beta, bob, 'reader', alice);
  const dir = await mkdtemp(path.join(tmpdir(), 'notegit-delegate-'));
  const pepper = await loadOrCreatePepper(path.join(dir, 'token-pepper.key'));
  const seed = new CredentialsService({ db, pepper });
  const bootstrapTokenFile = path.join(dir, 'admin-bootstrap.token');
  await writeFile(bootstrapTokenFile, 'fixture-unused');
  const app = buildApp({ db, pepper, bootstrapTokenFile, logger: false });
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

function errOf(res: { json(): unknown }): { code?: string } {
  return ((res.json() as { error?: { code?: string } }).error ?? {}) as { code?: string };
}

async function adminToken(ctx: Ctx): Promise<string> {
  return ctx.seed.createCredential(ctx.alice, { name: 'admin-seed', expires_at: inDays(30) }).token;
}

test('管理员代签：201 + token + origin=admin_delegated，token 可用且归属目标员工', async () => {
  const ctx = await build();
  try {
    const admin = await adminToken(ctx);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/employees/bob/credentials',
      headers: bearer(admin),
      payload: { name: 'dshent 委托', expires_at: inDays(30) },
    });
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as { token: string; origin: string; scope_access: string; scope_vaults: string[] };
    assert.match(body.token, /^ngt_/);
    assert.equal(body.origin, 'admin_delegated');
    assert.equal(body.scope_access, 'read_write');
    // 归属 bob：以其身份列库（bob 有成员关系的 alpha/beta）
    const vaults = await ctx.app.inject({ method: 'GET', url: '/api/v1/vaults', headers: bearer(body.token) });
    assert.equal(vaults.statusCode, 200);
    const slugs = (vaults.json() as { vaults: { slug: string }[] }).vaults.map((v) => v.slug).sort();
    assert.deepEqual(slugs, ['alpha', 'beta']);
  } finally {
    await dispose(ctx);
  }
});

test('非实例管理员代签 → 403 E-AUTHZ-001；目标员工不存在 → 404 E-RES-001', async () => {
  const ctx = await build();
  try {
    const bobSeed = ctx.seed.createCredential(ctx.bob, { name: 'bob-seed', expires_at: inDays(30) }).token;
    const forbidden = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/employees/bob/credentials',
      headers: bearer(bobSeed),
      payload: { name: 'x', expires_at: inDays(1) },
    });
    assert.equal(forbidden.statusCode, 403);
    assert.equal(errOf(forbidden).code, 'E-AUTHZ-001');

    const admin = await adminToken(ctx);
    const missing = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/employees/ghost/credentials',
      headers: bearer(admin),
      payload: { name: 'x', expires_at: inDays(1) },
    });
    assert.equal(missing.statusCode, 404);
    assert.equal(errOf(missing).code, 'E-RES-001');
  } finally {
    await dispose(ctx);
  }
});

test('代签 scope 同自助约束：未命中有权库 → 422 E-RES-007；收窄形态可用', async () => {
  const ctx = await build();
  try {
    const admin = await adminToken(ctx);
    const bad = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/employees/bob/credentials',
      headers: bearer(admin),
      payload: { name: 'x', expires_at: inDays(1), scope: { vaults: ['nope'] } },
    });
    assert.equal(bad.statusCode, 422, bad.body);
    assert.equal(errOf(bad).code, 'E-RES-007');

    const narrowed = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/employees/bob/credentials',
      headers: bearer(admin),
      payload: { name: 'y', expires_at: inDays(1), scope: { access: 'read', vaults: ['beta'] } },
    });
    assert.equal(narrowed.statusCode, 201);
    const created = narrowed.json() as { token: string; scope_vaults: string[]; scope_access: string };
    assert.deepEqual(created.scope_vaults, ['beta']);
    assert.equal(created.scope_access, 'read');
    // 收窄生效：alpha 越权 404 同形态（D-IC-06）
    const alpha = await ctx.app.inject({ method: 'GET', url: '/api/v1/vaults/alpha', headers: bearer(created.token) });
    assert.equal(alpha.statusCode, 404);
  } finally {
    await dispose(ctx);
  }
});

test('名额上限沿用：已有 20 条 active → 代签 409 E-RES-005', async () => {
  const ctx = await build();
  try {
    for (let i = 0; i < 20; i++) ctx.seed.createCredential(ctx.bob, { name: `seed-${i}`, expires_at: inDays(10) });
    const admin = await adminToken(ctx);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/employees/bob/credentials',
      headers: bearer(admin),
      payload: { name: 'x', expires_at: inDays(1) },
    });
    assert.equal(res.statusCode, 409);
    assert.equal(errOf(res).code, 'E-RES-005');
  } finally {
    await dispose(ctx);
  }
});

test('origin 透出：自助=self；管理员代管列表见 admin_delegated', async () => {
  const ctx = await build();
  try {
    ctx.seed.createCredential(ctx.bob, { name: 'self-made', expires_at: inDays(10) });
    const admin = await adminToken(ctx);
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/employees/bob/credentials',
      headers: bearer(admin),
      payload: { name: 'delegated', expires_at: inDays(10) },
    });
    const list = await ctx.app.inject({ method: 'GET', url: '/api/v1/admin/employees/bob/credentials', headers: bearer(admin) });
    assert.equal(list.statusCode, 200, list.body);
    const byName = new Map((list.json() as { credentials: { name: string; origin: string }[] }).credentials.map((c) => [c.name, c.origin] as const));
    assert.equal(byName.get('self-made'), 'self');
    assert.equal(byName.get('delegated'), 'admin_delegated');
  } finally {
    await dispose(ctx);
  }
});

test('审计：代签 credential.create 主体=管理员且 detail 记委托；凭据行动行透出 credential_origin', async () => {
  const ctx = await build();
  try {
    const admin = await adminToken(ctx);
    const delegated = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/employees/bob/credentials',
      headers: bearer(admin),
      payload: { name: 'audit-me', expires_at: inDays(10) },
    });
    assert.equal(delegated.statusCode, 201);
    const token = (delegated.json() as { token: string }).token;
    // 用委托凭据产生一条带审计的行动（建库 → vault.create）
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/vaults',
      headers: bearer(token),
      payload: { slug: 'bob-vault', name: 'Bob 库' },
    });
    assert.equal(created.statusCode, 201, created.body);

    const audit = await ctx.app.inject({ method: 'GET', url: '/api/v1/admin/audit?limit=50', headers: bearer(admin) });
    assert.equal(audit.statusCode, 200, audit.body);
    const events = (audit.json() as { events: { event_kind: string; detail: Record<string, unknown>; credential_origin: string | null }[] }).events;
    const createRows = events.filter((e) => e.event_kind === 'credential.create');
    const delegatedRow = createRows.find((e) => (e.detail as { delegated?: boolean } | null)?.delegated === true);
    assert.ok(delegatedRow, '应存在 detail.delegated=true 的 credential.create 行');
    assert.equal((delegatedRow.detail as { username?: string }).username, 'bob');
    const vaultRow = events.find((e) => e.event_kind === 'vault.create');
    assert.ok(vaultRow, '应存在 vault.create 行');
    assert.equal(vaultRow.credential_origin, 'admin_delegated');
  } finally {
    await dispose(ctx);
  }
});
