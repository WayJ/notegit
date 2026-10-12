import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ERROR_REGISTRY, registryFor, renderMessage } from '../src/registry.ts'
import { parseContractRegistry } from './helpers/contracts.ts'

test('错误码注册表全表与 validation.md §6.2 逐行一致（24 码，运行时解析契约表防漂移）', () => {
  const contractRows = parseContractRegistry()
  assert.equal(contractRows.length, 24, '契约注册表应有 24 码')
  assert.equal(ERROR_REGISTRY.length, contractRows.length)
  const byCode = new Map(ERROR_REGISTRY.map((e) => [e.code, e]))
  for (const row of contractRows) {
    const entry = byCode.get(row.code)
    assert.ok(entry, `实现注册表缺少 ${row.code}`)
    assert.equal(entry.rule, row.rule, `${row.code} rule id`)
    assert.equal(entry.severity, row.severity, `${row.code} severity`)
    assert.equal(entry.exitCode, row.exitCode, `${row.code} exitCode`)
    assert.deepEqual(entry.fields, row.fields, `${row.code} 定位字段`)
    assert.equal(entry.template, row.template, `${row.code} 消息模板`)
  }
  assert.equal(new Set(ERROR_REGISTRY.map((e) => e.code)).size, ERROR_REGISTRY.length, '码不得重复')
})

test('错误码结构符合 ^((E|W|N)-[A-Z]+-\\d{3})$，severity 与前缀一致', () => {
  for (const e of ERROR_REGISTRY) {
    assert.match(e.code, /^(E|W|N)-[A-Z]+-\d{3}$/)
    if (e.code.startsWith('E-')) assert.equal(e.severity, 'error')
    if (e.code.startsWith('W-')) assert.equal(e.severity, 'warning')
    if (e.code.startsWith('N-')) assert.equal(e.severity, 'info')
  }
})

test('registryFor：已注册码返回条目，未注册码抛错（fail-closed）', () => {
  assert.equal(registryFor('E-FM-001').rule, 'frontmatter.missing')
  assert.throws(() => registryFor('E-FM-999'))
})

test('renderMessage：以定位字段实例化模板，未知占位符原样保留', () => {
  assert.equal(
    renderMessage('E-FM-001', { path: 'docs/a.md' }),
    'docs/a.md：知识文档缺少 frontmatter（首行须为 `---`）',
  )
  assert.equal(
    renderMessage('E-LIMIT-001', { path: 'a.md', actual: 2097152, limit: 1048576 }),
    'a.md：文档 2097152 字节超上限 1048576；请拆分',
  )
})

test('定位字段列 ⊆ 报告 schema 的 issue 属性集 ∪ {path, message}（定位字段必须可落在 issue 上）', () => {
  // schemas/validation-report.schema.json $defs/issue 的可选定位属性
  const schemaIssueProps = new Set(['line', 'field', 'ref', 'actual', 'expected', 'limit', 'limitKey'])
  for (const e of ERROR_REGISTRY) {
    for (const f of e.fields) {
      assert.ok(
        schemaIssueProps.has(f) || f === 'path' || f === 'message',
        `${e.code} 定位字段 ${f} 不是报告 issue 形状的属性`,
      )
    }
  }
})
