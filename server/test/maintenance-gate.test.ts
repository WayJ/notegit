import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { loadOrCreatePepper } from '../src/bootstrap/pepper.ts';
import { hashPassword } from '../src/auth/password.ts';
import { createInvite } from '../src/invites/invite.ts';
import { CredentialsService } from '../src/credentials/service.ts';
import { newDb, addEmployee } from './credentials-fixtures.ts';
import { drainCount } from '../src/audit/audit.ts';
import { createMaintenanceGate } from '../src/maintenance/gate.ts';

// S2-T7 维护模式写闸门（backup-recovery §3 唯一语义源）：
// - 矩阵逐行：业务与管理写 503 E-MAINT-001（maintenance: true）；登录与一切读放行；
// - 进程内同步标志：切换调用返回后新请求立即生效（传播上界 0）；
// - 维护生命周期自身（开启/关闭）与登录会话属运行态写入，放行（backup §3 写分类）；
// - 仅实例管理员可切换；切换记 maintenance.enable/disable 审计（运行态审计行）。
// api.md §1/§2.3 E-MAINT-001；api.md §10 组装序 maintenance → （init gate）→ csrf → 路由。

const ORIGIN = { origin: 'http://localhost' };  // inject 默认目标 host（csrf.test.ts 同款）

interface Ctx {
  app: FastifyInstance;
  db: DatabaseSync;
  alice: number;
  bob: number;
  service: CredentialsService;
  pepper: Awaited<ReturnType<typeof loadOrCreatePepper>>;
  dir: string;
  close: () => Promise<void>;
}

async function build(): Promise<Ctx> {
  const db = newDb();
  const alice = addEmployee(db, { username: 'alice', is_instance_admin: 1 });
  const bob = addEmployee(db, { username: 'bob' });
  // 真实口令哈希（登录路径走真实 verify；每用户一次，Argon2id 默认实现）
  const aliceHash = await hashPassword('password-alice-1');
  const bobHash = await hashPassword('password-bob-1');
  db.prepare('UPDATE employees SET password_hash = ? WHERE id = ?').run(aliceHash, alice);
  db.prepare('UPDATE employees SET password_hash = ? WHERE id = ?').run(bobHash, bob);

  const dir = await mkdtemp(path.join(tmpdir(), 'notegit-maint-'));
  const pepper = await loadOrCreatePepper(path.join(dir, 'token-pepper.key'));
  const service = new CredentialsService({ db, pepper });
  const app = buildApp({
    db,
    pepper,
    bootstrapTokenFile: path.join(dir, 'admin-bootstrap.token'),
  });
  return {
    app, db, alice, bob, service, pepper, dir,
    close: async () => {
      await app.close();
      db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function login(app: FastifyInstance, username: string, password: string) {
  return app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password } });
}

async function sidOf(res: { headers: Record<string, unknown> }): Promise<string> {
  const sc = res.headers['set-cookie'];
  const raw = Array.isArray(sc) ? sc.join(';') : (sc as string | undefined);
  return /ngt_sid=([^;]+)/.exec(raw ?? '')?.[1] ?? '';
}

async function enable(app: FastifyInstance, headers: Record<string, string>) {
  return app.inject({ method: 'POST', url: '/api/v1/admin/maintenance', headers, payload: {} });
}

test('闸门单元：进程内同步标志——切换返回值反映是否发生迁移（幂等判定源）', () => {
  const gate = createMaintenanceGate();
  assert.equal(gate.isEnabled(), false, '初始关闭');
  assert.equal(gate.enable(), true, '首次开启发生迁移');
  assert.equal(gate.isEnabled(), true);
  assert.equal(gate.enable(), false, '已开再开为无迁移');
  assert.equal(gate.disable(), true);
  assert.equal(gate.disable(), false);
  assert.equal(gate.isEnabled(), false);
});

