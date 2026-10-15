/**
 * S2-T8 最小页面 HTML（架构 §6 完整 Web 整理属 S4——「最小」=可用即可：无路由
 * 框架、无前端构建）。页面 = 服务端渲染的外壳 + 页内 fetch 调 api.md 既有
 * 端点（同源；浏览器对非安全方法自动带 Origin，兼容 T5 CSRF 守卫链
 * Origin→Referer→reject——auth/csrf.ts）。动态数据一律 textContent 注入（无
 * innerHTML，防 XSS）；一次性明文（邀请/重置令牌、凭据 token）仅在创建响应后
 * 展示一次，刷新即失（identity §3.1/§7.2）。
 *
 * UI-RESTYLE：layout() 为 DESIGN.md 视觉契约壳（S16-T1 起 v2：56px 顶栏＋品牌
 * 渐变方片 brand-mark＋浅色页脚；样式唯一来源 /assets/styles.css——见
 * web/assets.ts 与 assets/styles.css 头注）。插值通道不变：文本仅 escapeHtml；
 * 结构与类名由本模板生成。每页恰好一个内联 <script> 块（既有测试断言）；
 * S12-T3 起改造页在内联块前另含恰一个共享脚本 <script src="/assets/app.js">
 * 引用（见下）。
 *
 * S11-T2：indexPage 追加「最近变更」区块（服务端渲染、无新增脚本——区块纯
 * 呈现）；条目行渲染 activityEntryRow 为首页与库内 activity 页共用（同形态），
 * 数据面在 web/activity/query.ts（审计成功发布行——sprint S11 D3）。
 *
 * S12-T2：topNav 升级账户菜单（G09；research F-9/P1-7——登出不再只在首页）：
 * 右上 details 零 JS 下拉（display_name 徽章=DESIGN.md badge-pill 既有 token +
 * 用户名；我的凭据/管理（仅实例管理员）/退出登录——id="logout" 由顶栏承担，
 * 首页原独立退出按钮移除）；顶栏新增「我的草稿」入口（认证全员）；登出脚本
 * ACCOUNT_SCRIPT 并入页面唯一 <script> 块（渐进增强——菜单开合零 JS 可用）。
 *
 * S12-T3（D19-A 第一步）：原内联 FETCH_HELPER（api/show）全文迁入共享脚本
 * /assets/app.js（web/assets/assets.ts 注册；全局命名空间 window.ngt——语义
 * 与原内联逐字一致，行为零变化）。用共享脚本的页面（login/admin/credentials）
 * 调 layout(..., sharedScript=true)：内联块前置 <script src> 引用，页面内联块
 * 顶部一行别名取用（SHARED_ALIAS——页面特有逻辑的调用面零改写）。
 *
 * S14-T2 应用壳升级：layout() 由「顶栏＋main＋页脚」升为**三段壳**——顶栏
 * ＋ `<div class="app-shell">`（左侧分区导航 sideNav() ＋ 内容区 main）＋ 深色
 * 页脚。侧栏承载 D3 五区（查找/我的草稿/引用解析/我的凭据/管理），当前区由
 * 服务端落 aria-current（D4：零 JS，不新增任何内联脚本——每页仍恰好一个
 * 内联 <script> 块，共享脚本引用规则不变）。侧栏仅登录态壳渲染（nav.user 存在
 * 时）；匿名/无导航壳（登录页 nav=undefined、403/404 兜底页）保持无侧栏形态。
 * 顶栏品牌/账户菜单/主 CTA 形态不变（S12 已验收资产不得回归）。
 *
 * S15-T2 工作台完善（DOD-E4-06/08；D4/D5）：indexPage 页头索引状态位接线
 * （indexStatusHtml 三态如实——数据面 web/workbench/query.ts indexStatus，
 * 成员过滤已在该层锁定）；跨库最近文档表新增视图开关 view=list|grid（零 JS
 * 纯 <a href> querystring 记忆，默认 list；grid 复用 vault-card/vault-grid
 * 既有 token 卡类）＋ 表尾可见性语义声明固定位。零新增脚本——每页仍恰一
 * 内联 <script> 块。
 */

import { ACTIVITY_LIMIT, type ActivityEntry } from './activity/query.ts';
import type { WorkbenchSummary, VaultCard, RecentDocumentRow, IndexStatus } from './workbench/query.ts';


/** HTML 文本转义：服务端渲染的唯一插值通道 */
export function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * 顶部导航上下文（DESIGN.md top-nav 组件的登录态/主菜单落位）：
 * - user 存在 → 右侧呈现账户菜单（S12-T2：details 零 JS 下拉——display_name
 *   徽章 + 用户名 + 凭据/管理/退出登录）；isAdmin 才出现「管理」链接
 *   （S2-T8 验收断言「普通成员页面任何位置不得出现 /admin」——本字段唯一来源）。
 *   displayName 缺省时徽章如实回落用户名（渐进接线：各页面模块 viewer 逐步补传）。
 * - active → 当前区段落位（aria-current 高亮）。
 */
export interface PageNav {
  readonly user?: { readonly username: string; readonly isAdmin: boolean; readonly displayName?: string };
  readonly active?: 'home' | 'vaults' | 'drafts' | 'search' | 'cite' | 'credentials' | 'admin';
}

/** 品牌标记：4-spoke 径向星芒（Notegit 身份；inline SVG，随色继承——容器渐变方片见 styles.css .brand-mark） */
const SPIKE_MARK =
  '<svg class="spike-mark" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><g stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M5.6 5.6 18.4 18.4"/><path d="M18.4 5.6 5.6 18.4"/></g></svg>';

