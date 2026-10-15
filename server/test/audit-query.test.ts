import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../src/app.ts';
import { createSession, DEFAULT_SESSION_TIMEOUTS } from '../src/auth/sessions.ts';
import { recordAuditEvent, settleAuditEvent } from '../src/audit/audit.ts';
import { newDb, addEmployee, addVault, addMember } from './credentials-fixtures.ts';

/**
 * S19-T1 审计查询两端点（api.md §9 契约在册，严格按文本锁定）：
 *
 * - GET /api/v1/vaults/{slug}/audit：库管理员或实例管理员；403 E-AUTHZ-001
 *   （成员但非管理员）/ 404 E-RES-001（非成员，与不存在同体 D-IC-06）/ 401 匿名。
 * - GET /api/v1/admin/audit：实例管理员（403 E-AUTHZ-001）；含实例级事件。
 * - 响应 {events:[{occurred_at,actor_kind,actor,credential_ref,entry,event_kind,
 *   ref_name,old_commit,new_commit,status,detail}],next_cursor}；排序
 *   occurred_at DESC, id DESC；limit 缺省 50、上限 200（超出 422 E-RES-007）；
 *   cursor 不透明游标（往返锁定）；过滤 actor/event_kind/status/since/until。
 *
 * 审计行经生产写面落库（recordAuditEvent + settleAuditEvent——与既有审计夹具
 * 同一形状；credential_ref 用 credential:<id> / session:<id> 两形态）。
 */

interface Harness {
  app: ReturnType<typeof buildApp>;
  db: DatabaseSync;
  session(employeeId: number): string;
  close(): Promise<void>;
}

async function harness(): Promise<Harness> {
  const db = newDb();
  const pepper = { active: { version: 1, key: randomBytes(32) }, retired: [] as never[] };
  const app = buildApp({ db, pepper, bootstrapTokenFile: '/tmp/notegit-audit-query.token' });
  await app.ready();
  const now = new Date();
  return {
    app,
    db,
    session(employeeId) {
      return createSession(db, employeeId, pepper.active.key, now, DEFAULT_SESSION_TIMEOUTS).sid;
    },
    close: async () => {
      await app.close();
      db.close();
    },
  };
}

function sidCookie(sid: string): Record<string, string> {
  return { cookie: `ngt_sid=${sid}` };
}

/** 40 位 hex OID（前缀区分） */
function oid(prefix: string): string {
  return prefix.padEnd(40, '0');
}

interface SeedInput {
  employeeId?: number;
  carrierRef?: string;
  entry?: 'web' | 'api' | 'git';
  actorKind?: 'employee' | 'bootstrap' | 'system';
  vaultId?: number | null;
  kind: string;
  occurredAt: string;
  status?: 'pending' | 'succeeded' | 'rejected' | 'unresolved';
  refName?: string | null;
  oldCommit?: string | null;
  newCommit?: string | null;
  detail?: Record<string, unknown>;
  /** true = 直接终态插入（管理类形态）；false = pending 预记录 → settle（发布类形态） */
  directTerminal?: boolean;
}

