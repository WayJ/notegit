import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../src/app.ts';
import { CredentialsService } from '../src/credentials/service.ts';
import { createSession, DEFAULT_SESSION_TIMEOUTS } from '../src/auth/sessions.ts';
import { authorize, type MembershipSource } from '../src/auth/lifecycle.ts';
import { createDbMembershipSource } from '../src/vaults/membership.ts';
import { newDb } from './credentials-fixtures.ts';

// 验收场景 S1 / DOD-02 核心（sprint S2 计划）：两员工 × 两不同成员集库的
// 可见性与读写矩阵。覆盖面：
// - Web 入口（ngt_sid 会话）与 API 入口（Bearer token）判定一致；
// - Git 入口 S3 落地——其授权将消费同一 authorize() × 真实表源（接口契约
//   见 vaults-membership.test.ts；本文件以组件级矩阵复核 Git 入口将得到的判定）；
// - 撤权后直接访问 404 与不存在一致（D-IC-06）；
// - 代码结构断言：authorize 组件被 Web/API 路由共同引用，路由不自行查权限表。

interface Harness {
  app: ReturnType<typeof buildApp>;
  db: DatabaseSync;
  source: MembershipSource;
  seed: CredentialsService;
  employee(username: string): number;
  session(employeeId: number): string;
  token(employeeId: number, scope?: { access: 'read' | 'read_write'; vaults: string[] }): string;
  close(): Promise<void>;
}