const NAV_ITEMS: ReadonlyArray<{ readonly href: string; readonly label: string; readonly key: NonNullable<PageNav['active']> }> = [
  { href: '/search', label: '查找', key: 'search' },
  { href: '/cite', label: '引用解析', key: 'cite' },
  { href: '/drafts', label: '我的草稿', key: 'drafts' }, // 认证全员可见（顶栏渲染过滤——匿名壳不呈现）
  { href: '/credentials', label: '我的凭据', key: 'credentials' },
];

/**
 * S14-T2 侧栏分区（D3 五区；D4 零 JS——当前区靠服务端落 aria-current，不用脚本切换）。
 * 图标为内联 SVG 线条标记（随色继承 currentColor，与 spike-mark 同一处理方式——
 * DESIGN.md 未覆盖侧栏组件，按其 Iteration Guide 原则推导：先结构与米色卡承载
 * 当前区，不引入第四种表面色、coral 不入侧栏）。
 */
const SIDE_ICONS: Readonly<Record<string, string>> = {
  search: '<svg class="side-nav-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><g stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"><circle cx="10" cy="10" r="6"/><path d="M14.5 14.5 19 19"/></g></svg>',
  drafts: '<svg class="side-nav-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><g stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M6 3.5h7.5L18 8v12.5H6z"/><path d="M13.5 3.5V8H18"/><path d="M9 12.5h6M9 16h4"/></g></svg>',
  cite: '<svg class="side-nav-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><g stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M4.5 5v13"/><path d="M8.5 7.5h11M8.5 12h11M8.5 16.5h6"/></g></svg>',
  credentials: '<svg class="side-nav-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><g stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"><circle cx="8" cy="12" r="3.6"/><path d="M11.6 12H20M16.5 12v3.2M18.8 12v2.2"/></g></svg>',
  admin: '<svg class="side-nav-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><g stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"><path d="M3.5 8h13M3.5 16h13"/><circle cx="8.5" cy="8" r="2.2"/><circle cx="14" cy="16" r="2.2"/></g></svg>',
};

/**
 * 左侧分区导航（S14-T2 应用壳中段；仅登录态壳渲染——匿名/无导航壳不落侧栏，D3）。
 * 管理项仍仅实例管理员可见（S2-T8 验收断言「普通成员页面任何位置不得出现
 * /admin」——本函数是 /admin 的第二个来源，仍只读 nav.user.isAdmin）。
 */
function sideNav(nav: PageNav): string {
  const items = NAV_ITEMS.map(
    (it) =>
      `      <li><a class="side-nav-item" href="${it.href}"${nav.active === it.key ? ' aria-current="page"' : ''}><span class="side-nav-mark">${SIDE_ICONS[it.key]}</span><span class="side-nav-text">${it.label}</span></a></li>`,
  );
  const adminItem =
    nav.user?.isAdmin === true
      ? `\n      <li><a class="side-nav-item" href="/admin"${nav.active === 'admin' ? ' aria-current="page"' : ''}><span class="side-nav-mark">${SIDE_ICONS.admin}</span><span class="side-nav-text">管理</span></a></li>`
      : '';
  return `<nav class="side-nav" aria-label="分区导航">
    <p class="side-nav-title">分区</p>
    <ul class="side-nav-list">
      ${items.join('\n')}${adminItem}
    </ul>
  </nav>`;
}

/** S12-T2 顶栏账户菜单登出脚本（layout 并入页面唯一 script 块；菜单开合零 JS） */
const ACCOUNT_SCRIPT = `
(function () {
  var btn = document.getElementById('logout');
  if (btn === null) return; // 无账户位页面（匿名壳）零行为
  btn.addEventListener('click', async function () {
    try { await fetch('/api/v1/auth/logout', { method: 'POST' }); } catch (err) { /* 尽力送达（端点幂等）*/ }
    location.href = '/login';
  });
})();
`;

function topNav(nav?: PageNav): string {
  const items = NAV_ITEMS.filter((it) => it.key !== 'drafts' || nav?.user !== undefined).map(
    (it) =>
      `<li><a href="${it.href}"${nav?.active === it.key ? ' aria-current="page"' : ''}>${it.label}</a></li>`,
  );
  const adminItem =
    nav?.user?.isAdmin === true
      ? `\n      <li><a href="/admin"${nav.active === 'admin' ? ' aria-current="page"' : ''}>管理</a></li>`
      : '';
  // 账户菜单（S12-T2）：details 零 JS 下拉——徽章（displayName 缺省回落用户名）+ 用户名；
  // 下拉=凭据/管理（仅实例管理员）/退出登录（id="logout"——顶栏全域承担，脚本见 ACCOUNT_SCRIPT）
  const account =
    nav?.user !== undefined
      ? `\n      <details class="nav-account">
        <summary title="${escapeHtml(nav.user.username)}"><span class="badge">${escapeHtml(nav.user.displayName ?? nav.user.username)}</span> <span class="nav-user">${escapeHtml(nav.user.username)}</span></summary>
        <div class="account-menu">
          <a href="/credentials"${nav.active === 'credentials' ? ' aria-current="page"' : ''}>我的凭据</a>${
            nav.user.isAdmin
              ? `\n          <a href="/admin"${nav.active === 'admin' ? ' aria-current="page"' : ''}>管理</a>`
              : ''
          }
          <button type="button" id="logout">退出登录</button>
        </div>
      </details>`
      : '';
  // 主 CTA：知识库（产品主入口；登录页由登录按钮承担 CTA，不重复呈现）
  const cta = nav?.active === 'home' ? '' : '\n      <a class="btn btn-primary" href="/vaults">知识库</a>';
  // S14 master 裁决（B 方案）：横向主菜单仅**匿名/无导航壳**渲染（登录页、403/404、
  // 写闸门兜底——基线链接集不变）；登录态桌面导航唯一承担者=侧栏（sideNav 五区），
  // 不重复两处。登录态顶栏保留品牌＋账户菜单＋主 CTA（S12 资产不回归）。
  const menu =
    nav?.user === undefined
      ? `\n    <ul class="nav-menu">
      ${items.join('\n      ')}${adminItem}
    </ul>`
      : '';
  return `<header class="top-nav">
  <div class="top-nav-inner">
    <a class="brand" href="/"><span class="brand-mark">${SPIKE_MARK}</span>Notegit</a>${menu}
    <div class="nav-side">${account}${cta}
    </div>
  </div>
</header>`;
}