test('矩阵逐行：开启后业务与管理写 503 E-MAINT-001；登录/读/运行态放行；未来端点自动被覆盖', async () => {
  const ctx = await build();
  try {
    // 准备：管理员会话（Cookie 载体）+ Bearer token（API 载体）+ 一条待撤销凭据 + K5 令牌
    const loginRes = await login(ctx.app, 'alice', 'password-alice-1');
    assert.equal(loginRes.statusCode, 200);
    const sid = await sidOf(loginRes);
    const cookie = { cookie: `ngt_sid=${sid}`, ...ORIGIN };
    const aliceToken = ctx.service.createCredential(ctx.alice, { name: 'm', expires_at: new Date(Date.now() + 86_400_000).toISOString() }).token;
    const seeded = ctx.service.createCredential(ctx.alice, { name: 'm2', expires_at: new Date(Date.now() + 86_400_000).toISOString() });
    const bearer = { authorization: `Bearer ${aliceToken}` };
    const { token: resetToken } = createInvite(ctx.db, ctx.pepper, { username: 'invitee', displayName: 'Invitee', invitedBy: ctx.alice }, new Date());

    // 开启（Bearer 载体——主体归因 api，见后续审计断言）
    const on = await enable(ctx.app, bearer);
    assert.equal(on.statusCode, 204, '开启成功');

    // —— backup §3 矩阵逐行（当前分支已存在的入口 + 契约路径的未来入口） ——
    interface Res {
      statusCode: number;
      json(): unknown;
    }
    const rejects: [string, Promise<Res>][] = [];
    const expect503 = (
      name: string,
      method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
      url: string,
      headers: Record<string, string>,
      payload?: Record<string, unknown>,
    ) => {
      const call =
        payload === undefined
          ? ctx.app.inject({ method, url, headers })
          : ctx.app.inject({ method, url, headers, payload });
      rejects.push([name, Promise.resolve(call)]);
    };
    // 管理操作：成员（邀请）、账号停用、凭据创建/撤销（矩阵第 5 行）
    expect503('邀请创建员工', 'POST', '/api/v1/admin/employees', cookie, { username: 'x1', display_name: 'X' });
    expect503('停用账号', 'PATCH', '/api/v1/admin/employees/bob', cookie, { active: false });
    expect503('凭据创建', 'POST', '/api/v1/credentials', bearer, { name: 'n', expires_at: new Date(Date.now() + 86_400_000).toISOString() });
    expect503('凭据撤销（自助）', 'DELETE', `/api/v1/credentials/${seeded.record.id}`, bearer);
    expect503('凭据撤销（代管）', 'DELETE', `/api/v1/admin/employees/alice/credentials/${seeded.record.id}`, cookie);
    // 口令域（权威数据：employees.password_hash）
    expect503('自助改密', 'POST', '/api/v1/me/password', bearer, { current_password: 'password-alice-1', new_password: 'password-alice-2' });
    expect503('口令重置消费（K5）', 'POST', '/api/v1/auth/password-reset', {}, { reset_token: resetToken, new_password: 'password-new-1' });
    expect503('bootstrap（初始化写）', 'POST', '/api/v1/auth/bootstrap', {}, { bootstrap_token: 't', username: 'u', display_name: 'U', password: 'password-u-1' });
    // 未来端点（闸门在路由之前，未注册路径同样被覆盖——api.md 标注「写」的契约路径）
    expect503('建库（S2-T6 未落地）', 'POST', '/api/v1/vaults', cookie, { slug: 'v', name: 'V' });
    expect503('成员授权（S2-T6 未落地）', 'PUT', '/api/v1/vaults/v/members/bob', cookie, { role: 'reader' });
    expect503('网页草稿保存（S4 未落地）', 'POST', '/api/v1/vaults/v/drafts', cookie, { path: 'a.md' });
    expect503('网页正式提交（S4 未落地）', 'POST', '/api/v1/vaults/v/submissions', bearer, { base_commit: '0'.repeat(40) });
    for (const [name, p] of rejects) {
      const res = await p;
      assert.equal(res.statusCode, 503, `${name} 应 503`);
      const body = res.json() as { error: { code: string; details?: { maintenance?: boolean } } };
      assert.equal(body.error.code, 'E-MAINT-001', `${name} 错误码`);
      assert.equal(body.error.details?.maintenance, true, `${name} maintenance 标志（api.md §2.3）`);
    }

    // —— 放行面（矩阵第 6–7 行 + 运行态写入） ——
    const loginDuring = await login(ctx.app, 'alice', 'password-alice-1');
    assert.equal(loginDuring.statusCode, 200, '登录/会话创建放行（会话属运行态，D-BR-06）');
    const logoutDuring = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie: `ngt_sid=${await sidOf(loginDuring)}`, ...ORIGIN } });
    assert.equal(logoutDuring.statusCode, 204, '登出（会话运行态写入）放行');
    const meDuring = await ctx.app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer });
    assert.equal(meDuring.statusCode, 200, 'API 读放行');
    const credListDuring = await ctx.app.inject({ method: 'GET', url: '/api/v1/credentials', headers: bearer });
    assert.equal(credListDuring.statusCode, 200, '凭据列表（读）放行');
    const healthDuring = await ctx.app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(healthDuring.statusCode, 200, '健康检查放行');
    const futureRead = await ctx.app.inject({ method: 'GET', url: '/api/v1/vaults', headers: bearer });
    assert.notEqual(futureRead.statusCode, 503, '未来读端点不被维护闸门拦截（404 路由缺失 ≠ 503）');

    // —— 维护生命周期自身放行（backup §3 写分类：运行态写入） ——
    const reEnable = await enable(ctx.app, cookie);
    assert.equal(reEnable.statusCode, 204, '已开再开幂等放行');
    const off = await ctx.app.inject({ method: 'DELETE', url: '/api/v1/admin/maintenance', headers: cookie });
    assert.equal(off.statusCode, 204, '维护期间可关闭（否则死锁）');

    // —— 关闭后立即恢复（传播上界 0 的另一半） ——
    const inviteAfter = await ctx.app.inject({
      method: 'POST', url: '/api/v1/admin/employees', headers: cookie,
      payload: { username: 'x2', display_name: 'X2' },
    });
    assert.equal(inviteAfter.statusCode, 201, '关闭后写请求立即恢复');
  } finally {
    await ctx.close();
  }
});

