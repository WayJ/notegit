/**
 * notegit sync clean —— 撤权库本地副本的显式清理（S7-T5；架构 §7.3「失去权限时
 * 标记该库不可继续同步，不自动删除副本；显式清理遇到本地改动或未推送提交时拒绝
 * 并提示导出」；identity §5.2 撤权 → Git 通道 404 → sync 置 revoked 位）。
 *
 * 范围与红线：
 *  - 只处理状态文件（state.ts）中 revoked=true 的库——纯本地动作，不联网、不需要
 *    凭据；未标记的库（含 slug 改名产生的孤儿目录）一概不碰（孤儿由 sync 的提示
 *    引导，清理范围不扩大）。
 *  - 默认（无强制旗标）遇「未导出数据」拒绝删除并给出导出指引——D7 同源红线的
 *    删除侧：不自动删，删除不可逆，宁可拒绝。拒绝原因（CleanRefusal）：
 *      not_a_repo（目录不是 git 仓库，内容不可判定）/ local_changes（未提交修改，
 *      含未跟踪文件）/ stash_entries（暂存栈条目）/ unpushed_commits（可达自
 *      任何本地引用而不可达自任何远端跟踪引用的提交）/ indeterminate（探测失败）。
 *  - 强制旗标语义（选型记录 2026-10-13）：带强制旗标 = 越过上述拒绝、删除副本并
 *    在 stderr 警示丢弃了什么。被否决的备选：强制旗标仍拒绝未导出改动（则旗标
 *    无语义）。理由：D7 禁的是「自动」覆盖/清理；显式命令 + 拒绝文案（含导出
 *    指引）+ 用户再次主动加旗标构成知情决定——工具不做用户数据的最终监护人，
 *    但保证默认路径永远不丢数据。
 *  - 「未推送」判定口径：可达自（全部本地分支 + 全部 tag + HEAD + 暂存栈）而不
 *    可达自任何 refs/remotes/* 的提交数 > 0。远端跟踪引用 = 最近一次 fetch/clone
 *    的记忆（撤权后无法核验真实远端，本地记忆是可用最优依据）；口径偏保守方向
 *    = 多拒绝 = fail-safe。
 *  - 并发：每库 repo 锁内「检查 + 删除 + 移除条目」（lock.ts；锁序 repo → state
 *    单向，与 runSync 一致，不得反向）。
 *  - 退出码：0 = 全部目标已清理（或无可清理）；1 = 存在拒绝或失败；2 = 用法错误。
 */
import process from 'node:process'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { localRootOf } from '../ls/local-status.ts'
import { readSyncState, removeVaultEntry } from './state.ts'
import { repoLockPath, withFileLock } from './lock.ts'
import { EXIT_ERROR, EXIT_FAIL, EXIT_OK } from '../exit-codes.ts'

/** 强制清理旗标（notegit 自身选项，非 git 实参——D7 扫描按调用形态豁免比较/常量形态，见 clobber-scan.ts）。 */
const FORCE_FLAG = '--force'

/** 拒绝原因（机器可读；detail 为人读文案，随原因生成）。 */
export type CleanRefusal = 'not_a_repo' | 'local_changes' | 'unpushed_commits' | 'stash_entries' | 'indeterminate'

/** 清理安全探测缝（纯本地 git 只读探测；注入式单测用，真实实现见 realCleanInspectOps）。 */
export interface CleanInspectOps {
  /** HEAD commit（40 位 sha）；undefined = 非 git 仓库或不可读。 */
  revParseHead(dir: string): Promise<string | undefined>
  /** status --porcelain 原始输出；undefined = 命令失败。 */
  statusPorcelain(dir: string): Promise<string | undefined>
  /** 暂存栈是否有条目；undefined = 命令失败。 */
  stashExists(dir: string): Promise<boolean | undefined>
  /** 未推送提交数（口径见模块头）；undefined = 命令失败。 */
  unpushedCount(dir: string): Promise<number | undefined>
}

