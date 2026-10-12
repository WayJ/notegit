import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validate } from '../src/validate.ts'
import type { FileInput } from '../src/validate.ts'

/**
 * ValidateInput.treePaths 基线扩展（S3-T7；T4 的 CommitDelta.treePaths 同语义
 * 对非 pre-receive scope 的对称落地）：web-submit/pre-commit 的调用方（发布
 * 组件/S6 hook）传入「候选提交全 tree 路径」时，新增/修改路径与库内存量路径的
 * 大小写冲突（E-PATH-004）被拦截——与 pre-receive 的全 tree 基线同构（架构
 * §5.4 三入口一致；契约 §4「同一提交内仅大小写不同的两条路径」的提交=候选
 * 提交，其 tree 含未变更存量路径）。缺省回退变更集内比对——既有语义不变。
 */

const VALID = '---\ntitle: First Case\nowner: alice\ndescription: 摘要\nsource: web\n---\n\n正文。\n'
const f = (path: string, content = VALID): FileInput => ({ path, mode: '100644', content })

test('web-submit + treePaths：新文件与库内存量路径仅大小写不同 → E-PATH-004（存量侧不产生 issue）', async () => {
  const report = await validate({
    scope: 'web-submit',
    vaultId: 'v1',
    commit: 'a'.repeat(40),
    files: [f('Notes/First.md')],
    knownPaths: ['README.md', 'notes/first.md', 'Notes/First.md'],
    treePaths: ['README.md', 'notes/first.md', 'Notes/First.md'],
  })
  assert.equal(report.result, 'fail')
  assert.equal(report.files.length, 1, '只有变更文件进 files——存量路径不产生条目')
  const file = report.files[0]!
  assert.equal(file.status, 'fail')
  assert.deepEqual(
    file.issues.filter((i) => i.severity === 'error').map((i) => i.code),
    ['E-PATH-004'],
  )
  const issue = file.issues.find((i) => i.code === 'E-PATH-004')!
  assert.equal(issue.actual, 'notes/first.md', 'actual=冲突的存量路径')
})

test('缺省 treePaths：web-submit 既有语义不变——变更集内比对，存量侧冲突不拦', async () => {
  const report = await validate({
    scope: 'web-submit',
    files: [f('Notes/First.md')],
    knownPaths: ['README.md', 'notes/first.md', 'Notes/First.md'],
  })
  assert.equal(report.result, 'pass')
})

test('变更集内两路径仅大小写不同仍拦（treePaths 给定与否都拦——既有语义）', async () => {
  for (const treePaths of [undefined, ['README.md', 'Notes/First.md', 'notes/first.md']]) {
    const report = await validate({
      scope: 'web-submit',
      files: [f('Notes/First.md'), f('notes/first.md', VALID)],
      ...(treePaths === undefined ? {} : { treePaths }),
    })
    assert.equal(report.result, 'fail')
    for (const file of report.files) {
      assert.ok(file.issues.some((i) => i.code === 'E-PATH-004'), `${file.path} 带 E-PATH-004`)
    }
  }
})

test('pre-commit + treePaths：同一扩展语义（暂存区 vs HEAD 基线）', async () => {
  const report = await validate({
    scope: 'pre-commit',
    files: [f('Notes/First.md')],
    treePaths: ['README.md', 'notes/first.md', 'Notes/First.md'],
  })
  assert.equal(report.result, 'fail')
  assert.ok(report.files[0]!.issues.some((i) => i.code === 'E-PATH-004'))
})

test('treePaths 与变更集去重合并：同路径重复不误报', async () => {
  const report = await validate({
    scope: 'web-submit',
    files: [f('docs/x.md')],
    treePaths: ['docs/x.md', 'docs/x.md', 'README.md'],
  })
  assert.equal(report.result, 'pass', '同路径重复（变更 ⊆ 基线）不构成大小写冲突')
})
