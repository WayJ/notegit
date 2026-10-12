#!/usr/bin/env node
/** notegit-validation CLI：stdin 读 ValidateInput JSON 清单 → stdout 输出报告 JSON → 按报告 exitCode 退出（0/1/2，validation.md §6.1）。 */
import { validate } from '../src/validate.ts'
import type { ValidateInput } from '../src/validate.ts'
import { exitCodeFor } from '../src/report.ts'
import { rulesVersion } from '../src/rules-version.ts'
import { issueOf } from '../src/registry.ts'
import process from 'node:process'

async function main(): Promise<number> {
  let input: string = ''
  for await (const chunk of process.stdin) input += chunk
  let parsed: ValidateInput
  try {
    parsed = JSON.parse(input) as ValidateInput
  } catch (e) {
    process.stdout.write(
      `${JSON.stringify(
        {
          rulesVersion: rulesVersion(),
          scope: 'pre-commit',
          result: 'error',
          exitCode: 2,
          summary: { filesTotal: 0, filesPassed: 0, filesFailed: 0, errorCount: 1, warningCount: 0 },
          issues: [issueOf('E-RUN-002', { actual: `stdin 不是合法 JSON：${e instanceof Error ? e.message : String(e)}` })],
          files: [],
        },
        null,
        2,
      )}\n`,
    )
    return 2
  }
  const report = await validate(parsed)
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  return exitCodeFor(report.result)
}

main().then(
  (code) => {
    process.exit(code)
  },
  (e) => {
    process.stderr.write(`internal error: ${e instanceof Error ? e.message : String(e)}\n`)
    process.exit(2)
  },
)
