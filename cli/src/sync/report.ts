/**
 * sync 报告契约（S7-T3；架构 §7.3「多库逐库报告成功、跳过、失败，不能把部分成功
 * 报告成全部成功」；breakdown §2.6 S7-T3 行）。
 *
 * T1 的最小 stderr/stdout 行在此升级为结构化逐项结果：
 *   - status ∈ success | skipped | failed；
 *   - reason_code：成功=动作（cloned/fast_forwarded/up_to_date）、跳过=四态
 *     （dirty/ahead/diverged/other_branch）、失败=引擎原因码（SyncFailureCode）；
 *   - 细节随变体：head（cloned/up_to_date）、from+to（fast_forwarded）、
 *     reason（跳过文案）、message（失败细节）。
 *
 * --json：stdout 仅一份 JSON 文档（server/local_root/generatedAt/vaults[]/summary，
 * schema 固化于 test/sync-report*.test.ts）。用法/认证等命令级错误不产生 JSON 信封
 * （stderr 文本 + 退出码，同 ls 契约）。
 * 退出码：非零当且仅当 summary.failed > 0——跳过不判失败（§7.3 语义）。
 */
import type { SyncFailureCode, SyncOutcome } from './engine.ts'
import { EXIT_FAIL, EXIT_OK } from '../exit-codes.ts'

export type VaultStatus = 'success' | 'skipped' | 'failed'
export type VaultReasonCode =
  | 'cloned'
  | 'fast_forwarded'
  | 'up_to_date'
  | 'dirty'
  | 'ahead'
  | 'diverged'
  | 'other_branch'
  | SyncFailureCode

/** 逐库结果对象（vaults[] 元素形态；键集按变体固化；last_sync 与状态文件同源同值——S7-T4）。 */
export type VaultResult =
  | { readonly slug: string; readonly status: 'success'; readonly reason_code: 'cloned' | 'up_to_date'; readonly path: string; readonly head: string; readonly last_sync: string }
  | { readonly slug: string; readonly status: 'success'; readonly reason_code: 'fast_forwarded'; readonly path: string; readonly from: string; readonly to: string; readonly last_sync: string }
  | { readonly slug: string; readonly status: 'skipped'; readonly reason_code: 'dirty' | 'ahead' | 'diverged' | 'other_branch'; readonly path: string | null; readonly reason: string; readonly head: string | null; readonly last_sync: string | null }
  | { readonly slug: string; readonly status: 'failed'; readonly reason_code: SyncFailureCode; readonly path: string | null; readonly message: string }

/** 汇总计数（各计数 == vaults[] 逐项复数；total == vaults.length）。 */
export interface SyncSummary {
  readonly total: number
  readonly success: number
  readonly skipped: number
  readonly failed: number
}

/** outcome → 逐项结果对象（纯映射，无副作用）。 */
export function vaultResultOf(outcome: SyncOutcome): VaultResult {
  switch (outcome.action) {
    case 'cloned':
      return { slug: outcome.slug, status: 'success', reason_code: 'cloned', path: outcome.path, head: outcome.head, last_sync: outcome.last_sync }
    case 'fast_forwarded':
      return { slug: outcome.slug, status: 'success', reason_code: 'fast_forwarded', path: outcome.path, from: outcome.from, to: outcome.to, last_sync: outcome.last_sync }
    case 'up_to_date':
      return { slug: outcome.slug, status: 'success', reason_code: 'up_to_date', path: outcome.path, head: outcome.head, last_sync: outcome.last_sync }
    case 'skipped':
      return { slug: outcome.slug, status: 'skipped', reason_code: outcome.state, path: outcome.path, reason: outcome.reason, head: outcome.head, last_sync: outcome.last_sync }
    case 'failed':
      return { slug: outcome.slug, status: 'failed', reason_code: outcome.code, path: outcome.path, message: outcome.message }
  }
}

/** 汇总：逐项复数（跳过不计入失败——§7.3）。 */
export function summarize(results: readonly VaultResult[]): SyncSummary {
  const count = (s: VaultStatus): number => results.filter((r) => r.status === s).length
  return { total: results.length, success: count('success'), skipped: count('skipped'), failed: count('failed') }
}

/** 退出码契约：非零当且仅当有失败；跳过不判失败。 */
export function exitCodeOf(summary: SyncSummary): number {
  return summary.failed > 0 ? EXIT_FAIL : EXIT_OK
}

/** --json 文档形态（generatedAt 为 ISO 8601 UTC）。 */
export interface SyncReportDoc {
  readonly server: string
  readonly local_root: string
  readonly generatedAt: string
  readonly vaults: readonly VaultResult[]
  readonly summary: SyncSummary
}

export function buildSyncReport(args: {
  server: string
  local_root: string
  outcomes: readonly SyncOutcome[]
  /** 时钟注入（测试固定 generatedAt 用；缺省真实时间）。 */
  now?: () => Date
}): SyncReportDoc {
  const vaults = args.outcomes.map(vaultResultOf)
  return {
    server: args.server,
    local_root: args.local_root,
    generatedAt: (args.now ?? (() => new Date()))().toISOString(),
    vaults,
    summary: summarize(vaults),
  }
}

/** JSON 序列化（2 空格缩进、末尾换行；可被 JSON.parse 原样读回）。 */
export function renderReportJson(doc: SyncReportDoc): string {
  return `${JSON.stringify(doc, null, 2)}\n`
}

function short(sha: string): string {
  return sha.slice(0, 7)
}

/**
 * 文本人读输出：逐库行（成功→stdout 侧、跳过/失败→stderr 侧）+ 汇总行（stdout 侧）。
 * 格式与 T1 最小报告逐字兼容；汇总行如实携带失败计数，不把部分成功报成全部成功。
 */
export function renderReportText(results: readonly VaultResult[], summary: SyncSummary): { out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  for (const r of results) {
    if (r.status === 'success') {
      if (r.reason_code === 'fast_forwarded') out.push(`${r.slug}：已快进 ${short(r.from)} → ${short(r.to)}`)
      else if (r.reason_code === 'cloned') out.push(`${r.slug}：已克隆（HEAD ${short(r.head)}）→ ${r.path}`)
      else out.push(`${r.slug}：已是最新（${short(r.head)}）`)
    } else if (r.status === 'skipped') {
      err.push(`${r.slug}：跳过——${r.reason}；离线副本 ${r.head === null ? '?' : r.head.slice(0, 7)}，上次同步 ${r.last_sync ?? '未知（该副本未经 notegit 同步）'}`)
    } else {
      err.push(`${r.slug}：失败——${r.message}`)
    }
  }
  out.push(`同步完成：共 ${summary.total} 库（成功 ${summary.success}、跳过 ${summary.skipped}、失败 ${summary.failed}）`)
  return { out, err }
}
