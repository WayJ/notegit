import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../src/db/migrate.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { buildApp } from '../src/app.ts';
import { CredentialsService } from '../src/credentials/service.ts';
import { createSession, DEFAULT_SESSION_TIMEOUTS } from '../src/auth/sessions.ts';
import {
  authorize,
  reauthorizeAtExecutionPoint,
  type MembershipSource,
  type MembershipLookup,
} from '../src/auth/lifecycle.ts';
import { newDb } from './credentials-fixtures.ts';

// S2-T5：identity §5.2 后果表 8 组用例（4 状态 × 2 入口）逐一断言 + §5.3 边界 +
// 授权层接口契约（mock 成员关系源，T6 接真实 vaults/vault_members 表）。
// - Web 入口 = ngt_sid 会话 Cookie（经 GET /api/v1/me 呈现）；
// - Git/API 入口 = Authorization: Bearer ngt_…（经 GET /api/v1/credentials 呈现）；
// - 撤权行经 authorize 缝断言（clone/refs 发现/对象读 = read；push = write）。

interface Harness {
  app: ReturnType<typeof buildApp>;
  db: DatabaseSync;
  seed: CredentialsService;
  employee(username: string, opts?: { admin?: boolean; active?: number }): number;
  session(employeeId: number): string;
  token(employeeId: number, scope?: { access: 'read' | 'read_write'; vaults: string[] }): string;
  close(): Promise<void>;
}

async function harness(): Promise<Harness> {
  // employees/sessions/credentials 由真实迁移建立；vaults/vault_members/audit_events
  // 属 S2-T6/T7，用 fixtures 的 IF NOT EXISTS 形态 DDL 供审计与 scope 断言（T4 同款）。
  const db = newDb();
  const pepper = { active: { version: 1, key: randomBytes(32) }, retired: [] as never[] };
  const seed = new CredentialsService({ db, pepper });
  const dir = await mkdtemp(path.join(tmpdir(), 'notegit-life-'));
  const bootstrapTokenFile = path.join(dir, 'admin-bootstrap.token');
  await writeFile(bootstrapTokenFile, 'fixture-unused');
  const app = buildApp({ db, pepper, bootstrapTokenFile });
  const now = new Date();
  return {
    app,
    db,
    seed,
    employee(username, opts) {
      db.prepare(
        `INSERT INTO employees (username, display_name, password_hash, is_instance_admin, active, invited_by, created_at)
         VALUES (?, ?, 'fixture-not-argon2', ?, ?, NULL, ?)`,
      ).run(username, username, opts?.admin ? 1 : 0, opts?.active ?? 1, now.toISOString());
      return (db.prepare('SELECT id FROM employees WHERE username = ?').get(username) as { id: number }).id;
    },
    session(employeeId) {
      return createSession(db, employeeId, pepper.active.key, now, DEFAULT_SESSION_TIMEOUTS).sid;
    },
    token(employeeId, scope) {
      return seed
        .createCredential(employeeId, {
          name: 'seed',
          expires_at: new Date(now.getTime() + 30 * 86_400_000).toISOString(),
          ...(scope ? { scope } : {}),
        })
        .token;
    },
    close: async () => {
      await app.close();
      db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function sidCookie(sid: string): Record<string, string> {
  return { cookie: `ngt_sid=${sid}` };
}

/** 同源头（api.md §1 CSRF 校验的对象；本文件 POST 均带，与后续 CSRF 插件一致） */
const SAME_ORIGIN = 'http://localhost';

function errOf(res: { json(): unknown }): { code?: string; details?: { reason?: string } } {
  return ((res.json() as { error?: Record<string, unknown> }).error ?? {}) as { code?: string; details?: { reason?: string } };
}

/** 授权层 mock 成员关系源（identity §5.1 第 2 层的接口化；T6 以 authz.role 规范查询实现） */
function mockSource(rows: Array<{ employeeId: number; slug: string; vaultId: number; role: 'reader' | 'editor' | 'admin' }>): {
  source: MembershipSource;
  revoke(employeeId: number, slug: string): void;
} {
  const map = new Map<string, MembershipLookup>();
  for (const r of rows) map.set(`${r.employeeId}\u0000${r.slug}`, { vaultId: r.vaultId, role: r.role });
  return {
    source: {
      lookup(slug, employeeId) {
        return map.get(`${employeeId}\u0000${slug}`);
      },
    },
    revoke(employeeId, slug) {
      map.delete(`${employeeId}\u0000${slug}`);
    },
  };
}

// ── §5.2 行 1：凭据过期 ──────────────────────────────────────────────────────

test('① 过期 × Web 会话：token 过期后会话入口不受影响（会话是独立凭据，identity §1/§5.2）', async () => {
  const h = await harness();
  try {
    const bob = h.employee('bob');
    const sid = h.session(bob);
    h.token(bob); // 会话之外另持一条 token
    h.db.prepare('UPDATE credentials SET expires_at = ?').run('2000-01-01T00:00:00.000Z');
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: sidCookie(sid) });
    assert.equal(res.statusCode, 200, `会话不应受 token 过期影响，实际 ${res.statusCode}: ${res.body}`);
    assert.equal((res.json() as { username: string }).username, 'bob');
  } finally {
    await h.close();
  }
});

test('② 过期 × Git/API token：下一请求立即 401 E-AUTH-002（零延迟，逐请求比较 expires_at）', async () => {
  const h = await harness();
  try {
    const bob = h.employee('bob');
    const token = h.token(bob);
    const before = await h.app.inject({ method: 'GET', url: '/api/v1/credentials', headers: bearer(token) });
    assert.equal(before.statusCode, 200);
    h.db.prepare('UPDATE credentials SET expires_at = ?').run('2000-01-01T00:00:00.000Z');
    const after = await h.app.inject({ method: 'GET', url: '/api/v1/credentials', headers: bearer(token) });
    assert.equal(after.statusCode, 401);
    assert.equal(errOf(after).code, 'E-AUTH-002');
    assert.equal(errOf(after).details?.reason, 'expired');
  } finally {
    await h.close();
  }
});

// ── §5.2 行 2：凭据撤销 ──────────────────────────────────────────────────────

test('③ 撤销 × Web 会话：撤销 token 不影响该账号会话（凭据互不连带，identity §1）', async () => {
  const h = await harness();
  try {
    const bob = h.employee('bob');
    const sid = h.session(bob);
    const cred = h.seed.createCredential(bob, { name: 'x', expires_at: new Date(Date.now() + 86_400_000).toISOString() });
    h.seed.revokeCredential(cred.record.id, bob, { actorEmployeeId: bob });
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: sidCookie(sid) });
    assert.equal(res.statusCode, 200);
  } finally {
    await h.close();
  }
});

