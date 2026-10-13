import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { loadOrCreatePepper } from '../src/bootstrap/pepper.ts';
import { CredentialsService } from '../src/credentials/service.ts';
import { newDb, addEmployee, addVault } from './credentials-fixtures.ts';
import { drainCount } from '../src/audit/audit.ts';
import { preRecordPendingPush, settlePushRejected } from '../src/githttp/receive-audit.ts';
import { sweepOrphanedPending } from '../src/audit/reconciliation.ts';
import { createMaintenanceGate } from '../src/maintenance/gate.ts';
import {
  waitForDrain,
  DRAIN_TIMEOUT_DEFAULT_MS,
  type DrainOutcome,
} from '../src/maintenance/drain.ts';

// S8-T3 §4 步骤 2 排空（backup-recovery §4 唯一语义源）：
// - 开启维护后等待权威数据上无 pending 写操作（排空判据 = storage-model §4
//   audit.drain_count 规范查询：pending|unresolved 计数——预记录面见 receive-audit）；
// - 有界等待：默认 300 秒可配（backup §4 步骤 2「等待有界超时（默认 300 秒，可配）」）；
// - 超时默认中止本次备份并保持维护模式（不半退出）——排空原语不持有闸门，
//   结构上无从「排空超时顺手关闸」；
// - 排空进度可查：GET /api/v1/admin/maintenance 维护端点进度面（T2 指标面可
//   直接消费 drain.pending 预留字段）。
// 在途写的表示 = preRecordPendingPush（真实 pre-receive hook 同一 API——架构 §4.4
// 「先预记录、后核对」的观察面；终态清算 = settlePushRejected/settleAuditEvent）。

/** 在途 receive 的落库形态（FK：真实员工与库行 + credential 载体） */
function recordPending(db: DatabaseSync, pushId: string, employeeId: number, vaultId: number, n = 1): void {
  preRecordPendingPush(db, {
    subject: { employeeId, carrierRef: 'credential:1', entry: 'git' },
    vaultId,
    commands: Array.from({ length: n }, (_, i) => ({
      ref: `refs/heads/br-${i}`,
      oldOid: '1'.repeat(40),
      newOid: '2'.repeat(40),
    })),
    pushId,
    occurredAt: new Date().toISOString(),
  });
}

/** 单元形态夹具：一员工 + 一库（audit_events FK 目标） */
function drainDb(): { db: DatabaseSync; employeeId: number; vaultId: number } {
  const db = newDb();
  const employeeId = addEmployee(db, { username: 'pusher' });
  const vaultId = addVault(db, 'drain-fixture', employeeId);
  return { db, employeeId, vaultId };
}

test('排空原语：无在途写 → 立即 drained（单进程传播上界 0，开启后即可查——backup §3）', async () => {
  const db = newDb();
  try {
    assert.equal(drainCount(db), 0, '前置：无 pending/unresolved 行');
    const r = await waitForDrain(db);
    assert.equal(r.outcome, 'drained');
    assert.equal(r.pending, 0);
    assert.equal(r.waitedMs, 0, '首个检查点即排空（首轮不等待）');
  } finally {
    db.close();
  }
});

test('排空等待路径：在途 receive（pending 预记录）清算后 → drained；等待窗口如实观测', async () => {
  const { db, employeeId, vaultId } = drainDb();
  try {
    recordPending(db, 'push-drain-wait', employeeId, vaultId, 2);
    assert.equal(drainCount(db), 2);
    // 模拟在途推送到达终态（post-receive 核对 / pre-receive 拒绝的同构面）
    const settleAt = 60;
    const timer = setTimeout(() => settlePushRejected(db, { pushId: 'push-drain-wait', reason: 'settled-in-flight' }), settleAt);
    const r: DrainOutcome = await waitForDrain(db, { timeoutMs: 5_000, pollMs: 15 });
    clearTimeout(timer);
    assert.equal(r.outcome, 'drained', '清算完成后排空成功');
    assert.equal(r.pending, 0);
    assert.ok(r.waitedMs >= settleAt - 5, `应观察到在途窗口（waitedMs=${r.waitedMs} ≥ 触发清算的 ${settleAt}ms）`);
    assert.ok(r.waitedMs < 5_000, '远未到界');
  } finally {
    db.close();
  }
});

