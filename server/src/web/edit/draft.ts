/**
 * S4-T3 草稿 API 形状占位（api.md §7——存储本体属 S4-T6）：
 *
 * 编辑页「保存草稿」按钮经此 URL + 请求体形状调用（§7 PUT：upsert 每作者每
 * 路径一份、body={content, base_commit}、content=组装全文含 frontmatter）。
 * T6 落地存储前端点不存在——页面如实呈现调用结果（形状已定，接线即通）。
 */

export interface DraftPutBody {
  readonly content: string;
  readonly base_commit: string | null;
}

export function draftPutUrl(vaultSlug: string, path: string): string {
  return `/api/v1/vaults/${encodeURIComponent(vaultSlug)}/drafts/${path
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
}