test('④ 撤销 × Git/API token：下一请求立即 401 E-AUTH-003（与过期可区分，审计归因用）', async () => {
  const h = await harness();
  try {
    const bob = h.employee('bob');
    const token = h.token(bob);
    const credId = (h.db.prepare('SELECT id FROM credentials ORDER BY id DESC LIMIT 1').get() as { id: number }).id;
    h.seed.revokeCredential(credId, bob, { actorEmployeeId: bob });
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/credentials', headers: bearer(token) });
    assert.equal(res.statusCode, 401);
    assert.equal(errOf(res).code, 'E-AUTH-003');
    assert.equal(errOf(res).details?.reason, 'revoked');
  } finally {
    await h.close();
  }
});

// ── §5.2 行 3：账号停用 ──────────────────────────────────────────────────────

test('⑤ 停用 × Web 会话：全部会话下一请求 401 E-AUTH-004 并登出（清 Cookie），无宽限期', async () => {
  const h = await harness();
  try {
    const bob = h.employee('bob');
    const sidA = h.session(bob);
    const sidB = h.session(bob);
    const ok = await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: sidCookie(sidA) });
    assert.equal(ok.statusCode, 200);
    h.db.prepare('UPDATE employees SET active = 0 WHERE id = ?').run(bob);
    for (const [label, sid] of [['A', sidA], ['B', sidB]] as const) {
      const res = await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: sidCookie(sid) });
      assert.equal(res.statusCode, 401, `会话 ${label} 应即刻无效`);
      assert.equal(errOf(res).code, 'E-AUTH-004');
      assert.equal(errOf(res).details?.reason, 'account_disabled');
      assert.match(String(res.headers['set-cookie'] ?? ''), /Max-Age=0/, '被登出应清 Cookie');
    }
    // 生效来自认证层逐请求查 active，而非删除行（storage-model §4 authn.session）
    const rows = h.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE employee_id = ?').get(bob) as { n: number };
    assert.equal(rows.n, 2, '停用不删除会话行（零延迟语义来自逐请求检查）');
  } finally {
    await h.close();
  }
});

