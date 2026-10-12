/**
 * S2-T8 最小页面 HTML（架构 §6 完整 Web 整理属 S4——「最小」=可用即可：无样式、
 * 无路由框架、无前端构建）。页面 = 服务端渲染的外壳 + 页内 fetch 调 api.md 既有
 * 端点（同源；浏览器对非安全方法自动带 Origin，兼容 T5 CSRF 守卫链
 * Origin→Referer→reject——auth/csrf.ts）。动态数据一律 textContent 注入（无
 * innerHTML，防 XSS）；一次性明文（邀请/重置令牌、凭据 token）仅在创建响应后
 * 展示一次，刷新即失（identity §3.1/§7.2）。
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

function layout(title: string, body: string, script = ''): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — Notegit</title>
</head>
<body>
${body}
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
  return layout('登录', `
<h1>Notegit 登录</h1>
<form id="login-form">
  <label>用户名 <input name="username" autocomplete="username" required></label><br>
  <label>口令 <input name="password" type="password" autocomplete="current-password" required></label><br>
  <button type="submit">登录</button>
</form>
<p id="login-error" role="alert"></p>
`, `${FETCH_HELPER}
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
`);
}

/** 入口页：服务端渲染当前员工与入口清单——管理入口仅实例管理员可见（S2-T8 验收断言） */
export function indexPage(user: { username: string; display_name: string; is_instance_admin: boolean }): string {
  const adminEntry = user.is_instance_admin ? '\n  <p><a href="/admin">管理</a>（员工、邀请、库、成员角色、维护模式）</p>' : '';
  return layout('首页', `
<h1>Notegit</h1>
<p>当前登录：<strong>${escapeHtml(user.display_name)}</strong>（${escapeHtml(user.username)}）</p>
<p><a href="/credentials">我的访问凭据</a>（创建 / 撤销 / 查看，脱敏显示）</p>${adminEntry}
<p><button id="logout">退出登录</button></p>
<p id="logout-msg"></p>
`, `${FETCH_HELPER}
document.getElementById('logout').addEventListener('click', async () => {
  try {
    await api('POST', '/api/v1/auth/logout');
    location.href = '/login';
  } catch (err) {
    show(document.getElementById('logout-msg'), '退出失败：' + err.message);
  }
});
`);
}

export function adminPage(): string {
  return layout('管理', `
<h1>Notegit 管理</h1>
<p><a href="/">← 返回</a></p>

<h2>员工管理</h2>
<table id="employees-table">
  <thead><tr><th>用户名</th><th>显示名</th><th>状态</th><th>实例管理员</th><th>创建时间</th><th>操作</th></tr></thead>
  <tbody></tbody>
</table>
<p><output id="employees-msg"></output></p>

<h2>邀请创建</h2>
<form id="invite-form">
  <label>用户名 <input name="username" required></label>
  <label>显示名 <input name="display_name" required></label>
  <button type="submit">邀请</button>
</form>
<p>一次性口令重置令牌（明文仅此一次，经企业内渠道交付）：</p>
<pre id="invite-token"></pre>
<p><output id="invite-msg"></output></p>

<h2>建库</h2>
<form id="vault-form">
  <label>库名 <input name="name" required></label>
  <label>slug <input name="slug" pattern="[a-z0-9-]{1,64}" required></label>
  <button type="submit">建库</button>
</form>
<p><output id="vault-msg"></output></p>

<h2>成员与角色管理（我任库管理员的库）</h2>
<p><select id="member-vault"></select> <button id="member-load" type="button">加载成员</button></p>
<table id="members-table">
  <thead><tr><th>用户名</th><th>显示名</th><th>角色</th><th>授权时间</th><th>操作</th></tr></thead>
  <tbody></tbody>
</table>
<form id="member-form">
  <label>用户名 <input name="username" required></label>
  <label>角色 <select name="role"><option value="reader">reader</option><option value="editor">editor</option><option value="admin">admin</option></select></label>
  <button type="submit">授权 / 改角色</button>
</form>
<p><output id="member-msg"></output></p>

<h2>维护模式</h2>
<p><button id="maint-on" type="button">开启维护模式</button> <button id="maint-off" type="button">关闭维护模式</button></p>
<p>（实例级写闸门：开启后业务与管理写一律 503，登录与读放行；当前状态无查询端点——见 docs/credentials-ops.md 与任务 notes）</p>
<p><output id="maint-msg"></output></p>
`, `${FETCH_HELPER}

// —— 员工管理：列表 + 停用/启用 + 实例管理员开关 + 重置口令 ——

async function loadEmployees() {
  const tbody = document.querySelector('#employees-table tbody');
  tbody.textContent = '';
  try {
    const { employees } = await api('GET', '/api/v1/admin/employees');
    for (const e of employees) {
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
          await loadEmployees();
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
          document.getElementById('invite-token').textContent = r.password_reset_token || '';
          show(document.getElementById('employees-msg'),
            e.username + ' 的重置令牌已生成（30 分钟内单次有效，见上方一次性令牌区）');
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
            await loadEmployees();
          } catch (err) { show(document.getElementById('employees-msg'), err.message); }
        });
        td.appendChild(promote);
      }
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
    show(document.getElementById('employees-msg'), '共 ' + employees.length + ' 名员工');
  } catch (err) {
    show(document.getElementById('employees-msg'), '加载失败：' + err.message);
  }
}
loadEmployees();

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
`);
}

export function credentialsPage(): string {
  return layout('我的访问凭据', `
<h1>我的访问凭据</h1>
<p><a href="/">← 返回</a></p>

<h2>创建凭据</h2>
<form id="cred-form">
  <label>名称 <input name="name" placeholder="如：本地 Harness" required></label>
  <label>到期 <input name="expires_at" type="datetime-local" required></label>
  <label>权限 <select name="access"><option value="read_write">read_write（默认）</option><option value="read">read</option></select></label>
  <label>库范围（可空 = 全部有权库；逗号分隔 slug 清单 = 只能收窄） <input name="vaults" placeholder="vault-a, vault-b"></label>
  <button type="submit">创建</button>
</form>
<p><strong>新凭据明文仅此一次展示，关闭/刷新后不可再取（identity §3.1）：</strong></p>
<pre id="cred-token"></pre>
<p><output id="cred-msg"></output></p>

<h2>我的凭据（脱敏显示）</h2>
<table id="cred-table">
  <thead><tr><th>名称</th><th>凭据</th><th>权限</th><th>库范围</th><th>创建</th><th>到期</th><th>最近使用</th><th>状态</th><th>操作</th></tr></thead>
  <tbody></tbody>
</table>
<p><output id="cred-list-msg"></output></p>
`, `${FETCH_HELPER}

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
`);
}
