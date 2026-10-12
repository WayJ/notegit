/** 规则版本唯一机器来源：docs/contracts/rules-version.json（validation.md §7；运行时读取，禁止在代码内硬编码版本号——D6）。 */
import { readContractJson } from './contract.ts'

export interface RulesManifest {
  contract: string
  rulesVersion: string
  status: string
  jsonSchemaDialect: string
  effectiveDate: string
  supersedes: string | null
  baseline: Record<string, unknown>
  artifacts: Record<string, string>
  changelog: Array<{ version: string; date: string; changes: string[] }>
}

export function rulesManifest(): Readonly<RulesManifest> {
  return readContractJson<RulesManifest>('rules-version.json')
}

export function rulesVersion(): string {
  return rulesManifest().rulesVersion
}