test('⑥ 停用 × Git/API token：该账号全部 token 下一请求 401 E-AUTH-004（无论各 token 自身状态）', async () => {
  const h = await harness();
  try {
    const bob = h.employee('bob');
    const tokenA = h.token(bob);
    const tokenB = h.token(bob);
    h.db.prepare('UPDATE employees SET active = 0 WHERE id = ?').run(bob);
    for (const [label, token] of [['A', tokenA], ['B', tokenB]] as const) {
      const res = await h.app.inject({ method: 'GET', url: '/api/v1/credentials', headers: bearer(token) });
      assert.equal(res.statusCode, 401, `token ${label} 应即刻无效`);
      assert.equal(errOf(res).code, 'E-AUTH-004');
      assert.equal(errOf(res).details?.reason, 'account_disabled');
    }
  } finally {
    await h.close();
  }
});

// ── §5.2 行 4：库成员撤权（授权层接口契约；T6 接真实表） ────────────────────

test('⑦ 撤权 × Web 会话：该库从可见集消失、直接访问 not_found（404 语义），其他库不受影响', async () => {
  const h = await harness();
  try {
    const alice = h.employee('alice');
    const { source, revoke } = mockSource([
      { employeeId: alice, slug: 'alpha', vaultId: 1, role: 'editor' },
      { employeeId: alice, slug: 'beta', vaultId: 2, role: 'reader' },
    ]);
    // 撤权前：两库均可见（列表 = 对每个库实时查权限的推导）
    const visible = (['alpha', 'beta'] as const).map((slug) => authorize(source, alice, slug, 'read').allowed);
    assert.deepEqual(visible, [true, true]);
    revoke(alice, 'alpha');
    // 撤权后：alpha 消失（下一次渲染即实时查权限）、beta 不受影响
    assert.deepEqual(authorize(source, alice, 'alpha', 'read'), { allowed: false, reason: 'not_found' });
    assert.equal(authorize(source, alice, 'beta', 'read').allowed, true);
    // 直接访问与「不存在」响应一致（D-IC-06，不泄露库存在性）
    assert.deepEqual(
      authorize(source, alice, 'alpha', 'read'),
      authorize(source, alice, 'no-such-vault', 'read'),
    );
  } finally {
    await h.close();
  }
});

test('⑧ 撤权 × Git/API token：clone（refs 发现）、fetch（对象读）、push 一律 not_found，与不存在一致', async () => {
  const h = await harness();
  try {
    const alice = h.employee('alice');
    const { source, revoke } = mockSource([{ employeeId: alice, slug: 'alpha', vaultId: 1, role: 'editor' }]);
    assert.equal(authorize(source, alice, 'alpha', 'write').allowed, true, '前置：撤权前可 push');
    revoke(alice, 'alpha');
    const ghost = authorize(source, alice, 'no-such-vault', 'read');
    for (const action of ['read', 'write'] as const) {
      const d = authorize(source, alice, 'alpha', action);
      assert.deepEqual(d, ghost, `撤权后 ${action} 应与不存在一致（identity §5.2 行 4）`);
      assert.deepEqual(d, { allowed: false, reason: 'not_found' });
    }
  } finally {
    await h.close();
  }
});

// ── §5.3 边界：在途操作按起点放行；执行点复查钩子（§5.1 第 3 层，S3 挂接） ──

test('⑨ 在途操作按起点放行：起点通过的授权在其操作期间不被追溯；「后续请求」立即反映新状态', async () => {
  const h = await harness();
  try {
    const alice = h.employee('alice');
    const { source, revoke } = mockSource([{ employeeId: alice, slug: 'alpha', vaultId: 1, role: 'editor' }]);
    const atStart = authorize(source, alice, 'alpha', 'read'); // 在途操作的起点授权
    revoke(alice, 'alpha');
    // 起点判定不因后续撤权被追溯改写（操作按其认证与授权通过时刻放行完成，identity §5.3）
    assert.equal(atStart.allowed, true);
    // 同一主体下一请求（新检查）立即阻断
    assert.equal(authorize(source, alice, 'alpha', 'read').allowed, false);
  } finally {
    await h.close();
  }
});

