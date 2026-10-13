/**
 * 服务端规则版本探测与比较（S6-T4；coordinator ask 裁定方案 A；S6-T7 激活）。
 *
 * GET <server>/api/v1/rules-version（Bearer，复用 ls 凭据面 NOTEGIT_SERVER/NOTEGIT_TOKEN）。
 * S6-T7 起端点已落地（api.md §3.3 补录 + server/src/rulesversion/routes.ts 实现，
 * 经 notegit-validation 运行时读 rules-version.json 单一来源）；本常量与 api.md
 * 端点表的一致性由 cli/test/rules-version-consistency.test.ts 断言。
 * 端点不可达/坏形状仍一律「跳过提示」，绝不影响校验判定与退出码（validation.md §6：
 * 版本差异本身不构成拒绝理由；N- 码退出码 0）。
 */
import type { ServerCredential } from '../ls/credential-source.ts'

/** 探测结局：拿到服务端版本，或跳过（silent=true 时不向用户输出跳过说明——未配置凭据是常态）。 */
export type VersionProbeResult = { kind: 'version'; version: string } | { kind: 'skipped'; reason: string; silent: boolean }

export const RULES_VERSION_ENDPOINT = '/api/v1/rules-version'

const NO_CREDENTIALS = { kind: 'skipped', reason: '未配置服务器凭据', silent: true } as const

export async function probeServerRulesVersion(
  cred: ServerCredential | undefined,
  fetchImpl: typeof fetch,
): Promise<VersionProbeResult> {
  if (cred === undefined) return NO_CREDENTIALS
  let res: Response
  try {
    res = await fetchImpl(`${cred.server}${RULES_VERSION_ENDPOINT}`, {
      headers: { authorization: `Bearer ${cred.token}` },
      signal: AbortSignal.timeout(5000),
    })
  } catch {
    return { kind: 'skipped', reason: '服务端不可达', silent: false }
  }
  if (res.status === 404) return { kind: 'skipped', reason: '服务端未提供规则版本端点', silent: false }
  if (!res.ok) return { kind: 'skipped', reason: `服务端返回 ${res.status}`, silent: false }
  let body: unknown
  try {
    body = await res.json()
  } catch {
    return { kind: 'skipped', reason: '响应不是合法 JSON', silent: false }
  }
  const version = (body as { rulesVersion?: unknown }).rulesVersion
  if (typeof version !== 'string' || version === '') return { kind: 'skipped', reason: '响应缺少 rulesVersion 字段', silent: false }
  return { kind: 'version', version }
}

/** SemVer 前置比较（validation.md §7.1 形态 `MAJOR.MINOR.PATCH[-prerelease]`）。-1=a<b、0=相等、1=a>b；任一不可解析 → null（调用方按不可比跳过提示）。 */
export function compareRulesVersions(a: string, b: string): number | null {
  const pa = parseSemVer(a)
  const pb = parseSemVer(b)
  if (pa === null || pb === null) return null
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i]! < pb.core[i]! ? -1 : 1
  }
  // 预发布段：无预发布 > 有预发布；逐标识符比较（数值 < 字母数字；同为数值按数值；短者先行则小）
  if (pa.pre === null && pb.pre === null) return 0
  if (pa.pre === null) return 1
  if (pb.pre === null) return -1
  const n = Math.min(pa.pre.length, pb.pre.length)
  for (let i = 0; i < n; i++) {
    const x = pa.pre[i]!
    const y = pb.pre[i]!
    if (x === y) continue
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) return Number(x) < Number(y) ? -1 : 1
    if (xn) return -1
    if (yn) return 1
    return x < y ? -1 : 1
  }
  return pa.pre.length < pb.pre.length ? -1 : pa.pre.length > pb.pre.length ? 1 : 0
}

function parseSemVer(v: string): { core: [number, number, number]; pre: string[] | null } | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v)
  if (m === null) return null
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] === undefined ? null : m[4].split('.') }
}
