/**
 * notegit sync 命令实现（S7-T1；架构 §7.3 唯一语义源，架构 §8.1 命令面）。
 *
 * 流程：凭据面（同 ls：环境变量）→ GET /api/v1/vaults → 逐库六态判定
 * （local-status 的 computeSyncStatus）→ §7.3 策略表应用（engine）→ 报告
 * （report.ts，S7-T3：--json 结构化逐项 + 文本人读；退出码非零当且仅当有失败）。
 *
 * D7 红线：全链路不存在 stash/reset/rebase；跳过 = 完全不动本地副本。
 * 报告契约（JSON、逐项结构、汇总口径）= S7-T3 report.ts（唯一渲染器）；
 * 退出码：非零当且仅当有失败（跳过不判失败）。
 * S7-T2：成功结局写每库 last-sync 标记（本地形状，T4 状态文件集成点见模块头）；
 * 跳过原因/离线副本 commit/上次同步时间由 engine 的 skipped outcome 携带进报告。
 * S7-T4：每库 Git 操作加 repo 锁（判定面 fetch + 变更面 clone/ff）、状态写入走
 * 全局状态锁（lock.ts；锁序固定 repo → state，不得反向）；runSync 单一 syncedAt
 * 时钟 → 报告 last_sync / 状态条目 / .git 标记三面同源同值；状态仅缓存
 * （state.ts），丢失由正常 sync 全流程重建。
 * S7-T5：fetch 收 404 → skipped/revoked + 状态位置位（stateEntryOfOutcome 推导，
 * 恢复权限即随正常结局复位）；子命令 clean（clean.ts）显式清理已标记库副本。
 * S7-T6：命令级网络失败（库列表拉取不可达）stderr 附离线提示（可能过期 +
 * 指向 ls）；逐库断网三态/离线副本明示在 engine.ts 变更面完成。
 */
import process from 'node:process'
import path from 'node:path'
import { mkdir, readdir } from 'node:fs/promises'
import { credentialSourceFromEnv } from '../ls/credential-source.ts'
import { cloneUrlOf, fetchVaults } from '../ls/api.ts'
import { computeSyncStatus, localRootOf, realSyncGitOps } from '../ls/local-status.ts'
import { applySyncStrategy, realSyncOps, type SyncOutcome } from './engine.ts'
import { buildSyncReport, exitCodeOf, renderReportJson, renderReportText, summarize, vaultResultOf } from './report.ts'
import { writeLastSync } from './last-sync.ts'
import { repoLockPath, withFileLock } from './lock.ts'
import { stateEntryOfOutcome, writeVaultEntry } from './state.ts'
import { runSyncClean } from './clean.ts'
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
      return { ok: false, message: `不接受位置参数：${a}（notegit sync [--depth <深度>] [--json]；清理子命令 notegit sync clean 见 --help）` }
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
    if (name.startsWith('.')) continue // 工具内部目录（.notegit 状态/锁——S7-T4），非用户副本，不提示
    const dir = path.join(root, name)
    if ((await ops.revParse(dir, 'HEAD')) === undefined) continue // 只提示 git 副本，忽略普通目录
    process.stderr.write(`提示：${dir} 不对应当前任何可见库（slug 可能已改名或权限有变）；notegit 不会移动或删除该目录\n`)
  }
}

/**
 * 记录单库同步结局（repo 锁内调用——锁序 repo → state）：
 *   成功 → .git 标记 + 状态条目（同一 syncedAt「事务」，见 last-sync.ts 头）；
 *   跳过 → 仅状态条目（head=当前本地，last_sync=上次值，不刷新）；
 *   失败 → 不写（保留旧缓存事实）。
 */
async function recordVaultSync(root: string, outcome: SyncOutcome, syncedAt: Date): Promise<void> {
  const entry = stateEntryOfOutcome(outcome, syncedAt.toISOString())
  if (entry === null) return
  if (outcome.action === 'cloned' || outcome.action === 'fast_forwarded' || outcome.action === 'up_to_date') {
    await writeLastSync(outcome.path, syncedAt)
  }
  await writeVaultEntry(root, outcome.slug, entry)
}

/** 执行 sync；返回进程退出码。用法错误打 stderr 并返回 2（不抛出）。 */
export async function runSync(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (argv[0] === 'clean') return runSyncClean(argv.slice(1), env) // S7-T5 子命令：显式清理撤权库副本
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
    // S7-T6：网络面失败（服务器不可达）提示离线语义——不声称最新，指向 ls 查看各库离线副本
    const offlineHint = result.kind === 'network' ? '；本地副本未刷新、可能过期（notegit ls 可查看各库 HEAD 与上次同步时间）' : ''
    process.stderr.write(`notegit sync: ${result.message}${offlineHint}\n`)
    return EXIT_FAIL
  }
  const root = localRootOf(env)
  const ops = realSyncGitOps()
  const syncOps = realSyncOps()
  await mkdir(root, { recursive: true })
  // 单一时钟（S7-T4）：报告 last_sync、状态条目、.git 标记三面取同一时刻（同源同值）
  const syncedAt = new Date()
  const outcomes: SyncOutcome[] = []
  for (const v of result.vaults) {
    const cloneUrl = cloneUrlOf(cred.server, v.slug)
    let out: SyncOutcome
    try {
      // 每库 Git 操作锁（架构 §7.3「每库 Git 操作……分别加锁」）：判定面（含 fetch）、
      // 变更面（clone/ff）与本库状态记录都在锁内；recordVaultSync 内取全局状态锁——
      // 锁序固定 repo → state 单向，任何嵌套不得反向。computeSyncStatus /
      // applySyncStrategy 自身不抛（失败折叠为 failed outcome），此处 catch 只会
      // 命中锁获取/状态写的基础设施失败 → 逐库报 lock_failed，不中断其余库。
      out = await withFileLock(repoLockPath(root, v.slug), async () => {
        const info = await computeSyncStatus({ root, slug: v.slug, defaultBranch: v.default_branch, cloneUrl, ops })
        const o = await applySyncStrategy({
          root,
          slug: v.slug,
          cloneUrl,
          defaultBranch: v.default_branch,
          info,
          depth: parsed.args.depth,
          ops: syncOps,
          syncedAt: syncedAt.toISOString(),
        })
        await recordVaultSync(root, o, syncedAt)
        return o
      })
    } catch (err) {
      out = {
        action: 'failed',
        slug: v.slug,
        path: path.join(root, v.slug),
        code: 'lock_failed',
        message: `并发锁或状态写入失败：${err instanceof Error ? err.message : String(err)}`,
      }
    }
    outcomes.push(out)
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
