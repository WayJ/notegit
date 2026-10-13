/**
 * S4-T3 定形的草稿 API 调用形状（api.md §7）——S4-T6 存储落地后即为真实端点
 * （server/src/drafts/routes.ts，迁移 0008 drafts 表）：
 *
 * 编辑页「保存草稿」按钮经此 URL + 请求体形状调用（§7 PUT：upsert 每作者每
 * 路径一份、body={content, base_commit}、content=组装全文含 frontmatter、
 * 200 {updated_at}）。保存不产生 Git 版本；提交成功后服务端把本人草稿标已
 * 提交（edit/submit.ts 挂点）。
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
