/**
 * S4-T4 附件鉴权通道接口占位（本任务 S4-T2 定形——breakdown：「附件图片引用经
 * 鉴权通道（占位到 T4 的附件路由，接口先定）」）。
 *
 * 语义：Markdown 内仓库相对图片引用一律不得直出仓库路径为 <img src>——附件
 * 读取必须经鉴权路由（架构 §6「附件经鉴权读取」；URL 不可枚举见 DOD-06）。
 * S4-T2 预览页以本接口注入渲染管；T4 落地附件路由后在装配点传入真实解析器
 * （入参 = Markdown 原始相对路径，解析到当前文档所在目录是 T4 装配侧职责）。
 * 未接入期间（本占位）渲染管产出占位标注而非 <img>。
 */

/** 仓库相对图片引用 → 鉴权附件 URL；null = 通道未接入（占位标注） */
export type AttachmentImageUrlResolver = (repoRelPath: string) => string | null;

/** S4-T2 缺省解析器：通道未接入（S4-T4 落地附件路由后替换装配） */
export const ATTACHMENT_CHANNEL_PENDING: AttachmentImageUrlResolver = () => null;
