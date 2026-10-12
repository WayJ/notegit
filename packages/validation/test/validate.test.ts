import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validate, createValidator, guardRun } from '../src/validate.ts'
import { rulesVersion } from '../src/rules-version.ts'
import type { FileInput } from '../src/validate.ts'

const FULL_FM = '---\ntitle: 文档\nowner: a\ndescription: d\nsource: s\n---\n\n正文\n'

function file(path: string, content: string | Uint8Array = FULL_FM, mode = '100644'): FileInput {
  return { path, mode, content }
}

function errCodesOf(r: { files: { issues: { severity: string; code: string }[] }[]; issues?: { severity: string; code: string }[] }): string[] {
  const all = [...(r.issues ?? []).map((i) => i.code), ...r.files.flatMap((f) => f.issues.map((i) => i.code))]
  return all.filter((c, i, a) => c.startsWith('E-') || c === 'N-UPGRADE-001' ? true : false).filter((c) => c[0] === 'E' || c.startsWith('N-')).filter((c, i, a) => a.indexOf(c) === i).sort()
}

// ---- pre-commit ----

test('pre-commit：两份合规文档 → pass/exitCode 0，summary 正确，无 refs 字段', async () => {
  const r = await validate({ scope: 'pre-commit', files: [file('docs/a.md'), file('docs/b.md')] })
  assert.equal(r.result, 'pass')
  assert.equal(r.exitCode, 0)
  assert.deepEqual(r.summary, { filesTotal: 2, filesPassed: 2, filesFailed: 0, errorCount: 0, warningCount: 0 })
  assert.equal(r.rulesVersion, rulesVersion())
  assert.equal('refs' in r, false)
  assert.equal(r.files.every((f) => f.status === 'pass'), true)
})

test('pre-commit：1 过 1 败（E-FM-003）→ fail/1，无 files[].commit', async () => {
  const r = await validate({
    scope: 'pre-commit',
    files: [file('docs/ok.md'), file('docs/bad.md', '---\nowner: a\n---\n\nx\n')],
  })
  assert.equal(r.result, 'fail')
  assert.equal(r.exitCode, 1)
  assert.equal(r.summary.filesPassed, 1)
  assert.equal(r.summary.filesFailed, 1)
  assert.equal(r.files[1].status, 'fail')
  assert.equal(r.files[1].issues[0].code, 'E-FM-003')
  assert.equal('commit' in r.files[1], false)
})

test('pre-commit：README 豁免标注 exempt:true 且不产生 E-FM-*', async () => {
  const r = await validate({ scope: 'pre-commit', files: [file('README.md', '# 导航\n无 frontmatter\n')] })
  assert.equal(r.result, 'pass')
  assert.equal(r.files[0].exempt, true)
})

test('pre-commit：危险 mode 整条短路（仅 E-PATH-002，不做类型/内容判定）', async () => {
  const r = await validate({ scope: 'pre-commit', files: [file('link', new TextEncoder().encode('/etc'), '120000')] })
  assert.deepEqual(errCodesOf(r), ['E-PATH-002'])
  assert.equal(r.files[0].issues.length, 1)
})

test('pre-commit：非法路径短路（仅 E-PATH-001，不做内容判定）', async () => {
  const r = await validate({ scope: 'pre-commit', files: [file('a\\b.md', 'no fm')] })
  assert.deepEqual(errCodesOf(r), ['E-PATH-001'])
})

test('pre-commit：暂存集内大小写冲突 → 两条 E-PATH-004 互指', async () => {
  const r = await validate({ scope: 'pre-commit', files: [file('docs/Foo.md'), file('docs/FOO.md')] })
  const codes = r.files.flatMap((f) => f.issues.map((i) => i.code))
  assert.deepEqual(codes.sort(), ['E-PATH-004', 'E-PATH-004'])
})

test('pre-commit：超限文档短路内容解析（坏 FM 也只报 E-LIMIT-001）', async () => {
  const big = '---\ntitle: t\n' + 'x'.repeat(1048576 + 10) + '\n---\n'
  const r = await validate({ scope: 'pre-commit', files: [file('docs/big.md', big)] })
  assert.deepEqual(errCodesOf(r), ['E-LIMIT-001'])
})

test('pre-commit：无效 UTF-8 内容 → E-FM-002', async () => {
  const bad = new Uint8Array([0x2d, 0x2d, 0x2d, 0x0a, 0x74, 0x69, 0x74, 0x6c, 0x65, 0x3a, 0x20, 0xff, 0xfe, 0x0a, 0x2d, 0x2d, 0x2d, 0x0a])
  const r = await validate({ scope: 'pre-commit', files: [file('docs/u.md', bad)] })
  assert.deepEqual(errCodesOf(r), ['E-FM-002'])
})