const SITE_FOOTER = `<footer class="site-footer">
  <div class="site-footer-inner">
    <span class="brand"><span class="brand-mark">${SPIKE_MARK}</span>Notegit</span>
    <nav class="site-footer-links" aria-label="页脚">
      <a href="/search">查找</a>
      <a href="/cite">引用解析</a>
      <a href="/credentials">我的凭据</a>
    </nav>
    <span class="foot-fine">团队知识库 · 服务端渲染</span>
  </div>
</footer>`;

export function layout(title: string, body: string, script = '', nav?: PageNav, sharedScript = false): string {
  // S12-T2：登录态页面把账户菜单脚本并入页面唯一 script 块（每页仍恰好一个 <script>）
  const inline = (nav?.user !== undefined ? [ACCOUNT_SCRIPT, script] : [script]).filter((s) => s !== '').join('\n');
  // S12-T3：共享脚本页（sharedScript=true）在内联块前置 <script src> 引用——
  // 经典 script 按文档序执行，保证内联块的 ngt 别名取用时 window.ngt 已就位
  const sharedRef = sharedScript ? '<script src="/assets/app.js"></script>\n' : '';
  // S14-T2 三段壳：顶栏 ＋ app-shell（左侧分区导航 ＋ 内容区）＋ 页脚。
  // 侧栏仅登录态壳渲染（nav.user 存在——匿名/无导航壳如登录页、403/404 兜底页
  // 保持无侧栏形态，D3）；侧栏零 JS（D4：当前区服务端落 aria-current）。
  const side = nav?.user !== undefined ? `${sideNav(nav)}\n` : '';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — Notegit</title>
<link rel="stylesheet" href="/assets/styles.css">
</head>
<body>
${topNav(nav)}
<div class="app-shell">
${side}<main>
${body}
</main>
</div>
${SITE_FOOTER}
${sharedRef}<script>
${inline}
</script>
</body>
</html>`;
}

/**
 * S12-T3 共享脚本页内联块顶部别名行（原 FETCH_HELPER 迁入 /assets/app.js 后的
 * 机械替换——页面特有逻辑的 api()/show() 调用面零改写；apiEnvelope=「code:
 * message」错误信封族，语义与原内联逐字一致，web-assets.test.ts 形态锁定）。
 */
const SHARED_ALIAS = `const api = ngt.apiEnvelope, show = ngt.show;`;

export function loginPage(): string {
  return layout(
    '登录',
    `<div class="login-wrap">
  <div class="login-card">
    <h1>登录 Notegit</h1>
    <p class="login-sub">团队知识库 · 输入员工账号继续</p>
    <form id="login-form">
      <label>用户名 <input name="username" autocomplete="username" required></label>
      <label>口令 <input name="password" type="password" autocomplete="current-password" required></label>
      <button type="submit" class="btn-primary">登录</button>
    </form>
    <p id="login-error" role="alert"></p>
  </div>
</div>
`,
    `${SHARED_ALIAS}
document.getElementById('login-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  try {
    await api('POST', '/api/v1/auth/login', {
      username: f.username.value,
      password: f.password.value,
    });
    location.href = '/';
  } catch (err) {
    show(document.getElementById('login-error'), '登录失败：' + err.message);
  }
});
`,
    undefined,
    true, // S12-T3：引用共享脚本 /assets/app.js（FETCH_HELPER 迁出——行为零变化）
  );
}

// ── S11-T2 最近变更（首页区块与 web/activity 库页共用呈现件） ────────────────

/** 相对时间：一分钟内=刚刚，此后分钟/小时/天，超一周回绝对日期（时钟异常如实回退原文） */
export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  const diffSec = Math.max(0, Math.floor((now.getTime() - at) / 1000));
  if (diffSec < 60) return '刚刚';
  const min = Math.floor(diffSec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day <= 7) return `${day} 天前`;
  return iso.slice(0, 10);
}

/** view 页 URL（与 browse viewUrl 同构；本文件不 import browse——防环，逐段编码同语义） */
function activityViewHref(slug: string, treePath: string): string {
  return `/vaults/${encodeURIComponent(slug)}/view/${treePath.split('/').map(encodeURIComponent).join('/')}`;
}

/** 最近变更条目行（首页区块与库内 activity 页同形态；data 属性为一致性断言所依）。
 *  审计 schema 无 commit message（identity §8：作者元数据不入审计）——「主题」
 *  呈现=分支+入口动作+commit 短码（链接该库历史页既有页）；detail 携带路径则
 *  链 view；new commit 缺失或全零（删引用形态）不生成 commit 链接。 */
export function activityEntryRow(e: ActivityEntry): string {
  const vaultHref = `/vaults/${encodeURIComponent(e.vaultSlug)}`;
  const branch = e.refName !== null && e.refName.startsWith('refs/heads/') ? e.refName.slice('refs/heads/'.length) : e.refName;
  const action = e.eventKind === 'vault.web_submit' ? '站内编辑' : 'git 推送';
  const newCommit = e.newCommit ?? '';
  const commitLink =
    /^[0-9a-f]{40}$/.test(newCommit) && !/^0+$/.test(newCommit)
      ? ` · <a href="${vaultHref}/history"><code>${escapeHtml(newCommit.slice(0, 7))}</code></a>`
      : '';
  const pathLinks = e.paths
    .map((p) => ` · <a href="${activityViewHref(e.vaultSlug, p)}">${escapeHtml(p)}</a>`)
    .join('');
  const branchText = branch === null || branch === '' ? '' : ` · ${escapeHtml(branch)}`;
  return `<li class="commit activity-item" data-vault="${escapeHtml(e.vaultSlug)}" data-actor="${escapeHtml(e.actorUsername)}" data-when="${escapeHtml(e.occurredAt)}" data-commit="${escapeHtml(newCommit)}" data-entry="${escapeHtml(e.entry)}"><a href="${vaultHref}">${escapeHtml(e.vaultSlug)}</a> · ${escapeHtml(e.actorDisplay)}（${escapeHtml(e.actorUsername)}）· ${escapeHtml(formatRelativeTime(e.occurredAt))}${branchText} · ${action}${commitLink}${pathLinks}</li>`;
}

// ── S14-T3 工作台首页（`/` 原地升级——DOD-E4-02/04/07） ──────────────────────

/** 工作台首页数据（各能力全部来自 web/workbench/query.ts——页面零自算，D26：
 *  成员过滤与统计口径已在该层锁定，indexPage 只渲染） */
export interface WorkbenchHomeData {
  readonly summary: WorkbenchSummary;
  readonly vaults: readonly VaultCard[];
  readonly docs: readonly RecentDocumentRow[];
  /** 页头索引状态位数据（S15-T2，D4：search_index_state 聚合——查询面已做成员过滤） */
  readonly indexStatus: IndexStatus;
  /** 跨库文档表视图（S15-T2，D5：querystring 记忆 view=list|grid；缺省 list——纯呈现偏好） */
  readonly view?: 'list' | 'grid';
}

/** 角色徽章文案（与 browse/pages.ts 同映射；本文件不 import browse——防环） */
const WORKBENCH_ROLE_LABELS: Readonly<Record<string, string>> = { admin: '管理员', editor: '编辑者', reader: '读者' };

/**
 * 图标片四色变奏（S16-T1 DESIGN v2 §5：tint/sand/lilac/teal——§1 装饰色仅限
 * 图标底）；按卡片序号循环取色，字形用原型同款文字字形（▦ 文库 / ▤ 文档）。
 */
const CHIP_VARIANTS: readonly string[] = ['v-tint', 'v-sand', 'v-lilac', 'v-teal'];

/** 概览卡（统计卡：值为查询面原样，绝对时间 title 可选；图标片由 CSS ::before 承载） */
function statCardHtml(value: string, label: string, title?: string): string {
  const t = title === undefined ? '' : ` title="${escapeHtml(title)}"`;
  return `<div class="stat-card"><span class="stat-value"${t}>${escapeHtml(value)}</span><span class="stat-label">${escapeHtml(label)}</span></div>`;
}

/** 我的文库卡（最后更新=相对时间＋绝对 title；无提交库如实「暂无发布」，D30 时钟源=审计 occurred_at） */
function workbenchVaultCardHtml(v: VaultCard, index: number): string {
  const role = WORKBENCH_ROLE_LABELS[v.role] ?? escapeHtml(v.role);
  const meta =
    v.lastCommitAt === null
      ? `<span class="vault-card-meta">${escapeHtml(String(v.docCount))} 篇 · 暂无发布</span>`
      : `<span class="vault-card-meta" title="${escapeHtml(v.lastCommitAt)}">${escapeHtml(String(v.docCount))} 篇 · ${escapeHtml(formatRelativeTime(v.lastCommitAt))}</span>`;
  return `<a class="vault-card" href="/vaults/${encodeURIComponent(v.slug)}/browse">
    <span class="vault-chip ${CHIP_VARIANTS[index % CHIP_VARIANTS.length]}" aria-hidden="true">▦</span>
    <span class="vault-name">${escapeHtml(v.name)}</span>
    <span class="vault-slug">${escapeHtml(v.slug)}</span>
    <span class="badge">${role}</span>
    ${meta}
  </a>`;
}

/**
 * 跨库最近文档表行（data 属性为一致性断言所依）。
 * view 链接与 browse viewUrl 同构（逐段 encodeURIComponent；本文件不 import
 * browse——防环，同 activityViewHref 手法）；维护者=Git 提交者元数据（DOD-03/
 * D25）——单元格 title 与区块脚注双通道如实标注；更新时间=服务端审计时间。
 */
function workbenchDocRowHtml(d: RecentDocumentRow): string {
  const view = activityViewHref(d.vaultSlug, d.path);
  const chips =
    d.tags.length === 0
      ? ''
      : `<span class="tag-chips">${d.tags.map((t) => `<span class="badge">${escapeHtml(t)}</span>`).join('')}</span>`;
  const titleLink = `<a href="${view}">${escapeHtml(d.title ?? d.path)}</a>`;
  const pathPart = d.title === null ? '' : `<span class="doc-row-path">${escapeHtml(d.path)}</span>`;
  return `<tr data-vault="${escapeHtml(d.vaultSlug)}" data-path="${escapeHtml(d.path)}" data-commit="${escapeHtml(d.commitOid)}">
      <td>${titleLink}${pathPart}${chips}</td>
      <td class="col-tertiary"><a href="/vaults/${encodeURIComponent(d.vaultSlug)}">${escapeHtml(d.vaultName)}</a></td>
      <td class="col-secondary" title="Git 提交者元数据，非认证身份（操作主体以服务端审计记录为准）">${escapeHtml(d.author)}</td>
      <td class="col-tertiary" title="${escapeHtml(d.occurredAt)}">${escapeHtml(formatRelativeTime(d.occurredAt))}</td>
    </tr>`;
}

/**
 * 页头索引状态位（S15-T2，D4 三态如实，零示意值）：
 * - 健康：相对时间文本 ＋ 绝对时间 title（查询面原值）。
 * - 失败：警示态类（styles.css 落 warning token）＋ title 含 lastError 摘要——
 *   索引失败不阻断发布（架构 §9），在此如实可见、不粉饰为健康。
 * - 无索引行：如实「尚未建立索引」，不虚构时间。
 */
function indexStatusHtml(s: IndexStatus): string {
  if (s.lastIndexedAt === null) {
    return '<p class="index-status is-empty">尚未建立索引</p>';
  }
  if (s.failing) {
    const t = s.lastError === null ? '' : ` title="${escapeHtml(`索引失败：${s.lastError}`)}"`;
    return `<p class="index-status is-failing"${t}>索引更新失败</p>`;
  }
  return `<p class="index-status is-healthy" title="${escapeHtml(s.lastIndexedAt)}">索引已更新 · ${escapeHtml(formatRelativeTime(s.lastIndexedAt))}</p>`;
}

/**
 * 跨库文档网格卡（view=grid，D5）：复用既有 vault-card/vault-grid token 卡形态
 * （不新引表面色）；整卡链接=viewUrl 同构；卡题=title（无 title 如实落路径，
 * 与列表行同语义）。
 */
function workbenchDocCardHtml(d: RecentDocumentRow, index: number): string {
  const chips =
    d.tags.length === 0
      ? ''
      : `<span class="tag-chips">${d.tags.map((t) => `<span class="badge">${escapeHtml(t)}</span>`).join('')}</span>`;
  return `<a class="vault-card" href="${activityViewHref(d.vaultSlug, d.path)}">
    <span class="vault-chip ${CHIP_VARIANTS[index % CHIP_VARIANTS.length]}" aria-hidden="true">▤</span>
    <span class="vault-name">${escapeHtml(d.title ?? d.path)}</span>
    <span class="doc-row-path">${escapeHtml(d.path)}</span>
    <span class="badge">${escapeHtml(d.vaultName)}</span>
    <span class="vault-card-meta" title="${escapeHtml(d.occurredAt)}">${escapeHtml(formatRelativeTime(d.occurredAt))}</span>${chips}
  </a>`;
}

/** 视图开关（D5 零 JS：纯 <a href> 携带 query——category-tab token 语义，当前态 aria-current） */
function viewToggleHtml(view: 'list' | 'grid'): string {
  return `<p class="view-toggle">视图：<a href="/?view=list"${view === 'list' ? ' aria-current="page"' : ''}>列表</a><a href="/?view=grid"${view === 'grid' ? ' aria-current="page"' : ''}>网格</a></p>`;
}

/**
 * 工作台首页（S14-T3 `/` 原地升级）：页头（索引状态位，S15-T2 接线）＋ 概览三卡
 * ＋ 我的文库卡片网格（首张「全部文库」聚合卡跳 /vaults，Q-E4-1——原「知识库」
 * 入口卡的等价承接）＋ 跨库最近文档表（S15-T2 起视图开关 list|grid ＋ 表尾可见性
 * 语义声明）＋ 最近变更事件流（次级区块，activity 数据面保留）。原三张
 * feature-card 入口卡移除：/credentials 与 /admin 由侧栏承接（S14-T2 壳），
 * /vaults 由聚合卡承接——导航可达性零回归。
 * 一切数字与状态来自 WorkbenchHomeData（workbench/query.ts 四能力，D26 同源同
 * 过滤已在该层锁定）；插值唯一通道 escapeHtml。
 */
export function indexPage(
  user: { username: string; display_name: string; is_instance_admin: boolean },
  workbench: WorkbenchHomeData,
  recent?: readonly ActivityEntry[],
): string {
  const { summary, vaults, docs } = workbench;
  const updateStat =
    summary.lastContentUpdateAt === null
      ? statCardHtml('暂无', '最近一次内容更新')
      : statCardHtml(formatRelativeTime(summary.lastContentUpdateAt), '最近一次内容更新', summary.lastContentUpdateAt);
  const statGrid = `<div class="stat-grid">
    ${statCardHtml(String(summary.vaultCount), '可访问文库')}
    ${statCardHtml(`${summary.publishedDocCount} 篇`, '已发布文档')}
    ${updateStat}
  </div>`;

  const vaultCardRows = vaults.map(workbenchVaultCardHtml).join('\n  ');
  const vaultSection = `<section aria-label="我的文库">
  <div class="section-head">
    <h2>我的文库</h2>
    <p class="page-meta">按你的成员关系实时呈现 · 一个文库对应一个知识仓库。</p>
  </div>
  <div class="vault-grid">
  <a class="vault-card vault-card-all" href="/vaults">
    <span class="vault-chip v-tint" aria-hidden="true">▦</span>
    <span class="vault-name">全部文库</span>
    <span class="vault-slug">${escapeHtml(String(summary.vaultCount))} 个文库 · 你有权访问</span>
  </a>${vaults.length === 0 ? '' : `\n  ${vaultCardRows}`}
  </div>
  ${vaults.length === 0 ? '<p class="state-note">尚无可访问文库（被授权后在此呈现）。</p>' : ''}
  </section>`;

  // S15-T2（D5）：视图开关 view=list|grid（querystring，默认 list）——grid 复用
  // vault-card/vault-grid 卡形态；非法值由接线层白名单回落 list，本处只收两态。
  const view = workbench.view ?? 'list';
  const docBody =
    docs.length === 0
      ? '<p class="state-note">尚无最近发布的文档（各库发布动作产生后在此呈现）。</p>'
      : view === 'grid'
        ? `<div class="vault-grid">\n  ${docs.map(workbenchDocCardHtml).join('\n  ')}\n  </div>`
        : `<div class="table-wrap">
  <table>
  <thead><tr><th>文档</th><th class="col-tertiary">所属库</th><th class="col-secondary">维护者</th><th class="col-tertiary">更新时间</th></tr></thead>
  <tbody>
  ${docs.map(workbenchDocRowHtml).join('\n')}
  </tbody>
  </table>
  </div>`;
  const docSection = `<section aria-label="跨库最近文档">
  <div class="section-head">
    <h2>跨库最近文档</h2>
    <p class="page-meta">按服务端审计时间排序的成功发布事件（触及文档路径，最近 ${escapeHtml(String(docs.length))} 条；路径与维护者从该次提交的 Git 记录派生）。维护者=Git 提交者元数据，非认证身份——操作主体以服务端审计记录为准。</p>
    ${viewToggleHtml(view)}
  </div>
  ${docBody}
  <p class="page-meta visibility-note">呈现已发布知识；草稿仅创建者可见。搜索与列表遵循文库成员权限。</p>
  </section>`;

  const entries = recent ?? [];
  const activityBody =
    entries.length === 0
      ? '<p class="state-note">尚无最近变更（各库发布动作产生后在此呈现）。</p>'
      : `<ul class="commits">\n  ${entries.map(activityEntryRow).join('\n  ')}\n  </ul>`;
  const activitySection = `<section class="card" aria-label="最近变更">
  <h2>最近变更</h2>
  ${activityBody}
  <p class="page-meta">按你的成员关系呈现各库最近发布（成功发布事件，最近 ${ACTIVITY_LIMIT} 条；主体=服务端审计记录的认证员工）。</p>
  </section>`;

  return layout(
    '工作台',
    `<div class="page">
  <div class="page-head">
    <h1>工作台</h1>
    <p class="page-meta">跨库知识工作台 · 数据按你的文库成员关系实时呈现</p>
    <!-- 索引状态位：S15-T2 已接线（search_index_state 实时面，三态如实零示意值——成员过滤在查询面锁定） -->
    ${indexStatusHtml(workbench.indexStatus)}
  </div>
  ${statGrid}
  ${vaultSection}
  ${docSection}
  ${activitySection}