/** 按生产写面形状落一笔审计行（返回行 id 供行级断言） */
function seedEvent(db: DatabaseSync, input: SeedInput): number {
  const status = input.status ?? 'succeeded';
  const insertPending = input.directTerminal === true || status === 'pending' || status === 'rejected' || status === 'unresolved';
  recordAuditEvent(db, {
    occurredAt: input.occurredAt,
    actorKind: input.actorKind ?? 'employee',
    ...(input.actorKind === undefined || input.actorKind === 'employee'
      ? {
          subject: {
            employeeId: input.employeeId!,
            carrierRef: input.carrierRef ?? `session:${input.employeeId}`,
            entry: input.entry ?? 'api',
          },
        }
      : { entry: input.entry ?? ('api' as const) }),
    eventKind: input.kind,
    vaultId: input.vaultId ?? null,
    refName: input.refName ?? null,
    oldCommit: input.oldCommit ?? null,
    newCommit: input.newCommit ?? null,
    status,
    detail: input.detail ?? {},
  });
  const id = Number((db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id);
  if (!insertPending) settleAuditEvent(db, id, 'succeeded');
  return id;
}

/** 标准布景：root=实例管理员；alice=handbook 库管理员；bob=handbook reader；
 *  carol=无成员关系；handbook 3 行（credential/git、session/web、pending/api）、
 *  notes 1 行 rejected（越权隔离断言素材）、实例级 1 行、bootstrap 1 行。 */
interface Stage {
  root: number;
  alice: number;
  bob: number;
  carol: number;
  handbook: number;
  notes: number;
}

async function stagedHarness(h: Harness): Promise<Stage> {
  const root = addEmployee(h.db, { username: 'root', display_name: '管理员', is_instance_admin: 1 });
  const alice = addEmployee(h.db, { username: 'alice', display_name: '爱丽丝' });
  const bob = addEmployee(h.db, { username: 'bob' });
  const carol = addEmployee(h.db, { username: 'carol' });
  const handbook = addVault(h.db, 'team-handbook', root);
  const notes = addVault(h.db, 'product-notes', root);
  addMember(h.db, handbook, alice, 'admin', root);
  addMember(h.db, handbook, bob, 'reader', root);
  seedEvent(h.db, {
    employeeId: alice,
    carrierRef: 'credential:9',
    entry: 'git',
    vaultId: handbook,
    kind: 'vault.push',
    occurredAt: '2026-10-14T10:05:00.000Z',
    refName: 'refs/heads/main',
    oldCommit: oid('9f90001'),
    newCommit: oid('cc30003'),
    detail: { pushId: 'seed-push-1' },
  });
  seedEvent(h.db, {
    employeeId: alice,
    carrierRef: 'session:7',
    entry: 'web',
    vaultId: handbook,
    kind: 'vault.web_submit',
    occurredAt: '2026-10-14T10:00:00.000Z',
    newCommit: oid('aa10001'),
    detail: { pushId: 'seed-web-1' },
  });
  seedEvent(h.db, {
    employeeId: alice,
    carrierRef: 'session:8',
    entry: 'api',
    vaultId: handbook,
    kind: 'vault.push',
    occurredAt: '2026-10-14T10:10:00.000Z',
    status: 'pending',
    newCommit: oid('dd40004'),
    detail: { pushId: 'seed-pending-1' },
  });
  seedEvent(h.db, {
    employeeId: alice,
    carrierRef: 'session:6',
    entry: 'web',
    vaultId: notes,
    kind: 'vault.web_submit',
    occurredAt: '2026-10-13T09:00:00.000Z',
    status: 'rejected',
    detail: { reason: 'validation' },
    directTerminal: true,
  });
  seedEvent(h.db, {
    employeeId: alice,
    carrierRef: 'credential:2',
    entry: 'api',
    kind: 'credential.created',
    occurredAt: '2026-10-14T11:00:00.000Z',
    detail: { credentialId: 2 },
  });
  seedEvent(h.db, {
    actorKind: 'bootstrap',
    kind: 'bootstrap.initialize',
    occurredAt: '2026-10-12T08:00:00.000Z',
  });
  return { root, alice, bob, carol, handbook, notes };
}

/** §9 契约行字段全集（逐字段断言不增不减） */
const ROW_FIELDS = [
  'occurred_at',
  'actor_kind',
  'actor',
  'credential_ref',
  'entry',
  'event_kind',
  'ref_name',
  'old_commit',
  'new_commit',
  'status',
  'detail',
].sort();

// ── 门槛：vault 端点（401/403/404） ──────────────────────────────────────────

test('vault audit 匿名 → 401 E-AUTH-001 信封', async () => {
  const h = await harness();
  try {
    await stagedHarness(h);
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/vaults/team-handbook/audit' });
    assert.equal(res.statusCode, 401);
    const body = res.json() as { error: { code: string; message: string } };
    assert.equal(body.error.code, 'E-AUTH-001');
  } finally {
    await h.close();
  }
});

test('vault audit 成员但非管理员（bob reader）→ 403 E-AUTHZ-001，错误体零行泄露', async () => {
  const h = await harness();
  try {
    const stage = await stagedHarness(h);
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/vaults/team-handbook/audit',
      headers: sidCookie(h.session(stage.bob)),
    });
    assert.equal(res.statusCode, 403);
    const body = res.json() as { error: { code: string; message: string }; events?: unknown };
    assert.equal(body.error.code, 'E-AUTHZ-001');
    assert.equal(body.events, undefined, '403 错误体不携带 events（零行泄露）');
  } finally {
    await h.close();
  }
});

