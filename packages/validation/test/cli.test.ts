import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

const CLI = new URL('../bin/notegit-validation.ts', import.meta.url).pathname

function runCli(manifest: unknown, args: string[] = []): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    input: JSON.stringify(manifest),
    encoding: 'utf8',
  })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

const GOOD = {
  scope: 'pre-commit',
  files: [{ path: 'docs/a.md', mode: '100644', content: '---\ntitle: t\nowner: o\ndescription: d\nsource: s\n---\n\nx\n' }],
}
const BAD = {
  scope: 'pre-commit',
  files: [{ path: 'docs/a.md', mode: '100644', content: 'no frontmatter\n' }],
}

test('CLI：通过 → 退出码 0，stdout 为 JSON 报告（rulesVersion 与包一致）', () => {
  const r = runCli(GOOD)
  assert.equal(r.status, 0)
  const report = JSON.parse(r.stdout)
  assert.equal(report.result, 'pass')
  assert.equal(report.exitCode, 0)
  assert.match(report.rulesVersion, /^\d+\.\d+\.\d+/)
})

test('CLI：校验错误 → 退出码 1；--json 旗标显式接受（契约 §6.1 支持 --json 输出）', () => {
  const r = runCli(BAD, ['--json'])
  assert.equal(r.status, 1)
  const report = JSON.parse(r.stdout)
  assert.equal(report.result, 'fail')
  assert.equal(report.files[0].issues[0].code, 'E-FM-001')
})

test('CLI：运行错误 → 退出码 2（maxValidationMemoryMb 极小触发 E-RUN-001）', () => {
  const r = runCli({ ...GOOD, config: { maxValidationMemoryMb: 1 } })
  assert.equal(r.status, 2)
  const report = JSON.parse(r.stdout)
  assert.equal(report.result, 'error')
  assert.equal(report.issues[0].code, 'E-RUN-001')
})

test('CLI：畸形输入（非法 JSON）→ fail-closed 退出码 2 与 E-RUN-002，不静默成功', () => {
  const r = spawnSync(process.execPath, [CLI], { input: '{not json', encoding: 'utf8' })
  assert.equal(r.status, 2)
  const report = JSON.parse(r.stdout)
  assert.equal(report.result, 'error')
  assert.equal(report.issues[0].code, 'E-RUN-002')
})
