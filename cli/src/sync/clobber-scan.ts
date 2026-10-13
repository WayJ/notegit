/**
 * D7 红线静态扫描（S7-T2；类似 S2 无缓存断言的代码结构检查，见 server/test/no-permission-cache.test.ts）。
 *
 * 扫描对象：源码中的字符串字面量（单引号/双引号/模板串）。注释里的裸字样不扫——
 * 「不存在 stash/reset/rebase 路径」是文档而非调用；字面量里的 git 参数才是调用面。
 *
 * 判定（按「调用形态」而非「字样提及」）：
 *   1. 精确：字面量（trim 后）恰为禁改令牌——即数组式参数 ['stash', ...] 中的独立实参；
 *   2. 分隔：更长的字面量内以空白分隔出现禁改令牌——捕获 'git reset --hard' 一类
 *      拼接串；斜杠连写的文案（「不自动 stash/reset/rebase」）不是空白分隔，不误报。
 *   例外——'clean' 与 sync 六态的状态名（D5 词表）冲突，故仅两种形态视为调用：
 *   argv 数组上下文中的独立 'clean'（字面量前同行有未闭合的 '['），或字面量内
 *   'git clean' 两字连写；状态比较/状态名文案不误报。
 */
export interface ClobberViolation {
  readonly line: number
  readonly literal: string
  readonly token: string
}

/** 禁改 git 子命令（会覆盖/丢弃本地改动或移动工作区）。 */
const BANNED_SUBCOMMANDS = ['stash', 'reset', 'rebase', 'checkout', 'restore', 'cherry-pick', 'revert', 'filter-branch'] as const

/** 禁改旗标（强制/删除形态；仅精确匹配——过短不宜做分隔匹配）。 */
const BANNED_FLAGS_EXACT = ['--hard', '--force', '-f', '-D'] as const

/** 长字面量内做空白分隔匹配的令牌（子命令 + 长旗标）。 */
const BANNED_DELIMITED: readonly string[] = [...BANNED_SUBCOMMANDS, '--hard', '--force']

/** 精确匹配集合（子命令 + 旗标；不含 'clean'——见模块头例外说明）。 */
const BANNED_EXACT: readonly string[] = [...BANNED_SUBCOMMANDS, ...BANNED_FLAGS_EXACT]

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 单引号/双引号（不跨行）与模板串（可跨行）。 */
const LITERAL_RE = /'([^'\n]*)'|"([^"\n]*)"|`([^`]*)`/g

/** 字面量起始前的同行前缀里，最近的 '[' 晚于最近的 ']' → 字面量处于数组实参位。 */
function inArrayContext(source: string, literalStart: number): boolean {
  const lineStart = source.lastIndexOf('\n', literalStart - 1) + 1
  const prefix = source.slice(lineStart, literalStart)
  return prefix.lastIndexOf('[') > prefix.lastIndexOf(']')
}

/** 'git clean' 两字连写（含引号内拼接串），不含裸 'clean'（状态名免误报）。 */
const GIT_CLEAN_RE = /(^|\s)git\s+clean(\s|$)/

/** 扫描一段 TypeScript 源，返回全部禁改调用形态（含行号与命中令牌）。 */
export function scanClobberingGitLiterals(source: string): ClobberViolation[] {
  const violations: ClobberViolation[] = []
  for (const m of source.matchAll(LITERAL_RE)) {
    const literal = m[1] ?? m[2] ?? m[3] ?? ''
    const start = m.index ?? 0
    const line = source.slice(0, start).split('\n').length
    const trimmed = literal.trim()
    const exact = BANNED_EXACT.find((t) => t === trimmed)
    if (exact !== undefined) {
      violations.push({ line, literal, token: exact })
      continue
    }
    if (trimmed === 'clean' && inArrayContext(source, start)) {
      violations.push({ line, literal, token: 'clean' })
      continue
    }
    if (GIT_CLEAN_RE.test(literal)) {
      violations.push({ line, literal, token: 'git clean' })
      continue
    }
    for (const token of BANNED_DELIMITED) {
      if (new RegExp(`(^|\\s)${escapeRe(token)}(\\s|$)`).test(literal)) {
        violations.push({ line, literal, token })
      }
    }
  }
  return violations
}
