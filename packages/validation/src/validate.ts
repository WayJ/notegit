/** 校验编排（validation.md §1 三端一致）：单入口按 scope 消费文件条目/引用更新，产出 schema 合规报告；
 * 运行时限制（超时/内存/并发→E-RUN-001，内部错误→E-RUN-002）fail-closed。 */
import { rulesVersion } from './rules-version.ts'
import { defaultConfig, withOverrides, type ConfigOverrides, type ValidationConfig } from './config.ts'
import { classifyFile, validatePathShape, isFrontmatterExempt } from './paths.ts'
import { checkTreeEntry, findCaseConflicts } from './tree.ts'
import { validateKnowledgeDoc, extractFrontmatter } from './frontmatter.ts'
import { checkIntraVaultLinks } from './links.ts'
import { checkFileLimits, checkPushLimits } from './limits.ts'
import { issueOf, renderMessage } from './registry.ts'
import { exitCodeFor, summarize, type Report, type ReportFile, type ReportRef, type Scope } from './report.ts'
import type { Issue } from './issue.ts'

/** 待校验文件条目（内容为提交内实际字节；删除条目不出现在 changes 中——§2.5 删除不做元数据校验）。 */
export interface FileInput {
  path: string
  /** Git tree 条目 mode（八进制字符串） */
  mode: string
  content: string | Uint8Array
}

/** 一个新引入提交相对父提交的新增/修改文件（合并提交按父比较由消费方展开）。 */
export interface CommitDelta {
  commit: string
  parent: string | null
  changes: FileInput[]
  /** 本提交全 tree 路径（E-PATH-004 全 tree 基线，S3-T4 扩展输入：命中基线的新增/修改
   *  路径与库内存量路径的大小写冲突也被拦截；缺省回退变更集内比对——既有语义不变）。 */
  treePaths?: string[]
}

export interface RefInput {
  ref: string
  headOld: string | null
  headNew: string | null
  commits: CommitDelta[]
}

