import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

// S6-T4 单元层：参数解析、版本比较纯函数、lintOnce hook 等价入口（S6-T5 消费
// 同一入口函数——hook 触发 lint 等价于手动 lint --staged 的同一报告）、注入式
// 依赖矩阵（黑盒 dist 测试见 lint.test.ts）。
import { parseLintArgs, lintOnce, compareRulesVersions, type LintDeps, type LintHint } from '../src/lint/index.ts'
import { rulesVersion, renderMessage } from 'notegit-validation'
import type { Report } from 'notegit-validation'

// ── parseLintArgs ─────────────────────────────────────────────────────────────

test('parseLintArgs：--staged/--all/--json 识别与组合', () => {
  assert.deepEqual(parseLintArgs(['--staged']), { ok: true, args: { mode: 'staged', json: false } })
  assert.deepEqual(parseLintArgs(['--all']), { ok: true, args: { mode: 'all', json: false } })
  assert.deepEqual(parseLintArgs(['--staged', '--json']), { ok: true, args: { mode: 'staged', json: true } })
  assert.deepEqual(parseLintArgs(['--all', '--json']), { ok: true, args: { mode: 'all', json: true } })
  assert.deepEqual(parseLintArgs(['--json', '--staged']), { ok: true, args: { mode: 'staged', json: true } })
})

test('parseLintArgs：缺模式 / 双模式 / 未知旗标 / 位置参数 / -h 短旗标 → 用法错误', () => {
  for (const argv of [['--json'], ['--staged', '--all'], ['--staged', '--nope'], ['--staged', 'x.md'], ['-h']]) {
    const r = parseLintArgs(argv)
    assert.equal(r.ok, false, `${JSON.stringify(argv)} 应为用法错误`)
    if (!r.ok) assert.ok(r.message.length > 0)
  }
})

// ── compareRulesVersions：SemVer 前置比较（rulesVersion 模式，validation.md §7.1）──

test('compareRulesVersions：核心段数值比较', () => {
  assert.equal(compareRulesVersions('1.0.0', '1.0.1'), -1)
  assert.equal(compareRulesVersions('1.1.0', '1.0.99'), 1)
  assert.equal(compareRulesVersions('2.0.0', '1.99.99'), 1)
  assert.equal(compareRulesVersions('1.0.0', '1.0.0'), 0)
})

test('compareRulesVersions：预发布段语义（无预发布 > 有预发布；标识符逐段比较）', () => {
  assert.equal(compareRulesVersions('1.0.0-draft.1', '1.0.0'), -1, '预发布 < 正式版')
  assert.equal(compareRulesVersions('1.0.0-draft.1', '1.0.0-draft.2'), -1)
  assert.equal(compareRulesVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1)
  assert.equal(compareRulesVersions('1.0.0-2', '1.0.0-10'), -1, '数字标识符按数值比较')
  assert.equal(compareRulesVersions('1.0.0-draft', '1.0.0-1'), 1, '数字标识符恒小于字母数字标识符（semver §11）')
})

test('compareRulesVersions：不可解析 → null（调用方按不可比跳过提示）', () => {
  assert.equal(compareRulesVersions('not-a-version', '1.0.0'), null)
  assert.equal(compareRulesVersions('1.0.0', ''), null)
  assert.equal(compareRulesVersions('1.0', '1.0.0'), null)
})

// ── lintOnce：注入式依赖（无 git 依赖的假件矩阵）────────────────────────────

function fakeDeps(overrides: Partial<LintDeps> = {}): LintDeps {
  return {
    cwd: '/definitely/not/a/repo',
    env: {},
    async execGit() {
      throw new Error('git 不可用（测试假件）')
    },
    async fetchImpl() {
      throw new Error('不应发起网络请求')
    },
    stdout: () => {},
    stderr: () => {},
    ...overrides,
  }
}

/** 空仓库假 git 面：root=/fake/repo、空 index、无暂存变更（unborn HEAD 由 git 语义自然覆盖——diff --cached 对空树）。 */
function emptyRepoDeps(overrides: Partial<LintDeps> = {}): LintDeps {
  return fakeDeps({
    async execGit(args: readonly string[]) {
      if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) return Buffer.from('/fake/repo\n')
      if (args[0] === 'ls-files') return Buffer.alloc(0)
      if (args[0] === 'diff') return Buffer.alloc(0)
      throw new Error(`意外调用：git ${args.join(' ')}`)
    },
    ...overrides,
  })
}