/**
 * 清理安全检查（纯函数面，无副作用）：null = 可安全删除（内容可由远端记忆重建）；
 * 否则返回首个命中的拒绝原因与人读 detail。检查顺序：git-ness → 未提交修改 →
 * 暂存栈 → 未推送提交；任一探测失败 → indeterminate（fail-safe 拒绝）。
 */
export async function inspectCleanSafety(ops: CleanInspectOps, dir: string): Promise<{ refusal: CleanRefusal; detail: string } | null> {
  const head = await ops.revParseHead(dir)
  if (head === undefined) return { refusal: 'not_a_repo', detail: '目录不是 git 仓库（或 HEAD 不可读）' }
  const status = await ops.statusPorcelain(dir)
  if (status === undefined) return { refusal: 'indeterminate', detail: '安全探测不可判定（git 命令失败）' }
  if (status.trim() !== '') return { refusal: 'local_changes', detail: '工作区有未提交修改（含未跟踪文件）' }
  const stash = await ops.stashExists(dir)
  if (stash === undefined) return { refusal: 'indeterminate', detail: '安全探测不可判定（git 命令失败）' }
  if (stash === true) return { refusal: 'stash_entries', detail: '暂存栈中有未导出条目' }
  const unpushed = await ops.unpushedCount(dir)
  if (unpushed === undefined) return { refusal: 'indeterminate', detail: '安全探测不可判定（git 命令失败）' }
  if (unpushed > 0) return { refusal: 'unpushed_commits', detail: `有 ${unpushed} 个未推送提交（领先于远端记忆）` }
  return null
}

/** 真实探测实现（execFile 异步；只读 git 调用；GIT_TERMINAL_PROMPT=0）。 */
function runCleanGit(cwd: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, encoding: 'utf8', timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (err, stdout) => resolve({ code: err === null ? 0 : (err as { code?: number }).code ?? 1, stdout: stdout ?? '' }),
    )
  })
}

const SHA_RE = /^[0-9a-f]{40}$/

export function realCleanInspectOps(): CleanInspectOps {
  return {
    revParseHead: async (dir) => {
      const r = await runCleanGit(dir, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])
      const sha = r.stdout.trim()
      return r.code === 0 && SHA_RE.test(sha) ? sha : undefined
    },
    statusPorcelain: async (dir) => {
      const r = await runCleanGit(dir, ['status', '--porcelain'])
      return r.code === 0 ? r.stdout : undefined
    },
    stashExists: async (dir) => {
      const r = await runCleanGit(dir, ['rev-parse', '--verify', '--quiet', 'refs/stash'])
      return r.code === 0 ? true : r.code === 1 ? false : undefined
    },
    unpushedCount: async (dir) => {
      // 暂存栈引用不存在时不得传入（rev-parse 报错）；先探测再拼入可达集。
      const stashProbe = await runCleanGit(dir, ['rev-parse', '--verify', '--quiet', 'refs/stash'])
      const hasStash = stashProbe.code === 0
      const r = await runCleanGit(dir, [
        'rev-list', '--count', '--branches', '--tags', 'HEAD', ...(hasStash ? ['refs/stash'] : []), '--not', '--remotes',
      ])
      if (r.code !== 0) return undefined
      const n = Number(r.stdout.trim())
      return Number.isFinite(n) && n >= 0 ? n : undefined
    },
  }
}

/** 单库清理结果（汇报用）。 */
type CleanOutcome =
  | { readonly kind: 'cleaned' }
  | { readonly kind: 'no_copy' }
  | { readonly kind: 'refused'; readonly refusal: CleanRefusal; readonly detail: string }
  | { readonly kind: 'forced'; readonly detail: string }
  | { readonly kind: 'failed'; readonly message: string }

/** 安全 slug（状态文件键理论上可被手改——删除路径拒绝路径穿越形态）。 */
function isSafeSlug(slug: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(slug) && slug !== '.' && slug !== '..'
}