</div>
`,
    '',
    {
      user: { username: user.username, isAdmin: user.is_instance_admin, displayName: user.display_name },
      active: 'home',
    },
  );
}

/** 管理页（UI-RESTYLE：分区 admin-section 米色卡 + 表格包裹层 + 一次性令牌深色窗） */
export function adminPage(viewer?: { username: string; is_instance_admin: boolean }): string {
  return layout(
    '管理',
    `<div class="page">
  <div class="page-head">
    <h1>Notegit 管理</h1>
    <p class="page-meta"><a href="/">← 返回</a></p>
  </div>

  <section class="admin-section">
  <h2>员工管理</h2>
  <div class="table-wrap">
  <table id="employees-table">
    <thead><tr><th>用户名</th><th>显示名</th><th>状态</th><th>实例管理员</th><th>创建时间</th><th>操作</th></tr></thead>
    <tbody></tbody>
  </table>
  </div>
  <p><button id="employees-more" type="button" hidden>加载更多</button></p>
  <p><output id="employees-msg"></output></p>
  </section>

  <section class="admin-section">
  <h2>邀请创建</h2>
  <form id="invite-form">
    <div class="form-row">
    <label>用户名 <input name="username" required></label>
    <label>显示名 <input name="display_name" required></label>
    </div>
    <p><button type="submit" class="btn-primary">邀请</button></p>
  </form>
  <p>一次性口令重置令牌（明文仅此一次，经企业内渠道交付）：</p>
  <pre id="invite-token" class="token-view"></pre>
  <p><output id="invite-msg"></output></p>
  </section>

  <section class="admin-section">
  <h2>建库</h2>
  <form id="vault-form">
    <div class="form-row">
    <label>库名 <input name="name" required></label>
    <label>slug <input name="slug" pattern="[a-z0-9-]{1,64}" required></label>
    </div>
    <p><button type="submit" class="btn-primary">建库</button></p>
  </form>
  <p><output id="vault-msg"></output></p>
  </section>

  <section class="admin-section">
  <h2>成员与角色管理（我任库管理员的库）</h2>
  <p class="toolbar"><select id="member-vault"></select> <button id="member-load" type="button">加载成员</button></p>
  <div class="table-wrap">
  <table id="members-table">
    <thead><tr><th>用户名</th><th>显示名</th><th>角色</th><th>授权时间</th><th>操作</th></tr></thead>
    <tbody></tbody>
  </table>
  </div>
  <form id="member-form">
    <div class="form-row">
    <label>用户名 <input name="username" required></label>
    <label>角色 <select name="role"><option value="reader">reader</option><option value="editor">editor</option><option value="admin">admin</option></select></label>
    </div>
    <p><button type="submit" class="btn-primary">授权 / 改角色</button></p>
  </form>
  <p><output id="member-msg"></output></p>
  <p>重置口令的一次性令牌（明文仅此一次，独立于邀请令牌展示）：</p>
  <pre id="reset-token" class="token-view"></pre>
  </section>

  <section class="admin-section">
  <h2>维护模式</h2>
  <p class="toolbar"><button id="maint-on" type="button">开启维护模式</button> <button id="maint-off" type="button">关闭维护模式</button></p>
  <p>（实例级写闸门：开启后业务与管理写一律 503，登录与读放行；当前状态无查询端点——见 docs/credentials-ops.md 与任务 notes）</p>
  <p><output id="maint-msg"></output></p>
  </section>
