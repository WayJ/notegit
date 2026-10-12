import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { CredentialsService, ApiError, AUTHN_TOKEN_SQL } from '../src/credentials/service.ts';
import type { PepperSet } from '../src/credentials/pepper.ts';
import { generateToken, hashToken, displayHint } from '../src/credentials/token.ts';
import { newDb, addEmployee, addVault, addMember, dumpAllText, auditRows } from './credentials-fixtures.ts';

// identity §3 为唯一语义源；storage-model §4 authn.token 为规范查询；
// api.md §2.3 错误码。本文件测服务层（路由层另见 credentials-routes.test.ts）。

function makePepper(activeId = 1, retiredIds: number[] = []): PepperSet {
  const keys = [activeId, ...retiredIds].map((id) => ({ id, key: randomBytes(32) }));
  const byId = new Map(keys.map((k) => [k.id, k] as const));
  return {
    active: keys[0]!,
    retired: keys.slice(1),
    pepperFor: (v: number) => byId.get(v),
  };
}

function inDays(n: number): string {
  return new Date(Date.now() + n * 86400_000).toISOString();
}

interface Setup {
  db: DatabaseSync;
  alice: number; // 实例管理员
  bob: number; // 普通员工：alpha=editor、beta=reader
  alpha: number;
  beta: number;
  svc: CredentialsService;
}

function setup(opts: { pepper?: PepperSet; now?: () => string; maxCredentialsPerEmployee?: number } = {}): Setup {
  const db = newDb();
  const alice = addEmployee(db, { username: 'alice', is_instance_admin: 1 });
  const bob = addEmployee(db, { username: 'bob' });
  const alpha = addVault(db, 'alpha', alice);
  const beta = addVault(db, 'beta', alice);
  addMember(db, alpha, bob, 'editor', alice);
  addMember(db, beta, bob, 'reader', alice);
  const svc = new CredentialsService({
    db,
    pepper: opts.pepper ?? makePepper(),
    now: opts.now,
    maxCredentialsPerEmployee: opts.maxCredentialsPerEmployee,
  });
  return { db, alice, bob, alpha, beta, svc };
}

function expectApiError(fn: () => unknown, status: number, code: string): ApiError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ApiError, `应为 ApiError，实得 ${String(err)}`);
    assert.equal(err.status, status);
    assert.equal(err.code, code);
    return err;
  }
  assert.fail(`应抛 ApiError ${code}，实际未抛`);
}

test('创建：返回 ngt_ token 一次 + 记录字段；库内只存 hmacv1$ 哈希与 display_hint，明文不落库', () => {
  const s = setup();
  const { record, token } = s.svc.createCredential(s.bob, {
    name: '本地 Harness',
    expires_at: inDays(30),
    scope: { access: 'read', vaults: ['alpha'] },
  });
  assert.match(token, /^ngt_[A-Za-z0-9_-]{43}$/);
  assert.equal(record.name, '本地 Harness');
  assert.equal(record.display_hint, displayHint(token));
  assert.equal(record.scope_access, 'read');
  assert.deepEqual(record.scope_vaults, ['alpha']);
  assert.equal(record.revoked_at, null);
  assert.equal(record.last_used_at, null);
  assert.ok(record.expires_at > new Date().toISOString());

  const row = s.db.prepare('SELECT * FROM credentials WHERE id = ?').get(record.id) as Record<string, string>;
  assert.match(row['token_hash'] as string, /^hmacv1\$[0-9a-f]{64}$/);
  assert.equal(row['display_hint'], displayHint(token));
  assert.deepEqual(JSON.parse(row['scope_vaults'] as string), [s.alpha]);
  // 明文扫描：全库文本转储不含 token，也不含 token 的中段
  const dump = dumpAllText(s.db);
  assert.ok(!dump.includes(token), '凭据明文不得出现在任何库内字段');
  assert.ok(!dump.includes(token.slice(6, -4)), '凭据明文中段不得出现在任何库内字段');
});

