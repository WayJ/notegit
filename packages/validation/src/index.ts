/** notegit-validation 公共 API（三端单一来源的代码化身，sprint D7）：
 * 本地 pre-commit hook（S6）/ 服务端 pre-receive 与发布组件（S3-T4/T7）/ 网页提交组件（S4）均从本包取定义。 */
export { rulesVersion, rulesManifest, type RulesManifest } from './rules-version.ts'
export { ERROR_REGISTRY, registryFor, renderMessage, issueOf, type RegistryEntry, type Severity, type MessageParams } from './registry.ts'
export type { Issue, IssueActual } from './issue.ts'
export { defaultConfig, withOverrides, globMatch, type ValidationConfig, type ConfigOverrides } from './config.ts'
export { FM_CONSTANTS, YAML_RESOURCES, validateKnowledgeDoc, extractFrontmatter } from './frontmatter.ts'
export { classifyFile, validatePathShape, isFrontmatterExempt, PATH_LIMITS, type FileClass } from './paths.ts'
export { checkTreeEntry, findCaseConflicts, VALID_FILE_MODES, type TreeEntry } from './tree.ts'
export { checkIntraVaultLinks } from './links.ts'
export { checkFileLimits, checkPushLimits } from './limits.ts'
export { exitCodeFor, summarize, type Report, type ReportFile, type ReportRef, type ReportNotice, type ReportSummary, type Scope, type ReportResult } from './report.ts'
export { validate, createValidator, guardRun, type ValidateInput, type FileInput, type CommitDelta, type RefInput } from './validate.ts'
