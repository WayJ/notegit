/**
 * sync 策略应用（S7-T1；架构 §7.3 为唯一语义源）。
 *
 * 六类工作副本状态 → 行为：
 *   new → 完整克隆（浅克隆仅 --depth 显式选项）；
 *   clean → 已最新不动 / 落后则 fetch 后快进（--ff-only 语义）；
 *   dirty / ahead / diverged / other_branch → 跳过并给原因；
 *   error（判定失败）→ 失败。
 *
 * D7 红线：本模块不存在任何 stash/reset/rebase 路径——跳过即完全不动本地副本。
 * 报告契约（JSON/逐项结构/汇总口径）见 report.ts（S7-T3）；本层只产出结构化 outcome
 * （失败带机器原因码 SyncFailureCode，跳过带四态与原因文案）。
 */
import path from 'node:path'
import { execFile } from 'node:child_process'
import type { SyncInfo, SyncState } from '../ls/local-status.ts'

/** 变更操作缝（clone/快进；单元测试注入假件，真实实现见 realSyncOps）。 */
export interface SyncOps {
  /** 克隆到 dir（git clone [--depth n] url dir）；失败抛 Error（含 git 输出首行）。 */
  clone(url: string, dir: string, depth?: number): Promise<void>
  /** fetch 后快进默认分支（git fetch url branch + git merge --ff-only FETCH_HEAD）；失败抛 Error。 */
  fastForward(dir: string, url: string, branch: string): Promise<void>
  /** 读取 HEAD（操作后核验用）；undefined = 不可读。 */
  revHead(dir: string): Promise<string | undefined>
}

export type SyncOutcome =
  | { readonly action: 'cloned'; readonly slug: string; readonly path: string; readonly head: string }
  | { readonly action: 'fast_forwarded'; readonly slug: string; readonly path: string; readonly from: string; readonly to: string }
  | { readonly action: 'up_to_date'; readonly slug: string; readonly path: string; readonly head: string }
  | { readonly action: 'skipped'; readonly slug: string; readonly path: string | null; readonly state: Exclude<SyncState, 'new' | 'clean'>; readonly reason: string }
  | { readonly action: 'failed'; readonly slug: string; readonly path: string | null; readonly code: SyncFailureCode; readonly message: string }

/**
 * 失败原因码（机器可读，S7-T3 报告契约）：status_error=六态判定基础设施失败；
 * clone_failed / fast_forward_failed=对应 git 变更操作失败；head_unreadable=变更
 * 完成后 HEAD 不可核验；internal=判定面数据不完整（不应发生的防御分支）。
 */
export type SyncFailureCode = 'status_error' | 'clone_failed' | 'head_unreadable' | 'fast_forward_failed' | 'internal'

/** 四类跳过态的原因文案（§7.3 枚举顺序；T3 收口报告契约时可再精化）。 */
function skipReason(info: SyncInfo, defaultBranch: string): string {
  switch (info.state) {
    case 'dirty':
      return '工作区有未提交修改（含未跟踪文件）；保留本地改动，不自动 stash/reset/rebase'
    case 'ahead':
      return '本地有领先远端的未推送提交'
    case 'diverged':
      return '本地与远端分叉（两侧各有新提交）'
    case 'other_branch':
      return info.branch === null
        ? `当前为分离头指针，不在默认分支 ${defaultBranch} 上`
        : `当前位于分支 ${info.branch}，不是默认分支 ${defaultBranch}`
    default:
      return `未知跳过态：${info.state}`
  }
}

function firstLine(message: string): string {
  return message.split('\n')[0] ?? message
}

/** 按判定结果应用 §7.3 策略表；永不抛出（git 失败折叠为 failed outcome）。 */
export async function applySyncStrategy(args: {
  root: string
  slug: string
  cloneUrl: string
  defaultBranch: string
  info: SyncInfo
  depth?: number
  ops: SyncOps
}): Promise<SyncOutcome> {
  const { slug, cloneUrl, defaultBranch, info, ops } = args
  const dir = info.path ?? path.join(args.root, slug)
  if (info.state === 'error') return { action: 'failed', slug, path: info.path, code: 'status_error', message: info.message ?? '状态判定失败' }
  if (info.state === 'new') {
    try {
      await ops.clone(cloneUrl, dir, args.depth)
      const head = await ops.revHead(dir)
      if (head === undefined) return { action: 'failed', slug, path: dir, code: 'head_unreadable', message: `克隆完成但无法读取 HEAD：${dir}` }
      return { action: 'cloned', slug, path: dir, head }
    } catch (err) {
      return { action: 'failed', slug, path: dir, code: 'clone_failed', message: `克隆失败：${firstLine(err instanceof Error ? err.message : String(err))}` }
    }
  }
  if (info.state === 'clean') {
    if (info.head === null || info.remote_tip === null) {
      return { action: 'failed', slug, path: dir, code: 'internal', message: 'clean 判定缺少 head/remote_tip（内部错误）' }
    }
    if (info.head === info.remote_tip) return { action: 'up_to_date', slug, path: dir, head: info.head }
    try {
      await ops.fastForward(dir, cloneUrl, defaultBranch)
      const head = await ops.revHead(dir)
      if (head === undefined) return { action: 'failed', slug, path: dir, code: 'head_unreadable', message: `快进后无法读取 HEAD：${dir}` }
      return { action: 'fast_forwarded', slug, path: dir, from: info.head, to: head }
    } catch (err) {
      return { action: 'failed', slug, path: dir, code: 'fast_forward_failed', message: `快进失败：${firstLine(err instanceof Error ? err.message : String(err))}` }
    }
  }
  return { action: 'skipped', slug, path: info.path, state: info.state, reason: skipReason(info, defaultBranch) }
}

/** 真实变更 ops（execFile 异步；GIT_TERMINAL_PROMPT=0；凭据经 credential helper，不进 URL）。 */
function runGitAsync(cwd: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, encoding: 'utf8', timeout: timeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (err, stdout, stderr) =>
        resolve({ code: err === null ? 0 : (err as { code?: number }).code ?? 1, stdout: stdout ?? '', stderr: stderr ?? '' }),
    )
  })
}

export function realSyncOps(): SyncOps {
  return {
    clone: async (url, dir, depth) => {
      const args = ['clone', '--quiet', ...(depth !== undefined ? ['--depth', String(depth)] : []), url, dir]
      const r = await runGitAsync(process.cwd(), args, 300_000)
      if (r.code !== 0) throw new Error(r.stderr || r.stdout || `git clone 退出码 ${r.code}`)
    },
    fastForward: async (dir, url, branch) => {
      const f = await runGitAsync(dir, ['fetch', '--quiet', url, branch], 120_000)
      if (f.code !== 0) throw new Error(f.stderr || f.stdout || `git fetch 退出码 ${f.code}`)
      const m = await runGitAsync(dir, ['merge', '--ff-only', 'FETCH_HEAD'], 120_000)
      if (m.code !== 0) throw new Error(m.stderr || m.stdout || `git merge --ff-only 退出码 ${m.code}`)
    },
    revHead: async (dir) => {
      const r = await runGitAsync(dir, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], 30_000)
      const sha = r.stdout.trim()
      return r.code === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : undefined
    },
  }
}
