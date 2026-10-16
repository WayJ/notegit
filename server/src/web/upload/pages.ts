import { escapeHtml, layout, type PageNav } from '../pages.ts';

/**
 * S4-T8 上传 UI 页模板（T4 遗留收口；breakdown §2.3 S4-T8 行 3）。D5 极简：
 * 服务端渲染 + 页内脚本 fetch 直发 octet-stream（T4 契约形态——唯一内容类型，
 * 不引 multipart）；插值唯一通道 escapeHtml（脚本字面量经 JSON 转义 `<`）。
 *
 * 错误呈现 = S4-T8 统一提示：upload POST 拒绝信封已携带 error.code/message/
 * hint（web/hints.ts 注册表映射），页内直接展示——不在页内复制映射表。
 */

/** 面包屑（与 browse/view/edit 各页同构——模块各自持有，D5） */
function breadcrumb(vault: { slug: string; name: string }, dirPath: string): string {
  const parts = [
    `<a href="/vaults">知识库</a>`,
    `<a href="/vaults/${encodeURIComponent(vault.slug)}/browse">${escapeHtml(vault.name)}</a>`,
  ];
  let acc = '';
  for (const seg of dirPath.split('/').filter((s) => s !== '')) {
    acc = acc === '' ? seg : `${acc}/${seg}`;
    parts.push(
      `<a href="/vaults/${encodeURIComponent(vault.slug)}/browse/${acc
        .split('/')
        .map(encodeURIComponent)
        .join('/')}">${escapeHtml(seg)}</a>`,
    );
  }
  return parts.join(' <span aria-hidden="true">›</span> ');
}

/** 树路径 → URL 段（与 browse/pages.ts encPath 同规则） */
function encPath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/');
}

export interface UploadPageInput {
  readonly vault: { slug: string; name: string };
  /** 上传目标目录（库内相对路径；''=库根）。目录可不存在——路径判定在 POST 走发布组件 */
  readonly dirPath: string;
  /** S10-T2 权限感知：当前会话员工对该库的写权（canWriteVault 实算；false=只读态
   *  ——D4：页面门槛保持 read 成员（200），表单禁用、无提交控件 + 无写权限标注。
   *  缺省 = 写者形态：模板直调测试兼容；生产路由恒传实算值（D17 呈现层）） */
  readonly canWrite?: boolean;
  /** UI-RESTYLE：顶部导航登录态（呈现层透传） */
  readonly viewer?: { username: string; display_name?: string; is_instance_admin: boolean };
}

/** 只读徽章（S10-T2：DESIGN.md badge-pill 形态——`.badge` 既有类，token 语义） */
const READONLY_BADGE = '<span class="badge">只读成员</span>';

export function uploadUrl(slug: string, dirPath: string): string {
  const enc = encPath(dirPath);
  return `/vaults/${encodeURIComponent(slug)}/upload${enc === '' ? '' : '/' + enc}`;
}

