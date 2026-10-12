import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkFileLimits, checkPushLimits } from '../src/limits.ts'
import { defaultConfig, withOverrides } from '../src/config.ts'
import type { FileClass } from '../src/paths.ts'

const MB = 1048576

test('E-LIMIT-001：知识文档超 maxDocumentBytes，含 limit/limitKey', () => {
  const cfg = defaultConfig()
  const issues = checkFileLimits('docs/a.md', cfg.maxDocumentBytes + 1, 'knowledge', cfg)
  assert.equal(issues.length, 1)
  assert.equal(issues[0].code, 'E-LIMIT-001')
  assert.equal(issues[0].actual, cfg.maxDocumentBytes + 1)
  assert.equal(issues[0].limit, cfg.maxDocumentBytes)
  assert.equal(issues[0].limitKey, 'validation.limits.maxDocumentBytes')
  assert.deepEqual(checkFileLimits('docs/a.md', cfg.maxDocumentBytes, 'knowledge', cfg), [], '恰在上限不触发')
})

test('E-LIMIT-002：非 .md 文件不在附件清单（svg 默认排除、无扩展名、大小写不敏感放行 .PNG）', () => {
  const cfg = defaultConfig()
  for (const [p, cls] of [
    ['logo.svg', 'attachment'],
    ['tool.exe', 'attachment'],
    ['Makefile', 'attachment'],
  ] as const) {
    const issues = checkFileLimits(p, 10, cls, cfg)
    assert.equal(issues[0]?.code, 'E-LIMIT-002', p)
    assert.ok(String(issues[0].expected).includes('.png'), 'expected 含允许清单')
  }
  assert.deepEqual(checkFileLimits('logo.PNG', 10, 'attachment', cfg), [])
  assert.deepEqual(checkFileLimits('a.jpg', 10, 'attachment', cfg), [])
})

test('E-LIMIT-003：附件超 maxAttachmentBytes，含 limitKey', () => {
  const cfg = defaultConfig()
  const issues = checkFileLimits('big.png', cfg.maxAttachmentBytes + 1, 'attachment', cfg)
  assert.equal(issues[0]?.code, 'E-LIMIT-003')
  assert.equal(issues[0]?.limitKey, 'validation.limits.maxAttachmentBytes')
  assert.deepEqual(checkFileLimits('ok.png', cfg.maxAttachmentBytes, 'attachment', cfg), [])
})

test('特殊文件（specialFilePatterns 命中）不做类型与容量判定（契约未定义其限额——任务决策）', () => {
  const cfg = defaultConfig()
  assert.deepEqual(checkFileLimits('.gitignore', 20 * MB, 'special', cfg), [])
})

test('README 豁免文件仍受文档容量限制（豁免仅限 frontmatter）', () => {
  const cfg = defaultConfig()
  const issues = checkFileLimits('README.md', cfg.maxDocumentBytes + 1, 'readme-exempt', cfg)
  assert.equal(issues[0]?.code, 'E-LIMIT-001')
})

test('管理员配置生效：收紧 maxDocumentBytes 后小文档即触发；扩展附件清单后 svg 放行', () => {
  const cfg = withOverrides(defaultConfig(), { maxDocumentBytes: 100 })
  assert.equal(checkFileLimits('docs/a.md', 101, 'knowledge', cfg)[0]?.code, 'E-LIMIT-001')
  assert.deepEqual(checkFileLimits('docs/a.md', 100, 'knowledge', cfg), [])
  const cfg2 = withOverrides(defaultConfig(), { attachmentAllowedExtensions: ['.png', '.svg'] })
  assert.deepEqual(checkFileLimits('logo.svg', 10, 'attachment', cfg2), [])
})

test('E-LIMIT-004：push 总量超限——每 ref 一条 issue，定位 ref 字段（不落单文件）', () => {
  const cfg = defaultConfig()
  const issues = checkPushLimits(['refs/heads/main', 'refs/heads/feature/x'], cfg.maxPushBytes + 1, 0, cfg)
  assert.equal(issues.length, 2)
  for (const i of issues) {
    assert.equal(i.code, 'E-LIMIT-004')
    assert.ok(i.ref?.startsWith('refs/'))
    assert.equal(i.limit, cfg.maxPushBytes)
    assert.equal(i.limitKey, 'validation.limits.maxPushBytes')
  }
  assert.deepEqual(checkPushLimits(['refs/heads/main'], cfg.maxPushBytes, 0, cfg), [])
})

test('E-LIMIT-005：库容量将超上限（当前+本次），含 limitKey 与 actual 合计', () => {
  const cfg = defaultConfig()
  const issues = checkPushLimits(['refs/heads/main'], 10 * MB, cfg.vaultCapacityBytes - 5 * MB, cfg)
  assert.equal(issues.length, 1)
  assert.equal(issues[0].code, 'E-LIMIT-005')
  assert.equal(issues[0].actual, cfg.vaultCapacityBytes - 5 * MB + 10 * MB)
  assert.equal(issues[0].limit, cfg.vaultCapacityBytes)
  assert.equal(issues[0].limitKey, 'validation.limits.vaultCapacityBytes')
})
