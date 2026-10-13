/**
 * S2-T8 最小页面 HTML（架构 §6 完整 Web 整理属 S4——「最小」=可用即可：无路由
 * 框架、无前端构建）。页面 = 服务端渲染的外壳 + 页内 fetch 调 api.md 既有
 * 端点（同源；浏览器对非安全方法自动带 Origin，兼容 T5 CSRF 守卫链
 * Origin→Referer→reject——auth/csrf.ts）。动态数据一律 textContent 注入（无
 * innerHTML，防 XSS）；一次性明文（邀请/重置令牌、凭据 token）仅在创建响应后
 * 展示一次，刷新即失（identity §3.1/§7.2）。
 *
 * UI-RESTYLE：layout() 升级为 DESIGN.md 视觉契约壳（top-nav 64px 米色栏 +
 * spike-mark 字标 + 深色页脚；样式唯一来源 /assets/styles.css——见 web/assets.ts
 * 与 assets/styles.css 头注）。插值通道不变：文本仅 escapeHtml；结构与类名由
 * 本模板生成。每页恰好一个 <script> 块（既有测试断言）。
 */

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
 * - user 存在 → 右侧呈现用户名；isAdmin 才出现「管理」菜单项
 *   （S2-T8 验收断言「普通成员页面任何位置不得出现 /admin」——本字段唯一来源）。
 * - active → 当前区段落位（aria-current 高亮）。
 */
export interface PageNav {
  readonly user?: { readonly username: string; readonly isAdmin: boolean };
  readonly active?: 'home' | 'vaults' | 'search' | 'cite' | 'credentials' | 'admin';
}

/** 品牌标记：4-spoke 径向星芒（DESIGN.md「spike-mark 风格标记」；inline SVG，随色继承） */
const SPIKE_MARK =
  '<svg class="spike-mark" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><g stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M5.6 5.6 18.4 18.4"/><path d="M18.4 5.6 5.6 18.4"/></g></svg>';

const NAV_ITEMS: ReadonlyArray<{ readonly href: string; readonly label: string; readonly key: NonNullable<PageNav['active']> }> = [
  { href: '/search', label: '查找', key: 'search' },
  { href: '/cite', label: '引用解析', key: 'cite' },
  { href: '/credentials', label: '我的凭据', key: 'credentials' },
];

function topNav(nav?: PageNav): string {
  const items = NAV_ITEMS.map(
    (it) =>
      `<li><a href="${it.href}"${nav?.active === it.key ? ' aria-current="page"' : ''}>${it.label}</a></li>`,
  );
  const adminItem =
    nav?.user?.isAdmin === true
      ? `\n      <li><a href="/admin"${nav.active === 'admin' ? ' aria-current="page"' : ''}>管理</a></li>`
      : '';
  const user = nav?.user !== undefined ? `\n      <span class="nav-user" title="${escapeHtml(nav.user.username)}">${escapeHtml(nav.user.username)}</span>` : '';
  // 主 CTA：知识库（产品主入口；登录页由登录按钮承担 CTA，不重复呈现）
  const cta = nav?.active === 'home' ? '' : '\n      <a class="btn btn-primary" href="/vaults">知识库</a>';
  return `<header class="top-nav">
  <div class="top-nav-inner">
    <a class="brand" href="/">${SPIKE_MARK}Notegit</a>
    <ul class="nav-menu">
      ${items.join('\n      ')}${adminItem}
    </ul>
    <div class="nav-side">${user}${cta}
    </div>
  </div>
</header>`;
}

const SITE_FOOTER = `<footer class="site-footer">
  <div class="site-footer-inner">
    <span class="brand">${SPIKE_MARK}Notegit</span>
    <nav class="site-footer-links" aria-label="页脚">
      <a href="/search">查找</a>
      <a href="/cite">引用解析</a>
      <a href="/credentials">我的凭据</a>
    </nav>
    <span class="foot-fine">团队知识库 · 服务端渲染</span>
  </div>
</footer>`;

export function layout(title: string, body: string, script = '', nav?: PageNav): string {
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
<main>
${body}
</main>
${SITE_FOOTER}
<script>
${script}
</script>
</body>
</html>`;
}

/** 同源 fetch JSON 封装：非 2xx 时抛出含错误码的可读信息（页面统一呈现） */
const FETCH_HELPER = `
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = data.error || {};
    throw new Error((err.code || res.status) + ': ' + (err.message || JSON.stringify(data)));
  }
  return data;
}
function show(el, text) { el.textContent = text; }
`;

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
    `${FETCH_HELPER}
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
  );
}

/**
 * 入口页：服务端渲染当前员工与入口清单——管理入口仅实例管理员可见（S2-T8 验收断言）。
 * UI-RESTYLE：入口清单落位 feature-card 网格（DESIGN.md 卡片族；整卡可点）。
 */
export function indexPage(user: { username: string; display_name: string; is_instance_admin: boolean }): string {
  const adminCard = user.is_instance_admin
    ? `
  <a class="feature-card" href="/admin"><h3>管理</h3><p>员工、邀请、库、成员角色、维护模式</p></a>`
    : '';
  return layout(
    '首页',
    `<div class="page">
  <div class="page-head">
    <h1>Notegit</h1>
    <p class="page-meta">当前登录：<strong>${escapeHtml(user.display_name)}</strong>（${escapeHtml(user.username)}）</p>
  </div>
  <div class="card-grid">
  <a class="feature-card" href="/vaults"><h3>知识库</h3><p>有权库列表与目录浏览</p></a>
  <a class="feature-card" href="/credentials"><h3>我的访问凭据</h3><p>创建 / 撤销 / 查看，脱敏显示</p></a>${adminCard}
  </div>
  <p><button id="logout" type="button">退出登录</button></p>
  <p id="logout-msg"></p>
</div>
`,
    `${FETCH_HELPER}
document.getElementById('logout').addEventListener('click', async () => {
  try {
    await api('POST', '/api/v1/auth/logout');
    location.href = '/login';
  } catch (err) {
    show(document.getElementById('logout-msg'), '退出失败：' + err.message);
  }
});
`,
    { user: { username: user.username, isAdmin: user.is_instance_admin }, active: 'home' },
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
    `${FETCH_HELPER}

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
    `${FETCH_HELPER}

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
