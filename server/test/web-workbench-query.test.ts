import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { recordAuditEvent, settleAuditEvent } from '../src/audit/audit.ts';
import {
  browseHarness,
  seededVault,
  addEmployee,
  addMember,
  gitOut,
  repoPathOf,
  type BrowseHarness,
} from './web-browse-fixtures.ts';
import {
  workbenchSummary,
  vaultCards,
  recentDocuments,
  WORKBENCH_RECENT_DOC_LIMIT,
  type RecentDocumentRow,
} from '../src/web/workbench/query.ts';

/**
 * S14-T1 工作台查询面（DOD-E4-03/04、D25/D26）：
 *
 * - 成员过滤（D26 硬安全不变量）：三个能力全部实时 JOIN vault_members，与
 *   search/query.ts 同一判定面、无缓存——撤权（DELETE 行）下一次查询立即消失。
 * - 排序键（D25）：只能是服务端审计时间 occurred_at；git 提交者时间是客户端可填
 *   元数据（DOD-03），本文件的「排序不消费 git 时间」用例以反向 git 时间锁定。
 * - 路径派生（D25）：审计 detail 不写路径，路径必须从事件 new_commit 经
 *   `git log --name-only -z` 派生——「路径派生」用例逐条比对 git 实际触及路径。
 *
 * 夹具沿用 web-browse-fixtures（newDb 等价夹具 + 真实 bare 仓库 + git CLI 种子
 * 提交）；审计行经生产写面落库（recordAuditEvent + settleAuditEvent），与
 * activity/home 测试同一形状，不走旁路 INSERT。
 */

let seedSeq = 0;

/** 40 位 hex OID 占位（未被 git 解析的伪 OID 用于「解析失败」降级用例） */
function fakeOid(prefix: string): string {
  return prefix.repeat(40).slice(0, 40);
}

interface Harness {
  h: BrowseHarness;
  alice: number;
  bob: number;
  carol: number;
}

/** 建两个库：alpha（alice 有权）+ bravo（alice 无权，仅 carol），各自带种子提交 */
async function harness(): Promise<Harness> {
  const h = await browseHarness();
  const alice = addEmployee(h.db, { username: 'alice' });
  const bob = addEmployee(h.db, { username: 'bob' });
  const carol = addEmployee(h.db, { username: 'carol' });
  const alpha = await seededVault(h, 'alpha', alice, {
    'README.md': '# alpha\n',
    'docs/guide.md': '---\ntitle: Guide\ntags:\n  - howto\n---\n\nbody\n',
  });
  const bravo = await seededVault(h, 'bravo', carol, {
    'README.md': '# bravo\n',
    'docs/secret.md': '---\ntitle: Secret\ntags: []\n---\n\nsecret body\n',
  });
  addMember(h.db, alpha, alice, 'editor', alice);
  addMember(h.db, alpha, bob, 'reader', alice);
  addMember(h.db, bravo, carol, 'editor', carol);
  return { h, alice, bob, carol };
}

async function headOid(h: BrowseHarness, vaultId: number): Promise<string> {
  return (await gitOut(['--git-dir', repoPathOf(h, vaultId), 'rev-parse', 'refs/heads/main'])).trim();
}