test('切换即时生效：开启响应返回后，下一请求立即被拒（传播上界 0，backup §3）', async () => {
  const ctx = await build();
  try {
    const loginRes = await login(ctx.app, 'alice', 'password-alice-1');
    const cookie = { cookie: `ngt_sid=${await sidOf(loginRes)}`, ...ORIGIN };
    // 开启前：写可达（401 未认证也证明到达不了 503 维护层之下——先确认为非 503）
    const before = await ctx.app.inject({ method: 'POST', url: '/api/v1/admin/employees', headers: cookie, payload: { username: 'a1', display_name: 'A' } });
    assert.equal(before.statusCode, 201);
    const on = await enable(ctx.app, cookie);
    assert.equal(on.statusCode, 204);
    // 同步标志：无任何等待/传播窗口，下一请求即被拒
    const after = await ctx.app.inject({ method: 'POST', url: '/api/v1/admin/employees', headers: cookie, payload: { username: 'a2', display_name: 'A' } });
    assert.equal(after.statusCode, 503);
    assert.equal((after.json() as { error: { code: string } }).error.code, 'E-MAINT-001');
    // 排空口径不受运行态审计行影响（无 pending 发布写）
    assert.equal(drainCount(ctx.db), 0);
  } finally {
    await ctx.close();
  }
});

