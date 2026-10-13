/**
 * sync 策略应用（S7-T1；架构 §7.3 为唯一语义源）。
 *
 * 六类工作副本状态 → 行为：
 *   new → 完整克隆（浅克隆仅 --depth 显式选项）；
 *   clean → 已最新不动 / 落后则 fetch 后快进（--ff-only 语义）；
 *   dirty / ahead / diverged / other_branch → 跳过并给原因；
 *   error（判定失败）→ 失败。
 * S7-T5：revoked（fetch 收 404——撤权信号，判定面见 local-status.ts fetchTip）
 *   → 跳过并给原因（副本保留、指向显式清理入口）——撤权是预期后果，不判失败。
 *
 * D7 红线：本模块不存在任何 stash/reset/rebase 路径——跳过即完全不动本地副本。
 * 报告契约（JSON/逐项结构/汇总口径）见 report.ts（S7-T3）；本层只产出结构化 outcome
 * （失败带机器原因码 SyncFailureCode，跳过带状态与原因文案）。
 * S7-T2：skipped outcome 携带离线副本 head 与上次同步时间（last-sync 本地形状，
 * T4 状态文件集成点见该模块头）——供报告层呈现「原因+commit+时间」。
 * S7-T4：成功 outcome 亦携带 last_sync（syncedAt 注入，与状态文件/报告同源同值）。
 * S7-T6：断网三态分类（无法连接/超时/HTTP 错误码 → net_unreachable/timeout/
 * http_error，进 T3 失败原因码）+ 失败库存在可读本地 HEAD 时 message 明示
 * 「离线副本 <commit>（可能过期），上次同步 <时间>」（架构 §7.1：不能声称一定
 * 使用最新知识）+ 克隆失败清理半成品目录（库内无半更新）。NOTEGIT_SYNC_TIMEOUT_MS
 * 为网络操作超时注入缝（缺省 clone 300s / fetch 120s）。
 */
import path from 'node:path'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import type { SyncInfo, SyncState } from '../ls/local-status.ts'
import { readLastSync } from './last-sync.ts'

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
  | { readonly action: 'cloned'; readonly slug: string; readonly path: string; readonly head: string; readonly last_sync: string }
  | { readonly action: 'fast_forwarded'; readonly slug: string; readonly path: string; readonly from: string; readonly to: string; readonly last_sync: string }
  | { readonly action: 'up_to_date'; readonly slug: string; readonly path: string; readonly head: string; readonly last_sync: string }
  | {
    readonly action: 'skipped'
    readonly slug: string
    readonly path: string | null
    readonly state: Exclude<SyncState, 'new' | 'clean'>
    readonly reason: string
    /** 离线副本当前 commit（本地 head；不可读为 null）。 */
    readonly head: string | null
    /** 上次成功同步时间（ISO；未经 notegit 同步为 null）。读取面见 last-sync.ts（状态文件优先）。 */
    readonly last_sync: string | null
    }
  | { readonly action: 'failed'; readonly slug: string; readonly path: string | null; readonly code: SyncFailureCode; readonly message: string }

/**
 * 失败原因码（机器可读，S7-T3 报告契约）：status_error=六态判定基础设施失败；
 * clone_failed / fast_forward_failed=对应 git 变更操作失败；head_unreadable=变更
 * 完成后 HEAD 不可核验；internal=判定面数据不完整（不应发生的防御分支）；
 * lock_failed=并发锁获取/释放失败（S7-T4：runSync 层产生，引擎自身不加锁）；
 * S7-T6 断网三态：net_unreachable=无法连接（拒连/重置/DNS 等传输层失败）、
 * timeout=网络操作超时（git 报告或 CLI 侧超时终止）、http_error=服务端返回
 * HTTP 错误码（含 404 撤权形态——S7-T5 消费）——由 git 输出分类（见
 * classifyNetworkFailure），优先于 clone_failed/fast_forward_failed。
 */
export type SyncFailureCode =
  | 'status_error'
  | 'clone_failed'
  | 'head_unreadable'
  | 'fast_forward_failed'
  | 'internal'
  | 'lock_failed'
  | 'net_unreachable'
  | 'timeout'
  | 'http_error'

/** S7-T6 断网三态（报告 failed 原因码的真子集）。 */
export type NetFailureKind = 'net_unreachable' | 'timeout' | 'http_error'

/** git/curl stderr 的 HTTP 错误码形态（如 "The requested URL returned error: 500"）。 */
const HTTP_STATUS_RE = /URL returned error:?\s*(\d{3})/i
/** 超时形态：git 报告（Connection/Operation timed out）、ETIMEDOUT、CLI 侧超时终止文案。 */
const TIMEOUT_RE = /timed?\s?-?\s?out|timeout|ETIMEDOUT|超时/i
/**
 * 无法连接形态（顺序在 http/timeout 之后兜底）：拒连/重置/不可达/DNS 等。
 * unable to access 是 git 传输失败通用前缀（http/timeout 已先匹配走），此处兜住
 * 其余传输层错误（如 gnutls_handshake 失败、空响应）。
 */