test('vault audit 非成员与不存在库 404 同体（D-IC-06 不泄露存在性）', async () => {
  const h = await harness();
  try {
    const stage = await stagedHarness(h);
    const member = await h.app.inject({
      method: 'GET',
      url: '/api/v1/vaults/product-notes/audit', // 真实存在、bob/carol 非成员
      headers: sidCookie(h.session(stage.carol)),
    });
    const ghost = await h.app.inject({
      method: 'GET',
      url: '/api/v1/vaults/no-such-vault/audit',
      headers: sidCookie(h.session(stage.carol)),
    });
    assert.equal(member.statusCode, 404);
    assert.equal(ghost.statusCode, 404);
    assert.equal((member.json() as { error: { code: string } }).error.code, 'E-RES-001');
    assert.equal(member.body, ghost.body, '非成员与不存在逐字节同体');
  } finally {
    await h.close();
  }
});

test('vault audit 库管理员（alice）→ 200；实例管理员 root 非成员也 200', async () => {
  const h = await harness();
  try {
    const stage = await stagedHarness(h);
    const admin = await h.app.inject({
      method: 'GET',
      url: '/api/v1/vaults/team-handbook/audit',
      headers: sidCookie(h.session(stage.alice)),
    });
    assert.equal(admin.statusCode, 200);
    const instanceAdmin = await h.app.inject({
      method: 'GET',
      url: '/api/v1/vaults/team-handbook/audit',
      headers: sidCookie(h.session(stage.root)),
    });
    assert.equal(instanceAdmin.statusCode, 200);
  } finally {
    await h.close();
  }
});

// ── 门槛：admin 端点 ─────────────────────────────────────────────────────────

test('admin audit 匿名 401；非实例管理员（alice 库管理员也不行）403 E-AUTHZ-001', async () => {
  const h = await harness();
  try {
    const stage = await stagedHarness(h);
    const anon = await h.app.inject({ method: 'GET', url: '/api/v1/admin/audit' });
    assert.equal(anon.statusCode, 401);
    assert.equal((anon.json() as { error: { code: string } }).error.code, 'E-AUTH-001');
    const aliceRes = await h.app.inject({ method: 'GET', url: '/api/v1/admin/audit', headers: sidCookie(h.session(stage.alice)) });
    assert.equal(aliceRes.statusCode, 403);
    assert.equal((aliceRes.json() as { error: { code: string } }).error.code, 'E-AUTHZ-001');
  } finally {
    await h.close();
  }
});

test('admin audit 实例管理员 200：含实例级事件与 bootstrap 行（actor_kind/actor 形态）', async () => {
  const h = await harness();
  try {
    const stage = await stagedHarness(h);
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/admin/audit', headers: sidCookie(h.session(stage.root)) });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { events: Record<string, unknown>[]; next_cursor: string | null };
    const kinds = body.events.map((e) => e.event_kind);
    assert.ok(kinds.includes('credential.created'), '实例级事件（凭据域）在册');
    assert.ok(kinds.includes('bootstrap.initialize'), 'bootstrap 事件在册');
    const boot = body.events.find((e) => e.event_kind === 'bootstrap.initialize');
    assert.equal(boot?.actor_kind, 'bootstrap');
    assert.equal(boot?.actor, null, '非员工主体 actor 如实 null');
    assert.equal(boot?.credential_ref, null);
    const cred = body.events.find((e) => e.event_kind === 'credential.created');
    assert.equal(cred?.credential_ref, 'credential:2', 'credential_ref 原样');
  } finally {
    await h.close();
  }
});

// ── 数据面：形状 / 排序 / 隔离 / detail 降级 ────────────────────────────────

