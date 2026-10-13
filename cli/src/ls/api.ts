/**
 * 库发现 API 客户端（S6-T3）：GET /api/v1/vaults（api.md §5——仅当前员工有成员
 * 关系的库；Bearer 认证）。实时权限由服务端逐请求判定（D-IC-05），CLI 不缓存。
 */

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

function isVaultItem(v: unknown): v is VaultSummary {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return (
    typeof r['slug'] === 'string' &&
    typeof r['name'] === 'string' &&
    typeof r['role'] === 'string' &&
    typeof r['default_branch'] === 'string' &&
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
  if (!Array.isArray(vaults) || !vaults.every(isVaultItem)) {
    return { ok: false, kind: 'shape', message: '响应不符合 /api/v1/vaults 契约（vaults 数组形态）' }
  }
  return { ok: true, vaults: vaults as VaultSummary[] }
}
