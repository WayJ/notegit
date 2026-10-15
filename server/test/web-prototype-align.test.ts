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

/**
 * S17-T1 原型对齐收口（静态原型九处视觉/结构差距——master 审计清单逐项；
 * 结构断言先行红→绿）。DESIGN.md v2 已是契约——本文件锁的是 v2 换轨时按
 * 「换皮不换骨」跳过的结构件（用户 review 后裁决补齐，S17 D1–D5）。
 *
 * 逐项落点（九处——第 9 处按 D2 裁决跳过并在此锁定跳过事实）：
 * 1) 顶栏：品牌后分隔线＋工作区名「知识工作台」（静态产品域标签——D1 不虚构
 *    多工作区概念）。
 * 2) 侧栏底部用户卡：28px 圆章（display_name 首字）＋姓名＋身份行
 *    （is_instance_admin ? 实例管理员 : 成员）——数据全在 PageNav.user。
 * 3) 页头重构：左=h1＋静态产品副标；右=head-meta 承载索引状态位（S15-T2 资产
 *    零语义变化，只挪位——三态文案与 title 断言在 web-workbench-status）。
 * 4) 首页搜索工具条：GET form action=/search（q+vault 与 S15-T1 同参数面）；
 *    vault 选项=vaultCards 同源（无权库不入选项——D1 数据零虚构）；⌘K/Ctrl-K
 *    聚焦并入首页唯一内联 script 块（D3——零 JS 表单仍可提交）。
 * 5) 统计卡图标片：三变奏 DOM 直加（▦ tint / ▤ green / ↻ orange——不再 CSS
 *    ::before）。
 * 6) 区块头动作链接：我的文库→「查看全部 →」（/vaults）；跨库最近文档→
 *    「查看全部文档 →」（/search）。
 * 7) 文档表三件：MD 文件图标片＋维护者头像圆章（git 作者名首字——D4 元数据
 *    展示，列的如实标注 title 不变）＋状态点（表内全为已发布，如实单态绿点）。
 * 8) 表尾条：visibility-note 声明（文案不变）＋右侧「查看全部文档 →」
 *    （/search）——inset 底表尾条形态。
 * 9) 面包屑：按 D2 裁决跳过（首页单层级纯噪音——审计披露项，非缺陷）。
 *
 * 行为零变化红线：每页恰一内联 <script> 块；22 路由零链接漂移（工具条是新
 * 链接不删旧链接——链接集基线在 web-shell-sidebar）。夹具沿用
 * web-browse-fixtures（与 web-workbench-home 同构：真实 bare 仓库 + git CLI
 * 种子提交 + 审计行经生产写面落库）。
 */

interface Harness {
  b: BrowseHarness;
  alice: number;
  bob: number;
  boss: number;
  alpha: number;
  bravo: number;
  gamma: number;
}

/** alpha（alice 编辑者，3 文档；bob 读者）/ bravo（仅 carol——无权库侧信道对照）/ gamma（alice 读者，无提交） */
async function harness(): Promise<Harness> {
  const b = await browseHarness();
  const alice = addEmployee(b.db, { username: 'alice', display_name: '爱丽丝' });
  const bob = addEmployee(b.db, { username: 'bob' }); // display_name 缺省回落用户名（fixture 层即该语义）
  const carol = addEmployee(b.db, { username: 'carol' });
  const boss = addEmployee(b.db, { username: 'boss', is_instance_admin: 1 });
  const alpha = await seededVault(b, 'alpha', alice, {
    'README.md': '# alpha\n',
    'docs/guide.md': '---\ntitle: Guide\ntags:\n  - howto\n---\n\nbody\n',
  });
  const bravo = await seededVault(b, 'bravo', carol, { 'docs/secret.md': 'secret\n' });
  const gamma = await seededVault(b, 'gamma', alice); // 无提交（unborn 分支）
  addMember(b.db, alpha, alice, 'editor', alice);
  addMember(b.db, alpha, bob, 'reader', bob);
  addMember(b.db, gamma, alice, 'reader', alice);
  return { b, alice, bob, boss, alpha, bravo, gamma };
}

async function headOid(h: Harness, vaultId: number): Promise<string> {
  return (await gitOut(['--git-dir', repoPathOf(h.b, vaultId), 'rev-parse', 'refs/heads/main'])).trim();
}