const NET_RE =
  /could not resolve host|failed to connect|connection refused|connection reset|recv failure|empty reply from server|network is unreachable|couldn'?t connect|unable to access/i

/**
 * 断网三态分类（S7-T6；纯函数）：从 git 错误文本判定 net_unreachable/timeout/
 * http_error，非网络失败返回 null（保持 clone_failed/fast_forward_failed）。
 * 模式顺序即优先级：HTTP 错误码 > 超时 > 无法连接（unable to access 前缀会同时
 * 出现在三类文案中，先到先得）。
 */
export function classifyNetworkFailure(text: string): NetFailureKind | null {
  if (HTTP_STATUS_RE.test(text)) return 'http_error'
  if (TIMEOUT_RE.test(text)) return 'timeout'
  if (NET_RE.test(text)) return 'net_unreachable'
  return null
}

/** 跳过态的原因文案（四类工作副本态 + 撤权态；§7.3 枚举顺序）。 */
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
    case 'revoked':
      return '库已不可访问（服务端对 fetch 返回 404——权限可能已被撤销或库已删除）；本地副本保留、不自动删除，可用 notegit sync clean 显式清理'
    default:
      return `未知跳过态：${info.state}`
  }
}

function firstLine(message: string): string {
  return message.split('\n')[0] ?? message
}

/** 断网类的可读前缀（S7-T6「网络失败可理解报错」；保留 git 首行作细节）。 */
function humanNetLine(kind: NetFailureKind, raw: string): string {
  // realSyncOps 的超时终止抛出已是最终人类形态——不二次包裹
  if (/^(?:无法连接服务器（|网络操作超时（|服务器 HTTP 错误)/.test(raw)) return raw
  const line = firstLine(raw)
  if (kind === 'net_unreachable') return `无法连接服务器（${line}）`
  if (kind === 'timeout') return `网络操作超时（${line}）`
  const status = HTTP_STATUS_RE.exec(raw)?.[1]
  return status !== undefined ? `服务器 HTTP 错误 ${status}（${line}）` : `服务器 HTTP 错误（${line}）`
}

/**
 * 失败库的离线副本明示（S7-T6；架构 §7.1「失败时明确提示离线副本的 commit 和
 * 同步时间」）：存在可读本地 HEAD 时追加「离线副本 <短 sha>（可能过期），上次
 * 同步 <时间/未知>」——离线信息随 message 携带（不扩 T3 失败键集）。
 */
function offlineHint(root: string, dir: string | null, head: string | null): string {
  if (head === null || dir === null) return ''
  return `；离线副本 ${head.slice(0, 7)}（可能过期），上次同步 ${readLastSync(root, dir) ?? '未知（该副本未经 notegit 同步）'}`
}

/**
 * 克隆失败后的半成品清理（S7-T6 原子性「不存在库内半更新」）：仅当目录由本次
 * 克隆尝试产生（new 判定发起——进入本函数即处 clone 失败分支）、且 HEAD 不可
 * 解析（典型：超时被杀，git 来不及自清）时移除，恢复同步前状态。HEAD 可解析的
 * 目录疑似完整副本/用户数据（D7），绝不删除；清理失败不影响失败报告。
 */
async function cleanupPartialClone(dir: string, ops: SyncOps): Promise<void> {
  try {
    if (!existsSync(dir)) return
    if ((await ops.revHead(dir)) !== undefined) return
    await rm(dir, { recursive: true, force: true })
  } catch {
    // 尽力而为：清不掉的残留由下轮判定面按 error 逐库报告
  }
}

/**
 * 按判定结果应用 §7.3 策略表；永不抛出（git 失败折叠为 failed outcome）。
 * syncedAt：本次同步时间（S7-T4；runSync 以单一时钟传入，成功 outcome 的
 * last_sync 与状态文件/报告同源同值；缺省取当前时刻——直连调用方/测试用）。
 */
