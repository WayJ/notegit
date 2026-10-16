import { escapeHtml, layout } from '../pages.ts';

/**
 * S4-T5 重命名/删除页模板（D5 极简：服务端渲染、无框架；插值唯一通道
 * escapeHtml）。与 edit/pages.ts 同构——面包屑模块各自持有（D5：不改共享文件）。
 */

/** 面包屑（与 edit/pages.ts 同构——模块各自持有） */
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

/** 树路径 → URL（逐段编码；与 browse/pages.ts 同规则） */
function encPath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/');
}

export interface OpNotice {
  readonly code?: string;
  readonly message: string;
  /** 校验 issue 的行定位（E-FM 码映射——validation §6.2 fields） */
  readonly line?: number;
  /** 修正建议（S4-T8 统一提示：错误码 → 行动指引，见 web/hints.ts） */
  readonly hint?: string;
}

function noticeHtml(notice: OpNotice | undefined): string {
  if (notice === undefined) return '';
  const code = notice.code === undefined ? '' : `<code>${escapeHtml(notice.code)}</code> `;
  const line = notice.line === undefined ? '' : `（第 ${notice.line} 行）`;
  const hint = notice.hint === undefined ? '' : `<br><small>建议：${escapeHtml(notice.hint)}</small>`;
  return `<p class="op-error" role="alert"><strong>${code}</strong>${escapeHtml(notice.message)}${escapeHtml(line)}${hint}</p>`;
}

export interface RenamePageInput {
  readonly vault: { slug: string; name: string };
  readonly from: string;
  /** 当前输入值（GET 预填源路径；失败回显用户提交值） */
  readonly to: string;
  readonly notice?: OpNotice;
  /** S10-T2 权限感知：当前会话员工对该库的写权（canWriteVault 实算；false=只读态
   *  ——D4：门槛保持 read 成员（200），表单禁用、无提交控件 + 无写权限标注。
   *  缺省 = 写者形态：模板直调/POST 回显形态兼容；生产 GET 路由恒传实算值（D17）） */
  readonly canWrite?: boolean;
  /** UI-RESTYLE：顶部导航登录态（呈现层透传） */
  readonly viewer?: { username: string; display_name?: string; is_instance_admin: boolean };
}

/** 只读徽章（S10-T2：DESIGN.md badge-pill 形态——`.badge` 既有类，token 语义） */
const READONLY_BADGE = '<span class="badge">只读成员</span>';

/** 重命名表单页（GET 无写操作；POST 走发布组件——写权限在提交时判定） */
export function renamePage(input: RenamePageInput): string {
  const { vault, from, to, notice, viewer } = input;
  const action = `/vaults/${encodeURIComponent(vault.slug)}/rename/${encPath(from)}`;
  const cancelHref = from.includes('/')
    ? `/vaults/${encodeURIComponent(vault.slug)}/browse/${encPath(from.slice(0, from.lastIndexOf('/')))}`
    : `/vaults/${encodeURIComponent(vault.slug)}/browse`;
  // S10-T2 只读态（D4）：reader 直开 URL——表单禁用、无提交控件 + 无写权限标注
  if (input.canWrite === false) {
    return layout(
      `重命名 ${from}`,
      `<div class="page page-narrow">
  <div class="page-head">
  <h1>重命名</h1>
  <nav aria-label="面包屑">${breadcrumb(vault, from)}</nav>
  </div>
  ${noticeHtml(notice)}
  <form class="form-card" aria-disabled="true">
  <fieldset disabled>
  <p class="page-meta">原路径：<code>${escapeHtml(from)}</code></p>
  <label>新路径（库内绝对路径，可含子目录；文件名须含扩展名）<br>
  <input type="text" name="to" value="${escapeHtml(to)}" disabled maxlength="1024"></label>
  </fieldset>
  <p class="page-meta">${READONLY_BADGE} 无写权限：仅可查看，不能重命名。</p>
  <div class="form-actions">
  <a href="${cancelHref}">取消</a>
  </div>
  </form>
</div>
`,
      '',
      viewer !== undefined ? { user: { username: viewer.username, displayName: viewer.display_name, isAdmin: viewer.is_instance_admin }, active: 'vaults' } : undefined,
    );
  }
  return layout(
    `重命名 ${from}`,
    `<div class="page page-narrow">
  <div class="page-head">
  <h1>重命名</h1>
  <nav aria-label="面包屑">${breadcrumb(vault, from)}</nav>
  </div>
  ${noticeHtml(notice)}
  <form method="post" action="${action}" class="form-card">
  <p class="page-meta">原路径：<code>${escapeHtml(from)}</code></p>
  <label>新路径（库内绝对路径，可含子目录；文件名须含扩展名）<br>
  <input type="text" name="to" value="${escapeHtml(to)}" required maxlength="1024"></label>
  <p><small>规则：改为 <code>.md</code> 须有合法 frontmatter（title 必填）；改名为 <code>README.md</code> 豁免 frontmatter（大小写不敏感）。</small></p>
  <div class="form-actions">
  <button type="submit" class="btn-primary">保存重命名</button>
  <a href="${cancelHref}">取消</a>
  </div>
  </form>
</div>
`,
    '',
    viewer !== undefined ? { user: { username: viewer.username, displayName: viewer.display_name, isAdmin: viewer.is_instance_admin }, active: 'vaults' } : undefined,
  );
}

