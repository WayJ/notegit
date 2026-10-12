/** 校验报告协议中的 issue 形状（schemas/validation-report.schema.json $defs/issue 的 TypeScript 化身）。 */
export type IssueActual = string | number | Array<string | number>

export interface Issue {
  severity: 'error' | 'warning' | 'info'
  code: string
  rule: string
  message: string
  /** 知识文档内 1 起始行号（frontmatter 区或链接所在行） */
  line?: number
  field?: string
  /** push 级问题所属 ref 名 */
  ref?: string
  actual?: IssueActual
  expected?: IssueActual
  limit?: number
  limitKey?: string
}
