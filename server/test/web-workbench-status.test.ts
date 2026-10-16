import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  browseHarness,
  seededVault,
  addEmployee,
  addMember,
  gitOut,
  repoPathOf,
  type BrowseHarness,
} from './web-browse-fixtures.ts';
import { recordAuditEvent, settleAuditEvent } from '../src/audit/audit.ts';
import { indexStatus } from '../src/web/workbench/query.ts';
import { viewUrl } from '../src/web/browse/pages.ts';

/**
 * S15-T2 索引状态位 + 视图开关 + 可见性声明（DOD-E4-06/08；D4/D5）。
 *
 * - **索引状态三态如实**（D4）：健康（MAX(indexed_at) + 绝对 title）/ 失败
 *   （consecutive_failures>0 → 警示态 + title 含 lastError）/ 无索引行（如实
 *   「尚未建立索引」）。零示意值——全部来自 search_index_state 实时查询面。
 * - **成员过滤（D26 延伸）**：状态位只聚合当前员工有权库的行——无权库的
 *   indexed_at 不抬高 lastIndexedAt、无权库的失败行不触发 failing、无权库的
 *   last_error 不出现在页面任何位置（侧信道零出现）。
 * - **视图开关**（D5）：view=list|grid（querystring，默认 list；grid 复用
 *   vault-card/vault-grid 既有 token 卡网格类）；切换链接纯 <a href>——零 JS。
 * - **可见性声明**：表尾固定位语义声明在位（两种视图都在）。
 * - 夹具沿用 web-browse-fixtures；search_index_state 行直插（生产由索引器写，
 *   本任务只读消费——写面零改动）。
 */

interface Harness {
  b: BrowseHarness;
  alice: number;
  bob: number;
  carol: number;
  alpha: number;
  bravo: number;
  gamma: number;
}

/** alpha（alice 编辑者，bob 读者）/ bravo（仅 carol——无权库侧信道对照）/ gamma（alice 读者） */
async function harness(): Promise<Harness> {
  const b = await browseHarness();
  const alice = addEmployee(b.db, { username: 'alice', display_name: '爱丽丝' });
  const bob = addEmployee(b.db, { username: 'bob' });
  const carol = addEmployee(b.db, { username: 'carol' });
  const alpha = await seededVault(b, 'alpha', alice, {
    'docs/guide.md': '---\ntitle: Guide\n---\n\nbody\n',
  });
  const bravo = await seededVault(b, 'bravo', carol, { 'docs/secret.md': 'secret\n' });
  const gamma = await seededVault(b, 'gamma', alice);
  addMember(b.db, alpha, alice, 'editor', alice);
  addMember(b.db, alpha, bob, 'reader', bob);
  addMember(b.db, bravo, carol, 'admin', carol); // fixture 的 addVault 不写成员行（生产建库者自动入库）——carol 权内对照需显式补
  addMember(b.db, gamma, alice, 'reader', alice);
  return { b, alice, bob, carol, alpha, bravo, gamma };
}

let seedSeq = 0;

/** 直插 search_index_state 一行（生产由索引器写；本任务只读消费，fixture 走直插） */
function seedIndexState(
  h: Harness,
  vaultId: number,
  f: { indexedAt: string; failures?: number; lastError?: string | null; lastErrorAt?: string | null },
): void {
  h.b.db
    .prepare(
      `INSERT INTO search_index_state
         (vault_id, branch, head_commit, triggered_by, triggered_at, indexed_at,
          duration_ms, lag_ms, updates, consecutive_failures, last_error, last_error_at)
       VALUES (?, 'main', NULL, 'vault.push', NULL, ?, 5, NULL, 1, ?, ?, ?)`,
    )
    .run(vaultId, f.indexedAt, f.failures ?? 0, f.lastError ?? null, f.lastErrorAt ?? null);
}

