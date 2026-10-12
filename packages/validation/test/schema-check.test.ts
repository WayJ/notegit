import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { schemaCheck } from './helpers/schema-check.ts'
import { contractsDir } from './helpers/contracts.ts'

const reportSchema = JSON.parse(readFileSync(new URL('schemas/validation-report.schema.json', contractsDir), 'utf8'))
const exampleNames = [
  'report-pass-with-warnings.json',
  'report-field-errors-partial.json',
  'report-dangerous-tree.json',
  'report-push-multiref.json',
  'report-runtime-error.json',
  'report-web-submit-draft-rejected.json',
]

test('自检：6 份契约报告示例全部通过内嵌校验器（校验器先对已知好数据自证）', () => {
  for (const name of exampleNames) {
    const example = JSON.parse(readFileSync(new URL(`examples/${name}`, contractsDir), 'utf8'))
    assert.deepEqual(schemaCheck(reportSchema, example), [], name)
  }
})

test('自检：破坏示例的关键约束会被内嵌校验器抓住', () => {
  const base = JSON.parse(readFileSync(new URL('examples/report-push-multiref.json', contractsDir), 'utf8'))
  // 缺必填字段
  const noSummary = { ...base }
  delete noSummary.summary
  assert.ok(schemaCheck(reportSchema, noSummary).length > 0)
  // result/exitCode 映射（if/then）
  const badExit = { ...base, exitCode: 0 }
  assert.ok(schemaCheck(reportSchema, badExit).length > 0)
  // pre-receive 必带 refs
  const noRefs = { ...base }
  delete noRefs.refs
  assert.ok(schemaCheck(reportSchema, noRefs).length > 0)
  // 错误码 pattern（$defs/$ref + pattern）
  const badCode = JSON.parse(JSON.stringify(base))
  badCode.files[0].issues[0].code = 'X-BAD-1'
  assert.ok(schemaCheck(reportSchema, badCode).some((e) => e.path.includes('code')))
  // scope 枚举
  const badScope = { ...base, scope: 'cron' }
  assert.ok(schemaCheck(reportSchema, badScope).length > 0)
  // line 最小值
  const badLine = JSON.parse(JSON.stringify(base))
  badLine.files[0].issues[0].line = 0
  assert.ok(schemaCheck(reportSchema, badLine).length > 0)
})
