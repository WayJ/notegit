import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stringify } from 'yaml'
import { validateKnowledgeDoc, FM_CONSTANTS, YAML_RESOURCES } from '../src/frontmatter.ts'
import { readContractJson } from './helpers/contracts.ts'

/** 组装带 frontmatter 的知识文档文本。 */
export function md(fm: string, body = '\n正文。\n'): string {
  return `---\n${fm}---\n${body}`
}

const PATH = 'docs/t/x.md'

function errCodes(issues: { severity: string; code: string }[]): string[] {
  return issues.filter((i) => i.severity === 'error').map((i) => i.code).sort()
}

test('frontmatter-cases.json 全部 object 用例：JSON→YAML→实现的错误码与 expect 一致', () => {
  const cases = readContractJson('examples/frontmatter-cases.json').cases as Array<{
    name: string
    kind: string
    expect: string
    expectedCodes: string[]
    frontmatter: unknown
  }>
  const objectCases = cases.filter((c) => c.kind === 'object')
  assert.ok(objectCases.length >= 10)
  for (const c of objectCases) {
    const text = md(`${stringify(c.frontmatter as Record<string, unknown>)}`)
    const issues = validateKnowledgeDoc(PATH, text)
    const got = errCodes(issues)
    assert.deepEqual(got, [...c.expectedCodes].sort(), `用例 ${c.name}`)
  }
})

test('frontmatter-cases.json 全部 raw 用例：原始 YAML 文本按 expectedCodes 拒绝', () => {
  const cases = readContractJson('examples/frontmatter-cases.json').cases as Array<{
    name: string
    kind: string
    expect: string
    expectedCodes: string[]
    frontmatter: string
  }>
  for (const c of cases.filter((x) => x.kind === 'raw' && !x.name.startsWith('raw-oversized'))) {
    const issues = validateKnowledgeDoc(PATH, md(c.frontmatter))
    assert.deepEqual(errCodes(issues), [...c.expectedCodes].sort(), `用例 ${c.name}`)
  }
})

test('raw-oversized 生成用例（契约注明由实现方测试生成）：>64KiB / >1000 节点 / 深度>8 均 E-FM-008', () => {
  // 1) 块字节数 > 64 KiB
  const big = `title: t\nnote: '${'x'.repeat(YAML_RESOURCES.maxBlockBytes)}'\n`
  assert.deepEqual(errCodes(validateKnowledgeDoc(PATH, md(big))), ['E-FM-008'])
  // 2) 解析节点 > 1000（每键计 pair+键+值 3 节点 + 根 map + title：400 键 = 1204）
  const many = 'title: t\n' + Array.from({ length: 400 }, (_, i) => `k${i}: ${i}`).join('\n') + '\n'
  assert.deepEqual(errCodes(validateKnowledgeDoc(PATH, md(many))), ['E-FM-008'])
  // 边界：300 键 + title = 904 节点 ≤ 1000，不触发（且无其他错误）
  const ok = 'title: t\nowner: a\ndescription: d\nsource: s\n' + Array.from({ length: 298 }, (_, i) => `k${i}: ${i}`).join('\n') + '\n'
  assert.deepEqual(validateKnowledgeDoc(PATH, md(ok)), [])
  // 3) 嵌套深度 > 8
  let deep = 'title: t\nnest:'
  for (let i = 0; i < 9; i++) deep += '\n' + ' '.repeat(2 * (i + 1)) + `d${i}:`
  deep += ' leaf\n'
  assert.deepEqual(errCodes(validateKnowledgeDoc(PATH, md(deep))), ['E-FM-008'])
})

// ---- 逐码细粒度 ----

test('E-FM-001：知识文档缺少 frontmatter 块（首行非 ---），无行号', () => {
  const issues = validateKnowledgeDoc(PATH, '# 直接正文\n没有 frontmatter\n')
  assert.deepEqual(errCodes(issues), ['E-FM-001'])
  assert.equal(issues[0].line, undefined)
})

test('E-FM-002：YAML 语法错误带行号；未闭合块同样判解析失败', () => {
  const issues = validateKnowledgeDoc(PATH, md('title: [unclosed\n'))
  assert.deepEqual(errCodes(issues), ['E-FM-002'])
  assert.equal(issues[0].line, 2)
  assert.ok(String(issues[0].actual).length > 0)
  const unterm = validateKnowledgeDoc(PATH, '---\ntitle: x\n正文没有闭合\n')
  assert.deepEqual(errCodes(unterm), ['E-FM-002'])
})

test('E-FM-002：frontmatter 顶层非映射被拒（合法 YAML 但形状不符）', () => {
  assert.deepEqual(errCodes(validateKnowledgeDoc(PATH, md('- a\n- b\n'))), ['E-FM-002'])
  assert.deepEqual(errCodes(validateKnowledgeDoc(PATH, md('just a scalar\n'))), ['E-FM-002'])
})

test('E-FM-003：title 缺失（行=块内首内容行）与去空白后为空（行=键所在行）', () => {
  const missing = validateKnowledgeDoc(PATH, md('owner: zhangsan\n'))
  assert.deepEqual(errCodes(missing), ['E-FM-003'])
  assert.equal(missing[0].line, 2)
  assert.equal(missing[0].field, 'title')
  const blank = validateKnowledgeDoc(PATH, md('title: "   "\n'))
  const e = blank.find((i) => i.code === 'E-FM-003')!
  assert.equal(e.line, 2)
})