test('pre-commit：附件类型判定（.png 通过、.svg 拒绝）', async () => {
  const ok = await validate({ scope: 'pre-commit', files: [file('img.png', new Uint8Array(8))] })
  assert.equal(ok.result, 'pass')
  const bad = await validate({ scope: 'pre-commit', files: [file('img.svg', new Uint8Array(8))] })
  assert.deepEqual(errCodesOf(bad), ['E-LIMIT-002'])
})

test('pre-commit：仅 warning → pass 且 warningCount 计数', async () => {
  const r = await validate({
    scope: 'pre-commit',
    files: [file('docs/w.md', '---\ntitle: 文档\n---\n\n见[政策](missing.md)\n')],
  })
  assert.equal(r.result, 'pass')
  assert.equal(r.exitCode, 0)
  assert.equal(r.summary.warningCount, 4) // W-FM-101 ×3 + W-LINK-101 ×1
})

// ---- web-submit ----

test('web-submit：报告级 commit 字段、无 refs；失败 result=fail（草稿保留由调用方消费）', async () => {
  const r = await validate({
    scope: 'web-submit',
    commit: 'abc123',
    vaultId: 'vault-1',
    files: [file('docs/new.md', '# 无 frontmatter\n')],
  })
  assert.equal(r.result, 'fail')
  assert.equal(r.exitCode, 1)
  assert.equal(r.commit, 'abc123')
  assert.equal(r.vaultId, 'vault-1')
  assert.equal('refs' in r, false)
})

// ---- pre-receive ----

test('pre-receive：全有或全无——任一 ref 违规则所有 ref rejected；files[].commit 归因引入提交', async () => {
  const r = await validate({
    scope: 'pre-receive',
    vaultId: 'v',
    refs: [
      {
        ref: 'refs/heads/main',
        headOld: 'o1',
        headNew: 'n1',
        commits: [{ commit: 'c1', parent: 'o1', changes: [file('docs/ok.md')] }],
      },
      {
        ref: 'refs/heads/feature/x',
        headOld: 'o2',
        headNew: 'n2',
        commits: [{ commit: 'c2', parent: 'o2', changes: [file('docs/bad.md', 'no fm')] }],
      },
    ],
  })
  assert.equal(r.result, 'fail')
  assert.equal(r.refs?.every((x) => x.outcome === 'rejected'), true)
  assert.deepEqual(
    r.refs?.map((x) => x.checkedCommits),
    [1, 1],
  )
  const bad = r.files.find((f) => f.path === 'docs/bad.md')
  assert.equal(bad?.commit, 'c2')
  assert.equal(bad?.issues[0].code, 'E-FM-001')
  const ok = r.files.find((f) => f.path === 'docs/ok.md')
  assert.equal(ok?.commit, 'c1')
})

test('pre-receive：全部合规 → 全部 accepted', async () => {
  const r = await validate({
    scope: 'pre-receive',
    refs: [{ ref: 'refs/heads/main', headOld: 'o', headNew: 'n', commits: [{ commit: 'c1', parent: 'o', changes: [file('docs/a.md')] }] }],
  })
  assert.equal(r.result, 'pass')
  assert.equal(r.refs?.[0].outcome, 'accepted')
})

test('pre-receive：同一文件跨两个提交修改、后者引入问题 → 单 files 条目归因后提交', async () => {
  const r = await validate({
    scope: 'pre-receive',
    refs: [
      {
        ref: 'refs/heads/main',
        headOld: 'o',
        headNew: 'n',
        commits: [
          { commit: 'c1', parent: 'o', changes: [file('docs/x.md')] },
          { commit: 'c2', parent: 'c1', changes: [file('docs/x.md', '---\n---\n')] },
        ],
      },
    ],
  })
  assert.equal(r.summary.filesTotal, 1)
  const f = r.files[0]
  assert.equal(f.commit, 'c2')
  assert.deepEqual(
    f.issues.filter((i) => i.severity === 'error').map((i) => i.code),
    ['E-FM-003'],
  )
})

test('pre-receive：push 总量超限（E-LIMIT-004）落顶层 issues、每 ref 一条、全拒', async () => {
  const r = await validate({
    scope: 'pre-receive',
    pushBytes: 52428801,
    refs: [
      { ref: 'refs/heads/main', headOld: null, headNew: 'n1', commits: [{ commit: 'c1', parent: null, changes: [file('docs/a.md')] }] },
      { ref: 'refs/heads/f', headOld: 'o', headNew: 'n2', commits: [] },
    ],
  })
  assert.equal(r.result, 'fail')
  assert.equal(r.issues?.filter((i) => i.code === 'E-LIMIT-004').length, 2)
  assert.ok(r.issues?.every((i) => i.ref !== undefined))
  assert.equal(r.refs?.every((x) => x.outcome === 'rejected'), true)
})

