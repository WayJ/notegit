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
 */
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'

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

/** 本地根目录解析：NOTEGIT_LOCAL_ROOT 显式优先，缺省 ~/knowbase（架构 §7.2）。 */
export function localRootOf(env: NodeJS.ProcessEnv): string {
  const explicit = (env['NOTEGIT_LOCAL_ROOT'] ?? '').trim()
  if (explicit !== '') return path.resolve(explicit)
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
