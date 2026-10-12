import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkIntraVaultLinks } from '../src/links.ts'

const KNOWN = new Set(['docs/hr/onboarding.md', 'docs/hr/policy/index.md', 'docs/hr/policy/holiday.md', 'docs/travel/x.md', 'docs/root.md', 'docs/a b.md'])

test('W-LINK-101：库内相对链接目标缺失——解析到所在目录、带行号与解析后路径', () => {
  const body = Array.from({ length: 13 }, (_, i) => `第${i + 1}行`).join('\n')
  const text = `${body}\n详见[请假政策](policy/leave.md)。\n`
  const issues = checkIntraVaultLinks('docs/hr/onboarding.md', text, KNOWN)
  assert.equal(issues.length, 1)
  assert.equal(issues[0].code, 'W-LINK-101')
  assert.equal(issues[0].line, 14)
  assert.equal(issues[0].actual, 'docs/hr/policy/leave.md')
})

test('存在的目标不告警（同目录、父目录 ../、子目录 ./、去 #fragment）', () => {
  const text = '[a](policy/index.md) [b](../travel/x.md) [c](./policy/holiday.md#section) [d](../root.md)\n'
  assert.deepEqual(checkIntraVaultLinks('docs/hr/onboarding.md', text, KNOWN), [])
})

test('外部链接与纯锚点不检查（第一版不做可达性检查）', () => {
  const text = '[g](https://example.com/a.md) [m](mailto:a@b.c) [p](//cdn.example.com/x) [frag](#section) [r][ref]\n\n[ref]: https://example.com\n'
  assert.deepEqual(checkIntraVaultLinks('docs/hr/onboarding.md', text, KNOWN), [])
})

test('图片与 reference 定义同样检查；根相对 / 路径按库根解析', () => {
  const img = '![](missing.png)\n'
  const imgIssues = checkIntraVaultLinks('docs/hr/onboarding.md', img, KNOWN)
  assert.equal(imgIssues[0]?.code, 'W-LINK-101')
  assert.equal(imgIssues[0]?.actual, 'docs/hr/missing.png')

  const refDef = '参见[政策][pol]。\n\n[pol]: policy/missing.md\n'
  const refIssues = checkIntraVaultLinks('docs/hr/onboarding.md', refDef, KNOWN)
  assert.equal(refIssues[0]?.code, 'W-LINK-101')
  assert.equal(refIssues[0]?.line, 3)

  const rootRel = '见[根文档](/docs/root.md)与[缺失](/docs/nope.md)\n'
  const rootIssues = checkIntraVaultLinks('docs/hr/onboarding.md', rootRel, KNOWN)
  assert.equal(rootIssues.length, 1)
  assert.equal(rootIssues[0]?.actual, 'docs/nope.md')
})

test('目录链接：目标为目录且有库内文件位于其下则通过；含空格路径支持 <> 形式', () => {
  assert.deepEqual(checkIntraVaultLinks('docs/hr/onboarding.md', '[目录](policy/)\n', KNOWN), [])
  const space = '见[带空格](<../a b.md>)与[缺失](<../c d.md>)\n'
  const issues = checkIntraVaultLinks('docs/hr/onboarding.md', space, KNOWN)
  assert.equal(issues.length, 1)
  assert.equal(issues[0]?.actual, 'docs/c d.md')
})