</div>
`,
    `${SHARED_ALIAS}

// —— 员工管理：列表（分页 limit=50 + cursor「加载更多」）+ 停用/启用 + 实例管理员开关 + 重置口令 ——

let employeesCursor = null;
async function loadEmployees(append) {
  const tbody = document.querySelector('#employees-table tbody');
  if (!append) {
    tbody.textContent = '';
    employeesCursor = null;
  }
  try {
    const url = employeesCursor === null
      ? '/api/v1/admin/employees'
      : '/api/v1/admin/employees?cursor=' + encodeURIComponent(employeesCursor);
    const page = await api('GET', url);
    for (const e of page.employees) {
      const tr = document.createElement('tr');
      const cells = [e.username, e.display_name, e.active ? '在岗' : '已停用',
        e.is_instance_admin ? '是' : '否', e.created_at];
      for (const text of cells) {
        const td = document.createElement('td');
        td.textContent = String(text);
        tr.appendChild(td);
      }
      const td = document.createElement('td');
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.textContent = e.active ? '停用' : '启用';
      toggle.addEventListener('click', async () => {
        try {
          await api('PATCH', '/api/v1/admin/employees/' + encodeURIComponent(e.username),
            { active: !e.active });
          await loadEmployees(false);
        } catch (err) { show(document.getElementById('employees-msg'), err.message); }
      });
      td.appendChild(toggle);
      const reset = document.createElement('button');
      reset.type = 'button';
      reset.textContent = '重置口令';
      reset.addEventListener('click', async () => {
        try {
          const r = await api('POST',
            '/api/v1/admin/employees/' + encodeURIComponent(e.username) + '/password-reset');
          // 独立展示区（不覆盖尚未交付的邀请令牌——两者明文都仅此一次，覆盖即丢失）
          document.getElementById('reset-token').textContent = r.password_reset_token || '';
          show(document.getElementById('employees-msg'),
            e.username + ' 的重置令牌已生成（30 分钟内单次有效，见下方重置令牌区）');
        } catch (err) { show(document.getElementById('employees-msg'), err.message); }
      });
      td.appendChild(reset);
      if (e.is_instance_admin === false) {
        const promote = document.createElement('button');
        promote.type = 'button';
        promote.textContent = '设为实例管理员';
        promote.addEventListener('click', async () => {
          try {
            await api('PATCH', '/api/v1/admin/employees/' + encodeURIComponent(e.username),
              { active: e.active, is_instance_admin: true });
            await loadEmployees(false);
          } catch (err) { show(document.getElementById('employees-msg'), err.message); }
        });
        td.appendChild(promote);
      }
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
    employeesCursor = page.next_cursor;
    document.getElementById('employees-more').hidden = employeesCursor === null;
    show(document.getElementById('employees-msg'), append
      ? '已追加 ' + page.employees.length + ' 名（继续点「加载更多」翻页）'
      : '本页 ' + page.employees.length + ' 名员工' + (employeesCursor ? '（还有更多）' : ''));
  } catch (err) {
    show(document.getElementById('employees-msg'), '加载失败：' + err.message);
  }
}
loadEmployees(false);
document.getElementById('employees-more').addEventListener('click', () => loadEmployees(true));

document.getElementById('invite-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  try {
    const r = await api('POST', '/api/v1/admin/employees', {
      username: f.username.value, display_name: f.display_name.value,
    });
    document.getElementById('invite-token').textContent = r.password_reset_token || '';
    show(document.getElementById('invite-msg'), '已邀请 ' + r.username);
    f.reset();
    await loadEmployees();
  } catch (err) {
    show(document.getElementById('invite-msg'), '邀请失败：' + err.message);
  }
});