test('创建：scope 可省 = read_write + 全部有权库（identity §3.4 默认）', () => {
  const s = setup();
  const { record } = s.svc.createCredential(s.bob, { name: 'x', expires_at: inDays(10) });
  assert.equal(record.scope_access, 'read_write');
  assert.deepEqual(record.scope_vaults, []);
});

test('创建校验：name 缺失/非字符串/空 → 400 E-RES-004', () => {
  const s = setup();
  expectApiError(() => s.svc.createCredential(s.bob, { expires_at: inDays(1) }), 400, 'E-RES-004');
  expectApiError(() => s.svc.createCredential(s.bob, { name: 42, expires_at: inDays(1) }), 400, 'E-RES-004');
  expectApiError(() => s.svc.createCredential(s.bob, { name: '', expires_at: inDays(1) }), 400, 'E-RES-004');
});

test('创建校验：expires_at 缺失/不可解析 → 400 E-RES-004；过去/超 90 天上限 → 422 E-RES-007', () => {
  const s = setup();
  expectApiError(() => s.svc.createCredential(s.bob, { name: 'x' }), 400, 'E-RES-004');
  expectApiError(() => s.svc.createCredential(s.bob, { name: 'x', expires_at: 'next tuesday' }), 400, 'E-RES-004');
  expectApiError(() => s.svc.createCredential(s.bob, { name: 'x', expires_at: inDays(-1) }), 422, 'E-RES-007');
  expectApiError(() => s.svc.createCredential(s.bob, { name: 'x', expires_at: inDays(91) }), 422, 'E-RES-007');
  // 恰好 90 天（≤ 实例上限）应通过
  const ok = s.svc.createCredential(s.bob, { name: 'x', expires_at: inDays(90) });
  assert.match(ok.token, /^ngt_/);
});

test('创建校验：scope 非法 → 422 E-RES-007（access 越枚举 / vaults 非数组 / 元素非字符串 / 未知 slug）', () => {
  const s = setup();
  expectApiError(() => s.svc.createCredential(s.bob, { name: 'x', expires_at: inDays(1), scope: { access: 'write' } }), 422, 'E-RES-007');
  expectApiError(() => s.svc.createCredential(s.bob, { name: 'x', expires_at: inDays(1), scope: 'read' }), 422, 'E-RES-007');
  expectApiError(() => s.svc.createCredential(s.bob, { name: 'x', expires_at: inDays(1), scope: { vaults: 'alpha' } }), 422, 'E-RES-007');
  expectApiError(() => s.svc.createCredential(s.bob, { name: 'x', expires_at: inDays(1), scope: { vaults: [42] } }), 422, 'E-RES-007');
  expectApiError(() => s.svc.createCredential(s.bob, { name: 'x', expires_at: inDays(1), scope: { vaults: ['ghost'] } }), 422, 'E-RES-007');
});

test('上限：每员工默认 20 条；第 21 条 → 409 E-RES-005；撤销/过期释放名额', () => {
  const s = setup();
  for (let i = 0; i < 20; i++) {
    s.svc.createCredential(s.bob, { name: `c${i}`, expires_at: inDays(1) });
  }
  expectApiError(() => s.svc.createCredential(s.bob, { name: 'over', expires_at: inDays(1) }), 409, 'E-RES-005');
  // 撤销第一条 → 名额释放
  const first = (s.db.prepare('SELECT id FROM credentials ORDER BY id LIMIT 1').get() as { id: number }).id;
  s.svc.revokeCredential(first, s.bob, { actorEmployeeId: s.bob });
  assert.match(s.svc.createCredential(s.bob, { name: 'after-revoke', expires_at: inDays(1) }).token, /^ngt_/);
  // 过期同样不计入在用名额
  expectApiError(() => s.svc.createCredential(s.bob, { name: 'over2', expires_at: inDays(1) }), 409, 'E-RES-005');
  s.db.prepare('UPDATE credentials SET expires_at = ? WHERE name = ?').run('2020-01-01T00:00:00.000Z', 'after-revoke');
  assert.match(s.svc.createCredential(s.bob, { name: 'after-expiry', expires_at: inDays(1) }).token, /^ngt_/);
  // 上限按员工隔离：alice 不受 bob 占满影响
  assert.match(s.svc.createCredential(s.alice, { name: 'alice-1', expires_at: inDays(1) }).token, /^ngt_/);
});

