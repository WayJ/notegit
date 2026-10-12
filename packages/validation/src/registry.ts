/** 结构化错误协议：错误码注册表全表（validation.md §6.2，24 码）。模板与契约逐字一致——由测试对 validation.md 运行时解析交叉核对（防漂移）。 */
import type { Issue } from './issue.ts'

export type Severity = 'error' | 'warning' | 'info'

export interface RegistryEntry {
  code: string
  rule: string
  severity: Severity
  exitCode: 0 | 1 | 2
  /** 契约 §6.2 定位字段列 */
  fields: readonly string[]
  /** 消息模板（中文，与契约逐字一致） */
  template: string
}

export const ERROR_REGISTRY: readonly RegistryEntry[] = [
  { code: 'E-FM-001', rule: 'frontmatter.missing', severity: 'error', exitCode: 1, fields: ['path'], template: '{path}：知识文档缺少 frontmatter（首行须为 `---`）' },
  { code: 'E-FM-002', rule: 'frontmatter.parse_failure', severity: 'error', exitCode: 1, fields: ['path', 'line'], template: '{path}：frontmatter YAML 解析失败：{actual}' },
  { code: 'E-FM-003', rule: 'frontmatter.title_required', severity: 'error', exitCode: 1, fields: ['path', 'line', 'field'], template: '{path}：{field} 缺失或去空白后为空；填写非空标题（≤200 字符）' },
  { code: 'E-FM-004', rule: 'frontmatter.field_type', severity: 'error', exitCode: 1, fields: ['path', 'line', 'field'], template: '{path}：字段 {field} 类型错误，期望 {expected}，实际 {actual}' },
  { code: 'E-FM-005', rule: 'frontmatter.status_enum', severity: 'error', exitCode: 1, fields: ['path', 'line', 'field'], template: '{path}：status 非法取值 {actual}；允许 active/draft/deprecated（缺省 active）' },
  { code: 'E-FM-006', rule: 'frontmatter.duplicate_key', severity: 'error', exitCode: 1, fields: ['path', 'line'], template: '{path}：frontmatter 存在重复键 {field}' },
  { code: 'E-FM-007', rule: 'frontmatter.unsafe_yaml', severity: 'error', exitCode: 1, fields: ['path', 'line'], template: '{path}：frontmatter 含不安全构造（自定义 tag/锚点/别名/合并键）' },
  { code: 'E-FM-008', rule: 'frontmatter.resource_limit', severity: 'error', exitCode: 1, fields: ['path', 'actual', 'limit'], template: '{path}：frontmatter 超资源常量（{limit}）；请精简元数据' },
  { code: 'E-FM-009', rule: 'frontmatter.field_constraint', severity: 'error', exitCode: 1, fields: ['path', 'line', 'field', 'actual', 'limit'], template: '{path}：字段 {field} 违反约束 {limit}（实际 {actual}）' },
  { code: 'E-PATH-001', rule: 'path.invalid', severity: 'error', exitCode: 1, fields: ['path', 'actual', 'expected'], template: '{path}：路径不合法（字符集/NFC/形状/长度/深度/保留名）：{actual}' },
  { code: 'E-PATH-002', rule: 'tree.symlink', severity: 'error', exitCode: 1, fields: ['path', 'actual'], template: '{path}：tree 条目为符号链接（{actual}）；第一版禁止，请改为常规文件' },
  { code: 'E-PATH-003', rule: 'tree.gitlink', severity: 'error', exitCode: 1, fields: ['path', 'actual'], template: '{path}：tree 条目为 submodule/gitlink（{actual}）；第一版禁止' },
  { code: 'E-PATH-004', rule: 'path.case_conflict', severity: 'error', exitCode: 1, fields: ['path', 'actual'], template: '{path}：与 {actual} 仅大小写不同；大小写不敏感系统上会互相覆盖' },
  { code: 'E-PATH-005', rule: 'tree.forbidden_entry', severity: 'error', exitCode: 1, fields: ['path', 'actual'], template: '{path}：禁止的 tree 条目（{actual}：.git 组件/.gitmodules/非法 mode）' },
  { code: 'E-LIMIT-001', rule: 'limit.document_size', severity: 'error', exitCode: 1, fields: ['path', 'actual', 'limit'], template: '{path}：文档 {actual} 字节超上限 {limit}；请拆分' },
  { code: 'E-LIMIT-002', rule: 'limit.file_type', severity: 'error', exitCode: 1, fields: ['path', 'actual', 'expected'], template: '{path}：文件类型 {actual} 不在允许清单 {expected}' },
  { code: 'E-LIMIT-003', rule: 'limit.attachment_size', severity: 'error', exitCode: 1, fields: ['path', 'actual', 'limit'], template: '{path}：附件 {actual} 字节超上限 {limit}' },
  { code: 'E-LIMIT-004', rule: 'limit.push_size', severity: 'error', exitCode: 1, fields: ['ref', 'actual', 'limit'], template: '{ref}：本次 push 总量 {actual} 字节超上限 {limit}；请分批推送' },
  { code: 'E-LIMIT-005', rule: 'limit.vault_capacity', severity: 'error', exitCode: 1, fields: ['ref', 'actual', 'limit'], template: '{ref}：库容量将超上限 {limit}（当前+本次 {actual}）；请清理或申请扩容' },
  { code: 'E-RUN-001', rule: 'run.timeout', severity: 'error', exitCode: 2, fields: ['limit'], template: '校验运行超时/资源超限（{limit}）；本次操作被拒绝，可重试或减小规模' },
  { code: 'E-RUN-002', rule: 'run.internal', severity: 'error', exitCode: 2, fields: [], template: '校验内部错误：{actual}；请重试并反馈管理员' },
  { code: 'W-FM-101', rule: 'frontmatter.optional_field_missing', severity: 'warning', exitCode: 0, fields: ['path', 'field'], template: '{path}：可选字段 {field} 缺失；不影响提交' },
  { code: 'W-LINK-101', rule: 'link.intra_vault_missing', severity: 'warning', exitCode: 0, fields: ['path', 'line', 'actual'], template: '{path}：库内相对链接目标 {actual} 不存在' },
  { code: 'N-UPGRADE-001', rule: 'upgrade.rules_stale', severity: 'info', exitCode: 0, fields: ['message'], template: '客户端校验规则为 {actual}，服务端为 {expected}；请运行 notegit setup 更新' },
]

