import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkTreeEntry, findCaseConflicts } from '../src/tree.ts'

test('合法 mode（100644/100755）不产生 tree 问题', () => {
  assert.equal(checkTreeEntry({ path: 'docs/a.md', mode: '100644' }), null)
  assert.equal(checkTreeEntry({ path: 'run.sh', mode: '100755' }), null)
})

test('E-PATH-002：mode 120000 符号链接', () => {
  const issue = checkTreeEntry({ path: 'docs/finance/evil-link', mode: '120000' })
  assert.equal(issue?.code, 'E-PATH-002')
  assert.equal(issue?.actual, 'mode 120000')
})

test('E-PATH-003：mode 160000 gitlink/submodule', () => {
  const issue = checkTreeEntry({ path: 'vendor/lib', mode: '160000' })
  assert.equal(issue?.code, 'E-PATH-003')
  assert.equal(issue?.actual, 'mode 160000')
})

test('E-PATH-005：非法 mode（040000 目录条目、100664）', () => {
  for (const mode of ['040000', '100664', '40755']) {
    const issue = checkTreeEntry({ path: 'x', mode })
    assert.equal(issue?.code, 'E-PATH-005', mode)
    assert.ok(String(issue?.actual).includes(mode), mode)
  }
})

test('E-PATH-005：.git 组件（不分大小写、任意层级）与 .gitmodules 文件', () => {
  for (const path of ['.git', 'sub/.git', 'sub/.Git/config', '.Git', '.gitmodules', 'docs/.Gitmodules']) {
    const issue = checkTreeEntry({ path, mode: '100644' })
    assert.equal(issue?.code, 'E-PATH-005', path)
  }
})

test('E-PATH-004：同集合内仅大小写不同的路径互指（含 README 组合），无冲突返回空', () => {
  const conflicts = findCaseConflicts(['docs/Foo.md', 'docs/FOO.md'])
  assert.equal(conflicts.get('docs/Foo.md'), 'docs/FOO.md')
  assert.equal(conflicts.get('docs/FOO.md'), 'docs/Foo.md')

  assert.equal(findCaseConflicts(['docs/a.md', 'docs/b.md', 'a/A.md']).size, 0)

  const readme = findCaseConflicts(['README.md', 'readme.md'])
  assert.equal(readme.size, 2)
})
