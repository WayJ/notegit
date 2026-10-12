import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/** Resolve docs/contracts/ relative to this test file (packages/validation/test/helpers → repo root). */
export const contractsDir = new URL('../../../../docs/contracts/', import.meta.url)

export function readContractJson(name: string): any {
  return JSON.parse(readFileSync(new URL(name, contractsDir), 'utf8'))
}

/** Parse validation.md §6.2 registry table rows at runtime (anti-drift source; no hardcoded copy). */
export interface ContractRegistryRow {
  code: string
  rule: string
  severity: 'error' | 'warning' | 'info'
  exitCode: number
  fields: string[]
  template: string
}

export function parseContractRegistry(): ContractRegistryRow[] {
  const md = readFileSync(new URL('validation.md', contractsDir), 'utf8')
  const rows: ContractRegistryRow[] = []
  for (const line of md.split('\n')) {
    const m = /^\| ((?:E|W|N)-[A-Z]+-\d{3}) \| ([^|]+) \| (error|warning|info) \| (\d) \| ([^|]*) \| (.+) \| \S/.exec(
      line,
    )
    if (!m) continue
    const [, code, rule, severity, exitCode, fieldsRaw, templateRaw] = m
    const fields = fieldsRaw
      .trim()
      .split(',')
      .map((f) => f.trim())
      .filter((f) => f !== '' && f !== '——')
    rows.push({
      code,
      rule: rule.trim(),
      severity: severity as 'error' | 'warning' | 'info',
      exitCode: Number(exitCode),
      fields,
      template: templateRaw.trim().replace(/ \| \S+$/, ''),
    })
  }
  return rows
}