test('认证：authn.token 命中返回主体上下文并回写 last_used_at；规范 SQL 与契约一致', () => {
  const s = setup();
  const { token, record } = s.svc.createCredential(s.bob, {
    name: 't',
    expires_at: inDays(1),
    scope: { access: 'read', vaults: ['alpha'] },
  });
  const ctx = s.svc.authenticate(token);
  assert.equal(ctx.credentialId, record.id);
  assert.equal(ctx.employeeId, s.bob);
  assert.equal(ctx.isInstanceAdmin, false);
  assert.equal(ctx.scopeAccess, 'read');
  assert.deepEqual(ctx.scopeVaultIds, [s.alpha]);
  const row = s.db.prepare('SELECT last_used_at FROM credentials WHERE id = ?').get(record.id) as { last_used_at: string };
  assert.ok(row.last_used_at, '认证后应回写 last_used_at');

  // 规范查询防漂移：与 storage-model.md -- @query authn.token 归一化空白后逐字一致
  const doc = readFileSync(path.resolve(import.meta.dirname, '../../docs/contracts/storage-model.md'), 'utf8');
  const m = /```sql\n-- @query authn\.token\n([\s\S]*?)```/.exec(doc);
  assert.ok(m, 'storage-model.md 应含 @query authn.token 块');
  const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim();
  assert.equal(norm(AUTHN_TOKEN_SQL), norm(m[1]!), 'authn.token 查询须与契约逐字一致（仅空白差异）');
});

test('四状态认证：撤销 E-AUTH-003 / 过期 E-AUTH-002 / 停用 E-AUTH-004，reason 可区分；未知 token E-AUTH-001', () => {
  const s = setup();
  const revoked = s.svc.createCredential(s.bob, { name: 'r', expires_at: inDays(1) });
  s.svc.revokeCredential(revoked.record.id, s.bob, { actorEmployeeId: s.bob });
  const e1 = expectApiError(() => s.svc.authenticate(revoked.token), 401, 'E-AUTH-003');
  assert.equal(e1.details?.['reason'], 'revoked');

  const expired = s.svc.createCredential(s.bob, { name: 'e', expires_at: inDays(1) });
  s.db.prepare('UPDATE credentials SET expires_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', expired.record.id);
  const e2 = expectApiError(() => s.svc.authenticate(expired.token), 401, 'E-AUTH-002');
  assert.equal(e2.details?.['reason'], 'expired');

  const disabled = s.svc.createCredential(s.bob, { name: 'd', expires_at: inDays(1) });
  s.db.prepare('UPDATE employees SET active = 0 WHERE id = ?').run(s.bob);
  const e3 = expectApiError(() => s.svc.authenticate(disabled.token), 401, 'E-AUTH-004');
  assert.equal(e3.details?.['reason'], 'account_disabled');
  s.db.prepare('UPDATE employees SET active = 1 WHERE id = ?').run(s.bob);

  expectApiError(() => s.svc.authenticate('ngt_' + 'A'.repeat(43)), 401, 'E-AUTH-001');
  expectApiError(() => s.svc.authenticate('garbage'), 401, 'E-AUTH-001');

  // 撤销优先于过期（都置位时报 revoked——显式管理动作优先）
  const both = s.svc.createCredential(s.bob, { name: 'b', expires_at: inDays(1) });
  s.db.prepare('UPDATE credentials SET expires_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', both.record.id);
  s.svc.revokeCredential(both.record.id, s.bob, { actorEmployeeId: s.bob });
  expectApiError(() => s.svc.authenticate(both.token), 401, 'E-AUTH-003');
});

