import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../src/app.ts';
import { CredentialsService } from '../src/credentials/service.ts';
import { loadOrCreatePepper, type PepperFile } from '../src/bootstrap/pepper.ts';
import { createSession, DEFAULT_SESSION_TIMEOUTS } from '../src/auth/sessions.ts';
import { newDb, addEmployee, addVault, addMember, auditRows } from './credentials-fixtures.ts';

/**
 * 签发面 scope 收窄（identity §3.4「只能收窄」+ 架构 §4.1「凭据范围只能收窄员工
 * 权限，不能扩大权限」）：凭据的 scope 不得超出发起它的**载体**（token）的 scope——
 * 载体 read → 只能签出 read；载体库清单 → 签出凭据的库清单取交集。
 *
 * 背景：签发面此前只校验「请求 scope ⊆ 员工权限」，载体自身的收窄在签发时丢失——
 * 一枚 read 限定的 token 可签出 read_write 凭据（自我提权），泄漏的受限令牌即成
 * 全权凭据。同理 credential.create 审计行的 credential_ref 指向**被创建对象**而非
 * 发起载体（identity §8 载体语义），受限令牌发起的签发在审计中不可归因。
 */

interface Ctx {
  app: ReturnType<typeof buildApp>;
  db: DatabaseSync;
  alice: number;
  bob: number;
  svc: CredentialsService;
  pepper: PepperFile;
  dir: string;
}

async function build(): Promise<Ctx> {
  const db = newDb();
  const alice = addEmployee(db, { username: 'alice', is_instance_admin: 1 });
  const bob = addEmployee(db, { username: 'bob' });
  const alpha = addVault(db, 'alpha', alice);
  const beta = addVault(db, 'beta', alice);
  addMember(db, alpha, alice, 'admin', alice);
  addMember(db, beta, alice, 'admin', alice);
  addMember(db, alpha, bob, 'editor', alice);
  addMember(db, beta, bob, 'editor', alice);
  const dir = await mkdtemp(path.join(tmpdir(), 'notegit-scope-'));
  const pepper = await loadOrCreatePepper(path.join(dir, 'token-pepper.key'));
  const svc = new CredentialsService({ db, pepper });
  const bootstrapTokenFile = path.join(dir, 'admin-bootstrap.token');
  await writeFile(bootstrapTokenFile, 'fixture-unused'); // 本域不触发 bootstrap 端点
  const app = buildApp({ db, pepper, bootstrapTokenFile, logger: false });
  return { app, db, alice, bob, svc, pepper, dir };
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

test('签发面 scope 收窄：read 载体签发的凭据不得为 read_write（载体 read → 只能签出 read）', async () => {
  const ctx = await build();
  try {
    const readToken = ctx.svc.createCredential(ctx.alice, {
      name: 'read-only',
      expires_at: inDays(30),
      scope: { access: 'read' },
    }).token;
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/credentials',
      headers: bearer(readToken),
      payload: { name: 'escalated', expires_at: inDays(30), scope: { access: 'read_write' } },
    });
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(res.json().scope_access, 'read', '载体 read → 签出凭据只能是 read');
  } finally {
    await dispose(ctx);
  }
});

test('签发面 scope 收窄：载体限定库清单时，签出凭据的库清单取交集', async () => {
  const ctx = await build();
  try {
    const scoped = ctx.svc.createCredential(ctx.alice, {
      name: 'alpha-only',
      expires_at: inDays(30),
      scope: { access: 'read_write', vaults: ['alpha'] },
    });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/credentials',
      headers: bearer(scoped.token),
      payload: { name: 'wider', expires_at: inDays(30), scope: { access: 'read_write', vaults: ['alpha', 'beta'] } },
    });
    assert.equal(res.statusCode, 201, res.body);
    assert.deepEqual(res.json().scope_vaults, ['alpha'], '签出凭据库清单 = 请求 ∩ 载体');
  } finally {
    await dispose(ctx);
  }
});

test('签发面 scope 收窄：请求库清单与载体无交集 → 422（不得静默放大为「全部有权库」）', async () => {
  const ctx = await build();
  try {
    const scoped = ctx.svc.createCredential(ctx.alice, {
      name: 'alpha-only',
      expires_at: inDays(30),
      scope: { access: 'read_write', vaults: ['alpha'] },
    });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/credentials',
      headers: bearer(scoped.token),
      payload: { name: 'outside', expires_at: inDays(30), scope: { access: 'read_write', vaults: ['beta'] } },
    });
    assert.equal(res.statusCode, 422, res.body);
    assert.equal(res.json().error.code, 'E-RES-007');
  } finally {
    await dispose(ctx);
  }
});

test('签发面 scope 收窄：会话载体（员工全量权限）不受收窄', async () => {
  const ctx = await build();
  try {
    const sid = createSession(ctx.db, ctx.alice, ctx.pepper.active.key, new Date(), DEFAULT_SESSION_TIMEOUTS).sid;
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/credentials',
      // 会话 Cookie 认证的写请求须带同源头（api.md §1 CSRF）
      headers: { cookie: `ngt_sid=${sid}`, origin: 'http://localhost' },
      payload: { name: 'by-session', expires_at: inDays(30), scope: { access: 'read_write', vaults: ['beta'] } },
    });
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(res.json().scope_access, 'read_write');
    assert.deepEqual(res.json().scope_vaults, ['beta']);
  } finally {
    await dispose(ctx);
  }
});

test('管理员代签：载体 read → 代签凭据同为 read（载体 scope 收窄对代签面同样生效）', async () => {
  const ctx = await build();
  try {
    const adminRead = ctx.svc.createCredential(ctx.alice, {
      name: 'admin-read',
      expires_at: inDays(30),
      scope: { access: 'read' },
    }).token;
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/employees/bob/credentials',
      headers: bearer(adminRead),
      payload: { name: 'delegated', expires_at: inDays(10) },
    });
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(res.json().scope_access, 'read', '载体 read → 代签凭据只能是 read');
  } finally {
    await dispose(ctx);
  }
});

test('审计归因：credential.create 的 credential_ref 指向发起载体（detail 记被创建凭据 id）', async () => {
  const ctx = await build();
  try {
    const carrier = ctx.svc.createCredential(ctx.alice, { name: 'carrier', expires_at: inDays(30) });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/credentials',
      headers: bearer(carrier.token),
      payload: { name: 'created', expires_at: inDays(30) },
    });
    assert.equal(res.statusCode, 201, res.body);
    const createdId = res.json().id as number;
    const rows = auditRows(ctx.db, 'credential.create');
    const row = rows.at(-1)!;
    assert.equal(row.credential_ref, `credential:${carrier.record.id}`, 'credential_ref 应指向发起载体而非被创建对象');
    assert.ok(row.detail.includes(String(createdId)), 'detail 应记被创建凭据 id（可追溯性）');
  } finally {
    await dispose(ctx);
  }
});