/** 按生产形状落一笔发布审计行（pending 预记录 → 终态；status='pending' = 在途不结算） */
function seedPublish(
  db: DatabaseSync,
  input: {
    employeeId: number;
    vaultId: number;
    kind?: 'vault.push' | 'vault.web_submit';
    occurredAt: string;
    newCommit: string | null;
    status?: 'succeeded' | 'rejected' | 'pending';
    detail?: Record<string, unknown>;
  },
): number {
  recordAuditEvent(db, {
    occurredAt: input.occurredAt,
    actorKind: 'employee',
    subject: {
      employeeId: input.employeeId,
      carrierRef: `session:${input.employeeId}`,
      entry: input.kind === 'vault.web_submit' ? 'web' : 'git',
    },
    eventKind: input.kind ?? 'vault.push',
    vaultId: input.vaultId,
    refName: 'refs/heads/main',
    oldCommit: null,
    newCommit: input.newCommit,
    status: 'pending',
    detail: input.detail ?? { pushId: `seed-${++seedSeq}` },
  });
  const id = Number((db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id);
  if (input.status !== 'pending') settleAuditEvent(db, id, input.status ?? 'succeeded');
  return id;
}

/** 铺派生索引行（docCount/title/tags 的唯一数据源；生产由 indexer 写） */
function indexDocs(
  db: DatabaseSync,
  vaultId: number,
  commitOid: string,
  docs: readonly { path: string; title: string | null; tags: readonly string[]; summary?: string }[],
): void {
  const ins = db.prepare(
    `INSERT INTO search_index (vault_id, path, commit_oid, title, tags, summary, body, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, '', ?)`,
  );
  for (const d of docs) {
    ins.run(vaultId, d.path, commitOid, d.title, JSON.stringify(d.tags), d.summary ?? '摘要片段', '2026-10-15T00:00:00.000Z');
  }
}

/** 以指定作者与作者时间追加一笔提交（clone→写→commit --date→push 快进） */
async function commitAs(
  h: BrowseHarness,
  vaultId: number,
  author: string,
  date: Date,
  files: Record<string, string>,
): Promise<string> {
  const work = path.join(h.dataDir, `wb-${vaultId}-${++seedSeq}`);
  await gitOut(['clone', repoPathOf(h, vaultId), work]);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(work, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
  }
  await gitOut(['-C', work, 'add', '.']);
  await gitOut([
    '-C', work,
    '-c', `user.name=${author}`,
    '-c', `user.email=${author}@notegit.test`,
    'commit', `--date=${date.toISOString()}`, '-m', `by ${author}`,
  ]);
  await gitOut(['-C', work, 'push', 'origin', 'HEAD:refs/heads/main']);
  const oid = (await gitOut(['-C', work, 'rev-parse', 'HEAD'])).trim();
  await rm(work, { recursive: true, force: true });
  return oid;
}

async function queryRecent(
  h: BrowseHarness,
  employeeId: number,
  limit: number,
): Promise<RecentDocumentRow[]> {
  return recentDocuments(h.db, employeeId, limit, { dataDir: h.dataDir });
}

// ── 成员过滤（D26 / DOD-E4-03 聚合面侧信道） ────────────────────────────────

test('成员过滤：无权库不出现在 vaultCards、不出现在 recentDocuments、其文档数不计入 publishedDocCount', async () => {
  const { h, alice } = await harness();
  try {
    const alphaId = Number(
      (h.db.prepare(`SELECT id FROM vaults WHERE slug = 'alpha'`).get() as { id: number }).id,
    );
    const bravoId = Number(
      (h.db.prepare(`SELECT id FROM vaults WHERE slug = 'bravo'`).get() as { id: number }).id,
    );
    const alphaHead = await headOid(h, alphaId);
    const bravoHead = await headOid(h, bravoId);
    // 两个库都有内容：若过滤失效，数字与卡片立刻可区分
    indexDocs(h.db, alphaId, alphaHead, [
      { path: 'README.md', title: null, tags: [] },
      { path: 'docs/guide.md', title: 'Guide', tags: ['howto'] },
    ]);
    indexDocs(h.db, bravoId, bravoHead, [
      { path: 'README.md', title: null, tags: [] },
      { path: 'docs/secret.md', title: 'Secret', tags: [] },
    ]);
    seedPublish(h.db, { employeeId: alice, vaultId: alphaId, occurredAt: '2026-10-15T01:00:00.000Z', newCommit: alphaHead });
    seedPublish(h.db, {
      employeeId: Number((h.db.prepare(`SELECT id FROM employees WHERE username='carol'`).get() as { id: number }).id),
      vaultId: bravoId,
      occurredAt: '2026-10-15T02:00:00.000Z',
      newCommit: bravoHead,
    });

    const summary = workbenchSummary(h.db, alice);
    assert.equal(summary.vaultCount, 1, '无权库不计入可访问库数');
    assert.equal(summary.publishedDocCount, 2, '无权库的文档数绝不计入已发布文档总数');

    const cards = vaultCards(h.db, alice);
    assert.deepEqual(cards.map((c) => c.slug), ['alpha'], '无权库卡片不出现');
    assert.equal(cards[0].docCount, 2);
    assert.equal(cards[0].role, 'editor');

    const rows = await queryRecent(h, alice, 20);
    assert.ok(rows.length > 0);
    assert.ok(
      rows.every((r) => r.vaultSlug === 'alpha'),
      '无权库的路径级文档行零出现',
    );
    assert.ok(
      !rows.some((r) => r.path.includes('secret')),
      '无权库路径零出现',
    );

    // 同源自洽：概览文档总数 === 各卡片 docCount 之和（同一过滤面，无差值泄露）
    assert.equal(
      summary.publishedDocCount,
      cards.reduce((n, c) => n + c.docCount, 0),
      '统计与卡片同源同过滤',
    );
  } finally {
    await h.close();
  }
});

test('撤权即时性：删除 vault_members 行后下一次查询立即消失（无缓存）', async () => {
  const { h, alice, bob } = await harness();
  try {
    const alphaId = Number(
      (h.db.prepare(`SELECT id FROM vaults WHERE slug = 'alpha'`).get() as { id: number }).id,
    );
    const head = await headOid(h, alphaId);
    indexDocs(h.db, alphaId, head, [{ path: 'README.md', title: null, tags: [] }]);
    seedPublish(h.db, { employeeId: alice, vaultId: alphaId, occurredAt: '2026-10-15T01:00:00.000Z', newCommit: head });

    assert.equal(workbenchSummary(h.db, bob).vaultCount, 1);
    assert.equal(vaultCards(h.db, bob).length, 1);
    assert.ok((await queryRecent(h, bob, 20)).length > 0);

    // 撤权 = DELETE 行（与 search/query.ts 同一撤权形态）
    h.db.prepare('DELETE FROM vault_members WHERE vault_id = ? AND employee_id = ?').run(alphaId, bob);

    assert.equal(workbenchSummary(h.db, bob).vaultCount, 0);
    assert.equal(workbenchSummary(h.db, bob).publishedDocCount, 0);
    assert.equal(workbenchSummary(h.db, bob).lastContentUpdateAt, null);
    assert.deepEqual(vaultCards(h.db, bob), []);
    assert.deepEqual(await queryRecent(h, bob, 20), []);
  } finally {
    await h.close();
  }
});

// ── 路径派生（D25：路径从事件 new_commit 的 git 触及路径派生） ────────────────

test('路径派生：审计事件的 new_commit 所触及路径正确出现在结果行（逐条对照 git）', async () => {
  const { h, alice } = await harness();
  try {
    const alphaId = Number(
      (h.db.prepare(`SELECT id FROM vaults WHERE slug = 'alpha'`).get() as { id: number }).id,
    );
    // 第二笔提交触及 README.md 与新文件 docs/new.md（README 为修改）
    const second = await commitAs(h, alphaId, 'bob', new Date('2026-10-10T00:00:00Z'), {
      'README.md': '# alpha v2\n',
      'docs/new.md': '---\ntitle: New\ntags:\n  - fresh\n---\n\nnew body\n',
    });
    indexDocs(h.db, alphaId, second, [
      { path: 'README.md', title: null, tags: [] },
      { path: 'docs/guide.md', title: 'Guide', tags: ['howto'] },
      { path: 'docs/new.md', title: 'New', tags: ['fresh'] },
    ]);
    seedPublish(h.db, { employeeId: alice, vaultId: alphaId, occurredAt: '2026-10-15T03:00:00.000Z', newCommit: second });

    // 对照：git 实际触及路径（不经生产读面的直通 git）
    const touched = (
      await gitOut([
        '--git-dir', repoPathOf(h, alphaId),
        'log', '--no-walk', '-1', '-z', '--name-only', '--diff-filter=d', '--format=', second,
      ])
    )
      .split('\0')
      .map((s) => s.replace(/^\n/, '').trim())
      .filter((s) => s !== '');
    assert.deepEqual(touched.sort(), ['README.md', 'docs/new.md']);

    const rows = await queryRecent(h, alice, 20);
    assert.deepEqual(rows.map((r) => r.path).sort(), ['README.md', 'docs/new.md']);

    // 维护者/提交者时间来自 git（%an / %aI），且是这次提交的实际值
    for (const r of rows) {
      assert.equal(r.commitOid, second);
      assert.equal(r.author, 'bob');
      assert.equal(r.authorIso, '2026-10-10T00:00:00Z');
      assert.equal(r.occurredAt, '2026-10-15T03:00:00.000Z', '排序/呈现时间取服务端审计时间');
    }
    // title/tags 来自派生索引（索引未命中时如实降级，不伪造）
    const byPath = new Map(rows.map((r) => [r.path, r]));
    assert.equal(byPath.get('docs/new.md')?.title, 'New');
    assert.deepEqual(byPath.get('docs/new.md')?.tags, ['fresh']);
    assert.equal(byPath.get('README.md')?.title, null, '无 frontmatter title 如实为 null，不用文件名伪造');
    assert.deepEqual(byPath.get('README.md')?.tags, []);

  } finally {
    await h.close();
  }
});

// ── 排序（D25）与 limit 边界 ───────────────────────────────────────────────

test('排序：以服务端审计时间新→旧（git 提交时间反向，排序不消费 git 时间）；limit 边界', async () => {
  const { h, alice } = await harness();
  try {
    const alphaId = Number(
      (h.db.prepare(`SELECT id FROM vaults WHERE slug = 'alpha'`).get() as { id: number }).id,
    );
    const c1 = await commitAs(h, alphaId, 'alice', new Date('2026-10-01T00:00:00Z'), { 'docs/a.md': 'a1\n' });
    const c2 = await commitAs(h, alphaId, 'bob', new Date('2026-10-14T00:00:00Z'), { 'docs/b.md': 'b1\n' });
    const c3 = await commitAs(h, alphaId, 'carol', new Date('2026-10-07T00:00:00Z'), { 'docs/c.md': 'c1\n' });
    // 审计时间序 c1 < c3 < c2，与 git 作者时间序完全逆序
    seedPublish(h.db, { employeeId: alice, vaultId: alphaId, occurredAt: '2026-10-15T01:00:00.000Z', newCommit: c1 });
    seedPublish(h.db, { employeeId: alice, vaultId: alphaId, occurredAt: '2026-10-15T02:00:00.000Z', newCommit: c3 });
    seedPublish(h.db, { employeeId: alice, vaultId: alphaId, occurredAt: '2026-10-15T03:00:00.000Z', newCommit: c2 });

    const rows = await queryRecent(h, alice, 20);
    assert.deepEqual(
      rows.map((r) => [r.path, r.occurredAt]),
      [
        ['docs/b.md', '2026-10-15T03:00:00.000Z'],
        ['docs/c.md', '2026-10-15T02:00:00.000Z'],
        ['docs/a.md', '2026-10-15T01:00:00.000Z'],
      ],
      '排序键是服务端审计时间 occurred_at，非 git 提交者时间',
    );

    // limit 边界：截断到请求条数，不静默超出；0 与负值如实返回空
    assert.equal((await queryRecent(h, alice, 2)).length, 2);
    assert.deepEqual((await queryRecent(h, alice, 1)).map((r) => r.path), ['docs/b.md']);
    assert.deepEqual(await queryRecent(h, alice, 0), []);
    assert.deepEqual(await queryRecent(h, alice, -5), []);
    assert.ok(WORKBENCH_RECENT_DOC_LIMIT > 0);
  } finally {
    await h.close();
  }
});

test('排序：只取成功终态发布事件（pending / rejected 不进流）', async () => {
  const { h, alice } = await harness();
  try {
    const alphaId = Number(
      (h.db.prepare(`SELECT id FROM vaults WHERE slug = 'alpha'`).get() as { id: number }).id,
    );
    const ok = await commitAs(h, alphaId, 'alice', new Date('2026-10-01T00:00:00Z'), { 'docs/ok.md': 'ok\n' });
    const rejected = await commitAs(h, alphaId, 'alice', new Date('2026-10-02T00:00:00Z'), { 'docs/bad.md': 'bad\n' });
    const pending = await commitAs(h, alphaId, 'alice', new Date('2026-10-03T00:00:00Z'), { 'docs/wip.md': 'wip\n' });
    seedPublish(h.db, { employeeId: alice, vaultId: alphaId, occurredAt: '2026-10-15T01:00:00.000Z', newCommit: ok });
    seedPublish(h.db, {
      employeeId: alice, vaultId: alphaId, occurredAt: '2026-10-15T02:00:00.000Z', newCommit: rejected, status: 'rejected',
    });
    seedPublish(h.db, {
      employeeId: alice, vaultId: alphaId, occurredAt: '2026-10-15T03:00:00.000Z', newCommit: pending, status: 'pending',
    });

    const rows = await queryRecent(h, alice, 20);
    assert.deepEqual(rows.map((r) => r.path), ['docs/ok.md']);
  } finally {
    await h.close();
  }
});

// ── 空态与降级 ─────────────────────────────────────────────────────────────

test('空态：无可访问库 / 无发布事件 / 未初始化或无提交的库——如实降级不崩', async () => {
  const { h, alice } = await harness();
  try {
    // 全新员工：零个成员库
    const dave = addEmployee(h.db, { username: 'dave' });
    const emptySummary = workbenchSummary(h.db, dave);
    assert.deepEqual(emptySummary, { vaultCount: 0, publishedDocCount: 0, lastContentUpdateAt: null });
    assert.deepEqual(vaultCards(h.db, dave), []);
    assert.deepEqual(await queryRecent(h, dave, 20), []);

    // 未初始化的库（bare init 但尚无提交）：有成员关系、无 git 提交
    const emptyVault = await seededVault(h, 'empty', alice); // 无 files → unborn 分支
    addMember(h.db, emptyVault, alice, 'reader', alice);
    const s2 = workbenchSummary(h.db, alice);
    assert.ok(s2.vaultCount >= 2, '未初始化的库仍是可访问库');
    const cards = vaultCards(h.db, alice);
    const emptyCard = cards.find((c) => c.slug === 'empty');
    assert.ok(emptyCard !== undefined, '未初始化的库有卡片');
    assert.equal(emptyCard?.docCount, 0);
    assert.equal(emptyCard?.lastCommitAt, null, '无提交时最后提交时间为 null，不虚构');
    // 无发布事件 → 汇总时间与文档流为空
    assert.deepEqual(await queryRecent(h, alice, 20), []);
    assert.equal(workbenchSummary(h.db, alice).lastContentUpdateAt, null);
  } finally {
    await h.close();
  }
});

test('降级：畸形 audit detail 如实不崩（D25——detail 不写路径，路径只从 git 派生）', async () => {
  const { h, alice } = await harness();
  try {
    const alphaId = Number(
      (h.db.prepare(`SELECT id FROM vaults WHERE slug = 'alpha'`).get() as { id: number }).id,
    );
    const c = await commitAs(h, alphaId, 'alice', new Date('2026-10-01T00:00:00Z'), { 'docs/x.md': 'x\n' });
    const id = seedPublish(h.db, {
      employeeId: alice, vaultId: alphaId, occurredAt: '2026-10-15T01:00:00.000Z', newCommit: c,
    });
    // 畸形 detail 直改行（原样落库的非 JSON 文本——本查询面不解析 detail，故路径不受影响）
    h.db.prepare('UPDATE audit_events SET detail = ? WHERE id = ?').run('{not-json', id);

    const rows = await queryRecent(h, alice, 20);
    assert.deepEqual(rows.map((r) => r.path), ['docs/x.md'], '路径仍从 new_commit 派生，畸形 detail 不影响');
  } finally {
    await h.close();
  }
});

test('降级：new_commit 为 NULL 的事件跳过不崩', async () => {
  const { h, alice } = await harness();
  try {
    const alphaId = Number(
      (h.db.prepare(`SELECT id FROM vaults WHERE slug = 'alpha'`).get() as { id: number }).id,
    );
    const good = await commitAs(h, alphaId, 'alice', new Date('2026-10-01T00:00:00Z'), { 'docs/g.md': 'g\n' });
    const id = seedPublish(h.db, {
      employeeId: alice, vaultId: alphaId, occurredAt: '2026-10-15T05:00:00.000Z', newCommit: good,
    });
    h.db.prepare('UPDATE audit_events SET new_commit = NULL WHERE id = ?').run(id);

    const rows = await queryRecent(h, alice, 20);
    assert.deepEqual(rows, []);
  } finally {
    await h.close();
  }
});

test('降级：new_commit 解析不到（伪 OID / 仓库缺失）如实跳过该事件，不崩不虚构', async () => {
  const { h, alice } = await harness();
  try {
    const alphaId = Number(
      (h.db.prepare(`SELECT id FROM vaults WHERE slug = 'alpha'`).get() as { id: number }).id,
    );
    const good = await commitAs(h, alphaId, 'alice', new Date('2026-10-01T00:00:00Z'), { 'docs/good.md': 'good\n' });
    // 最新一条事件的 new_commit 是伪 OID：解析失败 → 该事件零行，后续事件不受影响
    seedPublish(h.db, { employeeId: alice, vaultId: alphaId, occurredAt: '2026-10-15T05:00:00.000Z', newCommit: fakeOid('f') });
    seedPublish(h.db, { employeeId: alice, vaultId: alphaId, occurredAt: '2026-10-15T01:00:00.000Z', newCommit: good });

    const rows = await queryRecent(h, alice, 20);
    assert.deepEqual(rows.map((r) => r.path), ['docs/good.md']);
  } finally {
    await h.close();
  }
});

test('成员过滤：vaultCards 的 role 取自 vault_members 实时行（无角色缓存）', async () => {
  const { h, bob } = await harness();
  try {
    const alphaId = Number(
      (h.db.prepare(`SELECT id FROM vaults WHERE slug = 'alpha'`).get() as { id: number }).id,
    );
    assert.equal(vaultCards(h.db, bob)[0].role, 'reader');
    h.db.prepare('UPDATE vault_members SET role = ? WHERE vault_id = ? AND employee_id = ?').run('editor', alphaId, bob);
    assert.equal(vaultCards(h.db, bob)[0].role, 'editor', '角色变更下一次查询即生效');
  } finally {
    await h.close();
  }
});
