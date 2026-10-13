/**
 * S5-T6 引用三要素（引用面最小实现）：引用 = 库 + 路径 + commit，格式与
 * S7-T8 harness 指引对齐（docs/harness/README.md 实例工作流节——
 * `v-handbook / docs/getting-started.md @ 4c55b7a0…`；架构 §7.1「回答引用
 * 库、路径和 commit，可对应到 Web 历史」的页面侧落点）。纯字符串面：解析只做
 * 形态判定；存在性/权限判定在路由层（authorize + readEntryAtCommit——与
 * version 寻址面同判，不在本模块触库）。
 */

/** 引用三要素（slug=vault slug；path=库内树路径；commit=hex 缩写/全 SHA） */
export interface Citation {
  readonly slug: string;
  readonly path: string;
  readonly commit: string;
}

/** slug 形态（vaults/service.ts SLUG_PATTERN 同源：小写字母/数字/`-`，1–64） */
const SLUG_SHAPE = /^[a-z0-9-]{1,64}$/;
/** commit 形态（version.ts OID_SHAPE 同判：hex 缩写/全 SHA，小写） */
const OID_SHAPE = /^[0-9a-f]{4,64}$/;

/**
 * 解析引用串「库 / 路径 @ commit」：分隔符与 @ 前后空白宽容；路径可含空格与
 * 斜杠——取最后一个 @ 为界（其尾部须为合法 commit 形态）。形态不符返回 null
 * （格式错误呈现与存在性判定在路由层，两类失败各自同页可理解）。
 */
export function parseCitation(raw: string): Citation | null {
  const at = raw.lastIndexOf('@');
  if (at === -1) return null;
  const slash = raw.indexOf('/');
  if (slash === -1 || slash > at) return null;
  const slug = raw.slice(0, slash).trim();
  const path = raw.slice(slash + 1, at).trim();
  const commit = raw.slice(at + 1).trim();
  if (!SLUG_SHAPE.test(slug) || path === '' || !OID_SHAPE.test(commit)) return null;
  return { slug, path, commit };
}

/** 组装引用串（复制引用呈现用——全 SHA 时与解析回放一一对应） */
export function formatCitation(slug: string, path: string, commitOid: string): string {
  return `${slug} / ${path} @ ${commitOid}`;
}