test('⑩ 执行点复查钩子：撤权发生在检查后、执行点前 → 在途 push 被拒（写路径附加，供 S3 挂接）', async () => {
  const h = await harness();
  try {
    const alice = h.employee('alice');
    const { source, revoke } = mockSource([{ employeeId: alice, slug: 'alpha', vaultId: 1, role: 'editor' }]);
    assert.equal(authorize(source, alice, 'alpha', 'write').allowed, true, '前置：起点检查通过');
    revoke(alice, 'alpha');
    // identity §5.2 行 4：在途 push 在执行点复查时被拒（并记审计 rejected——随 S2-T7）
    assert.deepEqual(reauthorizeAtExecutionPoint(source, alice, 'alpha'), { allowed: false, reason: 'not_found' });
  } finally {
    await h.close();
  }
});

test('⑪ 授权层角色与 scope 语义：reader 读允许/写 forbidden（403），scope 只能收窄（identity §3.4）', async () => {
  const h = await harness();
  try {
    const alice = h.employee('alice');
    const { source } = mockSource([
      { employeeId: alice, slug: 'alpha', vaultId: 1, role: 'reader' },
      { employeeId: alice, slug: 'beta', vaultId: 2, role: 'editor' },
      { employeeId: alice, slug: 'gamma', vaultId: 3, role: 'admin' },
    ]);
    assert.deepEqual(authorize(source, alice, 'alpha', 'read'), { allowed: true, role: 'reader', access: 'read' });
    assert.deepEqual(authorize(source, alice, 'alpha', 'write'), { allowed: false, reason: 'forbidden' });
    assert.deepEqual(authorize(source, alice, 'beta', 'write'), { allowed: true, role: 'editor', access: 'read_write' });
    assert.deepEqual(authorize(source, alice, 'gamma', 'write'), { allowed: true, role: 'admin', access: 'read_write' });
    // scope 收窄：read-scoped token 对 editor 库不可写；清单外库与不存在一致（404）
    assert.deepEqual(
      authorize(source, alice, 'beta', 'write', { access: 'read', vaultIds: [2] }),
      { allowed: false, reason: 'forbidden' },
    );
    assert.deepEqual(
      authorize(source, alice, 'beta', 'read', { access: 'read_write', vaultIds: [1, 3] }),
      { allowed: false, reason: 'not_found' },
    );
  } finally {
    await h.close();
  }
});

// ── 载体并存与归因（architecture-notes §7 定稿语义的实现面） ────────────────

test('⑫ 载体并存：Authorization: Bearer 优先于会话 Cookie；非 Bearer scheme 不回退 Cookie', async () => {
  const h = await harness();
  try {
    const alice = h.employee('alice');
    const bob = h.employee('bob');
    const bobSid = h.session(bob); // 有效但属于另一账号的会话
    const aliceToken = h.token(alice);
    // Bearer 赢：主体应为 alice（若 Cookie 优先则会显示 bob）
    const res = await h.app.inject({
      method: 'GET', url: '/api/v1/me',
      headers: { ...bearer(aliceToken), ...sidCookie(bobSid) },
    });
    assert.equal(res.statusCode, 200);
    assert.equal((res.json() as { username: string }).username, 'alice', '并存时 Bearer 优先');
    // Authorization 非 Bearer scheme：显式选择了不受理的头凭据 → 401，不静默回退 Cookie
    const basic = await h.app.inject({
      method: 'GET', url: '/api/v1/credentials',
      headers: { authorization: 'Basic dXNlcjpwdw==', ...sidCookie(bobSid) },
    });
    assert.equal(basic.statusCode, 401);
    assert.equal(errOf(basic).code, 'E-AUTH-001');
  } finally {
    await h.close();
  }
});