test('认证：retired pepper 哈希的 token 仍可校验（D-IC-09 存储格式：按版本选键）', () => {
  const pepper = makePepper(2, [1]);
  const s = setup({ pepper });
  // 直接以 retired(v1) 键落一条凭据（模拟轮换前签发）
  const token = generateToken();
  const hash = hashToken(pepper.retired[0]!, token);
  s.db.prepare(
    `INSERT INTO credentials (employee_id, name, token_hash, display_hint, created_at, expires_at) VALUES (?, 'old', ?, ?, ?, ?)`,
  ).run(s.bob, hash, displayHint(token), new Date().toISOString(), inDays(5));
  const ctx = s.svc.authenticate(token);
  assert.equal(ctx.employeeId, s.bob);
});

test('last_used_at 节流：60 秒内不重复写，超 60 秒才更新（identity §3.3，观测字段）', () => {
  const base = Date.now();
  let offset = 0;
  const s = setup({ now: () => new Date(base + offset).toISOString() });
  const { token, record } = s.svc.createCredential(s.bob, { name: 't', expires_at: inDays(1) });
  const read = () =>
    (s.db.prepare('SELECT last_used_at FROM credentials WHERE id = ?').get(record.id) as { last_used_at: string | null }).last_used_at;

  s.svc.authenticate(token);
  const t1 = read();
  assert.ok(t1);
  offset = 30_000; // +30s：节流窗口内
  s.svc.authenticate(token);
  assert.equal(read(), t1, '60 秒内不重复回写');
  offset = 61_000; // +61s：超出节流间隔
  s.svc.authenticate(token);
  assert.ok(read()! > t1!, '超 60 秒应更新');
});

test('撤销：置位 revoked_at 即时生效；他人/不存在的凭据 404（不可见语义）；重复撤销幂等不重复审计', () => {
  const s = setup();
  const mine = s.svc.createCredential(s.bob, { name: 'm', expires_at: inDays(1) });
  const other = s.svc.createCredential(s.alice, { name: 'o', expires_at: inDays(1) });

  expectApiError(() => s.svc.revokeCredential(other.record.id, s.bob, { actorEmployeeId: s.bob }), 404, 'E-RES-001');
  expectApiError(() => s.svc.revokeCredential(999999, s.bob, { actorEmployeeId: s.bob }), 404, 'E-RES-001');

  s.svc.revokeCredential(mine.record.id, s.bob, { actorEmployeeId: s.bob });
  const row = s.db.prepare('SELECT revoked_at FROM credentials WHERE id = ?').get(mine.record.id) as { revoked_at: string };
  assert.ok(row.revoked_at);
  expectApiError(() => s.svc.authenticate(mine.token), 401, 'E-AUTH-003');

  s.svc.revokeCredential(mine.record.id, s.bob, { actorEmployeeId: s.bob }); // 幂等
  assert.equal(auditRows(s.db, 'credential.revoke').length, 1, '重复撤销不重复审计');
});

test('列表：按员工返回，display_hint 有、token 无；撤销行保留并带 revoked_at', () => {
  const s = setup();
  const a = s.svc.createCredential(s.bob, { name: 'a', expires_at: inDays(1) });
  const b = s.svc.createCredential(s.bob, { name: 'b', expires_at: inDays(2), scope: { access: 'read', vaults: ['beta'] } });
  s.svc.createCredential(s.alice, { name: 'c', expires_at: inDays(1) });
  s.svc.revokeCredential(a.record.id, s.bob, { actorEmployeeId: s.bob });

  const list = s.svc.listCredentials(s.bob);
  assert.equal(list.length, 2);
  const ser = JSON.stringify(list);
  assert.ok(!ser.includes('"token"'), '列表不得含 token 字段');
  assert.ok(!ser.includes(a.token), '列表不得含明文');
  assert.ok(!ser.includes(b.token), '列表不得含明文');
  const revokedRow = list.find((r) => r.name === 'a')!;
  assert.ok(revokedRow.revoked_at);
  assert.equal(revokedRow.display_hint, a.record.display_hint);
  const scoped = list.find((r) => r.name === 'b')!;
  assert.equal(scoped.scope_access, 'read');
  assert.deepEqual(scoped.scope_vaults, ['beta']);
});