test('vault audit 响应形状：§9 全字段逐项 + credential_ref 两形态原样 + detail 解析对象', async () => {
  const h = await harness();
  try {
    const stage = await stagedHarness(h);
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/vaults/team-handbook/audit',
      headers: sidCookie(h.session(stage.alice)),
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { events: Record<string, unknown>[]; next_cursor: string | null };
    assert.deepEqual(Object.keys(body).sort(), ['events', 'next_cursor'], '顶层形状 {events,next_cursor}');
    assert.equal(body.events.length, 3, '该库 3 行（credential/session/pending）');
    for (const ev of body.events) {
      assert.deepEqual(Object.keys(ev).sort(), ROW_FIELDS, '行字段不增不减（§9 契约形状）');
    }
    const byKind = body.events.find((e) => (e.detail as { pushId?: string }).pushId === 'seed-push-1')!;
    assert.ok(byKind !== undefined, 'push 行在册');
    assert.equal(byKind.credential_ref, 'credential:9', '凭据载体 credential:<id> 原样');
    assert.equal(byKind.entry, 'git');
    assert.equal(byKind.ref_name, 'refs/heads/main');
    assert.equal(byKind.new_commit, oid('cc30003'));
    assert.equal(byKind.old_commit, oid('9f90001'));
    assert.equal(byKind.status, 'succeeded');
    assert.equal((byKind.detail as { pushId?: string }).pushId, 'seed-push-1', 'detail 解析对象形态');
    const web = body.events.find((e) => (e.detail as { pushId?: string }).pushId === 'seed-web-1')!;
    assert.equal(web.credential_ref, 'session:7', '会话载体 session:<id> 原样');
    assert.equal(web.actor, '爱丽丝', 'actor=员工展示名');
    assert.equal(web.actor_kind, 'employee');
    assert.equal(web.occurred_at, '2026-10-14T10:00:00.000Z');
    assert.ok(!res.body.includes('ngt_'), '响应零 token 材料');
  } finally {
    await h.close();
  }
});

test('排序 occurred_at DESC,id DESC（同时刻按插入序倒排）', async () => {
  const h = await harness();
  try {
    const stage = await stagedHarness(h);
    const tieAt = '2026-10-14T12:00:00.000Z';
    const first = seedEvent(h.db, {
      employeeId: alice0(stage),
      vaultId: stage.handbook,
      kind: 'vault.push',
      occurredAt: tieAt,
      newCommit: oid('ee10001'),
    });
    const second = seedEvent(h.db, {
      employeeId: alice0(stage),
      vaultId: stage.handbook,
      kind: 'vault.push',
      occurredAt: tieAt,
      newCommit: oid('ee20002'),
    });
    assert.ok(second > first, '布景插入序成立');
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/vaults/team-handbook/audit',
      headers: sidCookie(h.session(stage.alice)),
    });
    const body = res.json() as { events: { detail: { pushId?: string }; occurred_at: string }[] };
    const occurredList = body.events.map((e) => e.occurred_at);
    const sorted = [...occurredList].sort().reverse();
    assert.deepEqual(occurredList, sorted, 'occurred_at 全列 DESC');
    const tieIds = body.events
      .map((e, i) => ({ i, at: e.occurred_at }))
      .filter((x) => x.at === tieAt)
      .map((x) => x.i);
    assert.equal(tieIds.length, 2);
    assert.ok(tieIds[0]! < tieIds[1]!, '同时刻后插入在前（id DESC 决胜）');
  } finally {
    await h.close();
  }
});

function alice0(stage: Stage): number {
  return stage.alice;
}

test('vault 端点只回该库行：notes 的 rejected 行与实例级行不混入', async () => {
  const h = await harness();
  try {
    const stage = await stagedHarness(h);
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/vaults/team-handbook/audit',
      headers: sidCookie(h.session(stage.alice)),
    });
    const body = res.json() as { events: { event_kind: string; detail: unknown }[] };
    assert.ok(!body.events.some((e) => (e.detail as { reason?: string })?.reason === 'validation'), '他库行不混入');
    assert.ok(!body.events.some((e) => e.event_kind === 'credential.created'), '实例级行不混入');
    assert.ok(!body.events.some((e) => e.event_kind === 'bootstrap.initialize'), 'bootstrap 行不混入');
  } finally {
    await h.close();
  }
});

