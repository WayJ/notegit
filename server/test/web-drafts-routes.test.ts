import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../src/app.ts';
import { createSession, DEFAULT_SESSION_TIMEOUTS } from '../src/auth/sessions.ts';
import { DraftsService } from '../src/drafts/service.ts';
import { newDb, addEmployee, addVault, addMember } from './credentials-fixtures.ts';

/**
 * S12-T2 我的草稿页 GET /drafts（G08/DOD-E2-08 跨库列表；sprint S12 D3）：
 * 门槛=任意认证员工（未认证 302 /login）；数据=本人现行草稿（active 行——
 * drafts 服务按作者私有存储，只读查询）；跨库按当前员工成员关系实时过滤
 * （撤权库的草稿行不呈现——与检索/最近变更同一判定面，撤权下一请求即消失）；
 * 条目=库 slug/路径/更新时间/「继续编辑」链接（既有 edit 页）。
 *
 * 草稿行经生产写面落库（DraftsService.put——编辑页「保存草稿」同一通道；
 * committed 流转经 markCommitted——提交链同一挂点）。
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
  const app = buildApp({ db, pepper, bootstrapTokenFile: '/tmp/notegit-web-drafts-routes.token' });
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

/** 经生产写面落一份本人现行草稿（时钟固定→updated_at 确定性） */
function seedDraft(db: DatabaseSync, vaultId: number, employeeId: number, path: string, at: string): void {
  new DraftsService({ db, now: () => at }).put(vaultId, employeeId, path, `# ${path}\n`, null);
}

/** 从页面 HTML 提取草稿条目序列（data 属性——不硬编码整页 HTML） */
function draftSeq(body: string): { vault: string; path: string; when: string }[] {
  const seq: { vault: string; path: string; when: string }[] = [];
  const re = /<li class="[^"]*\bdraft-item\b[^"]*" data-vault="([^"]*)" data-path="([^"]*)" data-when="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    seq.push({ vault: m[1], path: m[2], when: m[3] });
  }
  return seq;
}

/** 标准布景：alice=两库 editor；bob=仅 team-handbook reader */
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

// ── 门槛（三态） ────────────────────────────────────────────────────────────

test('GET /drafts 未认证 → 302 /login', async () => {
  const h = await harness();
  try {
    const res = await h.app.inject({ method: 'GET', url: '/drafts' });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/login');
  } finally {
    await h.close();
  }
});

test('alice 多库草稿 → 200：跨库条目齐全，按更新时间新→旧，「继续编辑」链既有 edit 页', async () => {
  const h = await harness();
  try {
    const stage = await stagedHarness(h);
    seedDraft(h.db, stage.handbook, stage.alice, 'docs/roadmap.md', '2026-10-14T10:00:00.000Z');
    seedDraft(h.db, stage.handbook, stage.alice, 'notes/week.md', '2026-10-14T10:05:00.000Z');
    seedDraft(h.db, stage.notes, stage.alice, 'docs/spec.md', '2026-10-14T09:55:00.000Z');

    const res = await h.app.inject({ method: 'GET', url: '/drafts', headers: sidCookie(h.session(stage.alice)) });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] as string, /^text\/html/);
    assert.ok(res.body.includes('我的草稿'), '页面标题落位');
    assert.ok(res.body.includes('class="nav-account"'), '认证页面顶栏账户位');
    const seq = draftSeq(res.body);
    assert.deepEqual(
      seq.map((x) => `${x.vault}:${x.path}`),
      ['team-handbook:notes/week.md', 'team-handbook:docs/roadmap.md', 'product-notes:docs/spec.md'],
      '跨库混合按更新时间新→旧（同刻路径稳定排序）',
    );
    assert.deepEqual(seq.map((x) => x.when), [
      '2026-10-14T10:05:00.000Z',
      '2026-10-14T10:00:00.000Z',
      '2026-10-14T09:55:00.000Z',
    ], '条目携带更新时间（data-when 原值）');
    // 「继续编辑」→ 既有 edit 页 URL（逐段编码，与 browse/view editUrl 同构）
    assert.ok(res.body.includes('href="/vaults/team-handbook/edit/notes/week.md"'), '继续编辑链接（edit 页）');
    assert.ok(res.body.includes('href="/vaults/product-notes/edit/docs/spec.md"'), '跨库条目各自链对应库 edit 页');
    // 库 slug 链接（browse 入口，与最近变更条目同形态）
    assert.ok(res.body.includes('href="/vaults/product-notes"'), '库 slug 链接');
  } finally {
    await h.close();
  }
});

