import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../src/app.ts';
import { createSession, DEFAULT_SESSION_TIMEOUTS } from '../src/auth/sessions.ts';
import { recordAuditEvent, settleAuditEvent } from '../src/audit/audit.ts';
import { newDb, addEmployee, addVault, addMember } from './credentials-fixtures.ts';

/**
 * S11-T2 库内最近变更页 GET /vaults/{slug}/activity（DOD-E2-06 库页面）：
 * 门槛=read 成员（D-IC-06：非成员/不存在 404 同页同体；未认证 302 /login）；
 * 数据源=该库审计发布事件成功行（web_submit 与 push 都呈现——两入口发布均
 * 记审计）；排序新→旧、上限 20；detail 携带路径则生成 view 链接。
 *
 * 审计行经生产写面落库（recordAuditEvent + settleAuditEvent——与 publish
 * 管线/receive 审计链同一形状）。
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
  const app = buildApp({ db, pepper, bootstrapTokenFile: '/tmp/notegit-web-activity-routes.token' });
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

let seedSeq = 0;

/** 40 位 hex OID（前缀区分——短码取前 7 位即可区分条目） */
function oid(prefix: string): string {
  return prefix.padEnd(40, '0');
}

interface SeedInput {
  employeeId: number;
  vaultId: number;
  kind: 'vault.push' | 'vault.web_submit';
  occurredAt: string;
  newCommit: string;
  oldCommit?: string;
  entry?: 'web' | 'git';
  detail?: Record<string, unknown>;
}

/** 按生产形状落一笔成功终态审计发布行（pending 预记录 → settle succeeded） */
function seedPublish(db: DatabaseSync, input: SeedInput): void {
  recordAuditEvent(db, {
    occurredAt: input.occurredAt,
    actorKind: 'employee',
    subject: {
      employeeId: input.employeeId,
      carrierRef: `session:${input.employeeId}`,
      entry: input.entry ?? (input.kind === 'vault.push' ? 'git' : 'web'),
    },
    eventKind: input.kind,
    vaultId: input.vaultId,
    refName: 'refs/heads/main',
    oldCommit: input.oldCommit ?? null,
    newCommit: input.newCommit,
    status: 'pending',
    detail: { pushId: `seed-${++seedSeq}`, ...(input.detail ?? {}) },
  });
  const id = Number((db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id);
  settleAuditEvent(db, id, 'succeeded');
}

/** 从页面 HTML 提取最近变更条目序列（data 属性——不硬编码整页 HTML） */
function activitySeq(body: string): { vault: string; actor: string; when: string; commit: string; entry: string }[] {
  const seq: { vault: string; actor: string; when: string; commit: string; entry: string }[] = [];
  const re =
    /<li class="[^"]*\bactivity-item\b[^"]*" data-vault="([^"]*)" data-actor="([^"]*)" data-when="([^"]*)" data-commit="([^"]*)" data-entry="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    seq.push({ vault: m[1], actor: m[2], when: m[3], commit: m[4], entry: m[5] });
  }
  return seq;
}

/** 标准布景：alice=两库 editor；bob=仅 team-handbook reader；各库一笔种子事件 */
interface Stage {
  alice: number;
  bob: number;
  handbook: number;
  notes: number;
}
async function stagedHarness(h: Harness): Promise<Stage> {
  const alice = addEmployee(h.db, { username: 'alice', display_name: '爱丽丝' });
  const bob = addEmployee(h.db, { username: 'bob' });
  const handbook = addVault(h.db, 'team-handbook', alice);
  const notes = addVault(h.db, 'product-notes', alice);
  addMember(h.db, handbook, alice, 'editor', alice);
  addMember(h.db, notes, alice, 'editor', alice);
  addMember(h.db, handbook, bob, 'reader', alice);
  return { alice, bob, handbook, notes };
}

// ── 门槛（三角色矩阵） ──────────────────────────────────────────────────────

test('GET /vaults/{slug}/activity 未认证 → 302 /login', async () => {
  const h = await harness();
  try {
    const res = await h.app.inject({ method: 'GET', url: '/vaults/team-handbook/activity' });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/login');
  } finally {
    await h.close();
  }
});

test('非成员 404，与不存在库同页同体（D-IC-06 反存在性）', async () => {
  const h = await harness();
  try {
    const stage = await stagedHarness(h);
    seedPublish(h.db, { employeeId: stage.alice, vaultId: stage.handbook, kind: 'vault.push', occurredAt: '2026-10-14T10:05:00.000Z', newCommit: oid('cc30003') });
    const bobRes = await h.app.inject({
      method: 'GET',
      url: '/vaults/product-notes/activity', // bob 非成员（库真实存在且有事件）
      headers: sidCookie(h.session(stage.bob)),
    });
    const ghostRes = await h.app.inject({
      method: 'GET',
      url: '/vaults/no-such-vault/activity', // 不存在的库
      headers: sidCookie(h.session(stage.bob)),
    });
    assert.equal(bobRes.statusCode, 404);
    assert.equal(ghostRes.statusCode, 404);
    assert.equal(bobRes.body, ghostRes.body, '非成员与不存在同页同体（不泄露库存在性）');
  } finally {
    await h.close();
  }
});

