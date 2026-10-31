/**
 * 库发现 API 客户端（S6-T3）：GET /api/v1/vaults（api.md §5——仅当前员工有成员
 * 关系的库；Bearer 认证）。实时权限由服务端逐请求判定（D-IC-05），CLI 不缓存。
 *
 * 本模块是 CLI 消费服务端响应的唯一收窄点：slug 与 default_branch 必须过
 * vault-shape.ts 的形态判定，否则整份列表按契约形态错误拒绝（fail-closed）。
 */
import { isSafeBranchName, isSafeVaultSlug } from '../vault-shape.ts'

/** 服务端列表项（api.md §5：slug/name/role/default_branch/main_admin_only）。 */
export interface VaultSummary {
  readonly slug: string
  readonly name: string
  readonly role: string
  readonly default_branch: string
  readonly main_admin_only: boolean
}

/** 失败分类（→ ls 统一映射退出码 1，消息区分呈现）。 */
export type VaultListErrorKind = 'auth' | 'server' | 'network' | 'shape'

export type VaultListResult =
  | { readonly ok: true; readonly vaults: readonly VaultSummary[] }
  | { readonly ok: false; readonly kind: VaultListErrorKind; readonly message: string }

/** clone URL（server Smart HTTP 形态 /git/<slug>[.git]，cgi.ts GIT_URL_RE 同构）。 */
export function cloneUrlOf(server: string, slug: string): string {
  return `${server.replace(/\/+$/, '')}/git/${slug}.git`
}

/**
 * 库标识与默认分支名的形态收窄（vault-shape.ts）：slug 必须是单个路径段、
 * 默认分支名必须是 git 可接受的 ref 子集。恶意/异常服务端可用越界 slug 把文件树
 * 写到同步根之外，或用分支名做 git 实参注入——形态不合即整份响应拒绝（fail-closed）。
 */
function hasValidIdentity(r: Record<string, unknown>): boolean {
  return (
    typeof r['slug'] === 'string' &&
    isSafeVaultSlug(r['slug']) &&
    typeof r['default_branch'] === 'string' &&
    isSafeBranchName(r['default_branch'])
  )
}

function isVaultItem(v: unknown): v is VaultSummary {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return (
    hasValidIdentity(r) &&
    typeof r['name'] === 'string' &&
    typeof r['role'] === 'string' &&
    typeof r['main_admin_only'] === 'boolean'
  )
}

/** 拉取有权库列表。任何传输/形态失败都折叠为 ok:false（不抛出）。 */
export async function fetchVaults(cred: { server: string; token: string }): Promise<VaultListResult> {
  let res: Response
  try {
    res = await fetch(`${cred.server}/api/v1/vaults`, {
      headers: { authorization: `Bearer ${cred.token}` },
    })
  } catch (err) {
    return { ok: false, kind: 'network', message: `无法连接服务器 ${cred.server}：${err instanceof Error ? err.message : String(err)}` }
  }
  if (res.status === 401) return { ok: false, kind: 'auth', message: '认证失败（401）：token 无效、过期或已撤销' }
  if (res.status !== 200) return { ok: false, kind: 'server', message: `服务器错误（${res.status}）：GET /api/v1/vaults 未成功` }
  let body: unknown
  try {
    body = await res.json()
  } catch {
    return { ok: false, kind: 'shape', message: '响应不符合 /api/v1/vaults 契约（非 JSON）' }
  }
  const vaults = (body as Record<string, unknown>)['vaults']
  if (!Array.isArray(vaults)) {
    return { ok: false, kind: 'shape', message: '响应不符合 /api/v1/vaults 契约（vaults 数组形态）' }
  }
  if (!vaults.every(isVaultItem)) {
    // 形态错误细分：库标识/默认分支名不合法（越界 slug、git 实参注入面）单列文案——
    // 与「数组结构不对」区分，便于用户判断是服务端异常还是响应被篡改。
    const identityBad = vaults.some((v) => typeof v !== 'object' || v === null || !hasValidIdentity(v as Record<string, unknown>))
    return {
      ok: false,
      kind: 'shape',
      message: identityBad
        ? '响应不符合 /api/v1/vaults 契约（库标识 slug 或默认分支名形态不合法）'
        : '响应不符合 /api/v1/vaults 契约（vaults 数组形态）',
    }
  }
  return { ok: true, vaults: vaults as VaultSummary[] }
}
