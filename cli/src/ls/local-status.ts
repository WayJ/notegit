/**
 * 本地状态判定（S6-T3；breakdown 行：已克隆/落后/未知 + 未克隆）。
 *
 * 路径约定（架构 §7.2）：本地根目录默认 ~/knowbase，库副本 = <root>/<slug>。
 *
 * 远端 tip 获取：api.md 未提供 tip 端点（缺口记 open——见执行记录），故经 git
 * 取远端：`git fetch <cloneUrl> <branch>` 后读 FETCH_HEAD（比 ls-remote 多带回
 * 对象，使 merge-base 祖先判定可行；不动分支/工作区）。fetch 走服务端 Smart
 * HTTP 的 credential helper 配置（T2 面），token 不进 URL/参数。
 *
 * 状态机（isAncestor=false 即本地领先/分叉 → unknown：精确六态属 S7 sync）：
 *   无副本 → not_cloned；head 或 tip 拿不到 → unknown；head==tip → cloned；
 *   head 是 tip 祖先 → behind；否则 → unknown。
 *
 * S7-T1 扩展（D5）：sync 六态 = ls 四态的展开——not_cloned→new；cloned/behind→
 * clean；unknown→{dirty/ahead/diverged/other_branch}（判定基础设施失败另记
 * error）。见下方 SyncGitOps/computeSyncStatus；ls 四态自身语义不变。
 * S7-T5 扩展：fetch 失败面分类（fetchTip）——HTTP 404 → revoked（撤权标记，
 * identity §5.2）；ls 四态与 remoteTip 语义不变（ls 不消费撤权信号）。
 */
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { execFile } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { readCliConfig } from '../setup/config.ts'

export type LocalStatus = 'not_cloned' | 'cloned' | 'behind' | 'unknown'

export interface LocalInfo {
  readonly path: string | null
  readonly status: LocalStatus
  readonly head: string | null
  readonly remote_tip: string | null
}

/** git 操作缝（单元测试注入假件；真实实现见 realGitOps）。 */
export interface GitOps {
  revParse(cwd: string, ref: string): Promise<string | undefined>
  remoteTip(cwd: string, url: string, branch: string): Promise<string | undefined>
  isAncestor(cwd: string, a: string, b: string): Promise<boolean | undefined>
}

/** 本地根目录解析（S6-T6 起三级）：NOTEGIT_LOCAL_ROOT 显式 > CLI 配置 localRoot（setup --local-root 持久化）> 缺省 ~/knowbase（架构 §7.2）。 */
export function localRootOf(env: NodeJS.ProcessEnv): string {
  const explicit = (env['NOTEGIT_LOCAL_ROOT'] ?? '').trim()
  if (explicit !== '') return path.resolve(explicit)
  const configured = (readCliConfig(env)['localRoot'] ?? '').trim()
  if (configured !== '') return path.resolve(configured)
  return path.join(os.homedir(), 'knowbase')
}

/**
 * S7-T7 托管隔离：员工本地根目录创建面（架构 §7.2「不同员工的可写工作目录不
 * 共享」、§4.1；DOD-10）。创建即 0700——列举目录即可泄露库 slug，其他员工不得
 * 持有任何组/其他权限位；预存在目录显式收紧（同 credentials.ts 对凭据文件 0600
 * 的先例——防历史/误配宽松权限，fail-closed 到私有；收紧只移除组/其他位，属主
 * 使用不受影响）。凭据文件的对应面在 credentials.ts（文件 0600 + 创建时父目录
 * 0700；父目录不收紧——令牌机密由文件位保护，不动用户 ~/.config 既有权限）。
 */
export function ensureLocalRoot(root: string): void {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  chmodSync(root, 0o700)
}

export async function computeLocalStatus(args: {
  root: string
  slug: string
  defaultBranch: string
  cloneUrl: string
  ops: GitOps
}): Promise<LocalInfo> {
  const dir = path.join(args.root, args.slug)
  if (!existsSync(dir)) return { path: null, status: 'not_cloned', head: null, remote_tip: null }
  const head = await args.ops.revParse(dir, `refs/heads/${args.defaultBranch}`)
  if (head === undefined) return { path: dir, status: 'unknown', head: null, remote_tip: null }
  const tip = await args.ops.remoteTip(dir, args.cloneUrl, args.defaultBranch)
  if (tip === undefined) return { path: dir, status: 'unknown', head, remote_tip: null }
  if (head === tip) return { path: dir, status: 'cloned', head, remote_tip: tip }
  const behind = await args.ops.isAncestor(dir, head, tip)
  if (behind === true) return { path: dir, status: 'behind', head, remote_tip: tip }
  return { path: dir, status: 'unknown', head, remote_tip: tip }
}