test('bob（有成员关系、无草稿）→ 200 如实空态；他人草稿零混入（按作者私有）', async () => {
  const h = await harness();
  try {
    const stage = await stagedHarness(h);
    seedDraft(h.db, stage.handbook, stage.alice, 'docs/roadmap.md', '2026-10-14T10:00:00.000Z');
    const carol = addEmployee(h.db, { username: 'carol' });
    addMember(h.db, stage.handbook, carol, 'editor', stage.alice);
    seedDraft(h.db, stage.handbook, carol, 'docs/carol.md', '2026-10-14T10:02:00.000Z');

    const res = await h.app.inject({ method: 'GET', url: '/drafts', headers: sidCookie(h.session(stage.bob)) });
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes('尚无本人草稿'), '空态如实呈现');
    assert.equal(draftSeq(res.body).length, 0, 'bob 无本人草稿（alice/carol 的行不可达——按作者私有）');
    assert.ok(!res.body.includes('docs/roadmap.md') && !res.body.includes('docs/carol.md'), '他人草稿路径零泄露');
  } finally {
    await h.close();
  }
});

// ── 成员关系过滤（撤权呈现形态：不呈现——实时 JOIN，与检索/最近变更同一判定面） ──

test('撤权后该库草稿行不呈现（数据保留）；未撤权库条目不受影响', async () => {
  const h = await harness();
  try {
    const stage = await stagedHarness(h);
    seedDraft(h.db, stage.handbook, stage.alice, 'docs/roadmap.md', '2026-10-14T10:00:00.000Z');
    seedDraft(h.db, stage.notes, stage.alice, 'docs/spec.md', '2026-10-14T10:05:00.000Z');

    // 撤权=DELETE vault_members 行（生产撤权面的落库形态；下一查询立即消失）
    h.db.prepare('DELETE FROM vault_members WHERE vault_id = ? AND employee_id = ?').run(stage.handbook, stage.alice);

    const res = await h.app.inject({ method: 'GET', url: '/drafts', headers: sidCookie(h.session(stage.alice)) });
    assert.equal(res.statusCode, 200);
    const seq = draftSeq(res.body);
    assert.deepEqual(seq.map((x) => `${x.vault}:${x.path}`), ['product-notes:docs/spec.md'], '仅未撤权库条目呈现');
    assert.ok(!res.body.includes('docs/roadmap.md'), '撤权库草稿行不呈现');
    // 草稿数据本身保留（只读查询过滤，非删除）——重新获权即恢复可见
    const kept = h.db
      .prepare("SELECT COUNT(*) AS n FROM drafts WHERE employee_id = ? AND status = 'active'")
      .get(stage.alice) as { n: number };
    assert.equal(kept.n, 2, '撤权不删草稿数据（呈现层过滤）');
    assert.ok(res.body.includes('成员关系'), '页面如实标注过滤口径');
  } finally {
    await h.close();
  }
});

test('已提交（committed）草稿不列——仅现行（active）草稿', async () => {
  const h = await harness();
  try {
    const stage = await stagedHarness(h);
    seedDraft(h.db, stage.handbook, stage.alice, 'docs/submitted.md', '2026-10-14T10:00:00.000Z');
    seedDraft(h.db, stage.handbook, stage.alice, 'docs/wip.md', '2026-10-14T10:05:00.000Z');
    new DraftsService({ db: h.db, now: () => '2026-10-14T10:06:00.000Z' })
      .markCommitted('team-handbook', stage.alice, 'docs/submitted.md');

    const res = await h.app.inject({ method: 'GET', url: '/drafts', headers: sidCookie(h.session(stage.alice)) });
    const seq = draftSeq(res.body);
    assert.deepEqual(seq.map((x) => x.path), ['docs/wip.md'], 'committed 终态行不列（现行草稿=active）');
  } finally {
    await h.close();
  }
});
