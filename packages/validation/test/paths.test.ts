import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyFile, validatePathShape } from '../src/paths.ts'
import { defaultConfig, withOverrides } from '../src/config.ts'

test('合法路径：中文/空格/允许标点/隐藏文件/COM10/16 级深度', () => {
  const cfg = defaultConfig()
  for (const p of [
    'docs/财务部/差旅报销制度.md',
    'a b/c-d.e(f)[g]{h}@i,j#k%l&m=n~o;p\'q!r^s+t.MD',
    '.gitignore',
    'COM10.txt',
    'root.md',
    'a/'.repeat(16) + 'f.md',
  ]) {
    assert.deepEqual(validatePathShape(p), [], p)
    assert.notEqual(classifyFile(p, cfg), undefined, p)
  }
})

test('E-PATH-001：形状违规（空组件/绝对/反斜杠/尾斜杠/./..）各触发且单条 issue 含原因', () => {
  for (const p of ['docs//a.md', '/abs/a.md', 'a\\b.md', 'dir/', './a.md', 'a/../b.md', '']) {
    const issues = validatePathShape(p)
    assert.equal(issues.length, 1, p)
    assert.equal(issues[0].code, 'E-PATH-001')
    assert.ok(typeof issues[0].actual === 'string' && (issues[0].actual as string).length > 0, p)
    assert.ok(issues[0].expected !== undefined, p)
  }
})

test('E-PATH-001：禁字符（: * ? " < > | $ emoji 与控制字符）', () => {
  for (const bad of ['a:b.md', 'a*b.md', 'a?b.md', 'a"b.md', 'a<b.md', 'a>b.md', 'a|b.md', 'a$b.md', 'a\u{1F600}b.md', 'a\u0001b.md', 'a\u009Fb.md']) {
    const issues = validatePathShape(bad)
    assert.equal(issues[0].code, 'E-PATH-001', bad)
  }
})

test('E-PATH-001：组件以空格或点结尾', () => {
  assert.equal(validatePathShape('dir /a.md')[0].code, 'E-PATH-001')
  assert.equal(validatePathShape('dir./a.md')[0].code, 'E-PATH-001')
})

test('E-PATH-001：Windows 保留名（去扩展名、不分大小写；COM10 不在列）', () => {
  for (const p of ['CON.md', 'aux', 'lpt1.md', 'Com9', 'PRN.txt', 'nul.log']) {
    assert.equal(validatePathShape(p)[0].code, 'E-PATH-001', p)
  }
  assert.deepEqual(validatePathShape('COM10.txt'), [])
})

test('E-PATH-001：长度与深度（组件>200B、全路径>1024B、>16 级目录）', () => {
  assert.equal(validatePathShape('a'.repeat(201) + '.md')[0].code, 'E-PATH-001')
  const long = ('d/'.repeat(3) + 'x'.repeat(200) + '/').repeat(5) + 'f.md' // 5×207+4 = 1039B > 1024
  assert.ok(Buffer.byteLength(long, 'utf8') > 1024)
  assert.equal(validatePathShape(long)[0].code, 'E-PATH-001')
  assert.equal(validatePathShape('a/'.repeat(17) + 'f.md')[0].code, 'E-PATH-001')
})

test('E-PATH-001：非 NFC（NFD 组合形式）被拒', () => {
  const nfd = 'café.md'
  assert.notEqual(nfd, nfd.normalize('NFC'))
  const issues = validatePathShape(nfd)
  assert.equal(issues[0].code, 'E-PATH-001')
  assert.ok(String(issues[0].actual).includes('NFC'))
})

test('classifyFile：README 豁免——任意目录、大小写不敏感', () => {
  const cfg = defaultConfig()
  assert.equal(classifyFile('README.md', cfg), 'readme-exempt')
  assert.equal(classifyFile('docs/Readme.MD', cfg), 'readme-exempt')
  assert.equal(classifyFile('a/b/c/readme.md', cfg), 'readme-exempt')
})

test('classifyFile：知识文档=扩展名 .md（大小写不敏感）；其余按清单归类', () => {
  const cfg = defaultConfig()
  assert.equal(classifyFile('docs/x.md', cfg), 'knowledge')
  assert.equal(classifyFile('docs/x.MD', cfg), 'knowledge')
  assert.equal(classifyFile('a.png', cfg), 'attachment')
  assert.equal(classifyFile('a.PDF', cfg), 'attachment')
  assert.equal(classifyFile('a.svg', cfg), 'attachment')
  assert.equal(classifyFile('Makefile', cfg), 'attachment')
  assert.equal(classifyFile('.gitignore', cfg), 'special')
  assert.equal(classifyFile('docs/.gitattributes', cfg), 'special')
})

test('classifyFile：管理员扩展豁免（additionalNavPatterns / specialFilePatterns，glob 生效）', () => {
  const cfg = withOverrides(defaultConfig(), {
    additionalNavPatterns: ['AGENTS.md', '**/INDEX.md'],
    specialFilePatterns: ['.editorconfig'],
  })
  assert.equal(classifyFile('AGENTS.md', cfg), 'nav-exempt')
  assert.equal(classifyFile('docs/INDEX.md', cfg), 'nav-exempt')
  assert.equal(classifyFile('.editorconfig', cfg), 'special')
  assert.equal(classifyFile('a.md', cfg), 'knowledge', '未命中模式的 .md 仍为知识文档')
  // 默认配置下扩展模式为空
  assert.equal(classifyFile('AGENTS.md', defaultConfig()), 'knowledge')
})