export function uploadPage(input: UploadPageInput): string {
  const { vault, dirPath, viewer } = input;
  const title = `上传 — ${vault.name}${dirPath === '' ? '' : ` / ${dirPath}`}`;
  const head = `<div class="page page-narrow">
  <div class="page-head">
  <h1>上传</h1>
  <nav aria-label="面包屑">${breadcrumb(vault, dirPath)} <span aria-hidden="true">›</span> 上传</nav>
  <p class="page-meta">目标目录：<code>${dirPath === '' ? '（库根）' : escapeHtml(dirPath)}</code> · 传输契约：<code>application/octet-stream</code>（原始字节，fetch 直发）</p>
  </div>`;
  const nav: PageNav | undefined =
    viewer !== undefined ? { user: { username: viewer.username, displayName: viewer.display_name, isAdmin: viewer.is_instance_admin }, active: 'vaults' } : undefined;

  // S10-T2 只读态（D4）：页面可达（门槛 read 成员不变）但表单禁用、不渲染提交
  // 控件 + 无写权限标注；无交互脚本（脚本绑定表单元素——禁用态不携带）
  if (input.canWrite === false) {
    return layout(
      title,
      `${head}
  <p class="page-meta">${READONLY_BADGE} 无写权限：你是本库只读成员，不能上传文件。</p>
  <form class="form-card" aria-disabled="true">
  <fieldset disabled>
  <label>文件<br><input type="file" disabled></label>
  <label>上传路径（相对本页目录，可含子目录；须含扩展名）<br>
  <input type="text" placeholder="文件名（选择文件后自动预填）" disabled maxlength="1024"></label>
  <p><small>规则：写入需 editor 及以上角色。</small></p>
  </fieldset>
  </form>
</div>
`,
      '',
      nav,
    );
  }
  const apiBase = `/vaults/${encodeURIComponent(vault.slug)}/upload`;
  const script = `
const DIR = ${JSON.stringify(dirPath)};
const POST_BASE = ${JSON.stringify(apiBase)};

// 选择文件后以文件名预填相对路径（可改——支持再嵌子目录）
document.getElementById('file').addEventListener('change', () => {
  const f = document.getElementById('file').files[0];
  if (f && document.getElementById('relpath').value === '') document.getElementById('relpath').value = f.name;
});

document.getElementById('upload-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const msg = document.getElementById('upload-msg');
  const out = document.getElementById('upload-result');
  const file = document.getElementById('file').files[0];
  const rel = document.getElementById('relpath').value.trim().replace(/^\\/+/, '');
  if (!file) { msg.textContent = '请先选择文件。'; return; }
  if (rel === '') { msg.textContent = '请填写上传路径（相对本页目录）。'; return; }
  const path = DIR === '' ? rel : DIR + '/' + rel;
  try {
    // 传输契约（S4-T4 定形）：fetch 直发原始字节 octet-stream——不引 multipart
    const res = await fetch(POST_BASE + '/' + path.split('/').map(encodeURIComponent).join('/'), {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: file,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // 统一错误提示：拒绝信封携带 error.code/message/hint（web/hints.ts 注册表映射）
      const e = data.error || {};
      msg.textContent = '上传被拒绝：' + (e.code ? e.code + ' ' : '') + (e.message || data.reason || res.status)
        + (e.hint ? '——建议：' + e.hint : '');
      out.textContent = '';
      return;
    }
    msg.textContent = '已上传（commit ' + (data.commit || '?') + '）：' + data.path;
    out.textContent = '';
    if (data.url) {
      const md = '![](' + data.url + ')';
      out.innerHTML = '';
      const a = document.createElement('a');
      a.href = data.url; a.textContent = data.url;
      const pre = document.createElement('pre'); pre.textContent = md;
      const cap = document.createElement('p'); cap.textContent = '附件地址（blob 寻址、经鉴权读取）与 Markdown 引用：';
      out.append(cap, a, pre);
    }
  } catch (err) {
    msg.textContent = '上传失败：' + err.message;
  }
});
`;
  return layout(
    title,
    `${head}
  <form id="upload-form" class="form-card">
  <label>文件<br><input type="file" id="file" required></label>
  <label>上传路径（相对本页目录，可含子目录；须含扩展名）<br>
  <input type="text" id="relpath" placeholder="文件名（选择文件后自动预填）" required maxlength="1024"></label>
  <p><small>规则：附件受扩展名清单与容量限制（E-LIMIT-002/003）；<code>.md</code> 上传须含合法 frontmatter（<code>README.md</code> 豁免——大小写不敏感）；写入需 editor 及以上角色。</small></p>
  <p id="upload-msg" role="alert"></p>
  <div id="upload-result"></div>
  <div class="form-actions">
  <button type="submit" class="btn-primary">上传</button>
  <a href="/vaults/${encodeURIComponent(vault.slug)}/browse${dirPath === '' ? '' : '/' + encPath(dirPath)}">取消</a>
  </div>
  </form>
</div>
`,
    script,
    nav,
  );
}

/** 状态页（存储未挂接——与 browseStatePage/editStatePage 同风格如实标注）。
 *  S12-T2（coordinator 批准扩展）：可选 viewer → 顶栏账户位（缺省兼容旧调用形态）。 */
export function uploadStatePage(
  vault: { slug: string; name: string },
  note: string,
  viewer?: { username: string; display_name?: string; is_instance_admin?: boolean },
): string {
  return layout(
    `上传 — ${vault.name}`,
    `<div class="page">
  <h1>上传</h1>
  <nav aria-label="面包屑"><a href="/vaults">知识库</a> <span aria-hidden="true">›</span> <a href="/vaults/${encodeURIComponent(vault.slug)}/browse">${escapeHtml(vault.name)}</a></nav>
  <p class="state-note">${escapeHtml(note)}</p>
</div>
`,
    '',
    viewer !== undefined
      ? { user: { username: viewer.username, displayName: viewer.display_name, isAdmin: viewer.is_instance_admin === true }, active: 'vaults' }
      : undefined,
  );
}