export interface DeleteConfirmInput {
  readonly vault: { slug: string; name: string };
  readonly path: string;
  readonly notice?: OpNotice;
  /** S10-T2 权限感知：同 RenamePageInput.canWrite（false=只读态——D4） */
  readonly canWrite?: boolean;
  /** UI-RESTYLE：顶部导航登录态（呈现层透传） */
  readonly viewer?: { username: string; display_name?: string; is_instance_admin: boolean };
}

/** 删除确认页（GET 无写操作；历史保留如实标注——S5 历史页可查旧版本） */
export function deleteConfirmPage(input: DeleteConfirmInput): string {
  const { vault, path, notice, viewer } = input;
  const action = `/vaults/${encodeURIComponent(vault.slug)}/delete/${encPath(path)}`;
  const cancelHref = path.includes('/')
    ? `/vaults/${encodeURIComponent(vault.slug)}/browse/${encPath(path.slice(0, path.lastIndexOf('/')))}`
    : `/vaults/${encodeURIComponent(vault.slug)}/browse`;
  // S10-T2 只读态（D4）：reader 直开 URL——无提交控件 + 无写权限标注
  if (input.canWrite === false) {
    return layout(
      `删除 ${path}`,
      `<div class="page page-narrow">
  <div class="page-head">
  <h1>删除确认</h1>
  <nav aria-label="面包屑">${breadcrumb(vault, path)}</nav>
  </div>
  ${noticeHtml(notice)}
  <p class="page-meta">将删除：<code>${escapeHtml(path)}</code></p>
  <p class="warn-block"><small>说明：删除不做元数据校验；Git 历史保留——旧提交中的历史版本仍可查（后续历史/还原功能基于此）。</small></p>
  <form class="form-card" aria-disabled="true">
  <p class="page-meta">${READONLY_BADGE} 无写权限：仅可查看，不能删除。</p>
  <div class="form-actions">
  <a href="${cancelHref}">取消</a>
  </div>
  </form>
</div>
`,
      '',
      viewer !== undefined ? { user: { username: viewer.username, displayName: viewer.display_name, isAdmin: viewer.is_instance_admin }, active: 'vaults' } : undefined,
    );
  }
  return layout(
    `删除 ${path}`,
    `<div class="page page-narrow">
  <div class="page-head">
  <h1>删除确认</h1>
  <nav aria-label="面包屑">${breadcrumb(vault, path)}</nav>
  </div>
  ${noticeHtml(notice)}
  <p class="page-meta">将删除：<code>${escapeHtml(path)}</code></p>
  <p class="warn-block"><small>说明：删除不做元数据校验；Git 历史保留——旧提交中的历史版本仍可查（后续历史/还原功能基于此）。</small></p>
  <form method="post" action="${action}" class="form-card">
  <div class="form-actions">
  <button type="submit" class="btn-primary">确认删除</button>
  <a href="${cancelHref}">取消</a>
  </div>
  </form>
</div>
`,
    '',
    viewer !== undefined ? { user: { username: viewer.username, displayName: viewer.display_name, isAdmin: viewer.is_instance_admin }, active: 'vaults' } : undefined,
  );
}

/** 存储/读取不可用态（成员已确认——非 404；与 browseStatePage 同规）。
 *  S12-T2（coordinator 批准扩展）：可选 viewer → 顶栏账户位（缺省兼容旧调用形态）。 */
export function opStatePage(
  vault: { slug: string; name: string },
  message: string,
  viewer?: { username: string; display_name?: string; is_instance_admin?: boolean },
): string {
  return layout(
    `${vault.name} 操作`,
    `<div class="page">
  <h1>${escapeHtml(vault.name)}</h1>
  <nav aria-label="面包屑">${breadcrumb(vault, '')}</nav>
  <p class="state-note">${escapeHtml(message)}</p>
</div>
`,
    '',
    viewer !== undefined
      ? { user: { username: viewer.username, displayName: viewer.display_name, isAdmin: viewer.is_instance_admin === true }, active: 'vaults' }
      : undefined,
  );
}
