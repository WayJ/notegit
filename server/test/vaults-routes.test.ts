import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../src/app.ts';
import { CredentialsService } from '../src/credentials/service.ts';
import { createSession, DEFAULT_SESSION_TIMEOUTS } from '../src/auth/sessions.ts';
import { branchWriteRules } from '../src/vaults/branch-rules.ts';
import { newDb } from './credentials-fixtures.ts';

// S2-T6 库与成员端点（api.md §5）：建库（任意 active 员工、创建者自动 admin、
// slug 冲突 409、非法 slug 400/422）、成员可见性列表、单库 404 语义、PATCH（库
// 管理员；slug 改名 id 稳定）、成员管理（库管理员；普通成员 403）。授权判定经
// 共用 authorize（结构断言与双员工矩阵见 vaults-matrix.test.ts）。

interface Harness {
  app: ReturnType<typeof buildApp>;
  db: DatabaseSync;
  seed: CredentialsService;
  employee(username: string, opts?: { admin?: boolean }): number;
  session(employeeId: number): string;
  token(employeeId: number, scope?: { access: 'read' | 'read_write'; vaults: string[] }): string;
  close(): Promise<void>;
}

async function harness(): Promise<Harness> {
  const db = newDb();
  const pepper = { active: { version: 1, key: randomBytes(32) }, retired: [] as never[] };
  const seed = new CredentialsService({ db, pepper });
  const dir = await mkdtemp(path.join(tmpdir(), 'notegit-vaults-'));
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
         VALUES (?, ?, 'fixture-not-argon2', ?, 1, NULL, ?)`,
      ).run(username, username, opts?.admin ? 1 : 0, now.toISOString());
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

const SAME_ORIGIN = 'http://localhost';

function errOf(res: { json(): unknown }): { code?: string } {
  return ((res.json() as { error?: { code?: string } }).error ?? {}) as { code?: string };
}

function vaultRow(db: DatabaseSync, slug: string): { id: number; slug: string; name: string; default_branch: string; main_admin_only: number; created_by: number } {
  const row = db.prepare('SELECT * FROM vaults WHERE slug = ?').get(slug);
  assert.ok(row, `vault ${slug} 应存在`);
  return row as never;
}

// ── POST /api/v1/vaults（建库；任意 active 员工，创建者自动 admin） ──────────

test('建库：任意 active 普通员工可建；201 形态 {id, slug, name, default_branch: main, main_admin_only: false, role: admin}', async () => {
  const h = await harness();
  try {
    const alice = h.employee('alice'); // 非实例管理员
    const sid = h.session(alice);
    const res = await h.app.inject({
      method: 'POST', url: '/api/v1/vaults',
      headers: { ...sidCookie(sid), origin: SAME_ORIGIN },
      payload: { name: '知识库 Alpha', slug: 'alpha' },
    });
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as ReturnType<typeof JSON.parse> & { id: number; slug: string; name: string; default_branch: string; main_admin_only: boolean; role: string };
    assert.equal(body.slug, 'alpha');
    assert.equal(body.name, '知识库 Alpha');
    assert.equal(body.default_branch, 'main');
    assert.equal(body.main_admin_only, false);
    assert.equal(body.role, 'admin');
    assert.ok(Number.isSafeInteger(body.id) && body.id > 0, '稳定内部 id（正整数）');
    // 创建者自动成为库管理员（架构 §4.2；epic D 裁定 2A）
    const member = h.db.prepare('SELECT role FROM vault_members WHERE vault_id = ? AND employee_id = ?').get(body.id, alice) as { role: string };
    assert.equal(member.role, 'admin');
    // vaults 行归因
    assert.equal(vaultRow(h.db, 'alpha').created_by, alice);
    // 审计 vault.create（entry=web：会话载体）
    const audit = h.db.prepare("SELECT entry, status, vault_id FROM audit_events WHERE event_kind = 'vault.create'").all() as { entry: string; status: string; vault_id: number }[];
    assert.deepEqual(audit.map((a) => ({ ...a })), [{ entry: 'web', status: 'succeeded', vault_id: body.id }]);
  } finally {
    await h.close();
  }
});

test('建库审计入口归因：Bearer 载体 entry=api（identity §8；与会话载体 web 并立）', async () => {
  const h = await harness();
  try {
    const bob = h.employee('bob');
    const token = h.token(bob);
    const res = await h.app.inject({
      method: 'POST', url: '/api/v1/vaults', headers: bearer(token),
      payload: { name: 'Beta', slug: 'beta' },
    });
    assert.equal(res.statusCode, 201, res.body);
    const audit = h.db.prepare("SELECT entry FROM audit_events WHERE event_kind = 'vault.create'").all() as { entry: string }[];
    assert.deepEqual(audit.map((a) => ({ ...a }).entry), ['api']);
  } finally {
    await h.close();
  }
});

test('建库：slug 冲突 → 409 E-RES-002（实例内唯一，架构 §7.2）', async () => {
  const h = await harness();
  try {
    const alice = h.employee('alice');
    const sid = h.session(alice);
    const first = await h.app.inject({
      method: 'POST', url: '/api/v1/vaults',
      headers: { ...sidCookie(sid), origin: SAME_ORIGIN },
      payload: { name: 'A', slug: 'alpha' },
    });
    assert.equal(first.statusCode, 201);
    const second = await h.app.inject({
      method: 'POST', url: '/api/v1/vaults',
      headers: { ...sidCookie(sid), origin: SAME_ORIGIN },
      payload: { name: 'Another', slug: 'alpha' },
    });
    assert.equal(second.statusCode, 409);
    assert.equal(errOf(second).code, 'E-RES-002');
  } finally {
    await h.close();
  }
});

test('建库：slug 非法字符集/长度 → 422 E-RES-007；缺必填/类型错 → 400 E-RES-004', async () => {
  const h = await harness();
  try {
    const alice = h.employee('alice');
    const sid = h.session(alice);
    const post = async (payload: Record<string, unknown>) =>
      h.app.inject({ method: 'POST', url: '/api/v1/vaults', headers: { ...sidCookie(sid), origin: SAME_ORIGIN }, payload });
    // 字符集：小写字母/数字/-（api.md §5；长度 1–64）
    for (const slug of ['Alpha', 'under_score', 'a/b', 'spa ce', '中文', 'a'.repeat(65)]) {
      const res = await post({ name: 'X', slug });
      assert.equal(res.statusCode, 422, `slug=${slug.slice(0, 8)} 应 422`);
      assert.equal(errOf(res).code, 'E-RES-007');
    }
    // 合法边界：单字符与 64 字符
    for (const slug of ['a', 'a'.repeat(64), 'team-kb-01']) {
      const res = await post({ name: 'X', slug });
      assert.equal(res.statusCode, 201, `slug=${slug.slice(0, 8)} 应合法`);
    }
    // 缺必填/类型错 → 400
    for (const payload of [{ name: 'X' }, { slug: 'x' }, { name: 42, slug: 'x' }, { name: '', slug: 'x' }, {}]) {
      const res = await post(payload);
      assert.equal(res.statusCode, 400, `payload=${JSON.stringify(payload)} 应 400`);
      assert.equal(errOf(res).code, 'E-RES-004');
    }
  } finally {
    await h.close();
  }
});

test('建库认证门禁：未认证 401 E-AUTH-001；停用账号 401 E-AUTH-004（active 员工才可建）', async () => {
  const h = await harness();
  try {
    const alice = h.employee('alice');
    const anon = await h.app.inject({ method: 'POST', url: '/api/v1/vaults', payload: { name: 'X', slug: 'x' } });
    assert.equal(anon.statusCode, 401);
    assert.equal(errOf(anon).code, 'E-AUTH-001');
    const sid = h.session(alice);
    h.db.prepare('UPDATE employees SET active = 0 WHERE id = ?').run(alice);
    const disabled = await h.app.inject({
      method: 'POST', url: '/api/v1/vaults',
      headers: { ...sidCookie(sid), origin: SAME_ORIGIN },
      payload: { name: 'X', slug: 'x' },
    });
    assert.equal(disabled.statusCode, 401);
    assert.equal(errOf(disabled).code, 'E-AUTH-004');
  } finally {
    await h.close();
  }
});

// ── GET /api/v1/vaults 与 GET /api/v1/vaults/{slug}（成员可见性） ─────────────

test('列表：仅当前员工有成员关系的库进入列表（未授权库不出现，架构 §4.2）；新库默认私有', async () => {
  const h = await harness();
  try {
    const alice = h.employee('alice');
    const bob = h.employee('bob');
    const aliceSid = h.session(alice);
    await h.app.inject({ method: 'POST', url: '/api/v1/vaults', headers: { ...sidCookie(aliceSid), origin: SAME_ORIGIN }, payload: { name: 'Alpha', slug: 'alpha' } });
    // 新库默认私有：bob（非成员）列表不含 alpha
    const bobList = await h.app.inject({ method: 'GET', url: '/api/v1/vaults', headers: bearer(h.token(bob)) });
    assert.equal(bobList.statusCode, 200);
    assert.deepEqual((bobList.json() as { vaults: unknown[] }).vaults, [], '非成员列表为空');
    // alice 列表含 alpha 且形态正确
    const aliceList = await h.app.inject({ method: 'GET', url: '/api/v1/vaults', headers: { ...sidCookie(aliceSid) } });
    assert.equal(aliceList.statusCode, 200);
    const items = (aliceList.json() as { vaults: Array<Record<string, unknown>> }).vaults;
    assert.equal(items.length, 1);
    assert.deepEqual(Object.keys(items[0] as Record<string, unknown>).sort(), ['default_branch', 'main_admin_only', 'name', 'role', 'slug']);
    assert.equal((items[0] as Record<string, unknown>)['role'], 'admin');
  } finally {
    await h.close();
  }
});

test('列表：token scope 收窄可见集（identity §3.4 交集；清单外库不出现）', async () => {
  const h = await harness();
  try {
    const alice = h.employee('alice');
    const bob = h.employee('bob');
    const bobToken = h.token(bob);
    // alice 建 alpha，bob 建 beta；alice 被授予两库成员
    await h.app.inject({ method: 'POST', url: '/api/v1/vaults', headers: bearer(h.token(alice)), payload: { name: 'Alpha', slug: 'alpha' } });
    await h.app.inject({ method: 'POST', url: '/api/v1/vaults', headers: bearer(bobToken), payload: { name: 'Beta', slug: 'beta' } });
    const betaId = vaultRow(h.db, 'beta').id;
    const now = new Date().toISOString();
    // alice 已是 alpha 的创建者管理员；补授 beta（两库均可见的前置）
    h.db.prepare(`INSERT INTO vault_members (vault_id, employee_id, role, granted_by, granted_at) VALUES (?, ?, 'editor', ?, ?)`).run(betaId, alice, bob, now);
    // scope 仅 alpha：列表只剩 alpha
    const scoped = h.seed.createCredential(alice, {
      name: 'scoped', expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      scope: { access: 'read', vaults: ['alpha'] },
    }).token;
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/vaults', headers: bearer(scoped) });
    assert.equal(res.statusCode, 200);
    const slugs = (res.json() as { vaults: Array<{ slug: string }> }).vaults.map((v) => v.slug);
    assert.deepEqual(slugs, ['alpha'], 'scope 清单外库不进入列表（只能收窄）');
    // 全量权限对照：非收窄 token 两库都在
    const full = await h.app.inject({ method: 'GET', url: '/api/v1/vaults', headers: bearer(h.token(alice)) });
    assert.deepEqual(((full.json() as { vaults: Array<{ slug: string }> }).vaults.map((v) => v.slug)).sort(), ['alpha', 'beta']);
  } finally {
    await h.close();
  }
});

test('单库：成员 200；非成员与不存在同 404 E-RES-001（响应体一致，D-IC-06）', async () => {
  const h = await harness();
  try {
    const alice = h.employee('alice');
    const bob = h.employee('bob');
    await h.app.inject({ method: 'POST', url: '/api/v1/vaults', headers: bearer(h.token(alice)), payload: { name: 'Alpha', slug: 'alpha' } });
    const member = await h.app.inject({ method: 'GET', url: '/api/v1/vaults/alpha', headers: bearer(h.token(alice)) });
    assert.equal(member.statusCode, 200);
    assert.equal((member.json() as { role: string }).role, 'admin');
    const outsider = await h.app.inject({ method: 'GET', url: '/api/v1/vaults/alpha', headers: bearer(h.token(bob)) });
    const ghost = await h.app.inject({ method: 'GET', url: '/api/v1/vaults/no-such', headers: bearer(h.token(bob)) });
    assert.equal(outsider.statusCode, 404);
    assert.equal(ghost.statusCode, 404);
    assert.equal(errOf(outsider).code, 'E-RES-001');
    assert.deepEqual(outsider.json(), ghost.json(), '非成员与不存在响应体完全一致（不泄露存在性）');
  } finally {
    await h.close();
  }
});

// ── PATCH /api/v1/vaults/{slug}（库管理员） ──────────────────────────────────

test('PATCH：库管理员改名/slug/main_admin_only；slug 改名后内部 id 与仓库路径映射不变（架构 §7.2）', async () => {
  const h = await harness();
  try {
    const alice = h.employee('alice');
    const sid = h.session(alice);
    const created = await h.app.inject({ method: 'POST', url: '/api/v1/vaults', headers: bearer(h.token(alice)), payload: { name: 'Alpha', slug: 'alpha' } });
    const idBefore = (created.json() as { id: number }).id;
    const res = await h.app.inject({
      method: 'PATCH', url: '/api/v1/vaults/alpha',
      headers: { ...sidCookie(sid), origin: SAME_ORIGIN },
      payload: { name: 'Alpha 2', slug: 'alpha-renamed', main_admin_only: true },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as { id: number; slug: string; name: string; main_admin_only: boolean; role: string };
    assert.equal(body.id, idBefore, '改 slug 不改内部 id（稳定 ID）');
    assert.equal(body.slug, 'alpha-renamed');
    assert.equal(body.name, 'Alpha 2');
    assert.equal(body.main_admin_only, true);
    assert.equal(vaultRow(h.db, 'alpha-renamed').id, idBefore);
    // 旧 slug 不可达、新 slug 可达
    const old = await h.app.inject({ method: 'GET', url: '/api/v1/vaults/alpha', headers: bearer(h.token(alice)) });
    assert.equal(old.statusCode, 404);
    const fresh = await h.app.inject({ method: 'GET', url: '/api/v1/vaults/alpha-renamed', headers: bearer(h.token(alice)) });
    assert.equal(fresh.statusCode, 200);
    // main_admin_only 配置反映进默认分支写入规则模型（架构 §4.3 可配置维）
    const rules = branchWriteRules(vaultRow(h.db, 'alpha-renamed'));
    assert.equal(rules.mainAdminOnly, true);
    assert.equal(rules.defaultBranch, 'main');
    // 审计 vault.update
    const audit = h.db.prepare("SELECT entry, status FROM audit_events WHERE event_kind = 'vault.update'").all() as { entry: string; status: string }[];
    assert.deepEqual(audit.map((a) => ({ ...a })), [{ entry: 'web', status: 'succeeded' }]);
  } finally {
    await h.close();
  }
});

test('PATCH：新 slug 冲突 → 409；非法 slug → 422；空补丁 → 400', async () => {
  const h = await harness();
  try {
    const alice = h.employee('alice');
    const bob = h.employee('bob');
    await h.app.inject({ method: 'POST', url: '/api/v1/vaults', headers: bearer(h.token(alice)), payload: { name: 'A', slug: 'alpha' } });
    await h.app.inject({ method: 'POST', url: '/api/v1/vaults', headers: bearer(h.token(bob)), payload: { name: 'B', slug: 'beta' } });
    const patch = async (payload: Record<string, unknown>) =>
      h.app.inject({ method: 'PATCH', url: '/api/v1/vaults/alpha', headers: bearer(h.token(alice)), payload });
    const conflict = await patch({ slug: 'beta' });
    assert.equal(conflict.statusCode, 409);
    assert.equal(errOf(conflict).code, 'E-RES-002');
    const bad = await patch({ slug: 'Not_Legal' });
    assert.equal(bad.statusCode, 422);
    assert.equal(errOf(bad).code, 'E-RES-007');
    const empty = await patch({});
    assert.equal(empty.statusCode, 400);
    assert.equal(errOf(empty).code, 'E-RES-004');
  } finally {
    await h.close();
  }
});

test('PATCH 授权：编辑者成员 403 E-AUTHZ-001；非成员与不存在 404（成员但非管理员才 403）', async () => {
  const h = await harness();
  try {
    const alice = h.employee('alice');
    const bob = h.employee('bob');
    const carol = h.employee('carol');
    await h.app.inject({ method: 'POST', url: '/api/v1/vaults', headers: bearer(h.token(alice)), payload: { name: 'A', slug: 'alpha' } });
    const alphaId = vaultRow(h.db, 'alpha').id;
    h.db.prepare(`INSERT INTO vault_members (vault_id, employee_id, role, granted_by, granted_at) VALUES (?, ?, 'editor', ?, ?)`).run(alphaId, bob, alice, new Date().toISOString());
    const editor = await h.app.inject({ method: 'PATCH', url: '/api/v1/vaults/alpha', headers: bearer(h.token(bob)), payload: { name: 'Hijack' } });
    assert.equal(editor.statusCode, 403);
    assert.equal(errOf(editor).code, 'E-AUTHZ-001');
    const outsider = await h.app.inject({ method: 'PATCH', url: '/api/v1/vaults/alpha', headers: bearer(h.token(carol)), payload: { name: 'Hijack' } });
    assert.equal(outsider.statusCode, 404);
    assert.equal(errOf(outsider).code, 'E-RES-001');
    const ghost = await h.app.inject({ method: 'PATCH', url: '/api/v1/vaults/ghost', headers: bearer(h.token(alice)), payload: { name: 'X' } });
    assert.equal(ghost.statusCode, 404);
    assert.deepEqual(outsider.json(), ghost.json(), '非成员与不存在一致');
  } finally {
    await h.close();
  }
});

// ── 成员管理端点（库管理员；普通成员 403 E-AUTHZ-001） ──────────────────────

test('成员管理：管理员可查/授/改/撤；行与审计落地（storage-model §5 member.grant/revoke）', async () => {
  const h = await harness();
  try {
    const alice = h.employee('alice');
    const bob = h.employee('bob');
    const aliceSid = h.session(alice);
    await h.app.inject({ method: 'POST', url: '/api/v1/vaults', headers: bearer(h.token(alice)), payload: { name: 'Alpha', slug: 'alpha' } });
    const alphaId = vaultRow(h.db, 'alpha').id;
    // 授权 reader
    const grant = await h.app.inject({
      method: 'PUT', url: '/api/v1/vaults/alpha/members/bob',
      headers: { ...sidCookie(aliceSid), origin: SAME_ORIGIN },
      payload: { role: 'reader' },
    });
    assert.equal(grant.statusCode, 200, grant.body);
    assert.deepEqual(grant.json(), { username: 'bob', role: 'reader' });
    // upsert 改角色 editor（PK 防重复授权 → 落 UPDATE 而非第二行）
    const upsert = await h.app.inject({
      method: 'PUT', url: '/api/v1/vaults/alpha/members/bob',
      headers: { ...sidCookie(aliceSid), origin: SAME_ORIGIN },
      payload: { role: 'editor' },
    });
    assert.equal(upsert.statusCode, 200);
    const rows = h.db.prepare('SELECT role FROM vault_members WHERE vault_id = ? AND employee_id = ?').all(alphaId, bob) as { role: string }[];
    assert.deepEqual(rows.map((r) => ({ ...r })), [{ role: 'editor' }], '一员工一库至多一行（upsert）');
    // 列表形态
    const list = await h.app.inject({ method: 'GET', url: '/api/v1/vaults/alpha/members', headers: { ...sidCookie(aliceSid) } });
    assert.equal(list.statusCode, 200);
    const members = (list.json() as { members: Array<Record<string, unknown>> }).members;
    assert.equal(members.length, 2);
    const bobRow = members.find((m) => m['username'] === 'bob') as Record<string, unknown>;
    assert.deepEqual(Object.keys(bobRow).sort(), ['display_name', 'granted_at', 'role', 'username']);
    assert.equal(bobRow['role'], 'editor');
    // 撤权 → 204，成员行消失，bob 直接访问 404
    const revoke = await h.app.inject({
      method: 'DELETE', url: '/api/v1/vaults/alpha/members/bob',
      headers: { ...sidCookie(aliceSid), origin: SAME_ORIGIN },
    });
    assert.equal(revoke.statusCode, 204);
    const n = h.db.prepare('SELECT COUNT(*) AS n FROM vault_members WHERE vault_id = ? AND employee_id = ?').get(alphaId, bob) as { n: number };
    assert.equal(n.n, 0);
    const after = await h.app.inject({ method: 'GET', url: '/api/v1/vaults/alpha', headers: bearer(h.token(bob)) });
    assert.equal(after.statusCode, 404, '撤权下一请求生效（identity §5.2 行 4）');
    // 审计成对落地：grant×2 + revoke×1
    const kinds = h.db.prepare('SELECT event_kind FROM audit_events WHERE event_kind LIKE ? ORDER BY id').all('member.%') as { event_kind: string }[];
    assert.deepEqual(kinds.map((k) => k.event_kind), ['member.grant', 'member.grant', 'member.revoke']);
  } finally {
    await h.close();
  }
});

test('成员管理错误面：非法角色 422 E-RES-007；目标员工不存在 404；撤不存在成员 404', async () => {
  const h = await harness();
  try {
    const alice = h.employee('alice');
    const aliceToken = h.token(alice);
    await h.app.inject({ method: 'POST', url: '/api/v1/vaults', headers: bearer(aliceToken), payload: { name: 'A', slug: 'alpha' } });
    const badRole = await h.app.inject({ method: 'PUT', url: '/api/v1/vaults/alpha/members/alice', headers: bearer(aliceToken), payload: { role: 'owner' } });
    assert.equal(badRole.statusCode, 422);
    assert.equal(errOf(badRole).code, 'E-RES-007');
    const missing = await h.app.inject({ method: 'PUT', url: '/api/v1/vaults/alpha/members/ghost-user', headers: bearer(aliceToken), payload: { role: 'reader' } });
    assert.equal(missing.statusCode, 404);
    assert.equal(errOf(missing).code, 'E-RES-001');
    const revokeMissing = await h.app.inject({ method: 'DELETE', url: '/api/v1/vaults/alpha/members/ghost-user', headers: bearer(aliceToken) });
    assert.equal(revokeMissing.statusCode, 404);
  } finally {
    await h.close();
  }
});

test('成员管理授权：编辑者 403 E-AUTHZ-001（api.md §5「普通成员 403」）；非成员 404 与不存在库一致', async () => {
  const h = await harness();
  try {
    const alice = h.employee('alice');
    const bob = h.employee('bob');
    const carol = h.employee('carol');
    await h.app.inject({ method: 'POST', url: '/api/v1/vaults', headers: bearer(h.token(alice)), payload: { name: 'A', slug: 'alpha' } });
    const alphaId = vaultRow(h.db, 'alpha').id;
    h.db.prepare(`INSERT INTO vault_members (vault_id, employee_id, role, granted_by, granted_at) VALUES (?, ?, 'editor', ?, ?)`).run(alphaId, bob, alice, new Date().toISOString());
    h.db.prepare(`INSERT INTO vault_members (vault_id, employee_id, role, granted_by, granted_at) VALUES (?, ?, 'reader', ?, ?)`).run(alphaId, carol, alice, new Date().toISOString());
    const bobToken = h.token(bob);
    const carolToken = h.token(carol);
    for (const [label, token] of [['editor', bobToken], ['reader', carolToken]] as const) {
      const put = await h.app.inject({ method: 'PUT', url: '/api/v1/vaults/alpha/members/bob', headers: bearer(token), payload: { role: 'admin' } });
      assert.equal(put.statusCode, 403, `${label} PUT 应 403`);
      assert.equal(errOf(put).code, 'E-AUTHZ-001');
      const del = await h.app.inject({ method: 'DELETE', url: '/api/v1/vaults/alpha/members/carol', headers: bearer(token) });
      assert.equal(del.statusCode, 403, `${label} DELETE 应 403`);
      const list = await h.app.inject({ method: 'GET', url: '/api/v1/vaults/alpha/members', headers: bearer(token) });
      assert.equal(list.statusCode, 403, `${label} GET members 应 403`);
    }
    // 非成员对成员端点：404（与不存在库一致，D-IC-06）
    const outsider = h.employee('outsider');
    const put = await h.app.inject({ method: 'PUT', url: '/api/v1/vaults/alpha/members/bob', headers: bearer(h.token(outsider)), payload: { role: 'reader' } });
    const ghostPut = await h.app.inject({ method: 'PUT', url: '/api/v1/vaults/ghost/members/bob', headers: bearer(h.token(outsider)), payload: { role: 'reader' } });
    assert.equal(put.statusCode, 404);
    assert.equal(ghostPut.statusCode, 404);
    assert.deepEqual(put.json(), ghostPut.json());
  } finally {
    await h.close();
  }
});

test('会话载体写请求缺同源头 → 403 E-AUTH-006（CSRF 守卫覆盖库域写端点）', async () => {
  const h = await harness();
  try {
    const alice = h.employee('alice');
    const sid = h.session(alice);
    const res = await h.app.inject({
      method: 'POST', url: '/api/v1/vaults',
      headers: sidCookie(sid), // 无 Origin/Referer
      payload: { name: 'A', slug: 'alpha' },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(errOf(res).code, 'E-AUTH-006');
  } finally {
    await h.close();
  }
});
