import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { loadOrCreatePepper, type PepperFile } from '../src/bootstrap/pepper.ts';
import { ensureBootstrapToken } from '../src/bootstrap/token.ts';
import { hashPassword } from '../src/auth/password.ts';
import { createInvite } from '../src/invites/invite.ts';
import { CredentialsService } from '../src/credentials/service.ts';
import { newDb, addEmployee, dumpAllText } from './credentials-fixtures.ts';

// S2-T7 既有流程审计挂接（storage-model §5 注册表为事件清单唯一源——coordinator
// 2026-10-13 批复：login/logout 不入审计，session 生命周期由 sessions 表承载）：
// - account.bootstrap（actor_kind=bootstrap，api.md §3）
// - employee.create（主体=邀请管理员 + 载体 + 入口，identity §8）
// - employee.deactivate / employee.activate（PATCH admin employees）
// - employee.password_reset（K5 消费：目标员工、无凭据载体）
// - credential.create / credential.revoke（S2-T4 已落地，扫描断言一并覆盖）
// 伪造 author 的请求记录认证主体（identity §8：author 仅内容元数据）；
// 载体优先级（architecture-notes §7.1：Authorization 在场即优先）端到端断言。

const ORIGIN = { origin: 'http://localhost' };

interface Ctx {
  app: FastifyInstance;
  db: DatabaseSync;
  pepper: PepperFile;
  service: CredentialsService;
  dir: string;
  logFile: string;
  close: () => Promise<void>;
}

async function build(withLog = false): Promise<Ctx> {
  const db = newDb();
  const dir = await mkdtemp(path.join(tmpdir(), 'notegit-audit-'));
  const logFile = path.join(dir, 'server.log');
  const pepper = await loadOrCreatePepper(path.join(dir, 'token-pepper.key'));
  const service = new CredentialsService({ db, pepper });
  const app = buildApp({
    db,
    pepper,
    bootstrapTokenFile: path.join(dir, 'admin-bootstrap.token'),
    logger: withLog ? { file: logFile, level: 'info' } : false,
  });
  return {
    app, db, pepper, service, dir, logFile,
    close: async () => {
      await app.close();
      db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** 初始化完成的实例：bootstrap 全流程（真实 Argon2 哈希 ×1） */
async function bootstrapAdmin(ctx: Ctx, username = 'root'): Promise<{ employeeId: number; password: string }> {
  const tokenFile = path.join(ctx.dir, 'admin-bootstrap.token');
  await writeFile(tokenFile, 'fixture-placeholder');  // isUninitialized 只看 employees 表
  const { pepper, db } = ctx;
  const bootstrapToken = 'boot-tok-fixture';
  db.prepare(
    `INSERT INTO one_time_tokens (purpose, token_hash, expires_at, created_at)
     VALUES ('bootstrap', ?, ?, ?)`,
  ).run(
    // 与 bootstrap/token.ts 同式：hmacv1$ 前缀哈希
    `hmacv1$${(await import('node:crypto')).createHmac('sha256', pepper.active.key).update(bootstrapToken).digest('hex')}`,
    new Date(Date.now() + 3_600_000).toISOString(),
    new Date().toISOString(),
  );
  const password = `password-${username}-1`;
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/bootstrap',
    payload: { bootstrap_token: bootstrapToken, username, display_name: 'Root', password },
  });
  assert.equal(res.statusCode, 201, `bootstrap 应 201：${res.body}`);
  return { employeeId: (res.json() as { employee_id: number }).employee_id, password };
}

async function login(app: FastifyInstance, username: string, password: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password } });
  assert.equal(res.statusCode, 200, `登录应 200：${res.body}`);
  const sc = res.headers['set-cookie'];
  const raw = Array.isArray(sc) ? sc.join(';') : (sc as string | undefined);
  return /ngt_sid=([^;]+)/.exec(raw ?? '')![1]!;
}

function rows(db: DatabaseSync, eventKind: string): Record<string, unknown>[] {
  return db
    .prepare('SELECT * FROM audit_events WHERE event_kind = ? ORDER BY id')
    .all(eventKind) as Record<string, unknown>[];
}

test('account.bootstrap：actor_kind=bootstrap、employee_id NULL、目标记 detail（api.md §3）', async () => {
  const ctx = await build();
  try {
    await bootstrapAdmin(ctx);
    const rs = rows(ctx.db, 'account.bootstrap');
    assert.equal(rs.length, 1);
    const row = rs[0]!;
    assert.equal(row['actor_kind'], 'bootstrap');
    assert.equal(row['employee_id'], null, 'DDL 注释：employee_id NULL 当且仅当 actor_kind != employee');
    assert.equal(row['credential_ref'], null);
    assert.equal(row['entry'], 'api');
    assert.equal(row['status'], 'succeeded');
    const detail = JSON.parse(row['detail'] as string);
    assert.equal(detail['username'], 'root');
    assert.equal(typeof detail['employee_id'], 'number', '创建的管理员记于 detail（无主体列）');
  } finally {
    await ctx.close();
  }
});

