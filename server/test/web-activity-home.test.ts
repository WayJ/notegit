import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../src/app.ts';
import { createSession, DEFAULT_SESSION_TIMEOUTS } from '../src/auth/sessions.ts';
import { recordAuditEvent, settleAuditEvent } from '../src/audit/audit.ts';
import { newDb, addEmployee, addVault, addMember } from './credentials-fixtures.ts';

/**
 * S11-T2 首页最近变更区块（DOD-E2-06 跨库面）：数据源=审计发布事件成功行
 * （vault.web_submit / vault.push——sprint S11 D3「派生即审计、零新表」）；
 * 跨库面按当前员工成员关系过滤——查询实时 JOIN vault_members（与检索
 * search/query.ts 同一判定面，D7 无缓存：撤权下一渲染即消失）。
 *
 * 审计行经生产写面落库（recordAuditEvent pending 预记录 + settleAuditEvent
 * 终态——与 publish 管线/receive 审计链同一形状），不经任何旁路 INSERT。
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
  const app = buildApp({ db, pepper, bootstrapTokenFile: '/tmp/notegit-web-activity-home.token' });
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

/** 终态形态（pending=预记录后不结算；unresolved=中断残留，测试直改行） */
type SeedStatus = 'succeeded' | 'rejected' | 'pending' | 'unresolved';

interface SeedInput {
  employeeId: number;
  vaultId: number;
  kind: 'vault.push' | 'vault.web_submit';
  occurredAt: string;
  newCommit: string;
  oldCommit?: string;
  entry?: 'web' | 'git';
  status?: SeedStatus;
  detail?: Record<string, unknown>;
}

/** 按生产形状落一笔审计发布行（pending 预记录 → 终态） */
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
  const status = input.status ?? 'succeeded';
  if (status === 'pending') return; // 在途形态：不结算
  if (status === 'unresolved') {
    db.prepare('UPDATE audit_events SET status = ? WHERE id = ?').run('unresolved', id); // 中断残留
    return;
  }
  settleAuditEvent(db, id, status);
}

interface ActivityItem {
  vault: string;
  actor: string;
  when: string;
  commit: string;
  entry: string;
}

/** 从页面 HTML 提取最近变更条目序列（data 属性——不硬编码整页 HTML） */
function activitySeq(body: string): ActivityItem[] {
  const seq: ActivityItem[] = [];
  const re =
    /<li class="[^"]*\bactivity-item\b[^"]*" data-vault="([^"]*)" data-actor="([^"]*)" data-when="([^"]*)" data-commit="([^"]*)" data-entry="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    seq.push({ vault: m[1], actor: m[2], when: m[3], commit: m[4], entry: m[5] });
  }
  return seq;
}

// ── 跨库面：成员关系过滤（DOD-E2-06「bob 不见 product-notes 条目」） ────────