test('detail 畸形 JSON 如实降级不崩（原文串呈现，200 不 5xx）', async () => {
  const h = await harness();
  try {
    const stage = await stagedHarness(h);
    const id = seedEvent(h.db, {
      employeeId: stage.alice,
      vaultId: stage.handbook,
      kind: 'vault.push',
      occurredAt: '2026-10-14T13:00:00.000Z',
      newCommit: oid('ff10001'),
    });
    h.db.prepare('UPDATE audit_events SET detail = ? WHERE id = ?').run('not-json{', id);
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/vaults/team-handbook/audit',
      headers: sidCookie(h.session(stage.alice)),
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { events: { detail: unknown }[] };
    const broken = body.events.find((e) => e.detail === 'not-json{');
    assert.ok(broken !== undefined, '畸形 detail 以原文串如实降级');
  } finally {
    await h.close();
  }
});

// ── 过滤组合 ────────────────────────────────────────────────────────────────

test('过滤 actor：用户名与展示名两形态命中同一集', async () => {
  const h = await harness();
  try {
    const stage = await stagedHarness(h);
    const byName = await h.app.inject({
      method: 'GET',
      url: '/api/v1/vaults/team-handbook/audit?actor=alice',
      headers: sidCookie(h.session(stage.alice)),
    });
    const byDisplay = await h.app.inject({
      method: 'GET',
      url: '/api/v1/vaults/team-handbook/audit?actor=%E7%88%B1%E4%B8%BD%E4%B8%9D',
      headers: sidCookie(h.session(stage.alice)),
    });
    const byOther = await h.app.inject({
      method: 'GET',
      url: '/api/v1/vaults/team-handbook/audit?actor=bob',
      headers: sidCookie(h.session(stage.alice)),
    });
    const a = (byName.json() as { events: unknown[] }).events;
    assert.equal(a.length, 3, 'username 命中全部 alice 行');
    assert.equal((byDisplay.json() as { events: unknown[] }).events.length, 3, '展示名同集');
    assert.equal((byOther.json() as { events: unknown[] }).events.length, 0, '他人名零行');
  } finally {
    await h.close();
  }
});

test('过滤 event_kind 与 status（可选单用）', async () => {
  const h = await harness();
  try {
    const stage = await stagedHarness(h);
    const url = '/api/v1/vaults/team-handbook/audit';
    const pushes = await h.app.inject({ method: 'GET', url: `${url}?event_kind=vault.push`, headers: sidCookie(h.session(stage.alice)) });
    assert.equal((pushes.json() as { events: unknown[] }).events.length, 2, '两笔 push（含 pending）');
    const pending = await h.app.inject({ method: 'GET', url: `${url}?status=pending`, headers: sidCookie(h.session(stage.alice)) });
    const pendBody = pending.json() as { events: { status: string; detail: { pushId?: string } }[] };
    assert.equal(pendBody.events.length, 1);
    assert.equal(pendBody.events[0]?.detail.pushId, 'seed-pending-1');
    const rejected = await h.app.inject({ method: 'GET', url: `${url}?status=rejected`, headers: sidCookie(h.session(stage.alice)) });
    assert.equal((rejected.json() as { events: unknown[] }).events.length, 0, '本库无 rejected（notes 行不越库）');
    const succeeded = await h.app.inject({ method: 'GET', url: `${url}?status=succeeded`, headers: sidCookie(h.session(stage.alice)) });
    assert.equal((succeeded.json() as { events: unknown[] }).events.length, 2);
  } finally {
    await h.close();
  }
});

test('过滤 since/until：端点值含入（>=since 且 <=until）', async () => {
  const h = await harness();
  try {
    const stage = await stagedHarness(h);
    const url = '/api/v1/vaults/team-handbook/audit';
    const since = await h.app.inject({
      method: 'GET',
      url: `${url}?since=2026-10-14T10:05:00.000Z`,
      headers: sidCookie(h.session(stage.alice)),
    });
    const sinceBody = since.json() as { events: { occurred_at: string }[] };
    assert.deepEqual(sinceBody.events.map((e) => e.occurred_at), ['2026-10-14T10:10:00.000Z', '2026-10-14T10:05:00.000Z']);
    const until = await h.app.inject({
      method: 'GET',
      url: `${url}?until=2026-10-14T10:00:00.000Z`,
      headers: sidCookie(h.session(stage.alice)),
    });
    assert.deepEqual((until.json() as { events: { occurred_at: string }[] }).events.map((e) => e.occurred_at), [
      '2026-10-14T10:00:00.000Z',
    ]);
    const window = await h.app.inject({
      method: 'GET',
      url: `${url}?since=2026-10-14T10:00:00.000Z&until=2026-10-14T10:05:00.000Z`,
      headers: sidCookie(h.session(stage.alice)),
    });
    assert.deepEqual((window.json() as { events: { occurred_at: string }[] }).events.map((e) => e.occurred_at), [
      '2026-10-14T10:05:00.000Z',
      '2026-10-14T10:00:00.000Z',
    ]);
  } finally {
    await h.close();
  }
});