test('排空超时路径：pending 不清零 → timeout；默认中止且维护模式保持开启（不半退出）', async () => {
  const { db, employeeId, vaultId } = drainDb();
  const gate = createMaintenanceGate();
  try {
    assert.equal(gate.enable(), true);
    recordPending(db, 'push-stuck', employeeId, vaultId, 1);
    const timeoutMs = 120;
    const r = await waitForDrain(db, { timeoutMs, pollMs: 10 });
    assert.equal(r.outcome, 'timeout', '有界等待到界即返回 timeout');
    assert.equal(r.pending, 1, '如实在途计数');
    assert.equal(r.timeoutMs, timeoutMs, '实际生效的可配值');
    assert.ok(r.waitedMs >= timeoutMs - 10, `等待了整个有界窗口（waitedMs=${r.waitedMs}）`);
    // backup §4 步骤 2：超时默认中止本次备份并保持维护模式——闸门仍开启，
    // 供排查（管理员可显式选择继续；退出只能走显式 DELETE）
    assert.equal(gate.isEnabled(), true, '不半退出：排空原语不触碰闸门，超时后维护仍在');
    // 清算后重试 → drained（超时不留副作用：判据仍是当下计数）
    settlePushRejected(db, { pushId: 'push-stuck', reason: 'late-settle' });
    const again = await waitForDrain(db, { timeoutMs: 200, pollMs: 10 });
    assert.equal(again.outcome, 'drained', '清算后重查即排空');
  } finally {
    db.close();
  }
});

test('默认有界等待 = 300 秒且可配（backup §4 步骤 2 原文缺省值）', async () => {
  assert.equal(DRAIN_TIMEOUT_DEFAULT_MS, 300_000, '默认 300s');
  const { db, employeeId, vaultId } = drainDb();
  try {
    // 缺省不传 timeoutMs：无 pending 时立即返回（不会真等 300s——首轮判据先行）
    const r = await waitForDrain(db, { pollMs: 5 });
    assert.equal(r.outcome, 'drained');
    // 可配缩窗：50ms 到界
    recordPending(db, 'push-default', employeeId, vaultId, 1);
    const short = await waitForDrain(db, { timeoutMs: 50, pollMs: 10 });
    assert.equal(short.outcome, 'timeout');
    assert.equal(short.timeoutMs, 50, '可配值原样生效');
  } finally {
    db.close();
  }
});

test('排空口径含待核对行：unresolved 残留同样阻塞排空（audit.drain_count 规范查询 pending|unresolved）', async () => {
  const { db, employeeId, vaultId } = drainDb();
  try {
    recordPending(db, 'push-orphan', employeeId, vaultId, 1);
    const swept = sweepOrphanedPending(db, { pushId: 'push-orphan', reason: 'receive-aborted' });
    assert.equal(swept, 1, '中断清扫 → unresolved（待核对）');
    assert.equal(drainCount(db), 1, 'unresolved 行计入排空口径（§5 不变量 1：无 pending 残留才可快照）');
    const r = await waitForDrain(db, { timeoutMs: 60, pollMs: 10 });
    assert.equal(r.outcome, 'timeout', '待核对不清零 → 不得进入快照步骤（到界中止）');
  } finally {
    db.close();
  }
});

// ── 进度面：GET /api/v1/admin/maintenance（维护端点；T2 指标面消费 drain.pending） ──

interface EndpointCtx {
  app: FastifyInstance;
  db: DatabaseSync;
  adminId: number;
  vaultId: number;
  adminBearer: Record<string, string>;
  memberBearer: Record<string, string>;
  close(): Promise<void>;
}

