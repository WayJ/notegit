/** 校验报告形状（schemas/validation-report.schema.json 的 TypeScript 化身；示例见 docs/contracts/examples/）。 */
import type { Issue } from './issue.ts'

export type Scope = 'pre-commit' | 'pre-receive' | 'web-submit'
export type ReportResult = 'pass' | 'fail' | 'error'

export interface ReportFile {
  path: string
  status: 'pass' | 'fail'
  /** 引入该文件问题的新提交 ID（pre-receive 逐提交归因） */
  commit?: string
  /** true=README 等豁免 frontmatter 的文件（仍受路径/类型/容量规则） */
  exempt?: boolean
  issues: Issue[]
}

export interface ReportRef {
  ref: string
  headOld: string | null
  headNew: string | null
  checkedCommits: number
  outcome: 'accepted' | 'rejected'
}

export interface ReportNotice {
  code: string
  message: string
}

export interface ReportSummary {
  filesTotal: number
  filesPassed: number
  filesFailed: number
  errorCount: number
  warningCount: number
}

export interface Report {
  rulesVersion: string
  scope: Scope
  result: ReportResult
  exitCode: 0 | 1 | 2
  vaultId?: string
  commit?: string
  /** 运行级与 push 级问题（不落在具体文件上） */
  issues?: Issue[]
  notices?: ReportNotice[]
  summary: ReportSummary
  files: ReportFile[]
  /** scope=pre-receive 时必填；result≠pass ⇒ 所有 outcome=rejected（全有或全无） */
  refs?: ReportRef[]
}

/** 退出码语义（validation.md §6.1）：0=通过（可含 warning）、1=校验错误、2=运行错误。 */
export function exitCodeFor(result: ReportResult): 0 | 1 | 2 {
  if (result === 'pass') return 0
  if (result === 'fail') return 1
  if (result === 'error') return 2
  throw new Error(`未知报告结果：${result satisfies never as string}`)
}

export function summarize(files: ReportFile[], topIssues: Issue[]): ReportSummary {
  const all = [...topIssues, ...files.flatMap((f) => f.issues)]
  return {
    filesTotal: files.length,
    filesPassed: files.filter((f) => f.status === 'pass').length,
    filesFailed: files.filter((f) => f.status === 'fail').length,
    errorCount: all.filter((i) => i.severity === 'error').length,
    warningCount: all.filter((i) => i.severity === 'warning').length,
  }
}