/** 铺一笔成功发布审计行（pending 预记录 → settle 终态；newCommit=库当前 head） */
async function seedPublishAtHead(h: Harness, employeeId: number, vaultId: number, occurredAt: string): Promise<string> {
  const head = (await gitOut(['--git-dir', repoPathOf(h.b, vaultId), 'rev-parse', 'refs/heads/main'])).trim();
  recordAuditEvent(h.b.db, {
    occurredAt,
    actorKind: 'employee',
    subject: { employeeId, carrierRef: `session:${employeeId}`, entry: 'git' },
    eventKind: 'vault.push',
    vaultId,
    refName: 'refs/heads/main',
    oldCommit: null,
    newCommit: head,
    status: 'pending',
    detail: { pushId: `status-${++seedSeq}` },
  });
  const id = Number((h.b.db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id);
  settleAuditEvent(h.b.db, id, 'succeeded');
  return head;
}

// ── indexStatus 查询面（三态 × 成员过滤） ───────────────────────────────────

test('indexStatus 健康态：lastIndexedAt=有权库 MAX(indexed_at)、failing=false、lastError=null', async () => {
  const h = await harness();
  try {
    seedIndexState(h, h.alpha, { indexedAt: '2026-10-15T01:00:00.000Z' });
    seedIndexState(h, h.gamma, { indexedAt: '2026-10-15T03:00:00.000Z' });
    assert.deepEqual(indexStatus(h.b.db, h.alice), {
      lastIndexedAt: '2026-10-15T03:00:00.000Z',
      failing: false,
      lastError: null,
    });
  } finally {
    await h.b.close();
  }
});

test('indexStatus 失败态：任一有权库 consecutive_failures>0 → failing=true 且 lastError=失败行摘要；健康行不掩盖失败', async () => {
  const h = await harness();
  try {
    seedIndexState(h, h.alpha, { indexedAt: '2026-10-15T01:00:00.000Z', failures: 2, lastError: '索引器异常：仓库不可读', lastErrorAt: '2026-10-15T01:00:00.000Z' });
    seedIndexState(h, h.gamma, { indexedAt: '2026-10-15T05:00:00.000Z' }); // 更新的健康行不掩盖失败
    assert.deepEqual(indexStatus(h.b.db, h.alice), {
      lastIndexedAt: '2026-10-15T05:00:00.000Z',
      failing: true,
      lastError: '索引器异常：仓库不可读',
    });
  } finally {
    await h.b.close();
  }
});

test('indexStatus 多失败行：lastError 取最近一次失败（last_error_at DESC）', async () => {
  const h = await harness();
  try {
    seedIndexState(h, h.alpha, { indexedAt: '2026-10-15T01:00:00.000Z', failures: 1, lastError: '旧错误', lastErrorAt: '2026-10-15T01:00:00.000Z' });
    seedIndexState(h, h.gamma, { indexedAt: '2026-10-15T02:00:00.000Z', failures: 3, lastError: '新错误', lastErrorAt: '2026-10-15T02:00:00.000Z' });
    const s = indexStatus(h.b.db, h.alice);
    assert.equal(s.failing, true);
    assert.equal(s.lastError, '新错误');
  } finally {
    await h.b.close();
  }
});

test('indexStatus 无索引行：三字段如实 null/false（有权库但无行 / 无任何库同形态，不虚构）', async () => {
  const h = await harness();
  try {
    assert.deepEqual(indexStatus(h.b.db, h.alice), { lastIndexedAt: null, failing: false, lastError: null }, '有权库但无状态行');
    const dave = addEmployee(h.b.db, { username: 'dave' });
    assert.deepEqual(indexStatus(h.b.db, dave), { lastIndexedAt: null, failing: false, lastError: null }, '无任何成员关系');
  } finally {
    await h.b.close();
  }
});

test('indexStatus 成员过滤（D26 延伸）：bob 的 lastIndexedAt 不受无权库行影响、failing 不被无权库失败行触发、无权库 lastError 零泄露', async () => {
  const h = await harness();
  try {
    seedIndexState(h, h.alpha, { indexedAt: '2026-10-15T01:00:00.000Z' }); // bob 有权（reader）
    seedIndexState(h, h.bravo, {
      indexedAt: '2026-10-15T09:00:00.000Z',
      failures: 4,
      lastError: 'bravo 索引崩溃：敏感路径详情',
      lastErrorAt: '2026-10-15T09:00:00.000Z',
    }); // bob 无权
    assert.deepEqual(indexStatus(h.b.db, h.bob), {
      lastIndexedAt: '2026-10-15T01:00:00.000Z',
      failing: false,
      lastError: null,
    }, '无权库的更新行与失败行都不进入 bob 的聚合');
    const carol = indexStatus(h.b.db, h.carol);
    assert.deepEqual(carol, {
      lastIndexedAt: '2026-10-15T09:00:00.000Z',
      failing: true,
      lastError: 'bravo 索引崩溃：敏感路径详情',
    }, '权内行为对照：carol 如实看到自己库的失败');
  } finally {
    await h.b.close();
  }
});

// ── 页面形态：状态位三态 / 视图开关 / 可见性声明 ────────────────────────────

interface StatusBit {
  cls: string;
  title: string | null;
  text: string;
}

function statusBit(body: string): StatusBit {
  const m = body.match(/<p class="index-status ([a-z-]+)"( title="([^"]*)")?>([^<]*)<\/p>/);
  assert.ok(m !== null, '页头索引状态位在位');
  return { cls: m[1] as string, title: m[3] ?? null, text: m[4] as string };
}

function docSectionOf(body: string): string {
  const start = body.indexOf('aria-label="跨库最近文档"');
  assert.ok(start > 0, '文档区块在位');
  const end = body.indexOf('aria-label="最近变更"', start);
  return body.slice(start, end);
}

async function seedOneDoc(h: Harness): Promise<void> {
  const head = await seedPublishAtHead(h, h.alice, h.alpha, '2026-10-15T01:00:00.000Z');
  // 派生索引行（生产由索引器写）：title/tags 的唯一数据源——网格卡卡题断言所需
  h.b.db
    .prepare(
      `INSERT INTO search_index (vault_id, path, commit_oid, title, tags, summary, body, indexed_at)
       VALUES (?, 'docs/guide.md', ?, 'Guide', '[]', '摘要片段', '', '2026-10-15T01:00:01.000Z')`,
    )
    .run(h.alpha, head);
}

test('状态位·健康态：相对时间文本 + 绝对时间 title（查询面原值，零示意值）', async () => {
  const h = await harness();
  try {
    seedIndexState(h, h.alpha, { indexedAt: '2026-10-15T01:00:00.000Z' });
    const res = await h.b.app.inject({ method: 'GET', url: '/', headers: h.b.session(h.alice) });
    assert.equal(res.statusCode, 200);
    const bit = statusBit(res.body);
    assert.equal(bit.cls, 'is-healthy');
    assert.equal(bit.title, '2026-10-15T01:00:00.000Z', 'title=查询面绝对时间');
    assert.ok(bit.text.startsWith('索引已更新 · '), `健康文本=「索引已更新 · 相对时间」（实得「${bit.text}」）`);
  } finally {
    await h.b.close();
  }
});

test('状态位·失败态：警示态类 + title 含 lastError 摘要（页面零自算，取查询面 lastError）', async () => {
  const h = await harness();
  try {
    seedIndexState(h, h.alpha, {
      indexedAt: '2026-10-15T01:00:00.000Z',
      failures: 2,
      lastError: '索引器异常：正文解码失败',
      lastErrorAt: '2026-10-15T01:00:00.000Z',
    });
    const res = await h.b.app.inject({ method: 'GET', url: '/', headers: h.b.session(h.alice) });
    assert.equal(res.statusCode, 200);
    const bit = statusBit(res.body);
    assert.equal(bit.cls, 'is-failing');
    assert.ok(bit.title !== null && bit.title.includes('索引器异常：正文解码失败'), `title 含 lastError 摘要（实得「${bit.title}」）`);
    assert.ok(bit.text.includes('失败'), '失败态文本如实（不粉饰为健康）');
  } finally {
    await h.b.close();
  }
});

test('状态位·无索引行：如实「尚未建立索引」（不虚构时间）', async () => {
  const h = await harness();
  try {
    const res = await h.b.app.inject({ method: 'GET', url: '/', headers: h.b.session(h.alice) });
    assert.equal(res.statusCode, 200);
    const bit = statusBit(res.body);
    assert.equal(bit.cls, 'is-empty');
    assert.equal(bit.text, '尚未建立索引');
    assert.equal(bit.title, null, '无行时无绝对时间 title');
  } finally {
    await h.b.close();
  }
});

test('状态位·bob 视角：无权库失败行不触发警示态、无权库 lastError 侧信道零出现', async () => {
  const h = await harness();
  try {
    seedIndexState(h, h.alpha, { indexedAt: '2026-10-15T01:00:00.000Z' });
    seedIndexState(h, h.bravo, {
      indexedAt: '2026-10-15T09:00:00.000Z',
      failures: 4,
      lastError: 'bravo 索引崩溃：敏感路径详情',
      lastErrorAt: '2026-10-15T09:00:00.000Z',
    });
    const res = await h.b.app.inject({ method: 'GET', url: '/', headers: h.b.session(h.bob) });
    assert.equal(res.statusCode, 200);
    const bit = statusBit(res.body);
    assert.equal(bit.cls, 'is-healthy', 'bob 的状态位只聚合其有权库');
    assert.equal(bit.title, '2026-10-15T01:00:00.000Z', 'lastIndexedAt 不被无权库行抬高');
    assert.ok(!res.body.includes('bravo'), '无权库 slug 零出现');
    assert.ok(!res.body.includes('bravo 索引崩溃'), '无权库 lastError 零泄露');
  } finally {
    await h.b.close();
  }
});

test('视图开关·默认 list：表格形态 + 切换链接纯 <a href>（零 JS、零存储写入）', async () => {
  const h = await harness();
  try {
    await seedOneDoc(h);
    const res = await h.b.app.inject({ method: 'GET', url: '/', headers: h.b.session(h.alice) });
    assert.equal(res.statusCode, 200);
    const section = docSectionOf(res.body);
    assert.ok(section.includes('class="table-wrap table-scroll"'), '默认 list=表格形态（S21-T1 起含横滚容器）');
    assert.ok(!section.includes('class="vault-grid"'), '默认态网格卡不渲染');
    assert.ok(section.includes('href="/?view=list"'), '切换链接=纯 <a href> 携带 query');
    assert.ok(section.includes('href="/?view=grid"'), '网格切换链接在位');
    assert.ok(section.includes('aria-current="page">列表</a>'), '当前态 aria-current 落在列表');
    assert.ok(!section.includes('<script'), '切换零脚本（零 JS 渐进增强）');
  } finally {
    await h.b.close();
  }
});

test('视图开关·view=grid：文档以 vault-card 网格卡呈现（复用既有 token 卡类），表格退场', async () => {
  const h = await harness();
  try {
    await seedOneDoc(h);
    const res = await h.b.app.inject({ method: 'GET', url: '/?view=grid', headers: h.b.session(h.alice) });
    assert.equal(res.statusCode, 200);
    const section = docSectionOf(res.body);
    assert.ok(section.includes('class="vault-grid"'), '网格容器=既有 vault-grid');
    assert.ok(section.includes('class="vault-card"'), '文档卡=既有 vault-card 形态');
    assert.ok(!section.includes('<table'), 'list 表格退场');
    assert.ok(section.includes(`href="${viewUrl('alpha', 'docs/guide.md')}"`), '网格卡链接与 viewUrl 同构');
    assert.ok(section.includes('>Guide</span>'), '卡题=title（title 命中时不以路径伪造；整卡为链接故标题在 span 内）');
    assert.ok(section.includes('aria-current="page">网格</a>'), '当前态 aria-current 落在网格');
    assert.ok(section.includes('href="/?view=list"'), '可切回 list（往返）');
  } finally {
    await h.b.close();
  }
});

test('视图开关·非法值回落 list：view=block 按默认 list 渲染（不做自由文本回显）', async () => {
  const h = await harness();
  try {
    await seedOneDoc(h);
    const res = await h.b.app.inject({ method: 'GET', url: '/?view=block', headers: h.b.session(h.alice) });
    assert.equal(res.statusCode, 200);
    const section = docSectionOf(res.body);
    assert.ok(section.includes('class="table-wrap table-scroll"'), '非法值=默认 list');
    assert.ok(section.includes('aria-current="page">列表</a>'), '当前态回落列表');
    assert.ok(!res.body.includes('block'), '非法参数值不回显');
  } finally {
    await h.b.close();
  }
});

test('可见性声明：表尾固定位语义声明在位（list 与 grid 两态都在，位于文档区块内）', async () => {
  const h = await harness();
  try {
    await seedOneDoc(h);
    const declaration = '呈现已发布知识；草稿仅创建者可见。搜索与列表遵循文库成员权限。';
    for (const url of ['/', '/?view=grid']) {
      const res = await h.b.app.inject({ method: 'GET', url, headers: h.b.session(h.alice) });
      assert.equal(res.statusCode, 200);
      const section = docSectionOf(res.body);
      assert.ok(section.includes(declaration), `声明在位（${url}）`);
      const body = res.body;
      const iDecl = body.indexOf(declaration);
      const iTable = body.indexOf('</table>');
      const iGrid = body.indexOf('class="vault-grid"');
      if (url === '/') {
        assert.ok(iDecl > iTable, 'list 态声明位于表尾');
      } else {
        assert.ok(iDecl > iGrid, 'grid 态声明位于网格之后');
      }
    }
  } finally {
    await h.b.close();
  }
});

test('安全形态：/ 与 /?view=grid 每页恰一内联 <script> 块（接线零新增脚本）', async () => {
  const h = await harness();
  try {
    await seedOneDoc(h);
    for (const url of ['/', '/?view=grid']) {
      const res = await h.b.app.inject({ method: 'GET', url, headers: h.b.session(h.alice) });
      assert.equal(res.statusCode, 200);
      assert.equal((res.body.match(/<script/g) ?? []).length, 1, `恰一内联 script（${url}）`);
    }
  } finally {
    await h.b.close();
  }
});