test('E-FM-004：字段类型错误（title 数值 / tags 字符串 / status 数值 / owner 列表），带 line+field+expected+actual', () => {
  for (const [fm, field, line] of [
    ['title: 123\n', 'title', 2],
    ['title: t\ntags: 人事\n', 'tags', 3],
    ['title: t\nstatus: 42\n', 'status', 3],
    ['title: t\nowner: [a, b]\n', 'owner', 3],
  ] as const) {
    const issues = validateKnowledgeDoc(PATH, md(fm))
    const e = issues.find((i) => i.code === 'E-FM-004')!
    assert.ok(e, fm)
    assert.equal(e.field, field)
    assert.equal(e.line, line)
    assert.ok(e.expected !== undefined && e.actual !== undefined)
    assert.deepEqual(errCodes(issues), ['E-FM-004'])
  }
})

test('E-FM-005：status 枚举外取值（字符串）→ E-FM-005 而非 E-FM-004', () => {
  const issues = validateKnowledgeDoc(PATH, md('title: t\nstatus: archived\n'))
  const e = issues.find((i) => i.code === 'E-FM-005')!
  assert.equal(e.field, 'status')
  assert.equal(e.line, 3)
  assert.equal(e.actual, 'archived')
  assert.deepEqual(errCodes(issues), ['E-FM-005'])
})

test('E-FM-006：重复键报告字段名与重复行行号', () => {
  const issues = validateKnowledgeDoc(PATH, md('title: a\ntitle: b\n'))
  assert.deepEqual(errCodes(issues), ['E-FM-006'])
  assert.equal(issues[0].field, 'title')
  assert.equal(issues[0].line, 3)
})

test('E-FM-007：自定义 tag / 锚点 / 别名 / 合并键（含无别名的 << 键）全部拒绝，单条 issue 定位首个构造', () => {
  const cases: Array<[string, number]> = [
    ["title: !exec 'rm -rf /'\n", 2],
    ['a: &x [1, 2]\nb: *x\n', 2],
    ['base: &b {k: 1}\nfoo:\n  <<: *b\n', 2],
    ['foo:\n  <<: {k: 1}\n', 3],
    ['"<<" : 1\n', 2],
  ]
  for (const [fm, line] of cases) {
    const issues = validateKnowledgeDoc(PATH, md(fm))
    assert.deepEqual(errCodes(issues), ['E-FM-007'], fm)
    assert.equal(issues[0].line, line, fm)
  }
})

test('E-FM-009：字段长度/数量/唯一性约束逐项触发，带 field/actual/limit', () => {
  const cases: Array<[string, string, number]> = [
    [`title: ${'标'.repeat(201)}\n`, 'title', 200],
    [`title: t\nowner: ${'o'.repeat(101)}\n`, 'owner', 100],
    [`title: t\ndescription: ${'d'.repeat(501)}\n`, 'description', 500],
    [`title: t\nsource: ${'s'.repeat(501)}\n`, 'source', 500],
    [`title: t\ntags: [${Array.from({ length: 33 }, (_, i) => 't' + i).join(', ')}]\n`, 'tags', 32],
    [`title: t\ntags: [${'a'.repeat(65)}]\n`, 'tags', 64],
    ['title: t\ntags: [人事, 人事]\n', 'tags', 32],
    ['title: t\ntags: [""]\n', 'tags', 1],
  ]
  for (const [fm, field, limit] of cases) {
    const issues = validateKnowledgeDoc(PATH, md(fm))
    const e = issues.find((i) => i.code === 'E-FM-009')!
    assert.ok(e, fm)
    assert.equal(e.field, field, fm)
    assert.equal(e.limit, limit, fm)
    assert.ok(e.actual !== undefined, fm)
    assert.deepEqual(errCodes(issues), ['E-FM-009'], fm)
  }
})

test('W-FM-101：owner/description/source 缺失各一条 warning（error 级为空）；status 缺失不提示', () => {
  const issues = validateKnowledgeDoc(PATH, md('title: t\n'))
  const warns = issues.filter((i) => i.code === 'W-FM-101')
  assert.deepEqual(warns.map((w) => w.field).sort(), ['description', 'owner', 'source'])
  assert.deepEqual(errCodes(issues), [])
  const full = validateKnowledgeDoc(
    PATH,
    md('title: t\nowner: a\ndescription: d\nsource: s\n'),
  )
  assert.deepEqual(full, [])
})

test('额外字段允许（标量/列表/嵌套映射，含 null/布尔/数字标量）——安全基础值即可，仅可能产生 W-FM-101', () => {
  const issues = validateKnowledgeDoc(
    PATH,
    md('title: 会议室预定规范\ndepartment: 行政部\nreviewers: [zhangsan, lisi]\nmeta:\n  floor: 3\n  active: true\nempty: null\n'),
  )
  assert.deepEqual(errCodes(issues), [], '额外字段不得产生 error')
  assert.ok(issues.every((i) => i.code === 'W-FM-101'), '除可选字段缺失提示外不得有其他 issue')
})

test('FM_CONSTANTS 与 schemas/frontmatter.schema.json 的版本化常量一致（运行时读 schema 防漂移）', () => {
  const schema = readContractJson('schemas/frontmatter.schema.json')
  assert.equal(FM_CONSTANTS.titleMaxLength, schema.properties.title.maxLength)
  assert.equal(FM_CONSTANTS.ownerMaxLength, schema.properties.owner.maxLength)
  assert.equal(FM_CONSTANTS.descriptionMaxLength, schema.properties.description.maxLength)
  assert.equal(FM_CONSTANTS.sourceMaxLength, schema.properties.source.maxLength)
  assert.equal(FM_CONSTANTS.tagsMaxItems, schema.properties.tags.maxItems)
  assert.equal(FM_CONSTANTS.tagMaxLength, schema.properties.tags.items.maxLength)
  assert.equal(FM_CONSTANTS.tagMinLength, schema.properties.tags.items.minLength)
  assert.deepEqual(FM_CONSTANTS.statusEnum, schema.properties.status.enum)
})