test('N-UPGRADE-001：客户端规则版本不一致时附通知（一致时不附）；版本差异不构成拒绝', async () => {
  const stale = await validate({
    scope: 'pre-receive',
    clientRulesVersion: '0.9.0',
    refs: [{ ref: 'refs/heads/main', headOld: 'o', headNew: 'n', commits: [{ commit: 'c1', parent: 'o', changes: [file('docs/a.md')] }] }],
  })
  assert.equal(stale.result, 'pass')
  assert.equal(stale.notices?.[0].code, 'N-UPGRADE-001')
  assert.equal(stale.notices?.[0].message.includes(rulesVersion()), true)
  const same = await validate({
    scope: 'pre-receive',
    clientRulesVersion: rulesVersion(),
    refs: [{ ref: 'refs/heads/main', headOld: 'o', headNew: 'n', commits: [{ commit: 'c1', parent: 'o', changes: [file('docs/a.md')] }] }],
  })
  assert.equal(same.notices, undefined)
})

test('knownPaths：库内既有路径并入链接存在性判定', async () => {
  const r = await validate({
    scope: 'pre-receive',
    knownPaths: ['docs/hr/policy/leave.md'],
    refs: [{ ref: 'refs/heads/main', headOld: 'o', headNew: 'n', commits: [{ commit: 'c1', parent: 'o', changes: [file('docs/hr/onboarding.md', '---\ntitle: t\nowner: o\ndescription: d\nsource: s\n---\n\n见[政策](policy/leave.md)\n')] }] }],
  })
  assert.equal(r.summary.warningCount, 0)
})

// ---- 运行时限制（E-RUN-001/E-RUN-002） ----

test('超时：clock 注入越过 validationTimeoutMs → result=error/exitCode 2，顶层 E-RUN-001（ref+limit+limitKey），refs 全拒、files 空', async () => {
  let t = 0
  const clock = () => (t === 0 ? (t = 1000) : 1000 + 20000)
  const r = await validate({
    scope: 'pre-receive',
    clock,
    refs: [{ ref: 'refs/heads/main', headOld: 'o', headNew: 'n', commits: [{ commit: 'c1', parent: 'o', changes: [file('docs/a.md')] }] }],
  })
  assert.equal(r.result, 'error')
  assert.equal(r.exitCode, 2)
  assert.equal(r.files.length, 0)
  assert.equal(r.issues?.[0].code, 'E-RUN-001')
  assert.equal(r.issues?.[0].ref, 'refs/heads/main')
  assert.equal(r.issues?.[0].limitKey, 'validation.runtime.validationTimeoutMs')
  assert.equal(r.refs?.every((x) => x.outcome === 'rejected'), true)
})

test('内存：maxValidationMemoryMb 极小值（1 MiB）触发 E-RUN-001（limitKey=maxValidationMemoryMb）', async () => {
  const r = await validate({
    scope: 'pre-commit',
    config: { maxValidationMemoryMb: 1 },
    files: [file('docs/a.md')],
  })
  assert.equal(r.result, 'error')
  assert.equal(r.exitCode, 2)
  assert.equal(r.issues?.[0].code, 'E-RUN-001')
  assert.equal(r.issues?.[0].limitKey, 'validation.runtime.maxValidationMemoryMb')
})

test('并发：createValidator(maxConcurrent=1) 下第二路并发校验立即 E-RUN-001', async () => {
  const v = createValidator({ maxConcurrentValidations: 1 })
  const input = {
    scope: 'pre-commit' as const,
    files: [file('docs/a.md'), file('docs/b.md'), file('docs/c.md')],
  }
  const [r1, r2] = await Promise.all([v.validate(input), v.validate(input)])
  assert.equal(r1.result, 'pass')
  assert.equal(r2.result, 'error')
  assert.equal(r2.issues?.[0].code, 'E-RUN-001')
  assert.equal(r2.issues?.[0].limitKey, 'validation.runtime.maxConcurrentValidations')
})

test('guardRun：内部异常包装为 E-RUN-002（exitCode 2）', () => {
  const r = guardRun(() => {
    throw new Error('boom')
  })
  assert.equal(r.result, 'error')
  assert.equal(r.exitCode, 2)
  assert.equal(r.issues![0].code, 'E-RUN-002')
  assert.ok(String(r.issues![0].message).includes('boom'))
})