test('切换权限：需实例管理员（403 E-AUTHZ-001）；未认证 401；Cookie 载体缺同源 Origin → CSRF 403', async () => {
  const ctx = await build();
  try {
    const bobToken = ctx.service.createCredential(ctx.bob, { name: 'b', expires_at: new Date(Date.now() + 86_400_000).toISOString() }).token;
    const unauth = await ctx.app.inject({ method: 'POST', url: '/api/v1/admin/maintenance', payload: {} });
    assert.equal(unauth.statusCode, 401);
    assert.equal((unauth.json() as { error: { code: string } }).error.code, 'E-AUTH-001');
    const member = await ctx.app.inject({ method: 'POST', url: '/api/v1/admin/maintenance', headers: { authorization: `Bearer ${bobToken}` }, payload: {} });
    assert.equal(member.statusCode, 403);
    assert.equal((member.json() as { error: { code: string } }).error.code, 'E-AUTHZ-001');
    const memberOff = await ctx.app.inject({ method: 'DELETE', url: '/api/v1/admin/maintenance', headers: { authorization: `Bearer ${bobToken}` } });
    assert.equal(memberOff.statusCode, 403);
    // Cookie 载体写请求受全局 CSRF 同源校验（auth/csrf.ts）
    const loginRes = await login(ctx.app, 'alice', 'password-alice-1');
    const noOrigin = await ctx.app.inject({ method: 'POST', url: '/api/v1/admin/maintenance', headers: { cookie: `ngt_sid=${await sidOf(loginRes)}` }, payload: {} });
    assert.equal(noOrigin.statusCode, 403);
    assert.equal((noOrigin.json() as { error: { code: string } }).error.code, 'E-AUTH-006');
  } finally {
    await ctx.close();
  }
});

test('切换审计：enable/disable 各记一行（主体=切换管理员+载体+entry）；幂等重复切换不产生重复行', async () => {
  const ctx = await build();
  try {
    const aliceToken = ctx.service.createCredential(ctx.alice, { name: 't', expires_at: new Date(Date.now() + 86_400_000).toISOString() }).token;
    const bearer = { authorization: `Bearer ${aliceToken}` };

    // Bearer 开启 → maintenance.enable：entry=api、credential:<id> 载体
    const on1 = await enable(ctx.app, bearer);
    assert.equal(on1.statusCode, 204);
    // 幂等重复开启：不新增行
    const on2 = await enable(ctx.app, bearer);
    assert.equal(on2.statusCode, 204);

    // Cookie 关闭 → maintenance.disable：entry=web、session:<id> 载体
    const loginRes = await login(ctx.app, 'alice', 'password-alice-1');
    const off = await ctx.app.inject({ method: 'DELETE', url: '/api/v1/admin/maintenance', headers: { cookie: `ngt_sid=${await sidOf(loginRes)}`, ...ORIGIN } });
    assert.equal(off.statusCode, 204);

    const rows = ctx.db
      .prepare(`SELECT event_kind, actor_kind, employee_id, credential_ref, entry, status, vault_id
                FROM audit_events WHERE event_kind LIKE 'maintenance.%' ORDER BY id`)
      .all() as Record<string, unknown>[];
    assert.equal(rows.length, 2, '幂等重复开启不重复记审计');
    const [enableRow, disableRow] = rows;
    assert.equal(enableRow!['event_kind'], 'maintenance.enable');
    assert.equal(enableRow!['actor_kind'], 'employee');
    assert.equal(enableRow!['employee_id'], ctx.alice, '主体 = 切换管理员（认证员工）');
    assert.match(enableRow!['credential_ref'] as string, /^credential:\d+$/, 'Bearer 载体标识');
    assert.equal(enableRow!['entry'], 'api', 'token 载体 → api 入口（§7.4）');
    assert.equal(enableRow!['status'], 'succeeded', '管理类直接终态');
    assert.equal(enableRow!['vault_id'], null, '实例级事件');
    assert.equal(disableRow!['event_kind'], 'maintenance.disable');
    assert.match(disableRow!['credential_ref'] as string, /^session:\d+$/, '会话载体标识');
    assert.equal(disableRow!['entry'], 'web', '会话载体 → web 入口（§7.4）');
    assert.equal(disableRow!['employee_id'], ctx.alice);
  } finally {
    await ctx.close();
  }
});

test('未开启时不拦截任何请求（零开销路径：关闭态完全放行）', async () => {
  const ctx = await build();
  try {
    const loginRes = await login(ctx.app, 'alice', 'password-alice-1');
    assert.equal(loginRes.statusCode, 200, '关闭态登录正常');
    const invite = await ctx.app.inject({
      method: 'POST', url: '/api/v1/admin/employees',
      headers: { cookie: `ngt_sid=${await sidOf(loginRes)}`, ...ORIGIN },
      payload: { username: 'n1', display_name: 'N' },
    });
    assert.equal(invite.statusCode, 201, '关闭态写正常');
  } finally {
    await ctx.close();
  }
});