test('审计：credential.create / credential.revoke 直接终态、主体=认证员工、无 token 材料；代管撤销 detail 记录', () => {
  const s = setup();
  const created = s.svc.createCredential(s.bob, { name: 'n', expires_at: inDays(1) });

  const creates = auditRows(s.db, 'credential.create');
  assert.equal(creates.length, 1);
  assert.equal(creates[0]!.employee_id, s.bob);
  assert.equal(creates[0]!.credential_ref, `credential:${created.record.id}`);
  assert.equal(creates[0]!.status, 'succeeded');
  assert.equal(creates[0]!.entry, 'api');

  // 管理员代管撤销：主体=管理员 alice，detail 记代管目标
  s.svc.revokeCredential(created.record.id, s.bob, { actorEmployeeId: s.alice, managedByUsername: 'bob' });
  const revokes = auditRows(s.db, 'credential.revoke');
  assert.equal(revokes.length, 1);
  assert.equal(revokes[0]!.employee_id, s.alice, '主体=认证员工（管理员），非被代管员工');
  assert.equal(revokes[0]!.credential_ref, `credential:${created.record.id}`);
  assert.ok(revokes[0]!.detail.includes('bob'), 'detail 记代管目标');
  // 审计与全库转储不含明文
  const dump = dumpAllText(s.db);
  assert.ok(!dump.includes(created.token));
});

test('scope 两维收窄：与员工当前权限取交集；越范围/非成员/不存在 → 同一 not_found（404 语义，D-IC-06）', () => {
  const s = setup();
  // bob：alpha=editor、beta=reader、非 gamma 成员
  const gamma = addVault(s.db, 'gamma', s.alice);
  const scoped = { access: 'read_write' as const, vaultIds: [s.alpha, gamma] };

  const alphaRes = s.svc.resolveVaultAccess(s.bob, scoped, 'alpha');
  assert.deepEqual(alphaRes, { allowed: true, access: 'read_write' });
  // 角色取更严者：beta=reader，即使 scope access=read_write 也只得 read
  const betaRes = s.svc.resolveVaultAccess(s.bob, { access: 'read_write', vaultIds: [] }, 'beta');
  assert.deepEqual(betaRes, { allowed: true, access: 'read' });
  // scope access 收窄角色：alpha=editor 但 scope 只给 read
  const alphaRead = s.svc.resolveVaultAccess(s.bob, { access: 'read', vaultIds: [] }, 'alpha');
  assert.deepEqual(alphaRead, { allowed: true, access: 'read' });

  // 越范围（beta 不在清单）→ not_found；与不存在库、非成员库不可区分
  const outOfScope = s.svc.resolveVaultAccess(s.bob, scoped, 'beta');
  const nonexistent = s.svc.resolveVaultAccess(s.bob, scoped, 'ghost');
  const notMember = s.svc.resolveVaultAccess(s.bob, scoped, 'gamma'); // 清单内但无成员关系
  assert.deepEqual(outOfScope, { allowed: false, reason: 'not_found' });
  assert.deepEqual(nonexistent, outOfScope, '越范围与不存在响应不可区分（不泄露存在性）');
  assert.deepEqual(notMember, outOfScope, '清单内但无成员关系同样 404');

  // 员工被撤权后，scope 清单内也 404（与员工当前权限取交集——撤权自动收窄）
  s.db.prepare('DELETE FROM vault_members WHERE vault_id = ? AND employee_id = ?').run(s.alpha, s.bob);
  assert.deepEqual(s.svc.resolveVaultAccess(s.bob, scoped, 'alpha'), { allowed: false, reason: 'not_found' });
});

test('上限可配：maxCredentialsPerEmployee 生效（identity §3.5 可配）', () => {
  const s = setup({ maxCredentialsPerEmployee: 2 });
  s.svc.createCredential(s.bob, { name: 'a', expires_at: inDays(1) });
  s.svc.createCredential(s.bob, { name: 'b', expires_at: inDays(1) });
  expectApiError(() => s.svc.createCredential(s.bob, { name: 'c', expires_at: inDays(1) }), 409, 'E-RES-005');
});
