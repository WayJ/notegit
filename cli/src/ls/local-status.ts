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
 */
import { existsSync } from 'node:fs'
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
}

/**
 * sync 六态（架构 §7.3 策略表的判定面）：
 *   new=无副本；clean=默认分支干净（含已最新与可快进）；dirty/ahead/diverged/other_branch=四类跳过。
 * error = 判定基础设施失败（非 git 仓库、fetch 失败、祖先判定不可用）——按失败逐库报告，不入策略表。
 */
export type SyncState = 'new' | 'clean' | 'dirty' | 'ahead' | 'diverged' | 'other_branch'

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
 * 脏→dirty；fetch→tip；head==tip→clean；head 祖先于 tip→clean（可快进）；
 * tip 祖先于 head→ahead；互不为祖先→diverged。
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
  const tip = await args.ops.remoteTip(dir, args.cloneUrl, args.defaultBranch)
  if (tip === undefined) {
    return { state: 'error', path: dir, branch, head: repoHead, remote_tip: null, message: `获取远端失败（网络或权限）：${args.cloneUrl}` }
  }
  const head = await args.ops.revParse(dir, `refs/heads/${args.defaultBranch}`)
  if (head === undefined) {
    return { state: 'error', path: dir, branch, head: null, remote_tip: tip, message: `本地默认分支 ${args.defaultBranch} 不可解析：${dir}` }
  }
  if (head === tip) return { state: 'clean', path: dir, branch, head, remote_tip: tip, message: null }
  const behind = await args.ops.isAncestor(dir, head, tip)
  if (behind === true) return { state: 'clean', path: dir, branch, head, remote_tip: tip, message: null }
  if (behind === undefined) {
    return { state: 'error', path: dir, branch, head, remote_tip: tip, message: `祖先判定不可用（head=${head.slice(0, 7)} tip=${tip.slice(0, 7)}）` }
  }
  const ahead = await args.ops.isAncestor(dir, tip, head)
  if (ahead === true) return { state: 'ahead', path: dir, branch, head, remote_tip: tip, message: null }
  return { state: 'diverged', path: dir, branch, head, remote_tip: tip, message: null }
}

/** 真实 sync 判定 ops（ls 三原语 + 分支/洁净度；同一 runGit 栈）。 */
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
  }
}