test('employee.create：主体=邀请管理员（认证员工）+ 载体 + 入口；K5 令牌明文不入审计', async () => {
  const ctx = await build();
  try {
    await bootstrapAdmin(ctx);
    const sid = await login(ctx.app, 'root', 'password-root-1');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/employees',
      headers: { cookie: `ngt_sid=${sid}`, ...ORIGIN },
      payload: { username: 'newbie', display_name: 'New Bee' },
    });
    assert.equal(res.statusCode, 201, res.body);
    const resetToken = (res.json() as { password_reset_token: string }).password_reset_token;

    const rs = rows(ctx.db, 'employee.create');
    assert.equal(rs.length, 1);
    const row = rs[0]!;
    const rootId = (ctx.db.prepare(`SELECT id FROM employees WHERE username = 'root'`).get() as { id: number }).id;
    assert.equal(row['actor_kind'], 'employee');
    assert.equal(row['employee_id'], rootId, '主体 = 邀请管理员（认证员工），非被邀请人');
    assert.match(row['credential_ref'] as string, /^session:\d+$/, '会话载体标识');
    assert.equal(row['entry'], 'web', '会话载体 → web（§7.4）');
    assert.equal(row['status'], 'succeeded');
    assert.equal(JSON.parse(row['detail'] as string)['username'], 'newbie');
    // K5 明文不进审计（identity §3.1/§8：凭据材料不入审计）
    const auditDump = ctx.db.prepare('SELECT * FROM audit_events').all().map((r) => JSON.stringify(r)).join('\n');
    assert.ok(!auditDump.includes(resetToken), 'K5 重置令牌明文不得出现在审计行');
  } finally {
    await ctx.close();
  }
});

test('伪造 author：请求体携带伪造 author/commit_author 字段，审计主体仍=认证员工', async () => {
  const ctx = await build();
  try {
    await bootstrapAdmin(ctx);
    const sid = await login(ctx.app, 'root', 'password-root-1');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/employees',
      headers: { cookie: `ngt_sid=${sid}`, ...ORIGIN },
      payload: {
        username: 'framed',
        display_name: 'Framed',
        author: 'somebody-else',
        commit_author: 'attacker <attacker@forged.example>',
        committer: 'also-forged',
      },
    });
    assert.equal(res.statusCode, 201, res.body);
    const row = rows(ctx.db, 'employee.create')[0]!;
    const rootId = (ctx.db.prepare(`SELECT id FROM employees WHERE username = 'root'`).get() as { id: number }).id;
    assert.equal(row['employee_id'], rootId, '主体 = 认证员工，与请求声称的 author 无关（identity §8）');
    assert.match(row['credential_ref'] as string, /^session:\d+$/, '会话载体标识形态');
    // 伪造字段不落主体，也不回显进 detail
    const detail = JSON.parse(row['detail'] as string) as Record<string, unknown>;
    assert.equal(detail['author'], undefined);
    assert.equal(detail['commit_author'], undefined);
  } finally {
    await ctx.close();
  }
});

test('载体并存优先级：Authorization 头在场即优先——双载体请求审计归因 Bearer 主体（§7.1）', async () => {
  const ctx = await build();
  try {
    await bootstrapAdmin(ctx);
    const rootId = (ctx.db.prepare(`SELECT id FROM employees WHERE username = 'root'`).get() as { id: number }).id;
    // 另一位管理员 bob（Bearer 载体）+ root 会话 Cookie 并存
    const bobId = addEmployee(ctx.db, { username: 'bob', is_instance_admin: 1 });
    const bobToken = ctx.service.createCredential(bobId, { name: 'b', expires_at: new Date(Date.now() + 86_400_000).toISOString() }).token;
    const rootSid = await login(ctx.app, 'root', 'password-root-1');

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/employees',
      headers: { cookie: `ngt_sid=${rootSid}`, authorization: `Bearer ${bobToken}` },  // 双载体
      payload: { username: 'prio', display_name: 'P' },
    });
    assert.equal(res.statusCode, 201, res.body);
    const row = rows(ctx.db, 'employee.create')[0]!;
    assert.equal(row['employee_id'], bobId, '主体 = Bearer 员工（Authorization 在场即优先，非 Cookie 员工）');
    assert.match(row['credential_ref'] as string, /^credential:\d+$/);
    assert.equal(row['entry'], 'api', 'token 载体 → api（§7.4）');
    assert.notEqual(row['employee_id'], rootId);
  } finally {
    await ctx.close();
  }
});