const byCode = new Map(ERROR_REGISTRY.map((e) => [e.code, e]))

export function registryFor(code: string): RegistryEntry {
  const entry = byCode.get(code)
  if (!entry) throw new Error(`未注册的错误码：${code}（注册表见 validation.md §6.2）`)
  return entry
}

export type MessageParams = Partial<Record<'path' | 'line' | 'field' | 'ref' | 'actual' | 'expected' | 'limit' | 'message', string | number | Array<string | number>>>

/** 按注册表模板实例化消息；未提供的占位符原样保留（报告 schema 只要求 string，不要求模板完全展开）。 */
export function renderMessage(code: string, params: MessageParams): string {
  const entry = registryFor(code)
  return entry.template.replace(/\{(\w+)\}/g, (m, key: string) => {
    const v = (params as Record<string, unknown>)[key]
    return v === undefined ? m : String(v)
  })
}

/** 由注册表条目 + 定位字段构造 issue（severity/rule/message 全部取自注册表，禁止调用方拼装）。 */
export function issueOf(code: string, params: MessageParams, loc?: { line?: number; field?: string; ref?: string; limitKey?: string }): Issue {
  const entry = registryFor(code)
  const issue: Issue = {
    severity: entry.severity,
    code: entry.code,
    rule: entry.rule,
    message: renderMessage(entry.code, params),
  }
  const p = params as Record<string, unknown>
  if (p.line !== undefined || loc?.line !== undefined) issue.line = (loc?.line ?? p.line) as number
  if (p.field !== undefined || loc?.field !== undefined) issue.field = (loc?.field ?? p.field) as string
  if (p.ref !== undefined || loc?.ref !== undefined) issue.ref = (loc?.ref ?? p.ref) as string
  if (p.actual !== undefined) issue.actual = p.actual as Issue['actual']
  if (p.expected !== undefined) issue.expected = p.expected as Issue['expected']
  if (p.limit !== undefined) issue.limit = p.limit as number
  if (loc?.limitKey !== undefined) issue.limitKey = loc.limitKey
  return issue
}
