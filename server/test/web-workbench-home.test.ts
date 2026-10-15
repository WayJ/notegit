import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
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
import { workbenchSummary, vaultCards } from '../src/web/workbench/query.ts';
import { viewUrl } from '../src/web/browse/pages.ts';

/**
 * S14-T3 工作台首页（DOD-E4-02/04/07 份额）：`/` 原地升级为跨库聚合工作台。
 *
 * - **统计与卡片零自算**（D26）：页面数字必须与 `workbench/query.ts` 三能力
 *   （workbenchSummary / vaultCards / recentDocuments）一致——本文件直接调用
 *   同一查询面对照页面呈现，锁定「indexPage 只渲染」的边界。
 * - **维护者列如实标注**（DOD-03/D25）：渲染处必须带说明性 title 或脚注
 *   「Git 提交者元数据，非认证身份」。
 * - **view 链接与 browse viewUrl 同构**：逐段 encodeURIComponent（含中文与
 *   空格路径可安全往返）。
 * - **入口卡移除零缺失**：原三张 feature-card 入口卡由侧栏（credentials/admin）
 *   与「全部文库」聚合卡（/vaults，Q-E4-1）承接，导航可达性零回归。
 * - **reader 视角零写入口**（bob 场景）；未认证 302 /login 不变；每页恰一
 *   内联 <script> 块规则不破。
 *
 * 夹具沿用 web-browse-fixtures（真实 bare 仓库 + git CLI 种子提交 + dataDir
 * 注入——recentDocuments 从事件 new_commit 经 git 派生路径需要真实仓库）；
 * 审计行经生产写面落库（recordAuditEvent + settleAuditEvent）。
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

/** alpha（alice 编辑者，3 文档）/ bravo（alice 无权，仅 carol）/ gamma（alice 读者，无提交） */
async function harness(): Promise<Harness> {
  const b = await browseHarness();
  const alice = addEmployee(b.db, { username: 'alice', display_name: '爱丽丝' });
  const bob = addEmployee(b.db, { username: 'bob' });
  const carol = addEmployee(b.db, { username: 'carol' });
  const alpha = await seededVault(b, 'alpha', alice, {
    'README.md': '# alpha\n',
    'docs/guide.md': '---\ntitle: Guide\ntags:\n  - howto\n---\n\nbody\n',
    'docs/指南 文档.md': '---\ntitle: 指南\ntags: []\n---\n\n中文正文\n',
  });
  const bravo = await seededVault(b, 'bravo', carol, { 'docs/secret.md': 'secret\n' });
  const gamma = await seededVault(b, 'gamma', alice); // 无提交（unborn 分支）
  addMember(b.db, alpha, alice, 'editor', alice);
  addMember(b.db, alpha, bob, 'reader', bob);
  addMember(b.db, gamma, alice, 'reader', alice);
  return { b, alice, bob, carol, alpha, bravo, gamma };
}

async function headOid(h: Harness, vaultId: number): Promise<string> {
  return (await gitOut(['--git-dir', repoPathOf(h.b, vaultId), 'rev-parse', 'refs/heads/main'])).trim();
}

