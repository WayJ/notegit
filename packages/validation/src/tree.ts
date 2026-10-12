/** 危险 tree 条目（validation.md §4.2：第一版禁止符号链接与 submodule；非法 mode 与 .git 系条目）。 */
import type { Issue } from './issue.ts'
import { issueOf } from './registry.ts'

export const VALID_FILE_MODES = new Set(['100644', '100755'])

export interface TreeEntry {
  path: string
  /** Git tree 条目 mode（八进制字符串，如 '100644'） */
  mode: string
}

/**
 * 单条 tree 条目检查（E-PATH-002/003/005）。
 * 危险条目（symlink/gitlink/非法 mode/.git 系名称）整条拒绝——类别与容量判定不再适用。
 */
export function checkTreeEntry(entry: TreeEntry): Issue | null {
  if (entry.mode === '120000') {
    return issueOf('E-PATH-002', { path: entry.path, actual: 'mode 120000', expected: 'mode 100644 或 100755' })
  }
  if (entry.mode === '160000') {
    return issueOf('E-PATH-003', { path: entry.path, actual: 'mode 160000' })
  }
  const components = entry.path.split('/')
  const name = components[components.length - 1] ?? ''
  const hasGitComponent = components.some((c) => c.toLowerCase() === '.git')
  if (hasGitComponent || name.toLowerCase() === '.gitmodules' || !VALID_FILE_MODES.has(entry.mode)) {
    const reason = hasGitComponent
      ? '.git 组件'
      : name.toLowerCase() === '.gitmodules'
        ? '.gitmodules'
        : `非法 mode ${entry.mode}`
    return issueOf('E-PATH-005', { path: entry.path, actual: reason })
  }
  return null
}

/**
 * 同一提交内仅大小写不同的路径（E-PATH-004）。
 * 返回 path → 冲突对端 path 的映射；两组路径互相指向。
 */
export function findCaseConflicts(paths: string[]): Map<string, string> {
  const byFolded = new Map<string, string[]>()
  for (const p of paths) {
    const folded = p.toLowerCase()
    const list = byFolded.get(folded) ?? []
    list.push(p)
    byFolded.set(folded, list)
  }
  const conflicts = new Map<string, string>()
  for (const list of byFolded.values()) {
    if (list.length < 2) continue
    for (const p of list) {
      const other = list.find((q) => q !== p)
      if (other !== undefined) conflicts.set(p, other)
    }
  }
  return conflicts
}