test('lintOnce：git 失败 → E-RUN-002 错误报告（result=error，exitCode=2）', async () => {
  const out = await lintOnce({ mode: 'staged', json: true }, fakeDeps())
  assert.equal(out.exitCode, 2)
  assert.equal(out.report.result, 'error')
  assert.ok(out.report.issues!.some((i) => i.code === 'E-RUN-002'))
  assert.equal(out.report.scope, 'pre-commit')
  assert.equal(out.report.rulesVersion, rulesVersion(), '错误报告也标明规则版本（契约 §6.3）')
})

test('lintOnce：注入 fetch 返回旧/同服务端版本 → 提示仅在旧于时出现，退出码不变', async () => {
  const serverVersion = (v: string): Partial<LintDeps> => ({
    async fetchImpl() {
      return new Response(JSON.stringify({ rulesVersion: v }), { status: 200 })
    },
    env: { NOTEGIT_SERVER: 'https://s.example', NOTEGIT_TOKEN: 'ngt_x' },
  })

  const stale = await lintOnce({ mode: 'staged', json: true }, emptyRepoDeps(serverVersion('99.0.0')))
  assert.equal(stale.exitCode, 0)
  assert.equal(stale.hint.kind, 'notice')
  assert.equal(stale.hint.notice!.code, 'N-UPGRADE-001')
  assert.equal(stale.hint.notice!.message, renderMessage('N-UPGRADE-001', { actual: rulesVersion(), expected: '99.0.0' }))
  assert.deepEqual(stale.report.notices, [stale.hint.notice], '提示进报告 notices[]（--json 可见）')

  const same = await lintOnce({ mode: 'staged', json: true }, emptyRepoDeps(serverVersion(rulesVersion())))
  assert.equal(same.hint.kind, 'none')
  assert.equal(same.report.notices, undefined)

  const newerLocal = await lintOnce({ mode: 'staged', json: true }, emptyRepoDeps(serverVersion('0.0.1')))
  assert.equal(newerLocal.hint.kind, 'none', '本地新于服务端不提示（服务端将升级）')

  const garbage = await lintOnce({ mode: 'staged', json: true }, emptyRepoDeps(serverVersion('oops')))
  assert.equal(garbage.hint.kind, 'skipped', '服务端版本不可解析 → 跳过提示')
})

test('lintOnce：凭据未配置 → hint=skipped（静默），不发起 fetch', async () => {
  const out = await lintOnce({ mode: 'staged', json: true }, emptyRepoDeps())
  assert.equal(out.hint.kind, 'skipped')
  assert.equal(out.report.notices, undefined)
})

// ── hook 等价入口（S6-T5 接缝）：lintOnce 报告 ≡ CLI lint --staged --json ──

const BIN = new URL('../dist/bin/notegit.js', import.meta.url).pathname

test('hook 等价入口：lintOnce({mode:"staged"}) 与 CLI --staged --json 输出同一报告', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'notegit-lint-unit-'))
  try {
    const git = (...args: string[]): void => {
      const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', ...args], { cwd: dir, encoding: 'utf8' })
      if (r.status !== 0) throw new Error(r.stderr)
    }
    git('init', '-b', 'main')
    await writeFile(path.join(dir, 'README.md'), '# nav\n')
    await writeFile(path.join(dir, 'a.md'), '# 缺 frontmatter\n')
    git('add', 'README.md', 'a.md')

    const once = await lintOnce({ mode: 'staged', json: true }, { cwd: dir, env: {} })
    const cli = spawnSync(process.execPath, [BIN, 'lint', '--staged', '--json'], {
      cwd: dir,
      encoding: 'utf8',
      env: { PATH: process.env['PATH']!, HOME: dir, GIT_CONFIG_NOSYSTEM: '1' },
    })
    assert.equal(cli.status, once.exitCode, 'CLI 退出码 = lintOnce 退出码')
    const cliReport = JSON.parse(cli.stdout) as Report
    assert.deepEqual(cliReport, JSON.parse(JSON.stringify(once.report)), 'hook 入口与手动 lint 同一报告')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// LintHint 形状由上面各用例间接固化；此处显式锁联合类型分支（编译期 + 文档）
test('LintHint 联合形状：none | skipped | notice', () => {
  const hints: LintHint[] = [
    { kind: 'none' },
    { kind: 'skipped', reason: '未配置凭据', silent: true },
    { kind: 'notice', notice: { code: 'N-UPGRADE-001', message: 'x' } },
  ]
  assert.equal(hints.length, 3)
})
