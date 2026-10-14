import { escapeHtml, layout } from '../pages.ts';
import { draftPutUrl } from './draft.ts';
import type { ParsedForForm } from './form.ts';

/**
 * S4-T3 编辑页模板（D5 极简：服务端渲染、无框架；插值唯一通道 escapeHtml）。
 *
 * 页面 = GET 表单（无写操作，api.md §13/D5）：六字段 + 额外字段文本区 +
 * 正文 textarea（多行纯文本，无富文本）；保存/提交按钮经页内脚本调用 API 端点
 * ——保存=§7 草稿 PUT（S4-T6 存储已落地：按作者私有、不产生 Git 版本），提交
 * =§8.2 submissions POST（S3-T7 发布组件，HTTP 接线 S4-T7；发布成功后提交者
 * 本人草稿由服务端标已提交）。422 报告的字段定位渲染为服务端 errors.ts 映射
 * 规则的页内镜像（显示胶水；权威映射在服务端，由发布组件报告驱动）。
 *
 * UI-RESTYLE：DESIGN.md 视觉契约落位——表单卡（form-card）、提交=珊瑚主按钮、
 * 保存草稿=米色描边按钮、行内错误位 error 语义色；viewer 透传顶部导航登录态。
 */

/** 顶部导航登录态（呈现层透传） */
export interface PageViewer {
  readonly username: string;
  readonly is_instance_admin: boolean;
}

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

/** 文档所在目录（上传附件入口落点——S4-T8 T4 遗留收口） */
function parentDirOf(entryPath: string): string {
  const slash = entryPath.lastIndexOf('/');
  return slash === -1 ? '' : entryPath.slice(0, slash);
}

/** 上传附件入口（编辑页头部：指向文档所在目录的上传页；S10-T2 reader 隐藏——写入口） */
function uploadAttachmentLink(vault: { slug: string }, entryPath: string, canWrite: boolean): string {
  if (!canWrite) return '';
  const dir = parentDirOf(entryPath);
  const href = `/vaults/${encodeURIComponent(vault.slug)}/upload${dir === '' ? '' : '/' + dir.split('/').map(encodeURIComponent).join('/')}`;
  return ` · <a href="${href}">上传附件</a>`;
}

export interface EditPageInput {
  readonly vault: { slug: string; name: string };
  readonly entryPath: string;
  /** edit=既有文件回填；new=路径不存在（title 自文件名生成） */
  readonly mode: 'edit' | 'new';
  /** 打开编辑器时默认分支 HEAD（§7/§8.2 base_commit；空库 null） */
  readonly baseCommit: string | null;
  readonly prefill: ParsedForForm;
  /** S4-T7 草稿预填信息（本人现行草稿回填时呈现；缺省 = 无草稿） */
  readonly draft?: { baseCommit: string | null; updatedAt: string; stale: boolean };
  /** S10-T2 权限感知：当前会话员工对该库的写权（canWriteVault 实算；false=只读态
   *  ——D4：门槛保持 read 成员（200），字段禁用 + 只读标注、不渲染保存草稿/提交
   *  控件；正文可看不可改。本人草稿回填逻辑不动（草稿是 read 成员可用的既有
   *  能力——回填照常，仅不可改）。缺省 = 写者形态：模板直调测试兼容；生产路由
   *  恒传实算值（D17 呈现层，非安全边界）） */
  readonly canWrite?: boolean;
  /** UI-RESTYLE：顶部导航登录态（可选——测试直调形态缺省） */
  readonly viewer?: PageViewer;
}

/** 只读徽章（S10-T2：DESIGN.md badge-pill 形态——`.badge` 既有类，token 语义） */
const READONLY_BADGE = '<span class="badge">只读成员</span>';

/** 自动保存缺省间隔（D3：页内可调常量的唯一服务端来源——脚本常量与状态行文案同源防漂移） */
const AUTOSAVE_INTERVAL_MS_DEFAULT = 30_000;