test('首页最近变更：两库成员见两库条目，按时间新→旧；区块在工作台首页保留', async () => {
  const h = await harness();
  try {
    const alice = addEmployee(h.db, { username: 'alice', display_name: '爱丽丝' });
    addEmployee(h.db, { username: 'bob' });
    const handbook = addVault(h.db, 'team-handbook', alice);
    const notes = addVault(h.db, 'product-notes', alice);
    addMember(h.db, handbook, alice, 'editor', alice);
    addMember(h.db, notes, alice, 'editor', alice);
    seedPublish(h.db, { employeeId: alice, vaultId: handbook, kind: 'vault.web_submit', occurredAt: '2026-10-14T09:55:00.000Z', newCommit: oid('aa10001'), oldCommit: oid('9f90001') });
    seedPublish(h.db, { employeeId: alice, vaultId: notes, kind: 'vault.push', occurredAt: '2026-10-14T10:00:00.000Z', newCommit: oid('bb20002'), oldCommit: oid('9f90002') });
    seedPublish(h.db, { employeeId: alice, vaultId: handbook, kind: 'vault.push', occurredAt: '2026-10-14T10:05:00.000Z', newCommit: oid('cc30003'), oldCommit: oid('aa10001') });

    const res = await h.app.inject({ method: 'GET', url: '/', headers: sidCookie(h.session(alice)) });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] as string, /^text\/html/);
    assert.ok(res.body.includes('最近变更'), '首页应呈现最近变更区块');
    const seq = activitySeq(res.body);
    assert.deepEqual(
      seq.map((x) => x.vault),
      ['team-handbook', 'product-notes', 'team-handbook'],
      '跨库混合按时间新→旧',
    );
    assert.deepEqual(
      seq.map((x) => x.commit.slice(0, 7)),
      ['cc30003', 'bb20002', 'aa10001'],
      '条目携带 commit 短码（新→旧序）',
    );
    assert.ok(seq.every((x) => x.actor === 'alice'), '作者=审计主体（认证员工）');
    assert.ok(res.body.includes('爱丽丝'), '作者显示名呈现');
    assert.ok(
      res.body.includes('href="/vaults/team-handbook/history"'),
      'commit 短码链接该库历史页（既有页）',
    );
    assert.ok(res.body.includes('href="/vaults/product-notes"'), '库 slug 链接（browse 入口）');
    // S14-T3 起首页升级为工作台：原 feature-card 入口卡退役（侧栏/聚合卡承接，
    // 见 web-workbench-home.test.ts）；本区块（最近变更）保留为次级区块
    assert.ok(res.body.includes('aria-label="最近变更"'), '最近变更区块保留');
    assert.ok(res.body.includes('id="logout"'), '登出控件保留');
    assert.equal((res.body.match(/<script/g) ?? []).length, 1, '唯一 script（区块不新增脚本）');
  } finally {
    await h.close();
  }
});

test('首页最近变更：bob（仅 team-handbook 成员）不见 product-notes 任何条目（零泄露）', async () => {
  const h = await harness();
  try {
    const alice = addEmployee(h.db, { username: 'alice', display_name: '爱丽丝' });
    const bob = addEmployee(h.db, { username: 'bob' });
    const handbook = addVault(h.db, 'team-handbook', alice);
    const notes = addVault(h.db, 'product-notes', alice);
    addMember(h.db, handbook, alice, 'editor', alice);
    addMember(h.db, notes, alice, 'editor', alice);
    addMember(h.db, handbook, bob, 'reader', alice);
    seedPublish(h.db, { employeeId: alice, vaultId: notes, kind: 'vault.web_submit', occurredAt: '2026-10-14T10:00:00.000Z', newCommit: oid('bb20002') });
    seedPublish(h.db, { employeeId: alice, vaultId: handbook, kind: 'vault.push', occurredAt: '2026-10-14T10:05:00.000Z', newCommit: oid('cc30003') });

    const res = await h.app.inject({ method: 'GET', url: '/', headers: sidCookie(h.session(bob)) });
    assert.equal(res.statusCode, 200);
    const seq = activitySeq(res.body);
    assert.ok(seq.length === 1, `bob 仅见成员库条目（实得 ${seq.length}）`);
    assert.equal(seq[0].vault, 'team-handbook');
    assert.ok(!res.body.includes('product-notes'), '无权库 slug 零泄露');
    assert.ok(!res.body.includes('bb20002'), '无权库 commit 短码零泄露');
  } finally {
    await h.close();
  }
});

test('首页最近变更：撤权（DELETE 成员行）后下一请求条目消失（实时 JOIN 无缓存）', async () => {
  const h = await harness();
  try {
    const alice = addEmployee(h.db, { username: 'alice' });
    const bob = addEmployee(h.db, { username: 'bob' });
    const handbook = addVault(h.db, 'team-handbook', alice);
    addMember(h.db, handbook, alice, 'editor', alice);
    addMember(h.db, handbook, bob, 'reader', alice);
    seedPublish(h.db, { employeeId: alice, vaultId: handbook, kind: 'vault.push', occurredAt: '2026-10-14T10:05:00.000Z', newCommit: oid('cc30003') });

    const before = await h.app.inject({ method: 'GET', url: '/', headers: sidCookie(h.session(bob)) });
    assert.equal(activitySeq(before.body).length, 1, '撤权前 bob 可见条目');
    h.db.prepare('DELETE FROM vault_members WHERE vault_id = ? AND employee_id = ?').run(handbook, bob);
    const after = await h.app.inject({ method: 'GET', url: '/', headers: sidCookie(h.session(bob)) });
    assert.equal(activitySeq(after.body).length, 0, '撤权后下一渲染条目消失');
    assert.ok(after.body.includes('最近变更'), '区块仍在（如实空态）');
  } finally {
    await h.close();
  }
});