test('employee.deactivate / employee.activate：PATCH admin employees 按最终态记行（主体=操作管理员）', async () => {
  const ctx = await build();
  try {
    await bootstrapAdmin(ctx);
    const sid = await login(ctx.app, 'root', 'password-root-1');
    const bobId = addEmployee(ctx.db, { username: 'bob' });
    const patch = (active: boolean) =>
      ctx.app.inject({
        method: 'PATCH',
        url: '/api/v1/admin/employees/bob',
        headers: { cookie: `ngt_sid=${sid}`, ...ORIGIN },
        payload: { active },
      });
    assert.equal((await patch(false)).statusCode, 204);
    assert.equal((await patch(true)).statusCode, 204);

    const off = rows(ctx.db, 'employee.deactivate');
    assert.equal(off.length, 1);
    assert.equal(off[0]!['employee_id'], (ctx.db.prepare(`SELECT id FROM employees WHERE username = 'root'`).get() as { id: number }).id);
    assert.equal(JSON.parse(off[0]!['detail'] as string)['username'], 'bob');
    assert.equal(off[0]!['entry'], 'web');
    const on = rows(ctx.db, 'employee.activate');
    assert.equal(on.length, 1);
    assert.equal(JSON.parse(on[0]!['detail'] as string)['username'], 'bob');
    void bobId;
  } finally {
    await ctx.close();
  }
});

test('employee.password_reset：K5 消费记目标员工、credential_ref NULL、entry=api', async () => {
  const ctx = await build();
  try {
    await bootstrapAdmin(ctx);
    const { token } = createInvite(ctx.db, ctx.pepper, { username: 'resetme', displayName: 'R', invitedBy: 1 }, new Date());
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password-reset',
      payload: { reset_token: token, new_password: 'password-reset-1' },
    });
    assert.equal(res.statusCode, 204, res.body);
    const rs = rows(ctx.db, 'employee.password_reset');
    assert.equal(rs.length, 1);
    const row = rs[0]!;
    const targetId = (ctx.db.prepare(`SELECT id FROM employees WHERE username = 'resetme'`).get() as { id: number }).id;
    assert.equal(row['actor_kind'], 'employee');
    assert.equal(row['employee_id'], targetId, '主体 = 口令被重置的目标员工（K5 归属）');
    assert.equal(row['credential_ref'], null, 'K5 非凭据载体（identity §8：载体=credential/session）');
    assert.equal(row['entry'], 'api');
  } finally {
    await ctx.close();
  }
});

test('脱敏扫描（验收）：全流程后 token/K5/口令明文不入审计行、日志与全库转储', async () => {
  const ctx = await build(true);
  try {
    await bootstrapAdmin(ctx);
    const sid = await login(ctx.app, 'root', 'password-root-1');
    // 凭据创建（T4 挂接）+ 撤销 + 邀请（K5）
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/credentials',
      headers: { cookie: `ngt_sid=${sid}`, ...ORIGIN },
      payload: { name: 'scan', expires_at: new Date(Date.now() + 86_400_000).toISOString() },
    });
    assert.equal(created.statusCode, 201, created.body);
    const ngtToken = (created.json() as { token: string }).token;
    const revoked = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/credentials/${(created.json() as { id: number }).id}`,
      headers: { cookie: `ngt_sid=${sid}`, ...ORIGIN },
    });
    assert.equal(revoked.statusCode, 204);
    const invite = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/employees',
      headers: { cookie: `ngt_sid=${sid}`, ...ORIGIN },
      payload: { username: 'scanuser', display_name: 'S' },
    });
    const k5Token = (invite.json() as { password_reset_token: string }).password_reset_token;

    await ctx.app.close();
    const log = await readFile(ctx.logFile, 'utf8');
    assert.ok(log.includes('incoming request'), '日志应有内容（扫描才是真实遍历）');
    // 日志：无任何 ngt_ 材料、K5 明文、口令明文
    assert.ok(!log.includes('ngt_'), '日志不得含 ngt_ 材料（含前缀）');
    assert.ok(!log.includes(k5Token), '日志不得含 K5 令牌明文');
    assert.ok(!log.includes('password-root-1'), '日志不得含口令明文');
    // 审计行：逐行扫
    for (const r of ctx.db.prepare('SELECT * FROM audit_events').all()) {
      const s = JSON.stringify(r);
      assert.ok(!s.includes(ngtToken), '审计行不得含 ngt_ 明文');
      assert.ok(!s.includes(k5Token), '审计行不得含 K5 明文');
      assert.ok(!/password-/i.test(s), '审计行不得含口令形态明文');
    }
    // 全库转储（含 credentials/one_time_tokens 等全部表）
    const dump = dumpAllText(ctx.db);
    assert.ok(!dump.includes(ngtToken), '全库不得含 ngt_ 明文（HMAC 存储）');
    assert.ok(!dump.includes(k5Token), '全库不得含 K5 明文（hmacv1$ 存储）');
  } finally {
    await ctx.close();
  }
});