// —— 建库（api.md §5：任意 active 员工；创建者自动库管理员） ——

document.getElementById('vault-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  try {
    const r = await api('POST', '/api/v1/vaults', { name: f.name.value, slug: f.slug.value });
    show(document.getElementById('vault-msg'), '已建库：' + r.slug + '（默认分支 main，你是库管理员）');
    await loadVaultOptions();
  } catch (err) {
    show(document.getElementById('vault-msg'), '建库失败：' + err.message);
  }
});

// —— 成员与角色管理：我任库管理员的库（GET /api/v1/vaults 只列本人成员关系） ——

async function loadVaultOptions() {
  const sel = document.getElementById('member-vault');
  sel.textContent = '';
  try {
    const { vaults } = await api('GET', '/api/v1/vaults');
    for (const v of vaults.filter((x) => x.role === 'admin')) {
      const opt = document.createElement('option');
      opt.value = v.slug;
      opt.textContent = v.slug + '（' + v.name + '）';
      sel.appendChild(opt);
    }
  } catch (err) {
    show(document.getElementById('member-msg'), '库列表加载失败：' + err.message);
  }
}
loadVaultOptions();

async function loadMembers() {
  const slug = document.getElementById('member-vault').value;
  if (!slug) return;
  const tbody = document.querySelector('#members-table tbody');
  tbody.textContent = '';
  try {
    const { members } = await api('GET', '/api/v1/vaults/' + encodeURIComponent(slug) + '/members');
    for (const m of members) {
      const tr = document.createElement('tr');
      for (const text of [m.username, m.display_name, m.role, m.granted_at]) {
        const td = document.createElement('td');
        td.textContent = String(text);
        tr.appendChild(td);
      }
      const td = document.createElement('td');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = '撤权';
      btn.addEventListener('click', async () => {
        try {
          await api('DELETE', '/api/v1/vaults/' + encodeURIComponent(slug)
            + '/members/' + encodeURIComponent(m.username));
          await loadMembers();
        } catch (err) { show(document.getElementById('member-msg'), err.message); }
      });
      td.appendChild(btn);
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
    show(document.getElementById('member-msg'), slug + '：' + members.length + ' 名成员');
  } catch (err) {
    show(document.getElementById('member-msg'), '成员加载失败：' + err.message);
  }
}
document.getElementById('member-load').addEventListener('click', loadMembers);

document.getElementById('member-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const slug = document.getElementById('member-vault').value;
  const f = ev.target;
  if (!slug) { show(document.getElementById('member-msg'), '先选择库'); return; }
  try {
    await api('PUT', '/api/v1/vaults/' + encodeURIComponent(slug)
      + '/members/' + encodeURIComponent(f.username.value), { role: f.role.value });
    show(document.getElementById('member-msg'), '已授权 ' + f.username.value + ' 为 ' + f.role.value);
    await loadMembers();
  } catch (err) {
    show(document.getElementById('member-msg'), '授权失败：' + err.message);
  }
});