test('组合过滤 actor+event_kind+status', async () => {
  const h = await harness();
  try {
    const stage = await stagedHarness(h);
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/vaults/team-handbook/audit?actor=alice&event_kind=vault.push&status=succeeded',
      headers: sidCookie(h.session(stage.alice)),
    });
    const body = res.json() as { events: { status: string; event_kind: string; detail: { pushId?: string } }[] };
    assert.equal(body.events.length, 1);
    assert.equal(body.events[0]?.detail.pushId, 'seed-push-1');
  } finally {
    await h.close();
  }
});

// ── limit 与游标分页 ────────────────────────────────────────────────────────

async function seededManyHarness(): Promise<{ h: Harness; stage: Stage }> {
  const h = await harness();
  const stage = await stagedHarness(h);
  for (let i = 0; i < 55; i++) {
    seedEvent(h.db, {
      employeeId: stage.alice,
      vaultId: stage.handbook,
      kind: 'vault.push',
      occurredAt: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(),
      newCommit: oid((1000 + i).toString(16).padStart(7, '0')),
    });
  }
  return { h, stage };
}

test('limit 缺省 50（55 行种量 → 50 + next_cursor）；limit=200 接受全量', async () => {
  const { h, stage } = await seededManyHarness();
  try {
    const def = await h.app.inject({
      method: 'GET',
      url: '/api/v1/vaults/team-handbook/audit',
      headers: sidCookie(h.session(stage.alice)),
    });
    const defBody = def.json() as { events: unknown[]; next_cursor: string | null };
    assert.equal(defBody.events.length, 50, '缺省 50');
    assert.ok(typeof defBody.next_cursor === 'string' && defBody.next_cursor.length > 0, '还有下一页');
    const capped = await h.app.inject({
      method: 'GET',
      url: '/api/v1/vaults/team-handbook/audit?limit=200',
      headers: sidCookie(h.session(stage.alice)),
    });
    const cappedBody = capped.json() as { events: unknown[]; next_cursor: string | null };
    assert.equal(capped.statusCode, 200);
    assert.equal(cappedBody.events.length, 58, '55 种量 + 3 布景行全量返回');
    assert.equal(cappedBody.next_cursor, null, '不足一页 → 尾页 null');
  } finally {
    await h.close();
  }
});

test('limit 越界与非正整数 → 422 E-RES-007', async () => {
  const h = await harness();
  try {
    const stage = await stagedHarness(h);
    const url = '/api/v1/vaults/team-handbook/audit';
    for (const bad of ['201', '0', '-1', 'abc', '']) {
      const res = await h.app.inject({ method: 'GET', url: `${url}?limit=${bad}`, headers: sidCookie(h.session(stage.alice)) });
      assert.equal(res.statusCode, 422, `limit=${JSON.stringify(bad)} → 422`);
      assert.equal((res.json() as { error: { code: string } }).error.code, 'E-RES-007');
    }
  } finally {
    await h.close();
  }
});