test('reader 成员 200：web_submit 与 push 事件都呈现（作者/时间/commit 短码→库历史页链接）', async () => {
  const h = await harness();
  try {
    const stage = await stagedHarness(h);
    seedPublish(h.db, { employeeId: stage.alice, vaultId: stage.handbook, kind: 'vault.web_submit', occurredAt: '2026-10-14T10:00:00.000Z', newCommit: oid('aa10001'), oldCommit: oid('9f90001') });
    seedPublish(h.db, { employeeId: stage.alice, vaultId: stage.handbook, kind: 'vault.push', occurredAt: '2026-10-14T10:05:00.000Z', newCommit: oid('bb20002'), oldCommit: oid('aa10001') });

    const res = await h.app.inject({ method: 'GET', url: '/vaults/team-handbook/activity', headers: sidCookie(h.session(stage.bob)) });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] as string, /^text\/html/);
    const seq = activitySeq(res.body);
    assert.equal(seq.length, 2, '两类事件各一条');
    const webRow = seq.find((x) => x.entry === 'web');
    const gitRow = seq.find((x) => x.entry === 'git');
    assert.ok(webRow !== undefined, 'vault.web_submit（站内编辑）事件呈现');
    assert.ok(gitRow !== undefined, 'vault.push（git 推送）事件呈现');
    assert.equal(webRow?.commit.slice(0, 7), 'aa10001');
    assert.equal(gitRow?.commit.slice(0, 7), 'bb20002');
    for (const row of seq) {
      assert.equal(row.actor, 'alice', '作者=审计主体（认证员工——DOD-03）');
      assert.equal(row.vault, 'team-handbook');
      assert.equal(row.when, seq[0] === row ? '2026-10-14T10:05:00.000Z' : '2026-10-14T10:00:00.000Z');
    }
    assert.ok(res.body.includes('爱丽丝'), '作者显示名呈现');
    assert.ok(res.body.includes('href="/vaults/team-handbook/history"'), 'commit 短码链接该库历史页');
    assert.ok(res.body.includes('team-handbook 最近变更'), '页面标题落位');
    assert.ok(!res.body.includes('product-notes'), '他库条目不混入');
  } finally {
    await h.close();
  }
});

// ── 数据面：排序/上限/路径链接/空态 ─────────────────────────────────────────

test('排序新→旧 + 上限 20 条（超出行截断）', async () => {
  const h = await harness();
  try {
    const stage = await stagedHarness(h);
    for (let i = 0; i < 22; i++) {
      seedPublish(h.db, {
        employeeId: stage.alice,
        vaultId: stage.handbook,
        kind: i % 2 === 0 ? 'vault.push' : 'vault.web_submit',
        occurredAt: new Date(Date.UTC(2026, 9, 14, 8, i)).toISOString(),
        newCommit: oid(i.toString(16).padStart(7, '0')),
      });
    }
    const res = await h.app.inject({ method: 'GET', url: '/vaults/team-handbook/activity', headers: sidCookie(h.session(stage.bob)) });
    const seq = activitySeq(res.body);
    assert.equal(seq.length, 20, `上限 20 条（实得 ${seq.length}）`);
    assert.equal(seq[0].commit.slice(0, 7), (21).toString(16).padStart(7, '0'), '最新在前');
    assert.equal(seq[19].commit.slice(0, 7), (2).toString(16).padStart(7, '0'), '窗口尾部=第 2 新');
    assert.ok(!seq.some((x) => x.commit.startsWith('0000000')), '最旧两条被截断');
  } finally {
    await h.close();
  }
});

test('detail 携带 paths → 生成 view 链接；无 paths → 不生成', async () => {
  const h = await harness();
  try {
    const stage = await stagedHarness(h);
    seedPublish(h.db, {
      employeeId: stage.alice,
      vaultId: stage.handbook,
      kind: 'vault.web_submit',
      occurredAt: '2026-10-14T10:00:00.000Z',
      newCommit: oid('aa10001'),
      detail: { paths: ['docs/roadmap.md', 'notes/week.md'] },
    });
    seedPublish(h.db, { employeeId: stage.alice, vaultId: stage.handbook, kind: 'vault.push', occurredAt: '2026-10-14T10:05:00.000Z', newCommit: oid('bb20002') });

    const res = await h.app.inject({ method: 'GET', url: '/vaults/team-handbook/activity', headers: sidCookie(h.session(stage.bob)) });
    assert.ok(res.body.includes('href="/vaults/team-handbook/view/docs/roadmap.md"'), 'detail 有路径 → view 链接（逐段编码）');
    assert.ok(res.body.includes('href="/vaults/team-handbook/view/notes/week.md"'), '多路径逐一生成');
    const rows = res.body.split('activity-item');
    const withPaths = rows.find((r) => r.includes('aa10001'));
    const withoutPaths = rows.find((r) => r.includes('bb20002'));
    assert.ok(withoutPaths !== undefined && !withoutPaths.includes('/view/'), '无路径条目不生成 view 链接');
    assert.ok(withPaths !== undefined && withPaths.includes('/view/'), '有路径条目生成 view 链接');
  } finally {
    await h.close();
  }
});

test('无事件库 → 200 如实空态（不 404——成员已确认）', async () => {
  const h = await harness();
  try {
    const stage = await stagedHarness(h);
    const res = await h.app.inject({ method: 'GET', url: '/vaults/team-handbook/activity', headers: sidCookie(h.session(stage.bob)) });
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes('最近变更'));
    assert.equal(activitySeq(res.body).length, 0);
  } finally {
    await h.close();
  }
});