// —— 维护模式（T7 端点：POST 开启 / DELETE 关闭；实例管理员） ——

document.getElementById('maint-on').addEventListener('click', async () => {
  try {
    await api('POST', '/api/v1/admin/maintenance');
    show(document.getElementById('maint-msg'), '已进入维护模式（写入被拒，登录与读放行）');
  } catch (err) { show(document.getElementById('maint-msg'), err.message); }
});
document.getElementById('maint-off').addEventListener('click', async () => {
  try {
    await api('DELETE', '/api/v1/admin/maintenance');
    show(document.getElementById('maint-msg'), '已退出维护模式');
  } catch (err) { show(document.getElementById('maint-msg'), err.message); }
});
`,
    viewer !== undefined ? { user: { username: viewer.username, isAdmin: viewer.is_instance_admin }, active: 'admin' } : undefined,
    true, // S12-T3：引用共享脚本 /assets/app.js（FETCH_HELPER 迁出——行为零变化）
  );
}

/** 员工自助凭据页（UI-RESTYLE：分区卡 + 表格包裹层 + 一次性令牌深色窗） */
export function credentialsPage(viewer?: { username: string; is_instance_admin: boolean }): string {
  return layout(
    '我的访问凭据',
    `<div class="page">
  <div class="page-head">
    <h1>我的访问凭据</h1>
    <p class="page-meta"><a href="/">← 返回</a></p>
  </div>

  <section class="admin-section">
  <h2>创建凭据</h2>
  <form id="cred-form">
    <div class="form-row">
    <label>名称 <input name="name" placeholder="如：本地 Harness" required></label>
    <label>到期 <input name="expires_at" type="datetime-local" required></label>
    <label>权限 <select name="access"><option value="read_write">read_write（默认）</option><option value="read">read</option></select></label>
    </div>
    <label>库范围（可空 = 全部有权库；逗号分隔 slug 清单 = 只能收窄） <input name="vaults" placeholder="vault-a, vault-b"></label>
    <p><button type="submit" class="btn-primary">创建</button></p>
  </form>
  <p><strong>新凭据明文仅此一次展示，关闭/刷新后不可再取（identity §3.1）：</strong></p>
  <pre id="cred-token" class="token-view"></pre>
  <p><output id="cred-msg"></output></p>
  </section>

  <section class="admin-section">
  <h2>我的凭据（脱敏显示）</h2>
  <div class="table-wrap">
  <table id="cred-table">
    <thead><tr><th>名称</th><th>凭据</th><th>权限</th><th>库范围</th><th>创建</th><th>到期</th><th>最近使用</th><th>状态</th><th>操作</th></tr></thead>
    <tbody></tbody>
  </table>
  </div>
  <p><output id="cred-list-msg"></output></p>
  </section>
