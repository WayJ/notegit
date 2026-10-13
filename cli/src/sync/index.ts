/**
 * notegit sync 命令实现（S7-T1；架构 §7.3 唯一语义源，架构 §8.1 命令面）。
 *
 * 流程：凭据面（同 ls：环境变量）→ GET /api/v1/vaults → 逐库六态判定
 * （local-status 的 computeSyncStatus）→ §7.3 策略表应用（engine）→ 报告
 * （report.ts，S7-T3：--json 结构化逐项 + 文本人读；退出码非零当且仅当有失败）。
 *
 * D7 红线：全链路不存在 stash/reset/rebase；跳过 = 完全不动本地副本。
 */
import process from 'node:process'
import path from 'node:path'
import { mkdir, readdir } from 'node:fs/promises'
import { credentialSourceFromEnv } from '../ls/credential-source.ts'
import { cloneUrlOf, fetchVaults } from '../ls/api.ts'
import { computeSyncStatus, localRootOf, realSyncGitOps } from '../ls/local-status.ts'
import { applySyncStrategy, realSyncOps, type SyncOutcome } from './engine.ts'
import { buildSyncReport, exitCodeOf, renderReportJson, renderReportText, summarize, vaultResultOf } from './report.ts'
import { EXIT_ERROR, EXIT_FAIL } from '../exit-codes.ts'

interface SyncArgs {
  depth?: number
  json: boolean
}

function parseArgs(argv: string[]): { ok: true; args: SyncArgs } | { ok: false; message: string } {
  let depth: number | undefined
  let json = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--depth') {
      const raw = argv[++i]
      if (raw === undefined || !/^[1-9]\d*$/.test(raw)) {
        return { ok: false, message: `--depth 需要正整数参数（浅克隆显式选项；缺省完整克隆）：${a} ${raw ?? ''}`.trim() }
      }
      depth = Number(raw)
    } else if (a === '--json') {
      json = true
    } else if (a.startsWith('-')) {
      return { ok: false, message: `未知选项：${a}（notegit sync --help 查看用法）` }
    } else {
      return { ok: false, message: `不接受位置参数：${a}（notegit sync [--depth <深度>] [--json]）` }
    }
  }
  return { ok: true, args: { depth, json } }
}

/** 本地根目录下不对应当前任何可见库的 git 副本 → 提示映射变化，不擅动目录（架构 §7.2）。 */
async function hintOrphanDirs(root: string, visibleSlugs: ReadonlySet<string>, ops: ReturnType<typeof realSyncGitOps>): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(root)
  } catch {
    return // 根目录不存在（尚无任何副本）——无孤儿可提示
  }
  for (const name of entries) {
    if (visibleSlugs.has(name)) continue
    const dir = path.join(root, name)
    if ((await ops.revParse(dir, 'HEAD')) === undefined) continue // 只提示 git 副本，忽略普通目录
    process.stderr.write(`提示：${dir} 不对应当前任何可见库（slug 可能已改名或权限有变）；notegit 不会移动或删除该目录\n`)
  }
}

/** 执行 sync；返回进程退出码。用法错误打 stderr 并返回 2（不抛出）。 */
export async function runSync(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const parsed = parseArgs(argv)
  if (!parsed.ok) {
    process.stderr.write(`notegit sync: ${parsed.message}\n`)
    return EXIT_ERROR
  }
  const cred = credentialSourceFromEnv(env)
  if (cred === undefined) {
    process.stderr.write('notegit sync: 未配置服务器或凭据（设置 NOTEGIT_SERVER 与 NOTEGIT_TOKEN；或先运行 notegit login）\n')
    return EXIT_FAIL
  }
  const result = await fetchVaults(cred)
  if (!result.ok) {
    process.stderr.write(`notegit sync: ${result.message}\n`)
    return EXIT_FAIL
  }
  const root = localRootOf(env)
  const ops = realSyncGitOps()
  const syncOps = realSyncOps()
  await mkdir(root, { recursive: true })
  const outcomes: SyncOutcome[] = []
  for (const v of result.vaults) {
    const cloneUrl = cloneUrlOf(cred.server, v.slug)
    const info = await computeSyncStatus({ root, slug: v.slug, defaultBranch: v.default_branch, cloneUrl, ops })
    outcomes.push(await applySyncStrategy({ root, slug: v.slug, cloneUrl, defaultBranch: v.default_branch, info, depth: parsed.args.depth, ops: syncOps }))
  }
  await hintOrphanDirs(root, new Set(result.vaults.map((v) => v.slug)), ops)
  if (parsed.args.json) {
    // 机器模式：stdout 仅一份 JSON 文档（逐项人读行不入 stdout；孤儿目录提示仍走 stderr）
    const doc = buildSyncReport({ server: cred.server, local_root: root, outcomes })
    process.stdout.write(renderReportJson(doc))
    return exitCodeOf(doc.summary)
  }
  const results = outcomes.map(vaultResultOf)
  const summary = summarize(results)
  const text = renderReportText(results, summary)
  for (const line of text.out) process.stdout.write(`${line}\n`)
  for (const line of text.err) process.stderr.write(`${line}\n`)
  return exitCodeOf(summary)
}
