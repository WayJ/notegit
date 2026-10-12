/** 库内相对链接检查（W-LINK-101，validation.md §6.2 / 架构 §5.3：仅 warning）。
 * 第一版实现为正则级 Markdown 链接提取（inline/image/reference 定义），不引入 CommonMark 解析器；
 * 漏检（复杂嵌套语法）只影响 warning 提示，不影响 error 判定——记于任务决策。 */
import type { Issue } from './issue.ts'
import { issueOf } from './registry.ts'

const SCHEME = /^[a-z][a-z0-9+.-]*:/i

interface LinkRef {
  target: string
  index: number
}

function extractLinks(text: string): LinkRef[] {
  const out: LinkRef[] = []
  // 行内链接与图片 [text](target) / ![alt](target)，含 <带空格> 形式
  const inline = /(!?)\[[^\]]*\]\(\s*(<[^>]*>|[^)\s]+)(\s+&quot;[^&]*&quot;|\s+"[^"]*")?\s*\)/g
  for (const m of text.matchAll(inline)) {
    const raw = m[2] ?? ''
    out.push({ target: raw.startsWith('<') ? raw.slice(1, -1) : raw, index: m.index ?? 0 })
  }
  // reference 定义 [label]: target
  const def = /^[ \t]{0,3}\[[^\]]+\]:[ \t]+(<[^>]*>|[^\s]+)/gm
  for (const m of text.matchAll(def)) {
    const raw = m[1] ?? ''
    out.push({ target: raw.startsWith('<') ? raw.slice(1, -1) : raw, index: m.index ?? 0 })
  }
  return out
}

/** POSIX 风格路径规范化（去 ./ 与 ../，不触文件系统）。 */
function normalizeRepoPath(p: string): string {
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return out.join('/')
}

function lineOfIndex(text: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++
  return line
}

export function checkIntraVaultLinks(path: string, text: string, knownPaths: ReadonlySet<string>, lineOffset = 0): Issue[] {
  const issues: Issue[] = []
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
  for (const link of extractLinks(text)) {
    let target = link.target.trim()
    if (target === '' || target.startsWith('#')) continue
    if (SCHEME.test(target) || target.startsWith('//')) continue
    target = target.split('#')[0] ?? ''
    if (target === '') continue
    const isDirLink = target.endsWith('/')
    const resolved =
      target.startsWith('/') ? normalizeRepoPath(target) : normalizeRepoPath(dir ? `${dir}/${target}` : target)
    if (resolved === '') continue
    const exists = knownPaths.has(resolved) || (isDirLink && [...knownPaths].some((k) => k.startsWith(`${resolved}/`)))
    if (!exists) {
      issues.push(issueOf('W-LINK-101', { path, actual: resolved }, { line: lineOfIndex(text, link.index) + lineOffset }))
    }
  }
  return issues
}