/** 以指定作者追加一笔提交（clone→写→commit→push 快进；维护者=git 作者名——客户端可填元数据） */
async function commitAs(
  h: Harness,
  vaultId: number,
  author: string,
  date: Date,
  files: Record<string, string>,
): Promise<string> {
  const work = path.join(h.b.dataDir, `wpa-${vaultId}-${author}-${date.getTime()}`);
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

/** 主场景种子：alpha 一笔成功发布（head 提交，2026-10-15T01:00:00.000Z） */
async function seedAlphaPublished(h: Harness): Promise<string> {
  const head = await headOid(h, h.alpha);
  seedPublish(h, { employeeId: h.alice, vaultId: h.alpha, occurredAt: '2026-10-15T01:00:00.000Z', newCommit: head });
  return head;
}

/** 首页 HTML（alice 视角缺省；h=已建夹具） */
async function homePage(h: Harness, employeeId?: number): Promise<string> {
  const res = await h.b.app.inject({ method: 'GET', url: '/', headers: h.b.session(employeeId ?? h.alice) });
  assert.equal(res.statusCode, 200);
  return res.body;
}

function sideNavBlock(body: string): string {
  const start = body.indexOf('class="side-nav"');
  assert.ok(start > 0, '侧栏在位');
  return body.slice(start, body.indexOf('</nav>', start));
}

// ── 差距 1：顶栏分隔线＋工作区名（静态产品域标签——D1） ─────────────────────

test('差距1 顶栏：品牌后 1px 分隔线＋工作区名「知识工作台」（12.5px ink2 静态文案；匿名壳同款）', async () => {
  const h = await harness();
  try {
    const body = await homePage(h);
    const iBrand = body.indexOf('class="brand"');
    const iDivider = body.indexOf('class="top-nav-divider"');
    const iWorkspace = body.indexOf('<span class="top-nav-workspace">知识工作台</span>');
    assert.ok(iBrand > 0, '品牌字标在位');
    assert.ok(iDivider > iBrand, '分隔线紧随品牌（1px line-strong 竖线）');
    assert.ok(iWorkspace > iDivider, '工作区名在分隔线之后（顺序：品牌→分隔线→工作区名）');

    // 匿名壳（登录页）同款顶栏——topNav 呈现件共享
    const login = await h.b.app.inject({ method: 'GET', url: '/login' });
    assert.ok(login.body.includes('class="top-nav-divider"'), '登录页顶栏分隔线在位');
    assert.ok(login.body.includes('<span class="top-nav-workspace">知识工作台</span>'), '登录页工作区名在位');

    // 样式：分隔线=line-strong、工作区名=卡片档 12.5px ink2（token 面）
    const css = await (await h.b.app.inject({ method: 'GET', url: '/assets/styles.css' })).body;
    assert.ok(css.includes('.top-nav-divider'), '分隔线样式在位');
    assert.ok(/\.top-nav-divider \{[^}]*var\(--line-strong\)/s.test(css), '分隔线=line-strong token');
    assert.ok(/\.top-nav-workspace \{[^}]*var\(--fs-card\)/s.test(css), '工作区名=12.5px（--fs-card）');
    assert.ok(/\.top-nav-workspace \{[^}]*var\(--ink2\)/s.test(css), '工作区名=ink2');
  } finally {
    await h.b.close();
  }
});

// ── 差距 2：侧栏底部用户卡 ──────────────────────────────────────────────────

test('差距2 侧栏用户卡：28px 圆章（display_name 首字）＋姓名＋身份行（成员/实例管理员）＋分隔线隔开导航区', async () => {
  const h = await harness();
  try {
    await seedAlphaPublished(h);
    // 普通成员（display_name=爱丽丝）：圆章首字「爱」＋姓名＋身份行「成员」
    const body = await homePage(h);
    const side = sideNavBlock(body);
    assert.ok(side.includes('class="side-foot"'), '侧栏底部用户卡在位');
    assert.ok(side.includes('<span class="side-foot-avatar" aria-hidden="true">爱</span>'), '圆章=display_name 首字');
    assert.ok(side.includes('<span class="side-foot-name">爱丽丝</span>'), '姓名=display_name');
    assert.ok(side.includes('<span class="side-foot-role">成员</span>'), '身份行=成员（非实例管理员）');
    const iList = side.indexOf('side-nav-list');
    const iFoot = side.indexOf('side-foot');
    assert.ok(iList > 0 && iFoot > iList, '用户卡在导航区之后（分隔线隔开）');
    // 数据面：bob（display_name 缺省回落用户名）——姓名=bob、圆章=b
    const bobBody = await homePage(h, h.bob);
    const bobSide = sideNavBlock(bobBody);
    assert.ok(bobSide.includes('<span class="side-foot-name">bob</span>'), 'display_name 缺省回落用户名');
    assert.ok(bobSide.includes('<span class="side-foot-avatar" aria-hidden="true">b</span>'), '回落时圆章=用户名首字');
    assert.ok(bobSide.includes('<span class="side-foot-role">成员</span>'), 'bob 身份行=成员');
    // 实例管理员：身份行如实「实例管理员」（仅文案——判定面仍在 API）
    const bossBody = await homePage(h, h.boss);
    assert.ok(sideNavBlock(bossBody).includes('<span class="side-foot-role">实例管理员</span>'), '管理员身份行');
    // 样式：圆章 28px #e9f3ff 底 accent-ink 字（§4 账户圆章同款）＋分隔线 line
    const css = (await h.b.app.inject({ method: 'GET', url: '/assets/styles.css' })).body;
    assert.ok(/\.side-foot-avatar \{[^}]*#e9f3ff/s.test(css), '圆章底=#e9f3ff（§4 明文值）');
    assert.ok(/\.side-foot-avatar \{[^}]*var\(--accent-ink\)/s.test(css), '圆章字=accent-ink');
    assert.ok(/\.side-foot-avatar \{[^}]*width: 28px/s.test(css), '圆章 28px');
    assert.ok(/\.side-foot \{[^}]*border-top: 1px solid var\(--line\)/s.test(css), '分隔线隔开导航区');
    assert.ok(/\.side-foot-name \{[^}]*var\(--fs-table\)/s.test(css), '姓名 11.5px');
    assert.ok(/\.side-foot-role \{[^}]*var\(--fs-aux-sm\)/s.test(css), '身份行 10.5px');
  } finally {
    await h.b.close();
  }
});

// ── 差距 3：页头重构（左副标 / 右置索引位） ────────────────────────────────

test('差距3 页头：左=h1＋静态产品副标（12.5px ink2）；右=head-meta 承载索引状态位（三态资产只挪位）', async () => {
  const h = await harness();
  try {
    await seedAlphaPublished(h);
    const body = await homePage(h);
    assert.ok(body.includes('<h1>工作台</h1>'), 'h1 保留');
    assert.ok(
      body.includes('<p class="page-sub">企业知识，按库组织、共同维护；快速搜索并定位到可追溯的原文。</p>'),
      '静态产品副标（D1：产品域描述句，非数据文案）',
    );
    assert.ok(!body.includes('跨库知识工作台 · 数据按你的文库成员关系实时呈现'), '原 page-meta 行由副标取代');
    const iH1 = body.indexOf('<h1>工作台</h1>');
    const iSub = body.indexOf('class="page-sub"');
    assert.ok(iH1 > 0 && iSub > iH1, '副标随 h1（左侧列）');
    // 右位：head-meta 内承载 index-status（p 元素与三态类原样——语义断言在 web-workbench-status）
    assert.ok(/<div class="head-meta">\s*<p class="index-status (is-healthy|is-failing|is-empty)"/.test(body), '索引状态位迁入右位 head-meta');
    const iSub2 = body.indexOf('class="page-sub"');
    const iMeta = body.indexOf('class="head-meta"');
    assert.ok(iMeta > iSub2, 'head-meta 在左列之后（同排右位）');
    // 样式：副标 12.5px ink2；页头分排容器在位
    const css = (await h.b.app.inject({ method: 'GET', url: '/assets/styles.css' })).body;
    assert.ok(/\.page-sub \{[^}]*var\(--fs-card\)/s.test(css), '副标 12.5px');
    assert.ok(/\.page-sub \{[^}]*var\(--ink2\)/s.test(css), '副标 ink2');
    assert.ok(css.includes('.page-head-split'), '页头分排容器样式在位');
    assert.ok(css.includes('.head-meta'), '右位容器样式在位');
  } finally {
    await h.b.close();
  }
});

// ── 差距 4：首页搜索工具条（真功能增量——S17 D3） ───────────────────────────

test('差距4 工具条：GET form action=/search（q+vault 同参数面）＋vault 选项=vaultCards 同源（无权库不入选项）＋⌘K 聚焦并入唯一内联 script', async () => {
  const h = await harness();
  try {
    await seedAlphaPublished(h);
    const body = await homePage(h);
    // 表单：method=get action=/search（零 JS 可提交）
    const iForm = body.indexOf('<form class="toolbar home-toolbar" method="get" action="/search">');
    assert.ok(iForm > 0, '工具条=GET form action=/search');
    const form = body.slice(iForm, body.indexOf('</form>', iForm));
    assert.ok(form.includes('name="q"'), 'q 参数面（与 /search 同名）');
    assert.ok(form.includes('name="vault"'), 'vault 参数面（与 S15-T1 同名）');
    assert.equal((form.match(/name="/g) ?? []).length, 2, '表单仅 q+vault 两参数（同参数面，不多不少）');
    assert.ok(form.includes('placeholder="搜索标题、标签或摘要…"'), '搜索框 placeholder');
    assert.ok(form.includes('class="kbd-hint" aria-hidden="true">⌘K</span>'), '⌘K 角标小片');
    assert.ok(form.includes('class="search-glyph"'), '⌕ 图标在位');
    assert.ok(form.includes('class="btn-primary">搜索</button>'), '主按钮「搜索」（胶囊 accent）');
    // 选项面：全部＋有权库（vaultCards 同源——alpha/gamma；bravo 无权不入）
    assert.ok(form.includes('<option value="all" selected>全部</option>'), '首项=全部');
    assert.ok(form.includes('<option value="alpha"'), 'alpha（alice 有权）入选项');
    assert.ok(form.includes('<option value="gamma"'), 'gamma（alice 有权）入选项');
    assert.ok(!form.includes('value="bravo"'), 'bravo（无权库）不入选项——数据零虚构（D1）');
    // 位置：页头之下、统计卡之上
    const iHead = body.indexOf('class="head-meta"');
    const iStats = body.indexOf('class="stat-grid"');
    assert.ok(iHead < iForm && iForm < iStats, '工具条位于页头下、统计卡上');
    // ⌘K：并入唯一内联 script 块（与账户脚本同块——每页恰一）
    assert.equal((body.match(/<script/g) ?? []).length, 1, '每页恰一内联 script 块');
    assert.ok(body.includes("getElementById('q')"), '⌘K 脚本取搜索框（id=q 与 /search 同名位）');
    assert.ok(/metaKey \|\| ev\.ctrlKey/.test(body) && body.includes("ev.key === 'k'"), '⌘K/Ctrl-K 聚焦逻辑顺延');
    // 鉴权面（bob：仅 alpha 成员）：选项=全部+alpha；无权库侧信道零出现
    const bobBody = await homePage(h, h.bob);
    const bobForm = bobBody.slice(bobBody.indexOf('home-toolbar'), bobBody.indexOf('</form>', bobBody.indexOf('home-toolbar')));
    assert.ok(bobForm.includes('<option value="alpha"'), 'bob 选项含其成员库 alpha');
    assert.ok(!bobForm.includes('value="gamma"'), '非成员库 gamma 不入 bob 选项');
    assert.ok(!bobForm.includes('value="bravo"'), '无权库 bravo 不入 bob 选项（同判定面）');
  } finally {
    await h.b.close();
  }
});

// ── 差距 5：统计卡图标片（DOM 直加三变奏） ─────────────────────────────────

test('差距5 统计卡图标片：三变奏 DOM 直加（▦ v-tint / ▤ v-green / ↻ v-orange）——CSS ::before 退役', async () => {
  const h = await harness();
  try {
    await seedAlphaPublished(h);
    const body = await homePage(h);
    const re = /<div class="stat-card"><span class="(stat-icon [a-z-]+)" aria-hidden="true">([^<]*)<\/span><span class="stat-value"(?: title="[^"]*")?>([^<]*)<\/span><span class="stat-label">([^<]*)<\/span><\/div>/g;
    const cards: { icon: string; glyph: string; label: string }[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) cards.push({ icon: m[1] as string, glyph: m[2] as string, label: m[4] as string });
    assert.deepEqual(
      cards.map((c) => [c.icon, c.glyph, c.label]),
      [
        ['stat-icon v-tint', '▦', '可访问文库'],
        ['stat-icon v-green', '▤', '已发布文档'],
        ['stat-icon v-orange', '↻', '最近一次内容更新'],
      ],
      '三卡图标片=字形×色变奏逐位对应（§5 统计卡行）',
    );
    // ::before 退役：样式面不再有统计卡伪元素；图标片为真实节点样式
    const css = (await h.b.app.inject({ method: 'GET', url: '/assets/styles.css' })).body;
    assert.ok(!css.includes('.stat-card::before'), 'CSS ::before 图标片退役（DOM 直加）');
    assert.ok(/\.stat-icon \{[^}]*width: 34px/s.test(css), '图标片 34px');
    assert.ok(/\.stat-icon \{[^}]*var\(--r-card\)/s.test(css), '图标片圆角 10px（--r-card）');
    assert.ok(/\.stat-icon \{[^}]*var\(--tint\)/s.test(css), '库卡变奏=tint 底');
    assert.ok(/\.stat-icon\.v-green \{[^}]*var\(--green-tint\)/s.test(css), '篇卡变奏=green-tint 底');
    assert.ok(/\.stat-icon\.v-orange \{[^}]*var\(--orange-tint\)/s.test(css), '更新卡变奏=orange-tint 底');
  } finally {
    await h.b.close();
  }
});

// ── 差距 6：区块头动作链接 ─────────────────────────────────────────────────

test('差距6 区块头动作链接：我的文库→查看全部 →（/vaults）；跨库最近文档→查看全部文档 →（/search）', async () => {
  const h = await harness();
  try {
    await seedAlphaPublished(h);
    const body = await homePage(h);
    const iVault = body.indexOf('aria-label="我的文库"');
    const iDoc = body.indexOf('aria-label="跨库最近文档"');
    assert.ok(iVault > 0 && iDoc > iVault, '两区块在位');
    const vaultSection = body.slice(iVault, iDoc);
    const docSection = body.slice(iDoc, body.indexOf('aria-label="最近变更"', iDoc));
    assert.ok(vaultSection.includes('<a class="section-action" href="/vaults">查看全部 →</a>'), '我的文库区块头动作链接（/vaults）');
    assert.ok(docSection.includes('<a class="section-action" href="/search">查看全部文档 →</a>'), '跨库最近文档区块头动作链接（/search）');
    // 区块头结构：标题＋副题在左、动作链接在右（容器在位）
    assert.ok(body.includes('class="section-head-main"'), '区块头左列容器在位');
    const css = (await h.b.app.inject({ method: 'GET', url: '/assets/styles.css' })).body;
    assert.ok(/\.section-action \{[^}]*var\(--fs-table\)/s.test(css), '动作链接 11.5px（accent-ink 为 a 默认色）');
  } finally {
    await h.b.close();
  }
});

// ── 差距 7：文档表三件（MD 片＋头像圆章＋状态点） ───────────────────────────

test('差距7 文档表三件：MD 图标片＋维护者头像圆章（git 作者名首字，title 如实标注不变）＋状态点（已发布绿点，时间列前）', async () => {
  const h = await harness();
  try {
    const head = await headOid(h, h.alpha);
    const second = await commitAs(h, h.alpha, '元数据可填者', new Date('2026-10-14T00:00:00Z'), {
      'docs/new.md': '---\ntitle: New\ntags: []\n---\n\nnew\n',
    });
    seedPublish(h, { employeeId: h.alice, vaultId: h.alpha, occurredAt: '2026-10-15T01:00:00.000Z', newCommit: head });
    seedPublish(h, { employeeId: h.alice, vaultId: h.alpha, occurredAt: '2026-10-15T02:00:00.000Z', newCommit: second });
    const body = await homePage(h);
    // MD 文件图标片：每文档行首一枚
    const fileChips = body.match(/<span class="doc-file-chip" aria-hidden="true">MD<\/span>/g) ?? [];
    const docRows = body.match(/<tr data-vault="alpha" data-path=/g) ?? [];
    assert.ok(docRows.length >= 2, '文档行在位');
    assert.equal(fileChips.length, docRows.length, '每文档行恰一枚 MD 图标片');
    // 维护者头像圆章：git 作者名首字＋姓名同格；title 如实标注（D4——元数据展示红线不变）
    assert.ok(body.includes('<span class="doc-author-avatar" aria-hidden="true">元</span>'), '头像圆章=git 作者名首字');
    assert.ok(body.includes('<span class="doc-author-name">元数据可填者</span>'), '维护者姓名如实呈现');
    assert.ok(body.includes('title="Git 提交者元数据，非认证身份（操作主体以服务端审计记录为准）"'), '维护者列如实标注 title 不变');
    // 状态点：时间列前 6px 绿点＋「已发布」（表内全为已发布——如实单态）
    const statusBits = body.match(/<span class="doc-status"><span class="status-dot" aria-hidden="true"><\/span>已发布<\/span>/g) ?? [];
    assert.equal(statusBits.length, docRows.length, '每文档行恰一处已发布状态点');
    // 状态点在时间列内、时间文本之前（td 的 title=审计绝对时间在开标签上，内容以状态点起头）
    assert.ok(
      /<td class="col-tertiary" title="2026-10-15T02:00:00\.000Z"><span class="doc-status">/.test(body),
      '时间单元格内容以状态点起头（点→「已发布」→相对时间文本）',
    );
    // 样式：MD 片 29×32 surface/line/accent-ink；头像 20px 中性圆章（与认证蓝圆章区分）；状态点 --green
    const css = (await h.b.app.inject({ method: 'GET', url: '/assets/styles.css' })).body;
    assert.ok(/\.doc-file-chip \{[^}]*width: 29px/s.test(css) && /\.doc-file-chip \{[^}]*height: 32px/s.test(css), 'MD 片 29×32');
    assert.ok(/\.doc-file-chip \{[^}]*var\(--surface\)/s.test(css) && /\.doc-file-chip \{[^}]*var\(--line\)/s.test(css), 'MD 片 surface 底 line 描边');
    assert.ok(/\.doc-file-chip \{[^}]*var\(--accent-ink\)/s.test(css), 'MD 字样 accent-ink');
    assert.ok(/\.doc-author-avatar \{[^}]*width: 20px/s.test(css), '头像圆章 20px');
    assert.ok(/\.status-dot \{[^}]*var\(--green\)/s.test(css), '状态点=--green（§5 状态点已发布）');
  } finally {
    await h.b.close();
  }
});

// ── 差距 8：表尾条 ─────────────────────────────────────────────────────────

test('差距8 表尾条：visibility-note 声明（文案不变）＋右侧「查看全部文档 →」（/search）——inset 底表尾条', async () => {
  const h = await harness();
  try {
    await seedAlphaPublished(h);
    const body = await homePage(h);
    const declaration = '呈现已发布知识；草稿仅创建者可见。搜索与列表遵循文库成员权限。';
    const iFoot = body.indexOf('<div class="table-foot">');
    assert.ok(iFoot > 0, '表尾条容器在位');
    const foot = body.slice(iFoot, body.indexOf('</div>', iFoot));
    assert.ok(foot.includes(`class="page-meta visibility-note">${declaration}</p>`), 'visibility-note 声明文案不变（S15-T2 资产）');
    assert.ok(foot.includes('<a class="section-action" href="/search">查看全部文档 →</a>'), '表尾右侧动作链接（/search）');
    assert.ok(iFoot > body.indexOf('</table>'), '表尾条位于表格之后');
    // grid 视图同样在位（区块尾不随视图退场）
    const grid = await (await h.b.app.inject({ method: 'GET', url: '/?view=grid', headers: h.b.session(h.alice) })).body;
    assert.ok(grid.includes('<div class="table-foot">'), 'grid 视图表尾条仍在');
    // 样式：inset 底表尾条形态（§5 表尾条）
    const css = (await h.b.app.inject({ method: 'GET', url: '/assets/styles.css' })).body;
    assert.ok(/\.table-foot \{[^}]*var\(--inset\)/s.test(css), '表尾条=inset 底');
  } finally {
    await h.b.close();
  }
});

// ── 差距 9：面包屑跳过（D2 裁决——披露项锁定） ─────────────────────────────

test('差距9 面包屑：按 S17 D2 裁决跳过（首页零 breadcrumb——单层级纯噪音；披露于 commit）', async () => {
  const h = await harness();
  try {
    await seedAlphaPublished(h);
    const body = await homePage(h);
    assert.ok(!body.includes('aria-label="面包屑"'), '首页无面包屑（D2：跳过并披露——库内页面包屑不受影响）');
    assert.ok(!body.includes('›'), '无面包屑分隔符残留');
  } finally {
    await h.b.close();
  }
});

// ── 行为零变化红线（收口总闸） ──────────────────────────────────────────────

test('行为零变化总闸：首页恰一内联 script；旧链接零删除（工具条/动作链接均为新增）', async () => {
  const h = await harness();
  try {
    await seedAlphaPublished(h);
    const body = await homePage(h);
    assert.equal((body.match(/<script/g) ?? []).length, 1, '每页恰一内联 script 块（⌘K 并入不另开块）');
    // 既有链接零丢失（22 路由零漂移——全集基线在 web-shell-sidebar，此处锁首页关键位；
    // /login 非页内链接——未认证 302 承担，不在链接集内）
    for (const href of ['/', '/search', '/drafts', '/cite', '/credentials', '/vaults']) {
      assert.ok(body.includes(`href="${href}"`), `既有链接 ${href} 未丢失`);
    }
  } finally {
    await h.b.close();
  }
});