/**
 * 清理单库（repo 锁内）：检查 →（默认）拒绝或删除 /（强制）警示后删除；
 * 删除/无副本后移除状态条目（锁序 repo → state）。
 */
async function cleanVault(root: string, slug: string, ops: CleanInspectOps, force: boolean): Promise<CleanOutcome> {
  return withFileLock(repoLockPath(root, slug), async () => {
    const dir = path.join(root, slug)
    if (!existsSync(dir)) {
      await removeVaultEntry(root, slug)
      return { kind: 'no_copy' }
    }
    const bad = await inspectCleanSafety(ops, dir)
    if (bad !== null && !force) return { kind: 'refused', ...bad }
    await rm(dir, { recursive: true, force: true })
    await removeVaultEntry(root, slug)
    return bad === null ? { kind: 'cleaned' } : { kind: 'forced', detail: bad.detail }
  })
}

/** 执行 notegit sync clean；返回进程退出码（0/1/2）。用法错误打 stderr 并返回 2。 */
export async function runSyncClean(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let force = false
  for (const a of argv) {
    if (a === FORCE_FLAG) {
      force = true
    } else if (a.startsWith('-')) {
      process.stderr.write(`notegit sync clean: 未知选项：${a}（notegit sync clean [--force]；notegit sync clean --help 查看用法）\n`)
      return EXIT_ERROR
    } else {
      process.stderr.write(`notegit sync clean: 不接受位置参数：${a}（清理范围只认状态文件中的撤权标记，不支持手点库名）\n`)
      return EXIT_ERROR
    }
  }
  const root = localRootOf(env)
  const marked = Object.entries(readSyncState(root).vaults)
    .filter(([, entry]) => entry.revoked)
    .map(([slug]) => slug)
    .sort()
  if (marked.length === 0) {
    process.stdout.write('没有已标记撤权的库，无需清理。\n')
    return EXIT_OK
  }
  const ops = realCleanInspectOps()
  let cleaned = 0
  let refused = 0
  let failed = 0
  for (const slug of marked) {
    if (!isSafeSlug(slug)) {
      process.stderr.write(`${slug}：失败——状态文件中的库形态不合法（拒绝执行删除）\n`)
      failed++
      continue
    }
    let out: CleanOutcome
    try {
      out = await cleanVault(root, slug, ops, force)
    } catch (err) {
      out = { kind: 'failed', message: `并发锁或清理操作失败：${err instanceof Error ? err.message : String(err)}` }
    }
    const dir = path.join(root, slug)
    switch (out.kind) {
      case 'cleaned':
        cleaned++
        process.stdout.write(`${slug}：已清理（本地副本已删除）\n`)
        break
      case 'no_copy':
        cleaned++
        process.stdout.write(`${slug}：无本地副本（仅移除撤权标记）\n`)
        break
      case 'forced':
        cleaned++
        process.stderr.write(`${slug}：强制清理——检测到未导出的本地数据：${out.detail}；本地副本已删除（内容已丢弃，不可恢复）\n`)
        break
      case 'refused':
        refused++
        process.stderr.write(`${slug}：拒绝清理——检测到未导出的本地数据：${out.detail}\n`)
        process.stderr.write(`  导出指引：git -C ${dir} bundle create ${dir}.bundle --all（或整体复制 ${dir} 目录留档）\n`)
        process.stderr.write('  如确认放弃这些内容，可带强制旗标重试（notegit sync clean --help 查看用法）\n')
        break
      case 'failed':
        failed++
        process.stderr.write(`${slug}：失败——${out.message}\n`)
        break
    }
  }
  process.stdout.write(`清理完成：共 ${marked.length} 个撤权标记库（已清理 ${cleaned}、拒绝 ${refused}、失败 ${failed}）\n`)
  return refused > 0 || failed > 0 ? EXIT_FAIL : EXIT_OK
}