// ── 数据面：仅成功终态 + 上限/排序 ──────────────────────────────────────────

test('首页最近变更：仅呈现成功终态行（rejected/pending/unresolved 不出现）', async () => {
  const h = await harness();
  try {
    const alice = addEmployee(h.db, { username: 'alice' });
    const bob = addEmployee(h.db, { username: 'bob' });
    const handbook = addVault(h.db, 'team-handbook', alice);
    addMember(h.db, handbook, alice, 'editor', alice);
    addMember(h.db, handbook, bob, 'reader', alice);
    seedPublish(h.db, { employeeId: alice, vaultId: handbook, kind: 'vault.push', occurredAt: '2026-10-14T10:00:00.000Z', newCommit: oid('aa10001'), status: 'succeeded' });
    seedPublish(h.db, { employeeId: alice, vaultId: handbook, kind: 'vault.push', occurredAt: '2026-10-14T10:01:00.000Z', newCommit: oid('bb20002'), status: 'rejected' });
    seedPublish(h.db, { employeeId: alice, vaultId: handbook, kind: 'vault.web_submit', occurredAt: '2026-10-14T10:02:00.000Z', newCommit: oid('cc30003'), status: 'pending' });
    seedPublish(h.db, { employeeId: alice, vaultId: handbook, kind: 'vault.web_submit', occurredAt: '2026-10-14T10:03:00.000Z', newCommit: oid('dd40004'), status: 'unresolved' });

    const res = await h.app.inject({ method: 'GET', url: '/', headers: sidCookie(h.session(bob)) });
    const seq = activitySeq(res.body);
    assert.equal(seq.length, 1, '仅成功终态一行呈现');
    assert.ok(res.body.includes('aa10001'), 'succeeded 行短码呈现');
    assert.ok(!res.body.includes('bb20002'), 'rejected 行不出现');
    assert.ok(!res.body.includes('cc30003'), 'pending（在途）行不出现');
    assert.ok(!res.body.includes('dd40004'), 'unresolved（待核对）行不出现');
  } finally {
    await h.close();
  }
});

test('首页最近变更：上限 20 条（新→旧截断，超出行不呈现）', async () => {
  const h = await harness();
  try {
    const alice = addEmployee(h.db, { username: 'alice' });
    const bob = addEmployee(h.db, { username: 'bob' });
    const handbook = addVault(h.db, 'team-handbook', alice);
    addMember(h.db, handbook, alice, 'editor', alice);
    addMember(h.db, handbook, bob, 'reader', alice);
    for (let i = 0; i < 22; i++) {
      seedPublish(h.db, {
        employeeId: alice,
        vaultId: handbook,
        kind: 'vault.push',
        occurredAt: new Date(Date.UTC(2026, 9, 14, 8, i)).toISOString(),
        newCommit: oid(i.toString(16).padStart(7, '0')),
      });
    }
    const res = await h.app.inject({ method: 'GET', url: '/', headers: sidCookie(h.session(bob)) });
    const seq = activitySeq(res.body);
    assert.equal(seq.length, 20, `上限 20 条（实得 ${seq.length}）`);
    assert.equal(seq[0].commit.slice(0, 7), (21).toString(16).padStart(7, '0'), '最新一条在前');
    assert.ok(!seq.some((x) => x.commit.startsWith('0000000')), '最旧两条（0/1 号）被截断不出现在条目序列');
  } finally {
    await h.close();
  }
});

test('首页最近变更：无任何事件 → 区块呈现如实空态（不报错、不 404）', async () => {
  const h = await harness();
  try {
    const alice = addEmployee(h.db, { username: 'alice' });
    const res = await h.app.inject({ method: 'GET', url: '/', headers: sidCookie(h.session(alice)) });
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes('最近变更'));
    assert.equal(activitySeq(res.body).length, 0);
  } finally {
    await h.close();
  }
});