export interface ValidateInput {
  scope: Scope
  /** pre-commit / web-submit 的文件集合 */
  files?: FileInput[]
  /** pre-receive 的引用更新（commits 为逐个新引入提交） */
  refs?: RefInput[]
  vaultId?: string
  /** web-submit 候选提交 ID */
  commit?: string
  /** 客户端上报的本地规则版本（≠服务端时附 N-UPGRADE-001） */
  clientRulesVersion?: string
  /** 本次 push 总字节（E-LIMIT-004 计量口径由消费方定义） */
  pushBytes?: number
  /** 库当前占用字节（与 pushBytes 合计判定 E-LIMIT-005） */
  vaultCurrentBytes?: number
  /** 库内既有路径（并入库内链接存在性判定） */
  knownPaths?: readonly string[]
  /** 候选提交全 tree 路径（pre-commit/web-submit 的 E-PATH-004 基线，S3-T7 对称
   *  扩展——与 pre-receive 的 CommitDelta.treePaths 同语义：命中基线的新增/修改
   *  路径与库内存量路径的大小写冲突被拦截；缺省回退变更集内比对——既有语义不变） */
  treePaths?: readonly string[]
  config?: ConfigOverrides
  /** 可注入时钟（测试用；默认 Date.now） */
  clock?: () => number
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

function byteLen(content: string | Uint8Array): number {
  return typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : content.byteLength
}

function decodeContent(content: string | Uint8Array): string {
  if (typeof content === 'string') return content
  return utf8Decoder.decode(content)
}

function bodyText(text: string): string {
  const fm = extractFrontmatter(text)
  if (fm.kind !== 'block') return text
  const lines = text.split('\n')
  return lines.slice(fm.closeLine ?? 0).join('\n')
}

interface FileOutcome {
  issues: Issue[]
  exempt: boolean
}

/** 单文件判定链：危险 tree 条目 → 路径形状 → 类别+容量 → frontmatter → 库内链接。上层短路语义见各任务决策。 */
function processFile(entry: FileInput, cfg: ValidationConfig, knownPaths: ReadonlySet<string>): FileOutcome {
  const treeIssue = checkTreeEntry(entry)
  if (treeIssue) return { issues: [treeIssue], exempt: false }
  const pathIssues = validatePathShape(entry.path)
  if (pathIssues.length > 0) return { issues: pathIssues, exempt: false }

  const cls = classifyFile(entry.path, cfg)
  const exempt = isFrontmatterExempt(cls)
  const limitIssues = checkFileLimits(entry.path, byteLen(entry.content), cls, cfg)
  if (cls === 'special' || cls === 'attachment') return { issues: limitIssues, exempt: false }

  // 知识文档（含 README/导航豁免——豁免仅限 frontmatter，容量与链接仍适用）
  if (limitIssues.some((i) => i.code === 'E-LIMIT-001')) return { issues: limitIssues, exempt }
  let text: string
  try {
    text = decodeContent(entry.content)
  } catch {
    return { issues: [...limitIssues, issueOf('E-FM-002', { path: entry.path, actual: '内容不是有效 UTF-8' })], exempt }
  }
  const issues: Issue[] = [...limitIssues]
  const fmIssues = exempt ? [] : validateKnowledgeDoc(entry.path, text)
  issues.push(...fmIssues)
  if (!fmIssues.some((i) => i.code === 'E-FM-001')) {
    // 行号语义为文档内 1 起始行号（§6.2）：body 首行 = closeLine+1，链接行 +closeLine 折算
    const fm = extractFrontmatter(text)
    const offset = fm.kind === 'block' ? (fm.closeLine ?? 0) : 0
    issues.push(...checkIntraVaultLinks(entry.path, bodyText(text), knownPaths, offset))
  }
  return { issues, exempt }
}

function issueKey(i: Issue): string {
  return `${i.code}|${i.line ?? ''}|${i.field ?? ''}|${i.ref ?? ''}|${JSON.stringify(i.actual ?? null)}`
}

function runIssue(code: 'E-RUN-001', limit: number, limitKey: string, ref?: string): Issue {
  return issueOf(code, { limit }, { ref, limitKey })
}

function errorReport(input: ValidateInput, issues: Issue[], refs?: ReportRef[]): Report {
  const files: ReportFile[] = []
  const summary = summarize(files, issues)
  const report: Report = {
    rulesVersion: rulesVersion(),
    scope: input.scope,
    result: 'error',
    exitCode: 2,
    summary,
    files,
    issues,
  }
  if (input.vaultId !== undefined) report.vaultId = input.vaultId
  if (input.scope === 'pre-receive') {
    report.refs = refs ?? (input.refs ?? []).map((r) => ({ ref: r.ref, headOld: r.headOld, headNew: r.headNew, checkedCommits: r.commits.length, outcome: 'rejected' as const }))
  }
  return report
}

async function validateInternal(input: ValidateInput): Promise<Report> {
  const cfg = withOverrides(defaultConfig(), input.config ?? {})
  const clock = input.clock ?? Date.now
  const start = clock()

  const timedOut = (ref?: string): boolean => {
    if (clock() - start >= cfg.validationTimeoutMs) return true
    return false
  }

  // 内存限制：入口即查（RSS 近似单次校验占用上界；见任务决策）
  if (process.memoryUsage().rss > cfg.maxValidationMemoryMb * 1024 * 1024) {
    return errorReport(input, [runIssue('E-RUN-001', cfg.maxValidationMemoryMb, 'validation.runtime.maxValidationMemoryMb')])
  }

  const topIssues: Issue[] = []
  const knownPaths = new Set<string>(input.knownPaths ?? [])
  const fileMap = new Map<string, ReportFile & { issueKeys: Set<string> }>()

  const mergeFile = (entry: { path: string }, outcome: FileOutcome, commit?: string): void => {
    let rec = fileMap.get(entry.path)
    if (!rec) {
      rec = { path: entry.path, status: 'pass', issues: [], issueKeys: new Set() }
      if (outcome.exempt) rec.exempt = true
      fileMap.set(entry.path, rec)
    }
    for (const issue of outcome.issues) {
      const key = issueKey(issue)
      if (!rec.issueKeys.has(key)) {
        rec.issueKeys.add(key)
        rec.issues.push(issue)
      }
      if (issue.severity === 'error' && commit !== undefined) rec.commit = commit
    }
    if (commit !== undefined && rec.commit === undefined) rec.commit = commit
  }

  const caseConflictIssues = (paths: string[]): Map<string, Issue> => {
    const out = new Map<string, Issue>()
    for (const [p, other] of findCaseConflicts(paths)) out.set(p, issueOf('E-PATH-004', { path: p, actual: other }))
    return out
  }

  if (input.scope === 'pre-receive') {
    const refsIn = input.refs ?? []
    const skeleton: ReportRef[] = refsIn.map((r) => ({
      ref: r.ref,
      headOld: r.headOld,
      headNew: r.headNew,
      checkedCommits: r.commits.length,
      outcome: 'accepted' as const,
    }))
    // 引用骨架构建后先查超时（示例 report-runtime-error：refs 计数完整、files 空；issue 定位首个 ref）
    if (timedOut()) {
      return errorReport(input, [runIssue('E-RUN-001', cfg.validationTimeoutMs, 'validation.runtime.validationTimeoutMs', refsIn[0]?.ref)], skeleton.map((s) => ({ ...s, outcome: 'rejected' as const })))
    }
    topIssues.push(...checkPushLimits(refsIn.map((r) => r.ref), input.pushBytes ?? 0, input.vaultCurrentBytes ?? 0, cfg))
    for (const refInput of refsIn) {
      for (const delta of refInput.commits) {
        const conflicts = caseConflictIssues(delta.treePaths ?? delta.changes.map((c) => c.path))
        for (const change of delta.changes) {
          knownPaths.add(change.path)
        }
        for (const change of delta.changes) {
          const outcome = processFile(change, cfg, knownPaths)
          const conflict = conflicts.get(change.path)
          if (conflict) outcome.issues.push(conflict)
          mergeFile(change, outcome, delta.commit)
          await Promise.resolve() // 让出事件循环（并发限制的交错点）
          if (timedOut(refInput.ref)) {
            return errorReport(input, [runIssue('E-RUN-001', cfg.validationTimeoutMs, 'validation.runtime.validationTimeoutMs', refInput.ref)], skeleton.map((s) => ({ ...s, outcome: 'rejected' as const })))
          }
        }
      }
    }
  } else {
    const filesIn = input.files ?? []
    // E-PATH-004 基线（S3-T7）：候选提交全 tree 路径给定时按其判定（变更 ⊆ 候选
    // tree，并集去重；同路径重复不构成冲突）；缺省回退变更集内比对（既有语义）
    const conflictBase = input.treePaths === undefined
      ? filesIn.map((f) => f.path)
      : [...new Set([...input.treePaths, ...filesIn.map((f) => f.path)])]
    const conflicts = caseConflictIssues(conflictBase)
    for (const f of filesIn) knownPaths.add(f.path)
    for (const f of filesIn) {
      const outcome = processFile(f, cfg, knownPaths)
      const conflict = conflicts.get(f.path)
      if (conflict) outcome.issues.push(conflict)
      mergeFile(f, outcome) // files[].commit 仅 pre-receive 逐提交归因
      await Promise.resolve()
      if (timedOut()) {
        return errorReport(input, [runIssue('E-RUN-001', cfg.validationTimeoutMs, 'validation.runtime.validationTimeoutMs')])
      }
    }
  }

  const files = [...fileMap.values()].map(({ issueKeys: _keys, ...rest }) => {
    const status = rest.issues.some((i) => i.severity === 'error') ? ('fail' as const) : ('pass' as const)
    return { ...rest, status }
  })

  const report: Report = {
    rulesVersion: rulesVersion(),
    scope: input.scope,
    result: 'pass',
    exitCode: 0,
    summary: summarize(files, topIssues),
    files,
  }
  if (input.vaultId !== undefined) report.vaultId = input.vaultId
  if (input.commit !== undefined) report.commit = input.commit
  if (topIssues.length > 0) report.issues = topIssues
  if (input.scope === 'pre-receive') {
    const hasError = topIssues.some((i) => i.severity === 'error') || files.some((f) => f.status === 'fail')
    report.refs = (input.refs ?? []).map((r) => ({
      ref: r.ref,
      headOld: r.headOld,
      headNew: r.headNew,
      checkedCommits: r.commits.length,
      outcome: !hasError ? ('accepted' as const) : ('rejected' as const),
    }))
  }
  if (input.clientRulesVersion !== undefined && input.clientRulesVersion !== rulesVersion()) {
    report.notices = [
      {
        code: 'N-UPGRADE-001',
        message: renderMessage('N-UPGRADE-001', { actual: input.clientRulesVersion, expected: rulesVersion() }),
      },
    ]
  }

  const hasErrorIssue = topIssues.some((i) => i.severity === 'error') || files.some((f) => f.status === 'fail')
  report.result = hasErrorIssue ? 'fail' : 'pass'
  report.exitCode = exitCodeFor(report.result)
  if (report.refs && report.result !== 'pass') {
    for (const r of report.refs) r.outcome = 'rejected'
  }
  return report
}

/** 单次校验（无并发限制——并发属实例级运行态，用 createValidator）。 */
export async function validate(input: ValidateInput): Promise<Report> {
  try {
    return await validateInternal(input)
  } catch (e) {
    return errorReport(input, [issueOf('E-RUN-002', { actual: e instanceof Error ? e.message : String(e) })])
  }
}

/** 实例级校验器：持有共享并发闸门与配置（服务端 pre-receive / 发布组件消费）。 */
export function createValidator(overrides: ConfigOverrides = {}) {
  const cfg = withOverrides(defaultConfig(), overrides)
  let active = 0
  return {
    config: cfg,
    async validate(input: ValidateInput): Promise<Report> {
      if (active >= cfg.maxConcurrentValidations) {
        return errorReport(input, [runIssue('E-RUN-001', cfg.maxConcurrentValidations, 'validation.runtime.maxConcurrentValidations')])
      }
      active++
      try {
        return await validateInternal({ ...input, config: { ...overrides, ...input.config } })
      } catch (e) {
        return errorReport(input, [issueOf('E-RUN-002', { actual: e instanceof Error ? e.message : String(e) })])
      } finally {
        active--
      }
    },
  }
}

/** 同步守护：内部异常 → E-RUN-002 报告（validate 的 catch 面向测试与复用方暴露）。 */
export function guardRun(fn: () => void): Pick<Report, 'result' | 'exitCode' | 'issues'> {
  try {
    fn()
    throw new Error('guardRun: 被守护函数未抛出异常')
  } catch (e) {
    return {
      result: 'error',
      exitCode: 2,
      issues: [issueOf('E-RUN-002', { actual: e instanceof Error ? e.message : String(e) })],
    }
  }
}
