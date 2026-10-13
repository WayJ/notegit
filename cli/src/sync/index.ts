/**
 * notegit sync 命令实现（S7-T1；架构 §7.3 唯一语义源，架构 §8.1 命令面）。
 *
 * 流程：凭据面（同 ls：环境变量）→ GET /api/v1/vaults → 逐库六态判定
 * （local-status 的 computeSyncStatus）→ §7.3 策略表应用（engine）→ 最小报告。
 *
 * D7 红线：全链路不存在 stash/reset/rebase；跳过 = 完全不动本地副本。
 * 报告契约（JSON、逐项结构、汇总口径）属 S7-T3；当前为最小 stdout/stderr 行，
 * 退出码语义先按 T3 验收口径落地：非零当且仅当有失败（跳过不判失败）。
 */
import process from 'node:process'
import path from 'node:path'
import { mkdir, readdir } from 'node:fs/promises'
import { credentialSourceFromEnv } from '../ls/credential-source.ts'
import { cloneUrlOf, fetchVaults } from '../ls/api.ts'
import { computeSyncStatus, localRootOf, realSyncGitOps } from '../ls/local-status.ts'
import { applySyncStrategy, realSyncOps, type SyncOutcome } from './engine.ts'
import { EXIT_ERROR, EXIT_FAIL, EXIT_OK } from '../exit-codes.ts'

interface SyncArgs {
  depth?: number
}

function parseArgs(argv: string[]): { ok: true; args: SyncArgs } | { ok: false; message: string } {
  let depth: number | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--depth') {
      const raw = argv[++i]
      if (raw === undefined || !/^[1-9]\d*$/.test(raw)) {
        return { ok: false, message: `--depth 需要正整数参数（浅克隆显式选项；缺省完整克隆）：${a} ${raw ?? ''}`.trim() }
      }
      depth = Number(raw)
    } else if (a.startsWith('-')) {
      return { ok: false, message: `未知选项：${a}（notegit sync --help 查看用法）` }
    } else {
      return { ok: false, message: `不接受位置参数：${a}（notegit sync [--depth <深度>]）` }
    }
  }
  return { ok: true, args: { depth } }
}

function short(sha: string | null | undefined): string {
  return sha === null || sha === undefined ? '?' : sha.slice(0, 7)
}

/** 最小报告行（T3 收口结构化契约前的过渡形态；成功走 stdout，跳过/失败走 stderr）。 */
function reportLine(out: SyncOutcome): void {
  switch (out.action) {
    case 'cloned':
      process.stdout.write(`${out.slug}：已克隆（HEAD ${short(out.head)}）→ ${out.path}\n`)
      break
    case 'fast_forwarded':
      process.stdout.write(`${out.slug}：已快进 ${short(out.from)} → ${short(out.to)}\n`)
      break
    case 'up_to_date':
      process.stdout.write(`${out.slug}：已是最新（${short(out.head)}）\n`)
      break
    case 'skipped':
      process.stderr.write(`${out.slug}：跳过——${out.reason}\n`)
      break
    case 'failed':
      process.stderr.write(`${out.slug}：失败——${out.message}\n`)
      break
  }
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
    const out = await applySyncStrategy({ root, slug: v.slug, cloneUrl, defaultBranch: v.default_branch, info, depth: parsed.args.depth, ops: syncOps })
    reportLine(out)
    outcomes.push(out)
  }
  await hintOrphanDirs(root, new Set(result.vaults.map((v) => v.slug)), ops)
  const ok = outcomes.filter((o) => o.action === 'cloned' || o.action === 'fast_forwarded' || o.action === 'up_to_date').length
  const skipped = outcomes.filter((o) => o.action === 'skipped').length
  const failed = outcomes.filter((o) => o.action === 'failed').length
  process.stdout.write(`同步完成：共 ${outcomes.length} 库（成功 ${ok}、跳过 ${skipped}、失败 ${failed}）\n`)
  return failed > 0 ? EXIT_FAIL : EXIT_OK
}