/** 以指定作者与作者时间追加一笔提交（clone→写→commit→push 快进） */
async function commitAs(
  h: Harness,
  vaultId: number,
  author: string,
  date: Date,
  files: Record<string, string>,
): Promise<string> {
  const work = path.join(h.b.dataDir, `wbh-${vaultId}-${author}-${date.getTime()}`);
  await gitOut(['clone', repoPathOf(h.b, vaultId), work]);
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

let seedSeq = 0;

/** 按生产形状落一笔成功发布审计行（pending 预记录 → settle 终态） */
function seedPublish(
  h: Harness,
  input: { employeeId: number; vaultId: number; occurredAt: string; newCommit: string },
): void {
  recordAuditEvent(h.b.db, {
    occurredAt: input.occurredAt,
    actorKind: 'employee',
    subject: { employeeId: input.employeeId, carrierRef: `session:${input.employeeId}`, entry: 'git' },
    eventKind: 'vault.push',
    vaultId: input.vaultId,
    refName: 'refs/heads/main',
    oldCommit: null,
    newCommit: input.newCommit,
    status: 'pending',
    detail: { pushId: `seed-${++seedSeq}` },
  });
  const id = Number((h.b.db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id);
  settleAuditEvent(h.b.db, id, 'succeeded');
}

/** 铺派生索引行（title/tags 的唯一数据源；生产由 indexer 写） */
function indexDocs(
  h: Harness,
  vaultId: number,
  commitOid: string,
  docs: readonly { path: string; title: string | null; tags: readonly string[] }[],
): void {
  const ins = h.b.db.prepare(
    `INSERT INTO search_index (vault_id, path, commit_oid, title, tags, summary, body, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, '', ?)`,
  );
  for (const d of docs) {
    ins.run(vaultId, d.path, commitOid, d.title, JSON.stringify(d.tags), '摘要片段', '2026-10-15T00:00:00.000Z');
  }
}

// ── 页面提取器（data 属性/结构化标记——不硬编码整页 HTML） ──────────────────

interface StatCell {
  value: string;
  title: string | null;
  label: string;
}

function statCards(body: string): StatCell[] {
  const out: StatCell[] = [];
  const re = /<div class="stat-card"><span class="stat-value"( title="([^"]*)")?>([^<]*)<\/span><span class="stat-label">([^<]*)<\/span><\/div>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) out.push({ title: m[2] ?? null, value: m[3] as string, label: m[4] as string });
  return out;
}

interface DocRowCell {
  vault: string;
  docPath: string;
  commit: string;
}

function docRows(body: string): DocRowCell[] {
  const out: DocRowCell[] = [];
  const re = /<tr data-vault="([^"]*)" data-path="([^"]*)" data-commit="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) out.push({ vault: m[1] as string, docPath: m[2] as string, commit: m[3] as string });
  return out;
}

function vaultCardHrefs(body: string): string[] {
  return [...body.matchAll(/<a class="vault-card[^"]*" href="([^"]+)"/g)].map((m) => m[1] as string);
}

function sideNavBlock(body: string): string {
  const start = body.indexOf('class="side-nav"');
  assert.ok(start > 0, '侧栏在位');
  return body.slice(start, body.indexOf('</nav>', start));
}

/** 主场景种子：alpha 索引 3 文档 + 一笔成功发布（2026-10-15T01:00:00.000Z） */
async function seedAlphaPublished(h: Harness): Promise<string> {
  const head = await headOid(h, h.alpha);
  indexDocs(h, h.alpha, head, [
    { path: 'README.md', title: null, tags: [] },
    { path: 'docs/guide.md', title: 'Guide', tags: ['howto'] },
    { path: 'docs/指南 文档.md', title: '指南', tags: [] },
  ]);
  seedPublish(h, { employeeId: h.alice, vaultId: h.alpha, occurredAt: '2026-10-15T01:00:00.000Z', newCommit: head });
  return head;
}

// ── 概览三卡（零自算：与 workbenchSummary 同源对照） ────────────────────────

test('概览三卡：数值与 workbenchSummary 一致（可访问文库/已发布文档 N 篇/最近更新含绝对时间 title）；无权库零出现', async () => {
  const h = await harness();
  try {
    await seedAlphaPublished(h);
    const res = await h.b.app.inject({ method: 'GET', url: '/', headers: h.b.session(h.alice) });
    assert.equal(res.statusCode, 200);

    const stats = statCards(res.body);
    assert.deepEqual(stats.map((s) => s.label), ['可访问文库', '已发布文档', '最近一次内容更新']);
    const summary = workbenchSummary(h.b.db, h.alice); // 同一查询面——页面数字必须与它一致
    assert.equal(stats[0]?.value, String(summary.vaultCount), '可访问文库=查询面 vaultCount');
    assert.equal(stats[1]?.value, `${summary.publishedDocCount} 篇`, '已发布文档=查询面 publishedDocCount（篇）');
    assert.equal(stats[2]?.title, summary.lastContentUpdateAt, '最近更新卡 title=绝对时间（查询面原值）');
    assert.ok(stats[2] !== undefined && stats[2].value.length > 0 && stats[2].value !== '暂无', '有发布事件时相对时间非空且非「暂无」');

    // 聚合面侧信道（D26 页面形态）：alice 无权 bravo——任何数字与文案不得提及
    assert.ok(!res.body.includes('bravo'), '无权库 slug 零出现');
    assert.ok(!res.body.includes('secret'), '无权库文档零出现');
  } finally {
    await h.b.close();
  }
});

// ── 我的文库卡片网格（与 vaultCards 同源对照；含全部文库聚合卡） ─────────────

test('库卡网格：首张「全部文库」聚合卡（href=/vaults），其余每库一卡与 vaultCards 一致（角色徽章/N 篇/最后更新；无提交库如实「暂无发布」）', async () => {
  const h = await harness();
  try {
    await seedAlphaPublished(h);
    const res = await h.b.app.inject({ method: 'GET', url: '/', headers: h.b.session(h.alice) });
    assert.equal(res.statusCode, 200);

    const hrefs = vaultCardHrefs(res.body);
    assert.equal(hrefs[0], '/vaults', '首张=全部文库聚合卡（Q-E4-1：跳 /vaults）');
    assert.deepEqual(hrefs.slice(1), ['/vaults/alpha/browse', '/vaults/gamma/browse'], '其余每库一卡（slug 序）');

    const summary = workbenchSummary(h.b.db, h.alice);
    assert.ok(res.body.includes('全部文库'), '聚合卡名');
    assert.ok(res.body.includes(`${summary.vaultCount} 个文库 · 你有权访问`), '聚合卡计数=查询面 vaultCount');

    const cards = vaultCards(h.b.db, h.alice); // 同一查询面
    assert.equal(cards.length, 2);
    const alphaCard = cards.find((c) => c.slug === 'alpha');
    assert.ok(alphaCard !== undefined);
    assert.ok(res.body.includes('<span class="badge">编辑者</span>'), 'alpha 角色徽章（editor→编辑者）');
    assert.ok(res.body.includes(`${alphaCard.docCount} 篇`), 'alpha 卡 N 篇=查询面 docCount');
    assert.ok(res.body.includes(`title="${alphaCard.lastCommitAt as string}"`), 'alpha 卡最后更新 title=绝对时间');

    const gammaCard = cards.find((c) => c.slug === 'gamma');
    assert.ok(gammaCard !== undefined);
    assert.ok(res.body.includes('<span class="badge">读者</span>'), 'gamma 角色徽章（reader→读者）');
    assert.ok(res.body.includes('暂无发布'), '无提交库如实「暂无发布」，不虚构时间');
    assert.ok(!res.body.includes('href="/vaults/bravo'), '无权库卡片零出现');
  } finally {
    await h.b.close();
  }
});

// ── 跨库最近文档表（viewUrl 同构 + 列结构 + 标签 chips） ────────────────────

test('文档表：行按审计时间新→旧；view 链接与 viewUrl 同构（中文与空格路径逐段编码）；标签 chips 与所属库链接在位', async () => {
  const h = await harness();
  try {
    const head = await seedAlphaPublished(h);
    const second = await commitAs(h, h.alpha, 'alice', new Date('2026-10-14T00:00:00Z'), {
      'docs/new.md': '---\ntitle: New\ntags:\n  - fresh\n---\n\nnew\n',
    });
    indexDocs(h, h.alpha, second, [{ path: 'docs/new.md', title: 'New', tags: ['fresh'] }]);
    seedPublish(h, { employeeId: h.alice, vaultId: h.alpha, occurredAt: '2026-10-15T02:00:00.000Z', newCommit: second });

    const res = await h.b.app.inject({ method: 'GET', url: '/', headers: h.b.session(h.alice) });
    assert.equal(res.statusCode, 200);

    const rows = docRows(res.body);
    assert.equal(rows[0]?.docPath, 'docs/new.md', '最新发布事件在前（审计时间排序）');
    assert.deepEqual(
      rows.map((r) => `${r.vault} ${r.docPath}`).sort(),
      ['alpha README.md', 'alpha docs/guide.md', 'alpha docs/new.md', 'alpha docs/指南 文档.md'],
      '路径集=发布事件 git 触及路径（ bravo 零出现）',
    );
    for (const r of rows) {
      assert.ok(
        res.body.includes(`href="${viewUrl(r.vault, r.docPath)}"`),
        `view 链接与 viewUrl 同构：${r.docPath}`,
      );
      assert.equal(r.commit.length, 40, '行携带 commit 锚点');
    }
    // 中文 + 空格路径逐段编码（encodeURIComponent 同构的直接证据）
    assert.ok(res.body.includes(`href="${viewUrl('alpha', 'docs/指南 文档.md')}"`), '中文与空格路径安全往返');

    assert.ok(res.body.includes('>Guide</a>'), 'title 命中时链接文本=title');
    assert.ok(res.body.includes('<span class="doc-row-path">docs/guide.md</span>'), '路径随行呈现');
    assert.ok(res.body.includes('<span class="badge">howto</span>'), '标签 chips（badge-pill 语义）');
    assert.ok(res.body.includes('href="/vaults/alpha">alpha</a>'), '所属库列链接库页');

    // 列优先级类（T2 断点约定承接：≤1020px 收维护者；≤680px 仅存文档列）
    assert.ok(res.body.includes('<th>文档</th>'), '首列=文档');
    assert.ok(res.body.includes('<th class="col-tertiary">所属库</th>'), '所属库列=col-tertiary');
    assert.ok(res.body.includes('<th class="col-secondary">维护者</th>'), '维护者列=col-secondary');
    assert.ok(res.body.includes('<th class="col-tertiary">更新时间</th>'), '更新时间列=col-tertiary');
  } finally {
    await h.b.close();
  }
});

test('维护者列如实标注（DOD-03/D25）：单元格 title + 区块脚注注明「Git 提交者元数据，非认证身份」；更新时间 title=审计绝对时间', async () => {
  const h = await harness();
  try {
    const head = await seedAlphaPublished(h);
    const second = await commitAs(h, h.alpha, '元数据可填者', new Date('2026-10-14T00:00:00Z'), {
      'docs/new.md': 'new\n',
    });
    seedPublish(h, { employeeId: h.alice, vaultId: h.alpha, occurredAt: '2026-10-15T02:00:00.000Z', newCommit: second });
    void head;

    const res = await h.b.app.inject({ method: 'GET', url: '/', headers: h.b.session(h.alice) });
    assert.equal(res.statusCode, 200);

    const marks = res.body.match(/Git 提交者元数据，非认证身份/g) ?? [];
    assert.ok(marks.length >= 2, `title 与脚注双通道在位（实得 ${marks.length} 处）`);
    assert.ok(res.body.includes('title="Git 提交者元数据，非认证身份'), '维护者单元格带说明性 title');
    assert.ok(/<td class="col-secondary"[^>]*>元数据可填者<\/td>/.test(res.body), '维护者=git 提交者名（如实呈现）');
    assert.ok(res.body.includes('title="2026-10-15T02:00:00.000Z"'), '更新时间单元格 title=服务端审计绝对时间');
  } finally {
    await h.b.close();
  }
});

// ── reader 视角（bob 场景）：零写入口 + 权限一致呈现 ────────────────────────

test('reader 视角（bob）：首页零写入口（无 form/upload/edit/admin），统计与文档表按其成员关系呈现', async () => {
  const h = await harness();
  try {
    await seedAlphaPublished(h);
    const res = await h.b.app.inject({ method: 'GET', url: '/', headers: h.b.session(h.bob) });
    assert.equal(res.statusCode, 200);
    const body = res.body;
    assert.ok(!body.includes('<form'), '页面无表单（零写入口）');
    assert.ok(!body.includes('/upload'), '无上传入口');
    assert.ok(!body.includes('/edit'), '无编辑入口');
    assert.ok(!body.includes('/admin'), '普通成员任何位置无管理入口');
    const summary = workbenchSummary(h.b.db, h.bob);
    const stats = statCards(body);
    assert.equal(stats[0]?.value, String(summary.vaultCount), 'reader 的可访问文库=其成员库数');
    assert.equal(stats[1]?.value, `${summary.publishedDocCount} 篇`, 'reader 的文档数=其有权库计数和');
    const rows = docRows(body);
    assert.ok(rows.length > 0, 'reader 见成员库文档行');
    assert.ok(rows.every((r) => r.vault === 'alpha'), '文档行仅成员库');
    assert.ok(!body.includes('bravo'), '无权库零出现');
    assert.ok(!body.includes('secret'), '无权库文档零出现');
  } finally {
    await h.b.close();
  }
});

// ── 空态（无库 / 有库无事件） ───────────────────────────────────────────────

test('空态·无库员工：三卡如实（0/0 篇/暂无）、库区空态文案、聚合卡仍承载 /vaults 入口、文档表与最近变更空态', async () => {
  const h = await harness();
  try {
    const dave = addEmployee(h.b.db, { username: 'dave' });
    const res = await h.b.app.inject({ method: 'GET', url: '/', headers: h.b.session(dave) });
    assert.equal(res.statusCode, 200);
    const body = res.body;
    const stats = statCards(body);
    assert.equal(stats[0]?.value, '0', '可访问文库=0');
    assert.equal(stats[1]?.value, '0 篇', '已发布文档=0 篇');
    assert.equal(stats[2]?.value, '暂无', '最近更新如实「暂无」（无发布事件不虚构）');
    assert.ok(stats[2]?.title === null, '无事件时无绝对时间 title');
    assert.ok(body.includes('尚无可访问文库'), '库区空态文案');
    assert.ok(vaultCardHrefs(body).length === 1, '仅聚合卡一卡（无库卡）');
    assert.ok(vaultCardHrefs(body)[0] === '/vaults', '聚合卡仍在（/vaults 导航零缺失）');
    assert.ok(body.includes('尚无最近发布的文档'), '文档表空态文案');
    assert.ok(body.includes('尚无最近变更'), '最近变更空态文案');
    assert.equal(docRows(body).length, 0, '零文档行');
  } finally {
    await h.b.close();
  }
});

test('空态·有库无发布事件：库卡在位（如实「暂无发布」），文档表空态、概览更新卡「暂无」', async () => {
  const h = await harness();
  try {
    const res = await h.b.app.inject({ method: 'GET', url: '/', headers: h.b.session(h.alice) });
    assert.equal(res.statusCode, 200);
    const body = res.body;
    assert.equal(statCards(body)[2]?.value, '暂无', '无发布事件→更新卡「暂无」');
    assert.ok(body.includes('暂无发布'), '库卡如实「暂无发布」');
    assert.ok(body.includes('尚无最近发布的文档'), '文档表空态');
    assert.equal(docRows(body).length, 0, '零文档行');
    assert.ok(vaultCardHrefs(body).length === 3, '聚合卡+两库卡在位');
  } finally {
    await h.b.close();
  }
});

// ── 入口卡移除 → 等价入口零缺失（导航可达性零回归） ─────────────────────────

test('入口卡移除零缺失：feature-card 入口卡不再渲染；侧栏五区+聚合卡 /vaults 承接；最近变更区块保留且位于文档表之后；索引状态占位在位', async () => {
  const h = await harness();
  try {
    addEmployee(h.b.db, { username: 'boss', is_instance_admin: 1 });
    await seedAlphaPublished(h);
    const aliceRes = await h.b.app.inject({ method: 'GET', url: '/', headers: h.b.session(h.alice) });
    assert.equal(aliceRes.statusCode, 200);
    const body = aliceRes.body;
    assert.ok(!body.includes('class="feature-card"'), '原 feature-card 入口卡移除');
    assert.ok(!body.includes('class="card-grid"'), '原入口卡网格容器移除');

    const side = sideNavBlock(body);
    for (const href of ['/search', '/drafts', '/cite', '/credentials']) {
      assert.ok(side.includes(`href="${href}"`), `侧栏等价入口 ${href} 在位`);
    }
    assert.ok(!side.includes('/admin'), '普通成员侧栏无管理项');
    assert.ok(vaultCardHrefs(body)[0] === '/vaults', '/vaults 由聚合卡承接（原「知识库」入口卡等价）');

    // 最近变更区块保留，置于跨库最近文档表之后（次级区块）
    const iDoc = body.indexOf('跨库最近文档');
    const iActivity = body.indexOf('最近变更');
    assert.ok(iDoc > 0 && iActivity > iDoc, `文档表在前、最近变更在后（${iDoc} < ${iActivity}）`);
    assert.ok(body.includes('class="commits"') || body.includes('class="commit activity-item"'), '最近变更条目形态保留');

    assert.ok(body.includes('<!-- 索引状态位'), '页头索引状态占位注释在位（S15 W05 接线，本任务不实现）');

    // 实例管理员：侧栏管理入口在位
    const bossRes = await h.b.app.inject({ method: 'GET', url: '/', headers: h.b.session(Number((h.b.db.prepare(`SELECT id FROM employees WHERE username='boss'`).get() as { id: number }).id)) });
    assert.ok(sideNavBlock(bossRes.body).includes('href="/admin"'), '实例管理员侧栏管理入口在位');
  } finally {
    await h.b.close();
  }
});

// ── 安全形态：认证缝 / 脚本规则 ─────────────────────────────────────────────

test('安全形态：未认证 / 仍 302 /login；登录态恰一内联 <script> 块；h1=工作台', async () => {
  const h = await harness();
  try {
    const anon = await h.b.app.inject({ method: 'GET', url: '/' });
    assert.equal(anon.statusCode, 302, '未认证 302（requirePageUser 认证缝不变）');
    assert.equal(anon.headers.location, '/login');

    await seedAlphaPublished(h);
    const res = await h.b.app.inject({ method: 'GET', url: '/', headers: h.b.session(h.alice) });
    assert.equal(res.statusCode, 200);
    assert.equal((res.body.match(/<script/g) ?? []).length, 1, '每页恰一内联 script 块（共享脚本规则不破）');
    assert.ok(res.body.includes('<h1>工作台</h1>'), '页头 h1');
  } finally {
    await h.b.close();
  }
});