test('游标翻页往返取尽：逐页无重复无遗漏，尾页 next_cursor=null', async () => {
  const h = await harness();
  try {
    const stage = await stagedHarness(h);
    for (let i = 0; i < 12; i++) {
      seedEvent(h.db, {
        employeeId: stage.alice,
        vaultId: stage.handbook,
        kind: 'vault.push',
        occurredAt: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(),
        newCommit: oid((2000 + i).toString(16).padStart(7, '0')),
      });
    }
    const url = '/api/v1/vaults/team-handbook/audit?limit=5';
    const seen: string[] = [];
    let cursor: string | null = null;
    type InjectResponse = Awaited<ReturnType<Harness['app']['inject']>>;
    for (let page = 0; page < 5; page++) {
      const res: InjectResponse = await h.app.inject({
        method: 'GET',
        url: cursor === null ? url : `${url}&cursor=${encodeURIComponent(cursor)}`,
        headers: sidCookie(h.session(stage.alice)),
      });
      assert.equal(res.statusCode, 200);
      const body = res.json() as { events: { new_commit: string | null }[]; next_cursor: string | null };
      for (const ev of body.events) seen.push(ev.new_commit ?? '');
      if (body.next_cursor === null) break;
      cursor = body.next_cursor;
    }
    assert.equal(seen.length, 15, '12 种量 + 3 布景行 全部取尽');
    assert.equal(new Set(seen).size, seen.length, '无重复');
    const expected = [...seen].sort().reverse();
    assert.deepEqual(seen, expected, '跨页整体保持 occurred_at DESC,id DESC');
  } finally {
    await h.close();
  }
});

test('无效 cursor → 422 E-RES-007', async () => {
  const h = await harness();
  try {
    const stage = await stagedHarness(h);
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/vaults/team-handbook/audit?cursor=not-a-cursor',
      headers: sidCookie(h.session(stage.alice)),
    });
    assert.equal(res.statusCode, 422);
    assert.equal((res.json() as { error: { code: string } }).error.code, 'E-RES-007');
  } finally {
    await h.close();
  }
});

// ── admin 端点数据面与维护放行 ───────────────────────────────────────────────

test('admin audit vault 过滤按 slug；未知 slug → 200 空态', async () => {
  const h = await harness();
  try {
    const stage = await stagedHarness(h);
    const filtered = await h.app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit?vault=team-handbook',
      headers: sidCookie(h.session(stage.root)),
    });
    assert.equal(filtered.statusCode, 200);
    const body = filtered.json() as { events: { detail: { pushId?: string } }[] };
    assert.equal(body.events.length, 3, '只回该库 3 行');
    assert.ok(body.events.every((e) => ['seed-push-1', 'seed-web-1', 'seed-pending-1'].includes(e.detail.pushId ?? '')));
    const unknown = await h.app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit?vault=no-such-vault',
      headers: sidCookie(h.session(stage.root)),
    });
    assert.equal(unknown.statusCode, 200);
    const unknownBody = unknown.json() as { events: unknown[]; next_cursor: string | null };
    assert.deepEqual(unknownBody, { events: [], next_cursor: null });
  } finally {
    await h.close();
  }
});

test('维护模式放行审计读（读路径族：开维护后两 GET 仍 200）', async () => {
  const h = await harness();
  try {
    const stage = await stagedHarness(h);
    const enable = await h.app.inject({
      method: 'POST',
      url: '/api/v1/admin/maintenance',
      headers: { ...sidCookie(h.session(stage.root)), origin: 'http://localhost' },
    });
    assert.equal(enable.statusCode, 204);
    const vaultAudit = await h.app.inject({
      method: 'GET',
      url: '/api/v1/vaults/team-handbook/audit',
      headers: sidCookie(h.session(stage.alice)),
    });
    assert.equal(vaultAudit.statusCode, 200, '维护中 vault audit 读放行');
    const adminAudit = await h.app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit',
      headers: sidCookie(h.session(stage.root)),
    });
    assert.equal(adminAudit.statusCode, 200, '维护中 admin audit 读放行');
  } finally {
    await h.close();
  }
});

test('bob 越权零行：vault 端点 403、admin 端点 403，响应体零事件（DOD-E6-05）', async () => {
  const h = await harness();
  try {
    const stage = await stagedHarness(h);
    const vaultRes = await h.app.inject({
      method: 'GET',
      url: '/api/v1/vaults/team-handbook/audit',
      headers: sidCookie(h.session(stage.bob)),
    });
    assert.equal(vaultRes.statusCode, 403);
    assert.match(vaultRes.body, /E-AUTHZ-001/);
    assert.ok(!vaultRes.body.includes('seed-push-1'), '零行泄露');
    const adminRes = await h.app.inject({ method: 'GET', url: '/api/v1/admin/audit', headers: sidCookie(h.session(stage.bob)) });
    assert.equal(adminRes.statusCode, 403);
    assert.ok(!adminRes.body.includes('credential.created'), 'admin 面零行泄露');
  } finally {
    await h.close();
  }
});
