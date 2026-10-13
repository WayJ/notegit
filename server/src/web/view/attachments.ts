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

// ── S4-T4 落地（T2 接口接线）──────────────────────────────────────────────
//
// 选型记录（breakdown「URL 不可枚举——路径含不可猜测成分或按 blob 寻址」）：
// **按 blob 寻址**——附件 URL 以 Git blob OID（40/64 hex，内容散列）为不可
// 猜测成分（/vaults/{slug}/attach/{oid}/{filename}），无任何列表面；鉴权仍
// 逐请求判定（无权 404 反存在性），不可枚举与鉴权互补而非互替。被拒方案：
// 路径直出（可枚举）、DB 随机 token 映射（引库外状态，附件本体在 Git——
// 双源漂移）。OID 寻址附带语义：附件重新上传（内容变）则旧 OID URL 失效，
// 预览页每请求重解析（数据页实时渲染，无页内缓存——同 S4-T1 约定）。

/** 附件 URL 的 blob OID 形状（SHA-1 40 / SHA-256 64 hex；小写——git 输出原样） */
export const ATTACHMENT_OID_PATTERN = /^[0-9a-f]{40,64}$/;

/**
 * Markdown 相对图片引用 → 仓库路径（T2 接口注释语义：解析到当前文档所在
 * 目录是 T4 装配侧职责）。'/' 前缀 = 仓库根绝对引用；'.'/'..' 段归一；
 * 越出仓库根、空段、反斜杠/控制字符等畸形一律 null（不产出可查询路径——
 * 查无此径与占位标注同形，不泄露树内容）。
 */
export function repoPathOfRef(docPath: string, ref: string): string | null {
  if (ref === '') return null;
  const base = docPath.includes('/') ? docPath.slice(0, docPath.lastIndexOf('/')) : '';
  const segs: string[] = [];
  for (const seg of (ref.startsWith('/') ? ref.slice(1) : `${base === '' ? '' : `${base}/`}${ref}`).split('/')) {
    if (seg === '') return null; // 空段（含尾随斜杠）= 畸形引用（与 treePathOk 同判）
    if (seg === '.') continue;
    if (seg === '..') {
      if (segs.length === 0) return null; // 越出仓库根
      segs.pop();
      continue;
    }
    segs.push(seg);
  }
  const joined = segs.join('/');
  // 形状终检与浏览树同规则（browse/tree.ts treePathOk：段/长/字符集约束）
  if (joined === '' || joined.length > 1024 || joined.includes('\\')) return null;
  for (const seg of segs) {
    if (seg.length === 0 || seg.length > 255) return null;
    if (/[\x00-\x1f\x7f]/.test(seg)) return null;
  }
  return joined;
}

/** 鉴权附件 URL（blob 寻址；slug 与文件名按段转义，OID 原样 hex） */
export function attachmentUrl(vaultSlug: string, blobOid: string, filename: string): string {
  return `/vaults/${encodeURIComponent(vaultSlug)}/attach/${blobOid}/${encodeURIComponent(filename)}`;
}