test('⑬ 审计入口归因：会话载体凭据操作 entry=web，Bearer 载体 entry=api（identity §8；T7 消费）', async () => {
  const h = await harness();
  try {
    const bob = h.employee('bob');
    const sid = h.session(bob);
    const token = h.token(bob); // 该种子自身的审计行不计入（createCredential 直接调用）
    const before = (h.db.prepare('SELECT COUNT(*) AS n FROM audit_events').get() as { n: number }).n;
    const viaCookie = await h.app.inject({
      method: 'POST', url: '/api/v1/credentials',
      headers: { ...sidCookie(sid), origin: SAME_ORIGIN },
      payload: { name: 'by-session', expires_at: new Date(Date.now() + 86_400_000).toISOString() },
    });
    assert.equal(viaCookie.statusCode, 201, viaCookie.body);
    const viaBearer = await h.app.inject({
      method: 'POST', url: '/api/v1/credentials',
      headers: bearer(token),
      payload: { name: 'by-token', expires_at: new Date(Date.now() + 86_400_000).toISOString() },
    });
    assert.equal(viaBearer.statusCode, 201, viaBearer.body);
    const entries = h.db
      .prepare("SELECT entry FROM audit_events WHERE event_kind = 'credential.create' AND id > ? ORDER BY id")
      .all(before) as { entry: string }[];
    assert.deepEqual(entries.map((e) => e.entry), ['web', 'api']);
  } finally {
    await h.close();
  }
});

test('⑭ /api/v1/me 双载体（api.md §3 错误列 001/002/003/004）：Bearer 可用且四状态映射与会话一致', async () => {
  const h = await harness();
  try {
    const bob = h.employee('bob');
    const token = h.token(bob);
    const ok = await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(token) });
    assert.equal(ok.statusCode, 200);
    assert.equal((ok.json() as { username: string }).username, 'bob');
    h.db.prepare('UPDATE credentials SET expires_at = ?').run('2000-01-01T00:00:00.000Z');
    const expired = await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(token) });
    assert.equal(expired.statusCode, 401);
    assert.equal(errOf(expired).code, 'E-AUTH-002');
    h.db.prepare('UPDATE employees SET active = 0 WHERE id = ?').run(bob);
    const disabled = await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: `Bearer ${h.token(bob)}` } });
    // 上行 token 因停用前创建仍「未过期/未撤销」，但账号停用应阻断：
    // （bob 已停用，用其另一条 token 断言 E-AUTH-004）
    assert.equal(disabled.statusCode, 401);
    assert.equal(errOf(disabled).code, 'E-AUTH-004');
  } finally {
    await h.close();
  }
});

test('⑮ T2 路由四状态统一：停用账号经会话与 Bearer 调管理路由 → 401 E-AUTH-004（缝修复，S2-T5 收尾 b）', async () => {
  const h = await harness();
  try {
    const boss = h.employee('boss', { admin: true });
    const sid = h.session(boss);
    const token = h.token(boss);
    const payload = { username: 'newbie', display_name: 'New Bee' };
    const invite = await h.app.inject({
      method: 'POST', url: '/api/v1/admin/employees',
      headers: { ...sidCookie(sid), origin: SAME_ORIGIN }, payload,
    });
    assert.equal(invite.statusCode, 201, `前置：在岗管理员可邀请，实际 ${invite.statusCode}: ${invite.body}`);
    h.db.prepare('UPDATE employees SET active = 0 WHERE id = ?').run(boss);
    const viaSession = await h.app.inject({
      method: 'POST', url: '/api/v1/admin/employees',
      headers: { ...sidCookie(sid), origin: SAME_ORIGIN }, payload: { username: 'n2', display_name: 'N2' },
    });
    assert.equal(viaSession.statusCode, 401);
    assert.equal(errOf(viaSession).code, 'E-AUTH-004', '会话载体停用应精确 E-AUTH-004（此前缝丢失原因）');
    const viaToken = await h.app.inject({
      method: 'POST', url: '/api/v1/admin/employees',
      headers: bearer(token), payload: { username: 'n3', display_name: 'N3' },
    });
    assert.equal(viaToken.statusCode, 401);
    assert.equal(errOf(viaToken).code, 'E-AUTH-004', 'Bearer 载体停用应 E-AUTH-004');
  } finally {
    await h.close();
  }
});
