/** 路径合法字符集与形状（validation.md §4.1）+ 文件类别判定与 README 豁免（§2）。 */
import type { Issue } from './issue.ts'
import { issueOf } from './registry.ts'
import { globMatch, type ValidationConfig } from './config.ts'

/** 版本化常量（T2 建议值）。 */
export const PATH_LIMITS = {
  componentMaxBytes: 200,
  pathMaxBytes: 1024,
  maxDepth: 16,
} as const

const RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
])

/** 允许清单制：Unicode 字母（含中文）、数字、空格及 -_.()[]{}@,#%&=~;'!^+（分隔符 / 除外）。 */
const ALLOWED_CHAR = /^[\p{L}\p{N}\-_.()\[\]{}@,#%&=~;'!^+ /]+$/u

/** 路径形状校验（E-PATH-001）。所有原因合并为单条 issue（actual 以；连接）。 */
export function validatePathShape(path: string): Issue[] {
  const reasons: string[] = []
  if (path === '') {
    reasons.push('空路径')
  }
  if (path.startsWith('/')) reasons.push('绝对路径（前导 /）')
  if (path.endsWith('/')) reasons.push('以 / 结尾')
  if (path.includes('\\')) reasons.push('含反斜杠 \\')
  if (path !== path.normalize('NFC')) reasons.push('非 NFC 规范形式（macOS 工作副本常见 NFD，提交前须规范化）')

  const components = path === '' ? [] : path.split('/')
  for (const comp of components) {
    if (comp === '') reasons.push('空路径组件（连续 / 或结尾 /）')
    else if (comp === '.' || comp === '..') reasons.push(`组件 ${comp}（相对引用）`)
    else if (comp.endsWith(' ') || comp.endsWith('.')) reasons.push(`组件「${comp}」以空格或 . 结尾（Windows 兼容）`)
    else {
      const byteLen = Buffer.byteLength(comp, 'utf8')
      if (byteLen > PATH_LIMITS.componentMaxBytes) reasons.push(`组件 ${byteLen}B 超上限 ${PATH_LIMITS.componentMaxBytes}B`)
      const base = comp.replace(/\.[^.]+$/, '')
      if (RESERVED_NAMES.has(base.toUpperCase())) reasons.push(`保留名 ${base.toUpperCase()}（CON/PRN/AUX/NUL/COM1-9/LPT1-9）`)
    }
  }

  if (/[\u0000-\u001F\u007F-\u009F]/.test(path)) reasons.push('含控制字符')
  if (!ALLOWED_CHAR.test(path)) reasons.push('含允许清单外字符（允许：Unicode 字母/数字/空格及 -_.()[]{}@,#%&=~;\'!^+）')

  const pathBytes = Buffer.byteLength(path, 'utf8')
  if (pathBytes > PATH_LIMITS.pathMaxBytes) reasons.push(`全路径 ${pathBytes}B 超上限 ${PATH_LIMITS.pathMaxBytes}B`)
  const depth = Math.max(0, components.length - 1)
  if (depth > PATH_LIMITS.maxDepth) reasons.push(`目录深度 ${depth} 超上限 ${PATH_LIMITS.maxDepth}`)

  if (reasons.length === 0) return []
  return [
    issueOf('E-PATH-001', {
      path,
      actual: reasons.join('；'),
      expected: 'UTF-8 NFC、允许字符集内、无空组件、非保留名、组件 ≤200B、全路径 ≤1024B、≤16 级目录',
    }),
  ]
}

/** 文件类别（validation.md §2 判定顺序：管理员模式 → README → .md → 附件）。 */
export type FileClass = 'knowledge' | 'readme-exempt' | 'nav-exempt' | 'special' | 'attachment'

/** 无 / 的模式按文件名匹配任意目录（.gitignore 式）；含 / 的模式匹配全路径。 */
function patternMatches(pattern: string, path: string): boolean {
  if (pattern.includes('/')) return globMatch(pattern, path)
  const segments = path.split('/')
  const base = segments[segments.length - 1] ?? ''
  return globMatch(pattern, base) || globMatch(pattern, path)
}

export function classifyFile(path: string, cfg: ValidationConfig): FileClass {
  for (const pattern of cfg.specialFilePatterns) if (patternMatches(pattern, path)) return 'special'
  for (const pattern of cfg.additionalNavPatterns) if (patternMatches(pattern, path)) return 'nav-exempt'
  const segments = path.split('/')
  const name = segments[segments.length - 1] ?? ''
  if (name.toLowerCase() === 'readme.md') return 'readme-exempt'
  if (name.toLowerCase().endsWith('.md')) return 'knowledge'
  return 'attachment'
}

/** 类别是否豁免 frontmatter（豁免仅限 frontmatter；路径/类型/容量规则仍适用，§2-2）。 */
export function isFrontmatterExempt(cls: FileClass): boolean {
  return cls === 'readme-exempt' || cls === 'nav-exempt'
}