async function harness(): Promise<Harness> {
  const db = newDb();
  const pepper = { active: { version: 1, key: randomBytes(32) }, retired: [] as never[] };
  const seed = new CredentialsService({ db, pepper });
  const dir = await mkdtemp(path.join(tmpdir(), 'notegit-matrix-'));
  const bootstrapTokenFile = path.join(dir, 'admin-bootstrap.token');
  await writeFile(bootstrapTokenFile, 'fixture-unused');
  const app = buildApp({ db, pepper, bootstrapTokenFile });
  const now = new Date();
  return {
    app,
    db,
    source: createDbMembershipSource(db),
    seed,
    employee(username) {
      db.prepare(
        `INSERT INTO employees (username, display_name, password_hash, is_instance_admin, active, invited_by, created_at)
         VALUES (?, ?, 'fixture-not-argon2', 0, 1, NULL, ?)`,
      ).run(username, username, now.toISOString());
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

interface MatrixWorld {
  h: Harness;
  alice: number;
  bob: number;
  aliceSid: string;
  bobSid: string;
  aliceToken: string;
  bobToken: string;
}

/** 矩阵世界：alpha={alice:admin, bob:reader}，beta={bob:admin}——两不同成员集库 */
async function world(): Promise<MatrixWorld> {
  const h = await harness();
  const alice = h.employee('alice');
  const bob = h.employee('bob');
  const aliceToken = h.token(alice);
  const bobToken = h.token(bob);
  await h.app.inject({ method: 'POST', url: '/api/v1/vaults', headers: bearer(aliceToken), payload: { name: 'Alpha', slug: 'alpha' } });
  await h.app.inject({ method: 'POST', url: '/api/v1/vaults', headers: bearer(bobToken), payload: { name: 'Beta', slug: 'beta' } });
  // alice 授 bob 在 alpha 的 reader（经端点走完整授权路径）
  await h.app.inject({
    method: 'PUT', url: '/api/v1/vaults/alpha/members/bob',
    headers: bearer(aliceToken), payload: { role: 'reader' },
  });
  return {
    h,
    alice,
    bob,
    aliceSid: h.session(alice),
    bobSid: h.session(bob),
    aliceToken,
    bobToken,
  };
}

// ── 可见性矩阵（列表与单库；Web/API 双入口一致） ──────────────────────────────

test('S1 可见性矩阵：列表只含有成员关系的库；两库成员集互不相同', async () => {
  const w = await world();
  try {
    const aliceList = (await (await w.h.app.inject({ method: 'GET', url: '/api/v1/vaults', headers: sidCookie(w.aliceSid) })).json() as { vaults: Array<{ slug: string; role: string }> }).vaults;
    const bobList = (await (await w.h.app.inject({ method: 'GET', url: '/api/v1/vaults', headers: sidCookie(w.bobSid) })).json() as { vaults: Array<{ slug: string; role: string }> }).vaults;
    assert.deepEqual(aliceList, [{ slug: 'alpha', name: 'Alpha', role: 'admin', default_branch: 'main', main_admin_only: false }]);
    assert.deepEqual(bobList.map((v) => [v.slug, v.role]), [['alpha', 'reader'], ['beta', 'admin']]);

    // API 入口（Bearer）与 Web 入口（会话）判定一致
    const aliceApi = (await (await w.h.app.inject({ method: 'GET', url: '/api/v1/vaults', headers: bearer(w.aliceToken) })).json() as { vaults: Array<{ slug: string }> }).vaults;
    assert.deepEqual(aliceApi.map((v) => v.slug), ['alpha'], 'Web 与 API 列表一致');
  } finally {
    await w.h.close();
  }
});

test('S1 单库矩阵：成员 200（按角色标注）；无权库与不存在库同 404（D-IC-06）', async () => {
  const w = await world();
  try {
    const cells: Array<[string, string, number]> = [
      // [slug, 载体（token id）, 期望状态]
      ['alpha', w.aliceToken, 200],
      ['alpha', w.bobToken, 200],   // bob 是 alpha 的 reader 成员
      ['beta', w.bobToken, 200],
    ];
    for (const [slug, token, expected] of cells) {
      const res = await w.h.app.inject({ method: 'GET', url: `/api/v1/vaults/${slug}`, headers: bearer(token) });
      assert.equal(res.statusCode, expected, `${slug}`);
    }
    const roleOf = JSON.parse((await w.h.app.inject({ method: 'GET', url: '/api/v1/vaults/alpha', headers: bearer(w.bobToken) })).body) as { role: string };
    assert.equal(roleOf.role, 'reader');

    // alice 对 beta（非成员）与 ghost（不存在）响应完全一致
    const noMember = await w.h.app.inject({ method: 'GET', url: '/api/v1/vaults/beta', headers: bearer(w.aliceToken) });
    const ghost = await w.h.app.inject({ method: 'GET', url: '/api/v1/vaults/ghost', headers: bearer(w.aliceToken) });
    assert.equal(noMember.statusCode, 404);
    assert.equal(ghost.statusCode, 404);
    assert.deepEqual(noMember.body, ghost.body, '无权与不存在响应体一致');
    // 会话载体同样一致（Web 入口）
    const viaSid = await w.h.app.inject({ method: 'GET', url: '/api/v1/vaults/beta', headers: sidCookie(w.aliceSid) });
    assert.equal(viaSid.statusCode, 404);
  } finally {
    await w.h.close();
  }
});

// ── 读写矩阵（authorize 组件级 = Git 入口 S3 将得到的判定；API 入口行为级） ──

test('S1 读写矩阵（组件级，Git 入口同款判定）：只读成员不能写入（DOD-02）', async () => {
  const w = await world();
  try {
    const cases: Array<[number, string, 'read' | 'write', boolean, string?]> = [
      [w.alice, 'alpha', 'read', true],
      [w.alice, 'alpha', 'write', true],   // admin
      [w.bob, 'alpha', 'read', true],
      [w.bob, 'alpha', 'write', false, 'forbidden'],  // reader：只读成员不能写入
      [w.alice, 'beta', 'read', false, 'not_found'],  // 非成员：与不存在一致
      [w.alice, 'beta', 'write', false, 'not_found'],
      [w.bob, 'beta', 'write', true],      // admin
    ];
    for (const [empId, slug, action, allowed, reason] of cases) {
      const d = authorize(w.h.source, empId, slug, action);
      assert.equal(d.allowed, allowed, `${empId}×${slug}×${action}`);
      if (!allowed) assert.equal((d as { reason: string }).reason, reason);
    }
  } finally {
    await w.h.close();
  }
});

test('S1 读写矩阵（API 入口行为级）：reader 写类管理操作 403；read-scoped token 收窄 admin 写', async () => {
  const w = await world();
  try {
    // bob（alpha 的 reader）调成员管理写 → 403 E-AUTHZ-001（普通成员 403）
    const manage = await w.h.app.inject({
      method: 'PUT', url: '/api/v1/vaults/alpha/members/bob',
      headers: bearer(w.bobToken), payload: { role: 'admin' },
    });
    assert.equal(manage.statusCode, 403);
    assert.equal(((manage.json() as { error: { code: string } }).error).code, 'E-AUTHZ-001');

    // alice 的 read-scoped token（仅 alpha）：admin 也被 scope 收窄为不可写（identity §3.4）
    const readOnly = w.h.seed.createCredential(w.alice, {
      name: 'ro', expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      scope: { access: 'read', vaults: ['alpha'] },
    }).token;
    const readOk = await w.h.app.inject({ method: 'GET', url: '/api/v1/vaults/alpha', headers: bearer(readOnly) });
    assert.equal(readOk.statusCode, 200, '读不受收窄影响');
    const writeBlocked = await w.h.app.inject({
      method: 'PATCH', url: '/api/v1/vaults/alpha',
      headers: bearer(readOnly), payload: { name: 'Hijack' },
    });
    assert.equal(writeBlocked.statusCode, 403, 'read-scoped token 管理写被拒（scope 只能收窄）');
  } finally {
    await w.h.close();
  }
});

// ── 撤权：下一请求生效，404 与不存在一致（identity §5.2 行 4） ───────────────

test('S1 撤权矩阵：bob 被 alpha 撤权后——列表消失、直接访问 404 与不存在一致、读写一律 not_found', async () => {
  const w = await world();
  try {
    // 前置：撤权前 bob 可读 alpha
    const before = await w.h.app.inject({ method: 'GET', url: '/api/v1/vaults/alpha', headers: bearer(w.bobToken) });
    assert.equal(before.statusCode, 200);
    // alice（alpha admin）撤 bob
    const revoke = await w.h.app.inject({
      method: 'DELETE', url: '/api/v1/vaults/alpha/members/bob',
      headers: { ...sidCookie(w.aliceSid), origin: SAME_ORIGIN },
    });
    assert.equal(revoke.statusCode, 204);

    // 列表：alpha 从 bob 的可见集消失，beta 不受影响
    const bobList = (await (await w.h.app.inject({ method: 'GET', url: '/api/v1/vaults', headers: bearer(w.bobToken) })).json() as { vaults: Array<{ slug: string }> }).vaults;
    assert.deepEqual(bobList.map((v) => v.slug), ['beta']);

    // 直接访问（Web 会话与 API token 双入口）：404 与不存在完全一致
    for (const headers of [bearer(w.bobToken), sidCookie(w.bobSid)]) {
      const revoked = await w.h.app.inject({ method: 'GET', url: '/api/v1/vaults/alpha', headers });
      const ghost = await w.h.app.inject({ method: 'GET', url: '/api/v1/vaults/ghost', headers });
      assert.equal(revoked.statusCode, 404);
      assert.deepEqual(revoked.body, ghost.body, '撤权与不存在响应一致（D-IC-06）');
    }

    // 组件级（Git 入口同款判定）：clone/fetch/push 一律 not_found
    for (const action of ['read', 'write'] as const) {
      assert.deepEqual(
        authorize(w.h.source, w.bob, 'alpha', action),
        { allowed: false, reason: 'not_found' },
        `撤权后 ${action} 应与不存在一致`,
      );
    }
  } finally {
    await w.h.close();
  }
});

// ── 代码结构断言：authorize 组件被 Web/API 入口共同引用（Git 入口 S3 消费同一源） ──

const SRC = (rel: string) => readFileSync(path.resolve(import.meta.dirname, '../src', rel), 'utf8');

test('结构断言：库域路由引用共用 authorize（auth/lifecycle.ts），不自行查权限表', async () => {
  const routes = SRC('vaults/routes.ts');
  // Web/API 入口的授权判定一律经共用组件（architecture-notes §7.5）
  assert.match(routes, /import\s*\{[^}]*authorize[^}]*\}\s*from\s*'\.\.\/auth\/lifecycle\.ts'/, '路由必须从共用模块导入 authorize');
  // 路由层不得出现直查 vault_members/vaults 权限的 SQL（判定只经 MembershipSource）
  assert.doesNotMatch(routes, /vault_members/, '路由不得直查 vault_members（判定经共用 authorize×MembershipSource）');
  assert.doesNotMatch(routes, /SELECT.*FROM\s+vaults\b/, '路由不得直查 vaults（数据访问经 VaultService）');
});

test('结构断言：MembershipSource 由 vaults 真实表实现，并被 app 接线（Web/API/Git 三入口共用一源）', async () => {
  const membership = SRC('vaults/membership.ts');
  assert.match(membership, /import type \{ MembershipSource[^}]*\} from '\.\.\/auth\/lifecycle\.ts'/, '实现必须消费 T5 定义的缝接口');
  assert.match(membership, /SELECT role FROM vault_members WHERE vault_id = \? AND employee_id = \?/, 'authz.role 规范查询是唯一判定 SQL');
  const app = SRC('app.ts');
  assert.match(app, /createDbMembershipSource/, 'app 接线真实表源（Web/API 路由经此共用）');
  // Git 入口（S3）执行点复查钩子仍在共用模块导出（identity §5.1 第 3 层）
  const lifecycle = SRC('auth/lifecycle.ts');
  assert.match(lifecycle, /export function reauthorizeAtExecutionPoint/, 'S3 Git 入口的执行点复查钩子须保持导出');
});