async function buildEndpointCtx(): Promise<EndpointCtx> {
  const db = newDb();
  const admin = addEmployee(db, { username: 'admin', is_instance_admin: 1 });
  const member = addEmployee(db, { username: 'member' });
  const dir = await mkdtemp(path.join(tmpdir(), 'notegit-drain-'));
  const pepper = await loadOrCreatePepper(path.join(dir, 'token-pepper.key'));
  const service = new CredentialsService({ db, pepper });
  const expires = new Date(Date.now() + 86_400_000).toISOString();
  const adminToken = service.createCredential(admin, { name: 'a', expires_at: expires }).token;
  const memberToken = service.createCredential(member, { name: 'm', expires_at: expires }).token;
  const app = buildApp({ db, pepper, bootstrapTokenFile: path.join(dir, 'admin-bootstrap.token') });
  return {
    app,
    db,
    adminId: admin,
    vaultId: addVault(db, 'drain-endpoint', admin),
    adminBearer: { authorization: `Bearer ${adminToken}` },
    memberBearer: { authorization: `Bearer ${memberToken}` },
    close: async () => {
      await app.close();
      db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('进度端点门槛：未认证 401；非实例管理员 403 E-AUTHZ-001', async () => {
  const ctx = await buildEndpointCtx();
  try {
    const unauth = await ctx.app.inject({ method: 'GET', url: '/api/v1/admin/maintenance' });
    assert.equal(unauth.statusCode, 401);
    const member = await ctx.app.inject({ method: 'GET', url: '/api/v1/admin/maintenance', headers: ctx.memberBearer });
    assert.equal(member.statusCode, 403);
    assert.equal((member.json() as { error: { code: string } }).error.code, 'E-AUTHZ-001');
  } finally {
    await ctx.close();
  }
});

test('进度端点：enabled + drain.pending 如实呈现（开启 → 在途计数 → 清零），维护中读放行', async () => {
  const ctx = await buildEndpointCtx();
  try {
    const off = await ctx.app.inject({ method: 'GET', url: '/api/v1/admin/maintenance', headers: ctx.adminBearer });
    assert.equal(off.statusCode, 200);
    assert.deepEqual(off.json(), { enabled: false, drain: { pending: 0 } }, '关闭态形状');

    const on = await ctx.app.inject({ method: 'POST', url: '/api/v1/admin/maintenance', headers: ctx.adminBearer, payload: {} });
    assert.equal(on.statusCode, 204);
    recordPending(ctx.db, 'push-progress', ctx.adminId, ctx.vaultId, 2);
    const during = await ctx.app.inject({ method: 'GET', url: '/api/v1/admin/maintenance', headers: ctx.adminBearer });
    assert.equal(during.statusCode, 200, '维护中 GET（读）放行（矩阵第 7 行）');
    assert.deepEqual(during.json(), { enabled: true, drain: { pending: 2 } }, '排空进度可查（§4 步骤 2）');

    settlePushRejected(ctx.db, { pushId: 'push-progress', reason: 'settled' });
    const after = await ctx.app.inject({ method: 'GET', url: '/api/v1/admin/maintenance', headers: ctx.adminBearer });
    assert.deepEqual(after.json(), { enabled: true, drain: { pending: 0 } }, '清算后计数归零');

    // 超时中止的可观测面（backup §4 步骤 2「保持维护模式供排查」）：真实端点开启 +
    // 在途不清零 → 排空到界 → 进度面仍 enabled（退出只能走显式 DELETE）
    recordPending(ctx.db, 'push-timeout', ctx.adminId, ctx.vaultId, 1);
    const stuck = await waitForDrain(ctx.db, { timeoutMs: 50, pollMs: 10 });
    assert.equal(stuck.outcome, 'timeout');
    const heldOn = await ctx.app.inject({ method: 'GET', url: '/api/v1/admin/maintenance', headers: ctx.adminBearer });
    assert.deepEqual(heldOn.json(), { enabled: true, drain: { pending: 1 } }, '超时中止后维护仍在（不半退出）+ 进度如实');
    settlePushRejected(ctx.db, { pushId: 'push-timeout', reason: 'settled' });

    const offToggle = await ctx.app.inject({ method: 'DELETE', url: '/api/v1/admin/maintenance', headers: ctx.adminBearer });
    assert.equal(offToggle.statusCode, 204);
  } finally {
    await ctx.close();
  }
});

test('写分类断言（backup §3）：运维审计行直接终态——运行态写入永不进入排空在途集合', async () => {
  const ctx = await buildEndpointCtx();
  try {
    const on = await ctx.app.inject({ method: 'POST', url: '/api/v1/admin/maintenance', headers: ctx.adminBearer, payload: {} });
    assert.equal(on.statusCode, 204);
    // 运行态写入已产生（maintenance.enable 行）——但它是直接终态（succeeded），
    // 不可能成为 pending/unresolved：不阻塞排空（「不入备份一致性集合」的排空侧
    // 判据；快照侧的物理排除随 T4 §4 步骤 3 落地）
    const rows = ctx.db
      .prepare(`SELECT event_kind, status FROM audit_events WHERE event_kind LIKE 'maintenance.%'`)
      .all() as { event_kind: string; status: string }[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.event_kind, 'maintenance.enable', '运维审计行产生');
    assert.equal(rows[0]!.status, 'succeeded', '直接终态（storage-model §5）');
    assert.equal(drainCount(ctx.db), 0, '运维行不计入排空口径');
    const r = await waitForDrain(ctx.db, { pollMs: 5 });
    assert.equal(r.outcome, 'drained', '维护生命周期写入不阻塞排空');
  } finally {
    await ctx.close();
  }
});