export async function applySyncStrategy(args: {
  root: string
  slug: string
  cloneUrl: string
  defaultBranch: string
  info: SyncInfo
  depth?: number
  ops: SyncOps
  syncedAt?: string
}): Promise<SyncOutcome> {
  const { slug, cloneUrl, defaultBranch, info, ops } = args
  const syncedAt = args.syncedAt ?? new Date().toISOString()
  const dir = info.path ?? path.join(args.root, slug)
  if (info.state === 'error') {
    // S7-T6：判定面失败（含获取远端失败的断网形态）且本地 HEAD 可读 → message 明示离线副本
    return { action: 'failed', slug, path: info.path, code: 'status_error', message: `${info.message ?? '状态判定失败'}${offlineHint(args.root, info.path, info.head)}` }
  }
  if (info.state === 'new') {
    try {
      await ops.clone(cloneUrl, dir, args.depth)
      const head = await ops.revHead(dir)
      if (head === undefined) return { action: 'failed', slug, path: dir, code: 'head_unreadable', message: `克隆完成但无法读取 HEAD：${dir}` }
      return { action: 'cloned', slug, path: dir, head, last_sync: syncedAt }
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err)
      const kind = classifyNetworkFailure(raw)
      // S7-T6：断网三态优先于 clone_failed；new 无离线副本可指——message 不带离线提示
      const failed = { action: 'failed', slug, path: dir, code: kind ?? ('clone_failed' as const), message: `克隆失败：${kind !== null ? humanNetLine(kind, raw) : firstLine(raw)}` } as const
      await cleanupPartialClone(dir, ops)
      return failed
    }
  }
  if (info.state === 'clean') {
    if (info.head === null || info.remote_tip === null) {
      return { action: 'failed', slug, path: dir, code: 'internal', message: 'clean 判定缺少 head/remote_tip（内部错误）' }
    }
    if (info.head === info.remote_tip) return { action: 'up_to_date', slug, path: dir, head: info.head, last_sync: syncedAt }
    try {
      await ops.fastForward(dir, cloneUrl, defaultBranch)
      const head = await ops.revHead(dir)
      if (head === undefined) return { action: 'failed', slug, path: dir, code: 'head_unreadable', message: `快进后无法读取 HEAD：${dir}` }
      return { action: 'fast_forwarded', slug, path: dir, from: info.head, to: head, last_sync: syncedAt }
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err)
      const kind = classifyNetworkFailure(raw)
      // S7-T6：断网三态优先于 fast_forward_failed；已有副本 → message 明示离线副本（§7.1）
      return {
        action: 'failed',
        slug,
        path: dir,
        code: kind ?? ('fast_forward_failed' as const),
        message: `快进失败：${kind !== null ? humanNetLine(kind, raw) : firstLine(raw)}${offlineHint(args.root, dir, info.head)}`,
      }
    }
  }
  return {
    action: 'skipped',
    slug,
    path: info.path,
    state: info.state,
    reason: skipReason(info, defaultBranch),
    head: info.head,
    last_sync: readLastSync(args.root, info.path),
  }
}

/** 真实变更 ops（execFile 异步；GIT_TERMINAL_PROMPT=0；凭据经 credential helper，不进 URL）。 */
function runGitAsync(cwd: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, encoding: 'utf8', timeout: timeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (err, stdout, stderr) => {
        const timedOut = err !== null && ((err as { killed?: boolean }).killed === true || /timed out/i.test(err.message))
        resolve({ code: err === null ? 0 : (err as { code?: number }).code ?? 1, stdout: stdout ?? '', stderr: stderr ?? '', timedOut })
      },
    )
  })
}

/**
 * 网络操作超时注入缝（S7-T6）：NOTEGIT_SYNC_TIMEOUT_MS 毫秒（正整数）覆盖 clone/
 * fetch 的内置超时（慢网/调试调优与断网超时测试注入）；缺省或非法值取内置缺省。
 */
function netTimeoutMs(fallbackMs: number): number {
  const raw = (process.env['NOTEGIT_SYNC_TIMEOUT_MS'] ?? '').trim()
  return /^[1-9]\d*$/.test(raw) ? Number(raw) : fallbackMs
}

export function realSyncOps(): SyncOps {
  return {
    clone: async (url, dir, depth) => {
      const args = ['clone', '--quiet', ...(depth !== undefined ? ['--depth', String(depth)] : []), url, dir]
      const timeout = netTimeoutMs(300_000)
      const r = await runGitAsync(process.cwd(), args, timeout)
      if (r.timedOut) throw new Error(`网络操作超时（git clone 超过 ${timeout} ms 上限）`)
      if (r.code !== 0) throw new Error(r.stderr || r.stdout || `git clone 退出码 ${r.code}`)
    },
    fastForward: async (dir, url, branch) => {
      const timeout = netTimeoutMs(120_000)
      const f = await runGitAsync(dir, ['fetch', '--quiet', url, branch], timeout)
      if (f.timedOut) throw new Error(`网络操作超时（git fetch 超过 ${timeout} ms 上限）`)
      if (f.code !== 0) throw new Error(f.stderr || f.stdout || `git fetch 退出码 ${f.code}`)
      const m = await runGitAsync(dir, ['merge', '--ff-only', 'FETCH_HEAD'], 120_000) // 本地操作，不接注入缝
      if (m.code !== 0) throw new Error(m.stderr || m.stdout || `git merge --ff-only 退出码 ${m.code}`)
    },
    revHead: async (dir) => {
      const r = await runGitAsync(dir, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], 30_000)
      const sha = r.stdout.trim()
      return r.code === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : undefined
    },
  }
}