/** 真实 git 调用（spawn；GIT_TERMINAL_PROMPT=0 防交互挂起；失败折叠 undefined）。 */
function runGit(cwd: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, encoding: 'utf8', timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (err, stdout) => resolve({ code: err === null ? 0 : (err as { code?: number }).code ?? 1, stdout: stdout ?? '' }),
    )
  })
}

/** 同 runGit 但捕获 stderr（fetch 失败面分类需要——S7-T5）。 */
function runGitErr(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, encoding: 'utf8', timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (err, stdout, stderr) => resolve({ code: err === null ? 0 : (err as { code?: number }).code ?? 1, stdout: stdout ?? '', stderr: stderr ?? '' }),
    )
  })
}

export function realGitOps(): GitOps {
  return {
    revParse: async (cwd, ref) => {
      const r = await runGit(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
      const sha = r.stdout.trim()
      return r.code === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : undefined
    },
    remoteTip: async (cwd, url, branch) => {
      const f = await runGit(cwd, ['fetch', '--quiet', url, branch])
      if (f.code !== 0) return undefined
      const p = await runGit(cwd, ['rev-parse', '--verify', '--quiet', 'FETCH_HEAD^{commit}'])
      const sha = p.stdout.trim()
      return p.code === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : undefined
    },
    isAncestor: async (cwd, a, b) => {
      const r = await runGit(cwd, ['merge-base', '--is-ancestor', a, b])
      return r.code === 0 ? true : r.code === 1 ? false : undefined
    },
  }
}

// ── S7-T1：sync 六态判定（D5：ls 四态的展开，复用本文件判定面） ────────────────

/** sync 判定附加缝：在 ls 的 GitOps 上增加当前分支与工作区洁净度（注入式单测用）。 */
export interface SyncGitOps extends GitOps {
  /** 当前检出分支名；null = 分离头指针；undefined = 不可判定。 */
  currentBranch(cwd: string): Promise<string | null | undefined>
  /** 工作区是否有未提交修改（含未跟踪文件——保守视为脏，防快进覆盖）；undefined = 不可判定。 */
  isDirty(cwd: string): Promise<boolean | undefined>
  /**
   * 判定面 fetch（同 remoteTip 语义）但失败面分类（S7-T5）：
   * not_found = HTTP 404 / 库不存在——撤权信号（identity §5.2）；
   * unavailable = 其他失败（网络、认证等——不误标撤权）。
   */
  fetchTip(cwd: string, url: string, branch: string): Promise<FetchTipResult>
}

export type FetchTipResult = { readonly found: true; readonly sha: string } | { readonly found: false; readonly reason: 'not_found' | 'unavailable' }

/**
 * sync 六态（架构 §7.3 策略表的判定面）：
 *   new=无副本；clean=默认分支干净（含已最新与可快进）；dirty/ahead/diverged/other_branch=四类跳过。
 * error = 判定基础设施失败（非 git 仓库、fetch 失败、祖先判定不可用）——按失败逐库报告，不入策略表。
 * revoked = 服务端权限面状态而非工作副本状态（S7-T5）：fetch 收 HTTP 404
 *   （identity §5.2：撤权库 Git 通道一律 404）→ 该库不可继续同步，策略上归入
 *   跳过族（本地副本保留，显式清理入口 sync clean）；判定序仍在 fetch 处——
 *   本地即可判的跳过态（脏/他分支等）不发起网络，也就不会发现撤权。
 */
export type SyncState = 'new' | 'clean' | 'dirty' | 'ahead' | 'diverged' | 'other_branch' | 'revoked'

export interface SyncInfo {
  readonly state: SyncState | 'error'
  readonly path: string | null
  /** 当前检出分支（无副本或分离头指针时 null；分离头指针属 other_branch）。 */
  readonly branch: string | null
  readonly head: string | null
  readonly remote_tip: string | null
  /** error 细节（skip 原因由引擎按状态生成，不在此重复）。 */
  readonly message: string | null
}

/**
 * 六态判定顺序（§7.3「先获取远端，再判断更新条件」作用于更新路径；本地即可判定的
 * 跳过态不发起网络）：无副本→new；非仓库→error；他分支/分离→other_branch；
 * 脏→dirty；fetch→tip（404→revoked，S7-T5；其他失败→error）；head==tip→clean；
 * head 祖先于 tip→clean（可快进）；tip 祖先于 head→ahead；互不为祖先→diverged。
 */
export async function computeSyncStatus(args: {
  root: string
  slug: string
  defaultBranch: string
  cloneUrl: string
  ops: SyncGitOps
}): Promise<SyncInfo> {
  const dir = path.join(args.root, args.slug)
  if (!existsSync(dir)) return { state: 'new', path: null, branch: null, head: null, remote_tip: null, message: null }
  const repoHead = await args.ops.revParse(dir, 'HEAD')
  if (repoHead === undefined) {
    return { state: 'error', path: dir, branch: null, head: null, remote_tip: null, message: `目录存在但不是 git 仓库（或 HEAD 不可读）：${dir}` }
  }
  const branch = await args.ops.currentBranch(dir)
  if (branch === undefined) {
    return { state: 'error', path: dir, branch: null, head: repoHead, remote_tip: null, message: `无法判定当前分支：${dir}` }
  }
  if (branch === null || branch !== args.defaultBranch) {
    return { state: 'other_branch', path: dir, branch, head: repoHead, remote_tip: null, message: null }
  }
  const dirty = await args.ops.isDirty(dir)
  if (dirty === undefined) {
    return { state: 'error', path: dir, branch, head: repoHead, remote_tip: null, message: `无法判定工作区洁净度：${dir}` }
  }
  if (dirty === true) return { state: 'dirty', path: dir, branch, head: repoHead, remote_tip: null, message: null }
  const tip = await args.ops.fetchTip(dir, args.cloneUrl, args.defaultBranch)
  if (tip.found === false) {
    if (tip.reason === 'not_found') {
      return { state: 'revoked', path: dir, branch, head: repoHead, remote_tip: null, message: null }
    }
    return { state: 'error', path: dir, branch, head: repoHead, remote_tip: null, message: `获取远端失败（网络或权限）：${args.cloneUrl}` }
  }
  const head = await args.ops.revParse(dir, `refs/heads/${args.defaultBranch}`)
  if (head === undefined) {
    return { state: 'error', path: dir, branch, head: null, remote_tip: tip.sha, message: `本地默认分支 ${args.defaultBranch} 不可解析：${dir}` }
  }
  if (head === tip.sha) return { state: 'clean', path: dir, branch, head, remote_tip: tip.sha, message: null }
  const behind = await args.ops.isAncestor(dir, head, tip.sha)
  if (behind === true) return { state: 'clean', path: dir, branch, head, remote_tip: tip.sha, message: null }
  if (behind === undefined) {
    return { state: 'error', path: dir, branch, head, remote_tip: tip.sha, message: `祖先判定不可用（head=${head.slice(0, 7)} tip=${tip.sha.slice(0, 7)}）` }
  }
  const ahead = await args.ops.isAncestor(dir, tip.sha, head)
  if (ahead === true) return { state: 'ahead', path: dir, branch, head, remote_tip: tip.sha, message: null }
  return { state: 'diverged', path: dir, branch, head, remote_tip: tip.sha, message: null }
}

/** 真实 sync 判定 ops（ls 三原语 + 分支/洁净度 + 分类 fetch；同一 runGit 栈）。 */
export function realSyncGitOps(): SyncGitOps {
  return {
    ...realGitOps(),
    currentBranch: async (cwd) => {
      const r = await runGit(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
      return r.code === 0 ? r.stdout.trim() : r.code === 1 ? null : undefined
    },
    isDirty: async (cwd) => {
      const r = await runGit(cwd, ['status', '--porcelain'])
      if (r.code !== 0) return undefined
      return r.stdout.trim() !== ''
    },
    fetchTip: async (cwd, url, branch) => {
      const f = await runGitErr(cwd, ['fetch', '--quiet', url, branch])
      if (f.code !== 0) {
        // git 对 Smart HTTP 404 的规范报错为「fatal: repository '<url>' not found」
        // （2026-10-13 本机探针实证：连接拒绝=unable to access…Failed to connect、
        // 认证失败=Authentication failed，均不含 not found）。本地化 git 理论上可漂移：
        // 匹配不到时落入 unavailable→error（fail-safe 方向——不误标撤权、不误清理）。
        return /not found/i.test(f.stderr) ? { found: false, reason: 'not_found' as const } : { found: false, reason: 'unavailable' as const }
      }
      const p = await runGit(cwd, ['rev-parse', '--verify', '--quiet', 'FETCH_HEAD^{commit}'])
      const sha = p.stdout.trim()
      return p.code === 0 && /^[0-9a-f]{40}$/.test(sha) ? { found: true, sha } : { found: false, reason: 'unavailable' as const }
    },
  }
}