</div>
`,
    `${SHARED_ALIAS}

async function loadCredentials() {
  const tbody = document.querySelector('#cred-table tbody');
  tbody.textContent = '';
  try {
    const { credentials } = await api('GET', '/api/v1/credentials');
    for (const c of credentials) {
      const tr = document.createElement('tr');
      const scopeText = c.scope_access + (c.scope_vaults.length ? '（' + c.scope_vaults.join(', ') + '）' : '（全部有权库）');
      for (const text of [c.name, c.display_hint, scopeText, c.created_at, c.expires_at,
        c.last_used_at || '—', c.revoked_at ? '已撤销' : '有效']) {
        const td = document.createElement('td');
        td.textContent = String(text);
        tr.appendChild(td);
      }
      const td = document.createElement('td');
      if (!c.revoked_at) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = '撤销';
        btn.addEventListener('click', async () => {
          try {
            await api('DELETE', '/api/v1/credentials/' + c.id);
            await loadCredentials();
          } catch (err) { show(document.getElementById('cred-list-msg'), err.message); }
        });
        td.appendChild(btn);
      }
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
    show(document.getElementById('cred-list-msg'), '共 ' + credentials.length + ' 条');
  } catch (err) {
    show(document.getElementById('cred-list-msg'), '加载失败：' + err.message);
  }
}
loadCredentials();

document.getElementById('cred-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const scope = { access: f.access.value };
  const vaults = f.vaults.value.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  if (vaults.length > 0) scope.vaults = vaults;
  try {
    const r = await api('POST', '/api/v1/credentials', {
      name: f.name.value,
      expires_at: new Date(f.expires_at.value).toISOString(),
      scope,
    });
    document.getElementById('cred-token').textContent = r.token || '';
    show(document.getElementById('cred-msg'), '已创建（' + r.display_hint + '）——明文仅此一次，请立即保存');
    f.reset();
    await loadCredentials();
  } catch (err) {
    show(document.getElementById('cred-msg'), '创建失败：' + err.message);
  }
});
`,
    viewer !== undefined ? { user: { username: viewer.username, isAdmin: viewer.is_instance_admin }, active: 'credentials' } : undefined,
    true, // S12-T3：引用共享脚本 /assets/app.js（FETCH_HELPER 迁出——行为零变化）
  );
}

/** S4-T1 起：页面 404（无权库与不存在同页同码，D-IC-06 页面形态） */
export function notFoundPage(): string {
  return layout(
    '404',
    `<div class="center-card-wrap">
  <div class="center-card">
    <h1>404</h1>
    <p>页面不存在或无权访问。</p>
    <p><a href="/">返回首页</a></p>
  </div>
</div>
`,
  );
}
