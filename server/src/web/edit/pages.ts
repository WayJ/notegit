import { escapeHtml, layout } from '../pages.ts';
import { draftPutUrl } from './draft.ts';
import type { ParsedForForm } from './form.ts';

/**
 * S4-T3 编辑页模板（D5 极简：服务端渲染、无框架；插值唯一通道 escapeHtml）。
 *
 * 页面 = GET 表单（无写操作，api.md §13/D5）：六字段 + 额外字段文本区 +
 * 正文 textarea（多行纯文本，无富文本）；保存/提交按钮经页内脚本调用 API 端点
 * ——保存=§7 草稿 PUT（存储 S4-T6 落地），提交=§8.2 submissions POST（S3-T7
 * 发布组件，HTTP 接线 S4-T7）。422 报告的字段定位渲染为服务端 errors.ts 映射
 * 规则的页内镜像（显示胶水；权威映射在服务端，由发布组件报告驱动）。
 */

/** 面包屑（与 view/pages.ts 同构——模块各自持有，不改共享文件，D5） */
function breadcrumb(vault: { slug: string; name: string }, entryPath: string): string {
  const parts = [
    `<a href="/vaults">知识库</a>`,
    `<a href="/vaults/${encodeURIComponent(vault.slug)}/browse">${escapeHtml(vault.name)}</a>`,
  ];
  const slash = entryPath.lastIndexOf('/');
  let acc = '';
  for (const seg of (slash === -1 ? [] : entryPath.slice(0, slash).split('/'))) {
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

function nameOf(entryPath: string): string {
  return entryPath.includes('/') ? entryPath.slice(entryPath.lastIndexOf('/') + 1) : entryPath;
}

export interface EditPageInput {
  readonly vault: { slug: string; name: string };
  readonly entryPath: string;
  /** edit=既有文件回填；new=路径不存在（title 自文件名生成） */
  readonly mode: 'edit' | 'new';
  /** 打开编辑器时默认分支 HEAD（§7/§8.2 base_commit；空库 null） */
  readonly baseCommit: string | null;
  readonly prefill: ParsedForForm;
}

/** 字段块：label + 控件 + 行内错误位（422 报告渲染落点 id="err-<field>"） */
function fieldRow(label: string, control: string, field: string): string {
  return `<label>${label}<br>${control}</label>\n<p class="field-err" id="err-${field}" role="alert"></p>`;
}

function attr(v: string): string {
  return escapeHtml(v);
}

/** 脚本字面量插值：JSON 序列化后转义 `<`（防 `</script>` 逃逸——escapeHtml 不适用于脚本块内） */
function js(v: string): string {
  return JSON.stringify(v).replaceAll('<', '\\u003c');
}

export function editPage(input: EditPageInput): string {
  const { vault, entryPath, mode, baseCommit, prefill } = input;
  const name = nameOf(entryPath);
  const isNew = mode === 'new';
  const statusEnum = ['active', 'draft', 'deprecated'];
  const rawStatus = prefill.fields.status;
  const statusOptions = [
    `<option value=""${rawStatus === '' ? ' selected' : ''}>缺省（按 active 解释）</option>`,
    ...statusEnum.map(
      (s) => `<option value="${s}"${rawStatus === s ? ' selected' : ''}>${s}</option>`,
    ),
    // 非法值原样保留展示（防呆之外的诚实：下拉无该值，校验兜底拒——双保险）
    ...(statusEnum.includes(rawStatus) || rawStatus === ''
      ? []
      : [`<option value="${attr(rawStatus)}" selected>${attr(rawStatus)}（非法值——提交将被校验拒绝）</option>`]),
  ];

  const apiBase = `/api/v1/vaults/${encodeURIComponent(vault.slug)}`;
  const script = `
const PATH = ${js(entryPath)};
const BASE = ${baseCommit === null ? "null" : js(baseCommit)};
const VIEW_URL = ${JSON.stringify(`/vaults/${encodeURIComponent(vault.slug)}/view/${entryPath.split('/').map(encodeURIComponent).join('/')}`)};
const DRAFT_URL = ${JSON.stringify(draftPutUrl(vault.slug, entryPath))};
const SUBMIT_URL = ${JSON.stringify(`${apiBase}/submissions`)};

// 组装（与 web/edit/form.ts composeDocument 同规则：JSON 流式标量——YAML 1.2 子集）
function composeDoc() {
  const f = document.getElementById('edit-form');
  const lines = [];
  if (f.title.value.trim() !== '') lines.push('title: ' + JSON.stringify(f.title.value));
  if (f.owner.value.trim() !== '') lines.push('owner: ' + JSON.stringify(f.owner.value));
  if (f.description.value.trim() !== '') lines.push('description: ' + JSON.stringify(f.description.value));
  const tags = f.tags.value.split(',').map((t) => t.trim()).filter((t) => t !== '');
  if (tags.length > 0) lines.push('tags: ' + JSON.stringify(tags));
  if (f.status.value.trim() !== '') lines.push('status: ' + JSON.stringify(f.status.value.trim()));
  if (f.source.value.trim() !== '') lines.push('source: ' + JSON.stringify(f.source.value));
  const extra = f.extra.value.replace(/^[\\n\\t ]+/, '').replace(/[\\n\\t ]+$/, '');
  if (extra !== '') lines.push(...extra.split('\\n'));
  return '---\\n' + (lines.length ? lines.join('\\n') + '\\n' : '') + '---\\n' + f.body.value;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error((data.error && data.error.message) || res.status); e.status = res.status; e.data = data; throw e; }
  return data;
}

// 422 报告 → 字段定位渲染（服务端 errors.ts 映射规则的页内镜像：六字段→行内位，
// extra 区解析层错误（无 field 或 field 非六字段且行落在 extra 区）→ extra 位，
// W 级 → 温和提示区不阻断）
const SIX = ['title', 'owner', 'description', 'tags', 'status', 'source'];
function renderReport(report) {
  for (const el of document.querySelectorAll('.field-err')) el.textContent = '';
  const msg = document.getElementById('form-msg');
  const warn = document.getElementById('form-warn');
  const warns = [];
  let blocked = false;
  const extraStart = 2 + [...document.getElementById('edit-form').elements].filter((el) =>
    ['title', 'owner', 'description', 'tags', 'status', 'source'].includes(el.name) && el.value.trim() !== '').length;
  for (const file of report.files || []) {
    for (const i of file.issues || []) {
      const loc = i.line !== undefined ? '（行 ' + i.line + '）' : '';
      const text = i.code + ' ' + i.message + loc;
      if (i.severity === 'warning') { warns.push(text); continue; }
      blocked = true;
      let el = null;
      if (i.field && SIX.includes(i.field)) el = document.getElementById('err-' + i.field);
      if (!el && i.field === undefined && i.line >= extraStart) el = document.getElementById('err-extra');
      if (!el) el = msg;
      el.textContent += (el.textContent ? '；' : '') + text;
    }
  }
  warn.textContent = warns.length ? '温和提示（不影响提交）：' + warns.join('；') : '';
  return blocked;
}

document.getElementById('save-draft').addEventListener('click', async () => {
  const msg = document.getElementById('form-msg');
  try {
    const r = await api('PUT', DRAFT_URL, { content: composeDoc(), base_commit: BASE });
    msg.textContent = '草稿已保存' + (r && r.updated_at ? '（' + r.updated_at + '）' : '') + '。';
  } catch (err) {
    msg.textContent = '保存草稿失败：' + err.message + (err.status === 404 ? '（草稿存储未接入——S4-T6 落地）' : '');
  }
});

document.getElementById('edit-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const msg = document.getElementById('form-msg');
  try {
    const r = await api('POST', SUBMIT_URL, {
      base_commit: BASE,
      message: f.message.value.trim() || ('Web 编辑：' + PATH),
      changes: [{ path: PATH, content: composeDoc() }],
    });
    msg.textContent = '已发布（commit ' + (r.commit || '?') + '）——草稿按架构 §6 清理或标记（S4-T6/T7 接线）。';
    setTimeout(() => { location.href = VIEW_URL; }, 600);
  } catch (err) {
    if (err.status === 422 && err.data && err.data.files) {
      renderReport(err.data); // T2 报告（scope=web-submit）——字段定位 + 行
      document.getElementById('form-msg').textContent = '提交被校验阻止（草稿内容保留在表单中——不发布）。';
    } else if (err.status === 409) {
      document.getElementById('form-msg').textContent = '提交冲突：分支已前进（他人先提交）——内容仍在表单，刷新基线后重提（S4-T7 完整接线）。';
    } else {
      document.getElementById('form-msg').textContent = '提交失败：' + err.message;
    }
  }
});
`;

  return layout(
    `${isNew ? '新建' : '编辑'}：${name} — ${vault.name}`,
    `<h1>${isNew ? '新建' : '编辑'}：${escapeHtml(name)}</h1>
<nav aria-label="面包屑">${breadcrumb(vault, entryPath)} <span aria-hidden="true">›</span> ${escapeHtml(name)}</nav>
<p>类型：Markdown 知识文档 · base commit：<code>${baseCommit === null ? '（空库——首次提交）' : escapeHtml(baseCommit)}</code>${isNew ? ' · <strong>新建</strong>（标题已从文件名生成，提交前可修改）' : ''}</p>
<form id="edit-form">
${fieldRow('标题 <strong>（必填）</strong>', `<input name="title" required maxlength="200" value="${attr(prefill.fields.title)}">`, 'title')}
${fieldRow('负责人（可选，知识负责人）', `<input name="owner" maxlength="100" value="${attr(prefill.fields.owner)}">`, 'owner')}
${fieldRow('摘要（可选，简短摘要）', `<textarea name="description" rows="2" maxlength="500">${attr(prefill.fields.description)}</textarea>`, 'description')}
${fieldRow('标签（可选，逗号分隔）', `<input name="tags" value="${attr(prefill.fields.tags)}">`, 'tags')}
${fieldRow('状态（可选，下拉封闭集）', `<select name="status">${statusOptions.join('')}</select>`, 'status')}
${fieldRow('来源（可选，原始资料或依据）', `<input name="source" maxlength="500" value="${attr(prefill.fields.source)}">`, 'source')}
${fieldRow('额外字段（可选；安全 YAML 值，每行 <code>key: value</code>；允许标量/列表/映射）', `<textarea name="extra" rows="3" placeholder="department: 财务部&#10;reviewers: [a, b]">${attr(prefill.extra)}</textarea>`, 'extra')}
<label>正文（Markdown，多行纯文本）<br><textarea name="body" rows="18">${attr(prefill.body)}</textarea></label>
<label>提交说明（可选）<br><input name="message" placeholder="缺省：Web 编辑：${attr(entryPath)}"></label>
<p id="form-warn" class="form-warn"></p>
<p id="form-msg" role="alert"></p>
<button type="button" id="save-draft">保存草稿</button>
<button type="submit">提交</button>
</form>
<p><small>保存=草稿（不产生 Git 版本，S4-T6 存储落地）；提交=正式发布（走统一校验与发布组件，S4-T7 完整接线）。</small></p>
`,
    script,
  );
}

/** README 豁免页（架构 §5.2：导航文档豁免 frontmatter）——仅正文编辑 */
export function readmeEditPage(input: Omit<EditPageInput, 'prefill'> & { body: string }): string {
  const { vault, entryPath, mode, baseCommit, body } = input;
  const name = nameOf(entryPath);
  const apiBase = `/api/v1/vaults/${encodeURIComponent(vault.slug)}`;
  const script = `
const PATH = ${js(entryPath)};
const BASE = ${baseCommit === null ? "null" : js(baseCommit)};
const DRAFT_URL = ${JSON.stringify(draftPutUrl(vault.slug, entryPath))};
const SUBMIT_URL = ${JSON.stringify(`${apiBase}/submissions`)};
const VIEW_URL = ${JSON.stringify(`/vaults/${encodeURIComponent(vault.slug)}/view/${entryPath.split('/').map(encodeURIComponent).join('/')}`)};
async function api(method, url, body) {
  const res = await fetch(url, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error((data.error && data.error.message) || res.status); e.status = res.status; e.data = data; throw e; }
  return data;
}
document.getElementById('save-draft').addEventListener('click', async () => {
  try {
    await api('PUT', DRAFT_URL, { content: document.getElementById('readme-body').value, base_commit: BASE });
    document.getElementById('form-msg').textContent = '草稿已保存。';
  } catch (err) {
    document.getElementById('form-msg').textContent = '保存草稿失败：' + err.message + (err.status === 404 ? '（草稿存储未接入——S4-T6 落地）' : '');
  }
});
document.getElementById('readme-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  try {
    const r = await api('POST', SUBMIT_URL, {
      base_commit: BASE,
      message: 'Web 编辑：' + PATH,
      changes: [{ path: PATH, content: document.getElementById('readme-body').value }],
    });
    document.getElementById('form-msg').textContent = '已发布（commit ' + (r.commit || '?') + '）。';
    setTimeout(() => { location.href = VIEW_URL; }, 600);
  } catch (err) {
    document.getElementById('form-msg').textContent = '提交失败：' + err.message;
  }
});
`;
  return layout(
    `编辑：${name} — ${vault.name}`,
    `<h1>编辑：${escapeHtml(name)}</h1>
<nav aria-label="面包屑">${breadcrumb(vault, entryPath)} <span aria-hidden="true">›</span> ${escapeHtml(name)}</nav>
<p>类型：README 导航文档 · <strong>frontmatter 豁免</strong>（架构 §5.2——不套用六字段表单，正文直接编辑） · base commit：<code>${baseCommit === null ? '（空库）' : escapeHtml(baseCommit)}</code>${mode === 'new' ? ' · 新建' : ''}</p>
<form id="readme-form">
<label>正文（Markdown，多行纯文本）<br><textarea id="readme-body" name="body" rows="18">${escapeHtml(body)}</textarea></label>
<p id="form-msg" role="alert"></p>
<button type="button" id="save-draft">保存草稿</button>
<button type="submit">提交</button>
</form>
`,
    script,
  );
}

/** 状态页（存储未挂接/超大文件——与 browse/view 状态页同风格如实标注） */
export function editStatePage(vault: { slug: string; name: string }, note: string): string {
  return layout(
    `编辑 — ${vault.name}`,
    `<h1>编辑</h1>
<nav aria-label="面包屑"><a href="/vaults">知识库</a> <span aria-hidden="true">›</span> <a href="/vaults/${encodeURIComponent(vault.slug)}/browse">${escapeHtml(vault.name)}</a></nav>
<p>${escapeHtml(note)}</p>
`,
  );
}
