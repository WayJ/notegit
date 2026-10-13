/**
 * 工作副本本地指纹（S7-T2 不覆盖证明的采集面）。
 *
 * 指纹 = 下列探针输出的带节标注拼接（逐字节可比）：
 *   git status（长格式）/ status --porcelain=v1 --branch / diff / diff --cached /
 *   diff HEAD / ls-files --stage / for-each-ref / rev-parse HEAD / symbolic-ref HEAD，
 *   加工作树递归行走（排除 .git，路径+类型+内容 sha256，排序稳定）。
 * 后者覆盖 git diff 的盲区（未跟踪文件）；refs/HEAD/索引探针覆盖分支与暂存字节。
 * 刻意不含 .git 对象库——sync 判定面的 fetch 会合法写入对象（FETCH_HEAD 面，
 * 不触及用户可见状态）；分支指针不动（按 URL fetch 不更新 tracking refs）。
 */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

function runProbe(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, encoding: 'utf8', timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } },
      (err, stdout, stderr) =>
        resolve(err === null ? stdout : `[探针失败 git ${args.join(' ')}：${(stderr || err.message).split('\n')[0]}]`),
    )
  })
}

/** 工作树递归行走（排除顶层 .git）；行形态 `file <rel> <sha256>` / `dir <rel>` / `other <rel> <种类>`。 */
async function walkWorktree(dir: string, prefix: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null)
  if (entries === null) return
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const e of sorted) {
    if (prefix === '' && e.name === '.git') continue
    const rel = prefix === '' ? e.name : `${prefix}/${e.name}`
    if (e.isDirectory()) {
      out.push(`dir ${rel}`)
      await walkWorktree(path.join(dir, e.name), rel, out)
    } else if (e.isFile()) {
      const content = await readFile(path.join(dir, e.name))
      out.push(`file ${rel} ${createHash('sha256').update(content).digest('hex')}`)
    } else {
      out.push(`other ${rel} ${e.isSymbolicLink() ? 'symlink' : 'special'}`)
    }
  }
}

/** 采集 dir 的本地指纹；探针失败以节内错误行呈现（不抛出，保证同一副本前后可比）。 */
export async function captureWorktreeFingerprint(dir: string): Promise<string> {
  const probes: ReadonlyArray<readonly [name: string, args: string[]]> = [
    ['status', ['status']],
    ['status-porcelain-branch', ['status', '--porcelain=v1', '--branch']],
    ['diff-worktree', ['diff']],
    ['diff-cached', ['diff', '--cached']],
    ['diff-head', ['diff', 'HEAD']],
    ['index-stage', ['ls-files', '--stage']],
    ['refs', ['for-each-ref', '--format=%(refname) %(objectname) %(*objectname)']],
    ['head', ['rev-parse', 'HEAD']],
    ['head-ref', ['symbolic-ref', 'HEAD']],
  ]
  const sections: string[] = []
  for (const [name, args] of probes) {
    sections.push(`== ${name} ==\n${await runProbe(dir, args)}`)
  }
  const worktree: string[] = []
  await walkWorktree(dir, '', worktree)
  sections.push(`== worktree ==\n${worktree.join('\n')}`)
  return sections.join('\n')
}

/** 返回两份指纹的首个差异行（含行号与两侧内容）；相同则 undefined。断言消息定位用。 */
export function firstFingerprintMismatch(a: string, b: string): string | undefined {
  if (a === b) return undefined
  const la = a.split('\n')
  const lb = b.split('\n')
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] !== lb[i]) return `行 ${i + 1}：${JSON.stringify(la[i])} ≠ ${JSON.stringify(lb[i])}`
  }
  return '长度不同（不应到达）'
}