/** 回填标注（T6 移交：呈现草稿 base_commit 旧值；stale=分支已前进如实提示） */
function draftNote(draft: { baseCommit: string | null; updatedAt: string; stale: boolean }): string {
  const base = draft.baseCommit === null ? '（空库）' : escapeHtml(draft.baseCommit);
  const tail = draft.stale
    ? '——<strong>分支已前进</strong>：他人已提交新版本，直接提交将得到冲突提示；请先核对最新内容，刷新本页即取最新基线重提'
    : '——与当前基线一致';
  return `<p class="draft-note">已回填你保存的草稿（更新于 ${escapeHtml(draft.updatedAt)}；草稿基线 <code>${base}</code>${tail}）。</p>`;
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

// ── 页内脚本共享块（S10-T3 抽出：editPage 与 newNotePage 同一来源——editPage
//    既有输出字节不变，既有编辑行为零变化） ───────────────────────────────────

const COMPOSE_DOC_JS = `
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
`;

const API_FN_JS = `
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
`;

// ── 草稿自动保存共享块（S12-T1 D3）：定时（默认 30s——常量在块顶可调，不引
//    配置面）+ 失焦触发（focusout 冒泡——离开字段即点检）；仅内容较上次保存
//    有变化才落库（未变不写）；状态行如实呈现（已保存 HH:MM / 失败重试提示——
//    非阻断，不打断编辑）。页各异的部分由 autosaveContent/autosavePut 两函数
//    提供（函数声明提升——共享块先包含、页函数随后定义即可）。
const autosaveJs = (formId: string): string => `
// ── 草稿自动保存（S12-T1 D3）──
const AUTOSAVE_INTERVAL_MS = ${AUTOSAVE_INTERVAL_MS_DEFAULT};
let autosaveSaved = null; // 上次已落库内容（脏判定——未变不写）
let autosaveBusy = false; // 在途防重入（上笔未归则本轮跳过）
let autosaveHalted = false; // 提交成功后停自动保存（草稿清理语义不变——迟到 PUT 不得复活草稿）
function autosaveStatus(text) { document.getElementById('autosave-status').textContent = text; }
function autosaveClock() { const t = new Date(); return String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0'); }
async function autosaveNow() {
  if (autosaveBusy || autosaveHalted) return;
  const content = autosaveContent();
  if (content === null || content === autosaveSaved) return;
  autosaveBusy = true;
  try {
    await autosavePut(content);
    autosaveSaved = content;
    autosaveStatus('草稿已自动保存（' + autosaveClock() + '）');
  } catch (err) {
    autosaveStatus('自动保存失败：' + err.message + '——内容保留在表单中，下个间隔自动重试');
  } finally {
    autosaveBusy = false;
  }
}
setInterval(autosaveNow, AUTOSAVE_INTERVAL_MS);
document.getElementById('${formId}').addEventListener('focusout', autosaveNow);
`;

const RENDER_REPORT_JS = `
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
`;

export function editPage(input: EditPageInput): string {
  const { vault, entryPath, mode, baseCommit, prefill, draft, viewer } = input;
  const name = nameOf(entryPath);
  const isNew = mode === 'new';
  const ro = input.canWrite === false; // S10-T2 reader 只读态（D4）
  const dis = ro ? ' disabled' : ''; // 字段禁用（正文可看不可改）
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
  // S10-T2 reader 只读态：不携带交互脚本（脚本绑定保存/提交控件——只读态不渲染）。
  // S10-T3：组装/请求/报告渲染三块抽出为共享常量（newNotePage 同源复用）——本页输出不变
  const script = ro ? '' : `
const PATH = ${js(entryPath)};
const BASE = ${baseCommit === null ? "null" : js(baseCommit)};
const VIEW_URL = ${JSON.stringify(`/vaults/${encodeURIComponent(vault.slug)}/view/${entryPath.split('/').map(encodeURIComponent).join('/')}`)};
const DRAFT_URL = ${JSON.stringify(draftPutUrl(vault.slug, entryPath))};
const SUBMIT_URL = ${JSON.stringify(`${apiBase}/submissions`)};
${COMPOSE_DOC_JS}${API_FN_JS}${RENDER_REPORT_JS}${autosaveJs('edit-form')}
// 自动保存页适配（D3）：内容=组装全文（frontmatter+正文，与手动保存同一形状）
function autosaveContent() { return composeDoc(); }
async function autosavePut(content) { await api('PUT', DRAFT_URL, { content: content, base_commit: BASE }); }

// ── 附件粘贴/拖拽（S12-T1 D4）：正文 textarea paste/drop 取 File → 既有上传
// 端点（octet-stream；判定单一来源=端点——编辑器不预判类型白名单，端点拒即
// 如实呈现 error.code+hint）→ 成功按类型回插引用（image/* → ![](url)；其余
// → [name](url)）。目标路径=文档所在目录+原文件名（重名覆盖由端点 upsert 判定）。
const UPLOAD_BASE = ${JSON.stringify(`/vaults/${encodeURIComponent(vault.slug)}/upload`)};
const UPLOAD_DIR = ${JSON.stringify(parentDirOf(entryPath) === '' ? '' : `${parentDirOf(entryPath).split('/').map(encodeURIComponent).join('/')}/`)};
const bodyTA = document.getElementById('edit-form').body;
function insertRef(ta, text) {
  const at = ta.selectionStart ?? ta.value.length;
  const end = ta.selectionEnd ?? at;
  ta.value = ta.value.slice(0, at) + text + ta.value.slice(end);
  const caret = at + text.length;
  ta.setSelectionRange(caret, caret);
  ta.dispatchEvent(new Event('input', { bubbles: true })); // 正文变化广播（预览随 input 刷新；自动保存随脏判定跟进）
}
async function uploadAndInsert(file) {
  const status = document.getElementById('autosave-status');
  status.textContent = '附件上传中：' + file.name + '…';
  try {
    const res = await fetch(UPLOAD_BASE + '/' + UPLOAD_DIR + encodeURIComponent(file.name), {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: file,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      const err = data.error || {};
      throw new Error((err.code ? err.code + ' ' : '') + (err.message || ('HTTP ' + res.status)) + (err.hint ? '（' + err.hint + '）' : ''));
    }
    insertRef(bodyTA, (file.type.startsWith('image/') ? '![](' : '[' + file.name + '](') + data.url + ')\\n');
    status.textContent = '附件已上传并插入引用：' + file.name;
  } catch (err) {
    status.textContent = '上传失败：' + file.name + '——' + err.message + '（未插入引用；可重试或经上传页）';
  }
}
bodyTA.addEventListener('paste', (ev) => {
  const files = ev.clipboardData && ev.clipboardData.files;
  if (!files || files.length === 0) return; // 纯文本粘贴不拦截——浏览器默认行为
  ev.preventDefault();
  for (const file of files) uploadAndInsert(file);
});
bodyTA.addEventListener('drop', (ev) => {
  const files = ev.dataTransfer && ev.dataTransfer.files;
  if (!files || files.length === 0) return;
  ev.preventDefault();
  for (const file of files) uploadAndInsert(file);
});
bodyTA.addEventListener('dragover', (ev) => ev.preventDefault());
document.getElementById('save-draft').addEventListener('click', async () => {
  const msg = document.getElementById('form-msg');
  try {
    const r = await api('PUT', DRAFT_URL, { content: composeDoc(), base_commit: BASE });
    autosaveSaved = composeDoc(); // 手动保存成功即对齐基线（自动保存不重复落库）
    msg.textContent = '草稿已保存' + (r && r.updated_at ? '（' + r.updated_at + '）' : '') + '。';
  } catch (err) {
    msg.textContent = '保存草稿失败：' + err.message;
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
    autosaveHalted = true; // 已发布：停自动保存（迟到 PUT 不得复活已清理草稿）
    msg.textContent = '已发布（commit ' + (r.commit || '?') + '）——草稿已标记为已提交。';
    setTimeout(() => { location.href = VIEW_URL; }, 600);
  } catch (err) {
    if (err.status === 422 && err.data && err.data.files) {
      renderReport(err.data); // T2 报告（scope=web-submit）——字段定位 + 行
      document.getElementById('form-msg').textContent = '提交被校验阻止（草稿内容保留在表单中——不发布）。';
    } else if (err.status === 409) {
      // S4-T7 冲突保护：409 信封 details.current_head（当前 tip 提示刷新——S3-T7 CAS 拒）
      const tip = err.data && err.data.error && err.data.error.details ? err.data.error.details.current_head : null;
      document.getElementById('form-msg').textContent = '提交冲突：分支已前进' + (tip ? '（当前 ' + String(tip).slice(0, 10) + '…）' : '') + '——他人先提交，内容仍在表单、草稿已保留；请先核对最新内容，刷新本页取最新基线后重提。';
    } else {
      document.getElementById('form-msg').textContent = '提交失败：' + err.message;
    }
  }
});
autosaveSaved = autosaveContent(); // 基线=装入内容（此后仅变化触发落库）
`;

  return layout(
    `${isNew ? '新建' : '编辑'}：${name} — ${vault.name}`,
    `<div class="page page-narrow">
  <div class="page-head">
  <h1>${isNew ? '新建' : '编辑'}：${escapeHtml(name)}</h1>
  <nav aria-label="面包屑">${breadcrumb(vault, entryPath)} <span aria-hidden="true">›</span> ${escapeHtml(name)}</nav>
  <p class="page-meta">类型：Markdown 知识文档 · base commit：<code>${baseCommit === null ? '（空库——首次提交）' : escapeHtml(baseCommit)}</code>${uploadAttachmentLink(vault, entryPath, !ro)}${isNew ? (draft ? ' · <strong>新建</strong>' : ' · <strong>新建</strong>（标题已从文件名生成，提交前可修改）') : ''}</p>
${ro ? `  <p class="page-meta">${READONLY_BADGE} 无写权限：正文可看不可改。</p>\n` : ''}  </div>
  ${draft ? draftNote(draft) : ''}
  <form id="edit-form" class="form-card"${ro ? ' aria-disabled="true"' : ''}>
${fieldRow('标题 <strong>（必填）</strong>', `<input name="title"${dis} required maxlength="200" value="${attr(prefill.fields.title)}">`, 'title')}
${fieldRow('负责人（可选，知识负责人）', `<input name="owner"${dis} maxlength="100" value="${attr(prefill.fields.owner)}">`, 'owner')}
${fieldRow('摘要（可选，简短摘要）', `<textarea name="description"${dis} rows="2" maxlength="500">${attr(prefill.fields.description)}</textarea>`, 'description')}
${fieldRow('标签（可选，逗号分隔）', `<input name="tags"${dis} value="${attr(prefill.fields.tags)}">`, 'tags')}
${fieldRow('状态（可选，下拉封闭集）', `<select name="status"${dis}>${statusOptions.join('')}</select>`, 'status')}
${fieldRow('来源（可选，原始资料或依据）', `<input name="source"${dis} maxlength="500" value="${attr(prefill.fields.source)}">`, 'source')}
${fieldRow('额外字段（可选；安全 YAML 值，每行 <code>key: value</code>；允许标量/列表/映射）', `<textarea name="extra"${dis} rows="3" placeholder="department: 财务部&#10;reviewers: [a, b]">${attr(prefill.extra)}</textarea>`, 'extra')}
  <label>正文（Markdown，多行纯文本）<br><textarea name="body"${dis} rows="18">${attr(prefill.body)}</textarea></label>
  <label>提交说明（可选）<br><input name="message"${dis} placeholder="缺省：Web 编辑：${attr(entryPath)}"></label>
  <p id="form-warn" class="form-warn"></p>
  <p id="form-msg" role="alert"></p>
${ro
  ? `  <p class="page-meta">${READONLY_BADGE} 无写权限：仅可查看本页，不能保存草稿或提交发布。</p>`
  : `  <p class="form-foot" id="autosave-status" role="status" aria-live="polite">自动保存已就绪（编辑期间每 30 秒与失焦时自动保存草稿）。</p>
  <div class="form-actions">
  <button type="button" id="save-draft">保存草稿</button>
  <button type="submit">提交</button>
  </div>`}
  </form>
${ro ? '' : `  <p class="form-foot"><small>保存=草稿（按作者私有、不产生 Git 版本，可再保存覆盖；编辑期间每 30 秒与失焦时自动保存草稿）；提交=正式发布（走统一校验与发布组件）——提交成功后草稿标记为已提交。</small></p>`}
</div>
`,
    script,
    viewer !== undefined ? { user: { username: viewer.username, isAdmin: viewer.is_instance_admin }, active: 'vaults' } : undefined,
  );
}

/** README 豁免页（架构 §5.2：导航文档豁免 frontmatter）——仅正文编辑 */
export function readmeEditPage(input: Omit<EditPageInput, 'prefill'> & { body: string }): string {
  const { vault, entryPath, mode, baseCommit, body, draft, viewer } = input;
  const name = nameOf(entryPath);
  const ro = input.canWrite === false; // S10-T2 reader 只读态（D4）
  const dis = ro ? ' disabled' : '';
  const apiBase = `/api/v1/vaults/${encodeURIComponent(vault.slug)}`;
  // S10-T2 reader 只读态：不携带交互脚本（同六字段页）
  const script = ro ? '' : `
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
${autosaveJs('readme-form')}
// 自动保存页适配（D3）：README 豁免 frontmatter——内容=正文 textarea 全量
function autosaveContent() { return document.getElementById('readme-body').value; }
async function autosavePut(content) { await api('PUT', DRAFT_URL, { content: content, base_commit: BASE }); }
document.getElementById('save-draft').addEventListener('click', async () => {
  try {
    await api('PUT', DRAFT_URL, { content: document.getElementById('readme-body').value, base_commit: BASE });
    autosaveSaved = document.getElementById('readme-body').value; // 手动保存成功即对齐基线
    document.getElementById('form-msg').textContent = '草稿已保存。';
  } catch (err) {
    document.getElementById('form-msg').textContent = '保存草稿失败：' + err.message;
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
    autosaveHalted = true; // 已发布：停自动保存（迟到 PUT 不得复活已清理草稿）
    document.getElementById('form-msg').textContent = '已发布（commit ' + (r.commit || '?') + '）——草稿已标记为已提交。';
    setTimeout(() => { location.href = VIEW_URL; }, 600);
  } catch (err) {
    if (err.status === 409) {
      // S4-T7 冲突保护（同六字段页 409 形态——当前 tip 提示刷新）
      const tip = err.data && err.data.error && err.data.error.details ? err.data.error.details.current_head : null;
      document.getElementById('form-msg').textContent = '提交冲突：分支已前进' + (tip ? '（当前 ' + String(tip).slice(0, 10) + '…）' : '') + '——他人先提交，内容仍在表单、草稿已保留；请先核对最新内容，刷新本页取最新基线后重提。';
    } else {
      document.getElementById('form-msg').textContent = '提交失败：' + err.message;
    }
  }
});
autosaveSaved = autosaveContent(); // 基线=装入内容（此后仅变化触发落库）
`;
  return layout(
    `编辑：${name} — ${vault.name}`,
    `<div class="page page-narrow">
  <div class="page-head">
  <h1>编辑：${escapeHtml(name)}</h1>
  <nav aria-label="面包屑">${breadcrumb(vault, entryPath)} <span aria-hidden="true">›</span> ${escapeHtml(name)}</nav>
  <p class="page-meta">类型：README 导航文档 · <strong>frontmatter 豁免</strong>（架构 §5.2——不套用六字段表单，正文直接编辑） · base commit：<code>${baseCommit === null ? '（空库）' : escapeHtml(baseCommit)}</code>${uploadAttachmentLink(vault, entryPath, !ro)}${mode === 'new' ? ' · 新建' : ''}</p>
${ro ? `  <p class="page-meta">${READONLY_BADGE} 无写权限：正文可看不可改。</p>\n` : ''}  </div>
  ${draft ? draftNote(draft) : ''}
  <form id="readme-form" class="form-card"${ro ? ' aria-disabled="true"' : ''}>
  <label>正文（Markdown，多行纯文本）<br><textarea id="readme-body" name="body"${dis} rows="18">${escapeHtml(body)}</textarea></label>
  <p id="form-msg" role="alert"></p>
${ro
  ? `  <p class="page-meta">${READONLY_BADGE} 无写权限：仅可查看本页，不能保存草稿或提交发布。</p>`
  : `  <p class="form-foot" id="autosave-status" role="status" aria-live="polite">自动保存已就绪（编辑期间每 30 秒与失焦时自动保存草稿）。</p>
  <div class="form-actions">
  <button type="button" id="save-draft">保存草稿</button>
  <button type="submit">提交</button>
  </div>`}
  </form>
</div>
`,
    script,
    viewer !== undefined ? { user: { username: viewer.username, isAdmin: viewer.is_instance_admin }, active: 'vaults' } : undefined,
  );
}

/** 状态页（存储未挂接/超大文件——与 browse/view 状态页同风格如实标注） */
export function editStatePage(vault: { slug: string; name: string }, note: string): string {
  return layout(
    `编辑 — ${vault.name}`,
    `<div class="page">
  <h1>编辑</h1>
  <nav aria-label="面包屑"><a href="/vaults">知识库</a> <span aria-hidden="true">›</span> <a href="/vaults/${encodeURIComponent(vault.slug)}/browse">${escapeHtml(vault.name)}</a></nav>
  <p class="state-note">${escapeHtml(note)}</p>
</div>
`,
  );
}

/** 站内新建表单入参（S10-T3，sprint D5） */
export interface NewNotePageInput {
  readonly vault: { slug: string; name: string };
  /** 目标目录（''=库根）：面包屑上下文与路径输入前缀来源 */
  readonly dir: string;
  /** 路径输入预填：缺省=目录前缀（dir/）；?path= 确认态=完整候选路径（已核不存在） */
  readonly pathPrefill?: string;
  /** 打开时默认分支 HEAD（编辑页既有嵌入逻辑——提交 CAS 旧值；空库 null） */
  readonly baseCommit: string | null;
  /** 六字段+正文预填（空表单=parseDocForForm('')；?path= 确认态可回填本人草稿） */
  readonly prefill: ParsedForForm;
  /** 本人现行草稿回填信息（?path= 确认态有草稿时呈现；缺省=无草稿） */
  readonly draft?: { baseCommit: string | null; updatedAt: string; stale: boolean };
  /** S10-T2 同形：canWriteVault 实算；false=只读态（门槛保持 read 成员，D4/D17） */
  readonly canWrite?: boolean;
  /** UI-RESTYLE：顶部导航登录态（可选——测试直调形态缺省） */
  readonly viewer?: PageViewer;
}

/**
 * 站内新建笔记页（S10-T3，D5：browse「新建笔记」落点）：复用编辑表单模板族
 * （六字段 + 额外字段 + 正文——editPage 同构），差别=路径可输入（预填目录
 * 前缀）+「新建笔记」标注 +「将创建新文件」契约文案。提交走既有 §8.2
 * submissions 端点（不新建端点）；成功后跳转新文档 view 页（编辑页既有
 * location.href 约定复用）。
 *
 * 防误覆盖（submissions 对 upsert 语义是覆盖同名——D17：呈现层防护，POST
 * 端点行为不变）：提交前对路径输入做存在性探测（HEAD view URL——200 即
 * 已存在，阻断并提示换路径/走编辑页），表单侧保证新建不覆盖既有文件。
 */
export function newNotePage(input: NewNotePageInput): string {
  const { vault, dir, baseCommit, prefill, draft, viewer } = input;
  const ro = input.canWrite === false; // S10-T2 reader 只读态同形（D4）
  const dis = ro ? ' disabled' : '';
  const apiBase = `/api/v1/vaults/${encodeURIComponent(vault.slug)}`;
  const dirPrefix = dir === '' ? '' : `${dir}/`;
  const pathValue = input.pathPrefill !== undefined ? input.pathPrefill : dirPrefix;
  const confirmed = input.pathPrefill !== undefined; // ?path= 确认态（服务端已核不存在）
  const statusOptions = [
    `<option value="" selected>缺省（按 active 解释）</option>`,
    ...['active', 'draft', 'deprecated'].map((s) => `<option value="${s}">${s}</option>`),
  ];
  const uploadHref = `/vaults/${encodeURIComponent(vault.slug)}/upload${dir === '' ? '' : '/' + dir.split('/').map(encodeURIComponent).join('/')}`;
  // S10-T2 reader 只读态同形：不携带交互脚本
  const script = ro ? '' : `
const BASE = ${baseCommit === null ? "null" : js(baseCommit)};
const VIEW_BASE = ${JSON.stringify(`/vaults/${encodeURIComponent(vault.slug)}/view/`)};
const DRAFT_BASE = ${JSON.stringify(`${apiBase}/drafts/`)};
const SUBMIT_URL = ${JSON.stringify(`${apiBase}/submissions`)};

// 路径输入 → 候选库内路径（S10-T3 新建特有：先校验形态，再探测存在性——防误覆盖）
function normPath(v) {
  return v.trim().replace(/^\\/+/, '').replace(/\\/+$/, '');
}
function currentPath() {
  return normPath(document.getElementById('edit-form').path.value);
}
function pathProblem(p) {
  if (p === '') return '路径必填（库内路径，如 docs/my-note.md）';
  if (!p.toLowerCase().endsWith('.md')) return '路径须以 .md 结尾（附件请用上传入口）';
  if (p.includes('\\\\') || p.split('/').some((s) => s === '' || s === '.' || s === '..')) return '路径含非法段（不允许空段、. 、.. 或反斜杠）';
  return null;
}
const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');
const viewUrlOf = (p) => VIEW_BASE + encPath(p);
${COMPOSE_DOC_JS}${API_FN_JS}${RENDER_REPORT_JS}${autosaveJs('edit-form')}
// 自动保存页适配（D3）：键=路径+内容（路径输入变化也算脏——新路径下留草稿）；
// 路径未定形（必填/.md/非法段）时 null——不落库，路径定形后随内容变化保存
function autosaveContent() {
  const p = currentPath();
  return pathProblem(p) !== null ? null : p + '\\n' + composeDoc();
}
async function autosavePut(_content) { await api('PUT', DRAFT_BASE + encPath(currentPath()), { content: composeDoc(), base_commit: BASE }); }
document.getElementById('save-draft').addEventListener('click', async () => {
  const msg = document.getElementById('form-msg');
  const p = currentPath();
  const bad = pathProblem(p);
  if (bad !== null) { document.getElementById('err-path').textContent = bad; return; }
  document.getElementById('err-path').textContent = '';
  try {
    const r = await api('PUT', DRAFT_BASE + encPath(p), { content: composeDoc(), base_commit: BASE });
    autosaveSaved = p + '\\n' + composeDoc(); // 手动保存成功即对齐基线
    msg.textContent = '草稿已保存（路径 ' + p + (r && r.updated_at ? '，' + r.updated_at : '') + '）——重新打开本页（带 path=' + p + '）可回填。';
  } catch (err) {
    msg.textContent = '保存草稿失败：' + err.message;
  }
});

document.getElementById('edit-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const msg = document.getElementById('form-msg');
  const p = currentPath();
  const bad = pathProblem(p);
  if (bad !== null) { document.getElementById('err-path').textContent = bad; return; }
  document.getElementById('err-path').textContent = '';
  try {
    // 防误覆盖：提交前探测候选路径（HEAD view URL）——200=已存在，阻断（submissions
    // 对 upsert 语义是覆盖同名；新建直提既有路径属破坏——D17 呈现层防护）
    const probe = await fetch(viewUrlOf(p), { method: 'HEAD' });
    if (probe.status === 200) {
      document.getElementById('err-path').textContent = '该路径已存在——提交将覆盖既有文件（已阻止）。请更换路径，或打开既有文件的编辑页修改。';
      return;
    }
    const r = await api('POST', SUBMIT_URL, {
      base_commit: BASE,
      message: f.message.value.trim() || ('Web 新建：' + p),
      changes: [{ path: p, content: composeDoc() }],
    });
    autosaveHalted = true; // 已发布：停自动保存（迟到 PUT 不得复活已清理草稿）
    msg.textContent = '已创建并发布（commit ' + (r.commit || '?') + '）——即将打开新文档。';
    setTimeout(() => { location.href = viewUrlOf(p); }, 600);
  } catch (err) {
    if (err.status === 422 && err.data && err.data.files) {
      renderReport(err.data); // T2 报告——字段定位 + 行（err-title 等既有映射复用）
      document.getElementById('form-msg').textContent = '提交被校验阻止（表单内容保留——不发布）。';
    } else if (err.status === 409) {
      // S4-T7 冲突保护同形：409 信封 details.current_head（打开页面后他人已提交）
      const tip = err.data && err.data.error && err.data.error.details ? err.data.error.details.current_head : null;
      document.getElementById('form-msg').textContent = '提交冲突：分支已前进' + (tip ? '（当前 ' + String(tip).slice(0, 10) + '…）' : '') + '——他人先提交，内容仍在表单、草稿已保留；请先核对最新内容，刷新本页取最新基线后重提。';
    } else {
      document.getElementById('form-msg').textContent = '提交失败：' + err.message;
    }
  }
});
autosaveSaved = autosaveContent(); // 基线=装入内容（此后仅变化触发落库）
`;
  return layout(
    `新建笔记 — ${vault.name}`,
    `<div class="page page-narrow">
  <div class="page-head">
  <h1>新建笔记</h1>
  <nav aria-label="面包屑">${breadcrumb(vault, dir)} <span aria-hidden="true">›</span> 新建笔记</nav>
  <p class="page-meta">类型：Markdown 知识文档 · 目标目录：${dir === '' ? '库根' : escapeHtml(dir)} · base commit：<code>${baseCommit === null ? '（空库——首次提交）' : escapeHtml(baseCommit)}</code> · <strong>将创建新文件${confirmed ? `：${escapeHtml(pathValue)}` : ''}</strong>（已存在路径将被阻止——不覆盖既有文件） · <a href="${uploadHref}">上传附件</a></p>
${ro ? `  <p class="page-meta">${READONLY_BADGE} 无写权限：正文可看不可改。</p>\n` : ''}  </div>
  ${draft ? draftNote(draft) : ''}
  <form id="edit-form" class="form-card"${ro ? ' aria-disabled="true"' : ''}>
${fieldRow('路径 <strong>（必填，库内路径，以 .md 结尾）</strong>', `<input name="path"${dis} value="${attr(pathValue)}" placeholder="${attr(dirPrefix)}my-note.md">`, 'path')}
${fieldRow('标题 <strong>（必填）</strong>', `<input name="title"${dis} required maxlength="200" value="${attr(prefill.fields.title)}">`, 'title')}
${fieldRow('负责人（可选，知识负责人）', `<input name="owner"${dis} maxlength="100" value="${attr(prefill.fields.owner)}">`, 'owner')}
${fieldRow('摘要（可选，简短摘要）', `<textarea name="description"${dis} rows="2" maxlength="500">${attr(prefill.fields.description)}</textarea>`, 'description')}
${fieldRow('标签（可选，逗号分隔）', `<input name="tags"${dis} value="${attr(prefill.fields.tags)}">`, 'tags')}
${fieldRow('状态（可选，下拉封闭集）', `<select name="status"${dis}>${statusOptions.join('')}</select>`, 'status')}
${fieldRow('来源（可选，原始资料或依据）', `<input name="source"${dis} maxlength="500" value="${attr(prefill.fields.source)}">`, 'source')}
${fieldRow('额外字段（可选；安全 YAML 值，每行 <code>key: value</code>；允许标量/列表/映射）', `<textarea name="extra"${dis} rows="3" placeholder="department: 财务部&#10;reviewers: [a, b]">${attr(prefill.extra)}</textarea>`, 'extra')}
  <label>正文（Markdown，多行纯文本）<br><textarea name="body"${dis} rows="18">${attr(prefill.body)}</textarea></label>
  <label>提交说明（可选）<br><input name="message"${dis} placeholder="缺省：Web 新建：&lt;路径&gt;"></label>
  <p id="form-warn" class="form-warn"></p>
  <p id="form-msg" role="alert"></p>
${ro
  ? `  <p class="page-meta">${READONLY_BADGE} 无写权限：仅可查看本页，不能保存草稿或提交发布。</p>`
  : `  <p class="form-foot" id="autosave-status" role="status" aria-live="polite">自动保存已就绪（路径定形后，每 30 秒与失焦时自动保存草稿）。</p>
  <div class="form-actions">
  <button type="button" id="save-draft">保存草稿</button>
  <button type="submit">创建</button>
  </div>`}
  </form>
${ro ? '' : `  <p class="form-foot"><small>创建=以新路径正式发布（走统一校验与发布组件，提交既有 submissions 端点）——路径已存在将被阻止，不覆盖既有文件；保存草稿按路径私有留存，重开本页（带 path）可回填。</small></p>`}
</div>
`,
    script,
    viewer !== undefined ? { user: { username: viewer.username, isAdmin: viewer.is_instance_admin }, active: 'vaults' } : undefined,
  );
}

/**
 * 已存在路径提示态（S10-T3 防误覆盖：?path= 指向既有条目——submissions 对
 * upsert 语义是覆盖同名，创建表单不得呈现；引导到既有文件编辑页或换路径）。
 */
export function newNoteExistsPage(vault: { slug: string; name: string }, existingPath: string, kind: 'blob' | 'tree'): string {
  const enc = (p: string) => p.split('/').map(encodeURIComponent).join('/');
  const slash = existingPath.lastIndexOf('/');
  const parentDir = slash === -1 ? '' : existingPath.slice(0, slash);
  const existingOps =
    kind === 'tree'
      ? `<a href="/vaults/${encodeURIComponent(vault.slug)}/browse/${enc(existingPath)}">浏览该目录</a>`
      : `<a href="/vaults/${encodeURIComponent(vault.slug)}/view/${enc(existingPath)}">查看</a> · <a href="/vaults/${encodeURIComponent(vault.slug)}/edit/${enc(existingPath)}">编辑既有文件</a>`;
  const retryHref = `/vaults/${encodeURIComponent(vault.slug)}/edit/new${parentDir === '' ? '' : `?dir=${parentDir.split('/').map(encodeURIComponent).join('/')}`}`;
  return layout(
    `新建笔记 — ${vault.name}`,
    `<div class="page">
  <div class="page-head">
  <h1>新建笔记</h1>
  <nav aria-label="面包屑"><a href="/vaults">知识库</a> <span aria-hidden="true">›</span> <a href="/vaults/${encodeURIComponent(vault.slug)}/browse">${escapeHtml(vault.name)}</a></nav>
  </div>
  <p class="state-note">路径 <code>${escapeHtml(existingPath)}</code> 已存在——站内新建不覆盖既有文件。请更换路径重新新建，或直接${kind === 'tree' ? '浏览该目录' : '编辑既有文档'}。</p>
  <p>${existingOps} · <a href="${retryHref}">换个路径新建</a></p>
</div>
`,
  );
}
