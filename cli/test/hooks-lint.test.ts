import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdtemp, rm, mkdir, writeFile, symlink, rm as rmf } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { lintStaged, scanStaged } from '../src/hooks/staged.ts'
import type { Report } from 'notegit-validation'

// S6-T5 暂存区校验核心（与 lint --staged 同一实现的临时载体——T4 并行未合并，
// 接口约定记于 .agents/notes/2026-10-13-S6-T5-hooks.md；T4 合并后等价断言对真命令扩展）。
// validation §1 pre-commit 行：读 index，不读工作目录；部分暂存只校验暂存内容。
const CLI_DIR = fileURLToPath(new URL('..', import.meta.url))
const HOOK_DIST = path.join(CLI_DIR, 'dist', 'src', 'hooks', 'pre-commit.js')

const GIT_ENV = {
  PATH: process.env['PATH']!,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

async function seedRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  git(dir, 'init', '-b', 'main')
  git(dir, 'config', 'user.name', 't')
  git(dir, 'config', 'user.email', 't@notegit.invalid')
}

async function commitAll(dir: string): Promise<void> {
  git(dir, 'add', '.')
  git(dir, 'commit', '-m', 'seed')
}

const VALID_DOC = '---\ntitle: 差旅报销制度\nowner: zhangsan\n---\n\n正文\n'
const INVALID_DOC = '# 缺 frontmatter\n'

test('scanStaged：部分暂存（2/3）只返回暂存条目 —— 校验对象是 index（§1 S1 场景）', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'notegit-t5-l1-'))
  try {
    await seedRepo(repo)
    await writeFile(path.join(repo, 'a.md'), VALID_DOC)
    await writeFile(path.join(repo, 'b.md'), VALID_DOC)
    await commitAll(repo)
    // 改动 3 个文件，只暂存 2 个；未暂存的 c.md 不属于将提交内容
    await writeFile(path.join(repo, 'a.md'), INVALID_DOC)
    await writeFile(path.join(repo, 'b.md'), INVALID_DOC)
    await writeFile(path.join(repo, 'c.md'), INVALID_DOC)
    git(repo, 'add', 'a.md', 'b.md')

    const scan = await scanStaged(repo)
    assert.deepEqual([...scan.files].map((f) => f.path).sort(), ['a.md', 'b.md'])
    assert.ok(scan.treePaths.includes('c.md') === false, 'treePaths 是候选提交（index）全路径：未暂存内容不入候选')
    assert.deepEqual([...scan.treePaths].sort(), ['a.md', 'b.md'])
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('scanStaged：读 index 不读工作目录 —— 双向（暂存坏+工作区修好→仍坏；暂存好+工作区改坏→仍好）', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'notegit-t5-l2-'))
  try {
    await seedRepo(repo)
    await writeFile(path.join(repo, 'a.md'), INVALID_DOC)
    await writeFile(path.join(repo, 'b.md'), VALID_DOC)
    git(repo, 'add', 'a.md', 'b.md')
    // add 之后改工作目录：a 修好、b 改坏 —— index 内容不变
    await writeFile(path.join(repo, 'a.md'), VALID_DOC)
    await writeFile(path.join(repo, 'b.md'), INVALID_DOC)

    const scan = await scanStaged(repo)
    const byPath = new Map(scan.files.map((f) => [f.path, f.content as Uint8Array]))
    assert.equal(new TextDecoder().decode(byPath.get('a.md')!), INVALID_DOC, 'a.md 应取暂存的坏内容')
    assert.equal(new TextDecoder().decode(byPath.get('b.md')!), VALID_DOC, 'b.md 应取暂存的好内容')
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('lintStaged：报告走 validation-report 协议（scope=pre-commit），好坏内容判定正确', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'notegit-t5-l3-'))
  try {
    await seedRepo(repo)
    await writeFile(path.join(repo, 'bad.md'), INVALID_DOC)
    await writeFile(path.join(repo, 'good.md'), VALID_DOC)
    git(repo, 'add', '.')

    const { report, exitCode } = await lintStaged(repo)
    assert.equal(report.scope, 'pre-commit')
    assert.equal(report.result, 'fail')
    assert.equal(report.exitCode, 1)
    assert.equal(exitCode, 1)
    assert.equal(typeof report.rulesVersion, 'string')
    assert.equal(report.summary.filesTotal, 2)
    assert.equal(report.summary.filesFailed, 1)
    const bad = report.files.find((f) => f.path === 'bad.md')!
    assert.equal(bad.status, 'fail')
    assert.ok(bad.issues.some((i) => i.code === 'E-FM-001'))
    assert.equal(report.files.find((f) => f.path === 'good.md')!.status, 'pass')

    // 修好重暂存 → pass（warning 不失败）
    await writeFile(path.join(repo, 'bad.md'), VALID_DOC)
    git(repo, 'add', 'bad.md')
    const ok = await lintStaged(repo)
    assert.equal(ok.report.result, 'pass')
    assert.equal(ok.report.exitCode, 0)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('lintStaged：仅 warning（可选字段缺失）→ result=pass、exitCode=0（不阻断）', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'notegit-t5-l4-'))
  try {
    await seedRepo(repo)
    await writeFile(path.join(repo, 'min.md'), '---\ntitle: 最小文档\n---\n\n正文\n')
    git(repo, 'add', 'min.md')
    const { report, exitCode } = await lintStaged(repo)
    assert.equal(report.result, 'pass')
    assert.equal(report.exitCode, 0)
    assert.equal(exitCode, 0)
    assert.ok(report.summary.warningCount > 0, '仅 title 应产生 W-FM-101 warning')
    assert.ok(report.files[0]!.issues.some((i) => i.code === 'W-FM-101'))
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('lintStaged：根提交（无 HEAD）全检暂存内容', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'notegit-t5-l5-'))
  try {
    await seedRepo(repo)
    await writeFile(path.join(repo, 'one.md'), VALID_DOC)
    await writeFile(path.join(repo, 'two.md'), INVALID_DOC)
    git(repo, 'add', '.')
    const { report } = await lintStaged(repo)
    assert.equal(report.result, 'fail')
    assert.deepEqual(report.files.map((f) => f.path).sort(), ['one.md', 'two.md'])
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('lintStaged：暂存删除不做元数据校验（§2.5），其余改动照常校验', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'notegit-t5-l6-'))
  try {
    await seedRepo(repo)
    await writeFile(path.join(repo, 'a.md'), VALID_DOC)
    await commitAll(repo)
    git(repo, 'rm', 'a.md') // 暂存删除
    await writeFile(path.join(repo, 'b.md'), VALID_DOC)
    git(repo, 'add', 'b.md')
    const { report } = await lintStaged(repo)
    assert.equal(report.result, 'pass')
    assert.deepEqual(report.files.map((f) => f.path), ['b.md'], '删除条目不进报告')
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('lintStaged：暂存符号链接 → E-PATH-002（不读其内容作文本）', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'notegit-t5-l7-'))
  try {
    await seedRepo(repo)
    await writeFile(path.join(repo, 'target.md'), VALID_DOC)
    await symlink('target.md', path.join(repo, 'link.md'))
    git(repo, 'add', '.')
    const { report } = await lintStaged(repo)
    assert.equal(report.result, 'fail')
    assert.ok(report.files.some((f) => f.path === 'link.md' && f.issues.some((i) => i.code === 'E-PATH-002')))
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('lintStaged：非 git 仓库 → error 报告（result=error、exitCode=2、E-RUN-002），不抛出', async () => {
  const notRepo = await mkdtemp(path.join(tmpdir(), 'notegit-t5-l8-'))
  try {
    const { report, exitCode } = await lintStaged(notRepo)
    assert.equal(report.result, 'error')
    assert.equal(report.exitCode, 2)
    assert.equal(exitCode, 2)
    assert.ok(report.issues?.some((i) => i.code === 'E-RUN-002'))
  } finally {
    await rm(notRepo, { recursive: true, force: true })
  }
})

test('treePaths 接线：暂存 Ok.md 与 HEAD 存量 ok.md 大小写冲突 → E-PATH-004（候选全 tree 基线）', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'notegit-t5-l11-'))
  try {
    await seedRepo(repo)
    await writeFile(path.join(repo, 'ok.md'), VALID_DOC)
    await commitAll(repo)
    // 大小写不敏感文件系统（macOS APFS）上两路径是同一文件，无法经工作区暂存出冲突；
    // 经 update-index --cacheinfo 直接插入字面路径 Ok.md（跨平台构造该 index 状态）
    const oid = git(repo, 'hash-object', '-t', 'blob', path.join(repo, 'ok.md')).trim()
    git(repo, 'update-index', '--add', '--cacheinfo', `100644,${oid},Ok.md`)
    const { report } = await lintStaged(repo)
    assert.equal(report.result, 'fail')
    assert.ok(
      report.files.some((f) => f.path === 'Ok.md' && f.issues.some((i) => i.code === 'E-PATH-004')),
      '应命中与存量路径的大小写冲突（treePaths 基线输入）',
    )
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('knownPaths 接线：库内链接指向已跟踪未改动文件 → 无 W-LINK-101（基线含候选全 tree）', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'notegit-t5-l12-'))
  try {
    await seedRepo(repo)
    await writeFile(path.join(repo, 'target.md'), VALID_DOC)
    await writeFile(path.join(repo, 'ref.md'), '---\ntitle: 引用\nowner: zhangsan\n---\n\n见 [目标](./target.md)\n')
    await commitAll(repo)
    await writeFile(path.join(repo, 'new.md'), '---\ntitle: 新增\nowner: zhangsan\ndescription: 新增说明\nsource: 测试\n---\n\n见 [目标](./target.md)\n')
    git(repo, 'add', 'new.md')
    const { report } = await lintStaged(repo)
    assert.equal(report.result, 'pass')
    assert.equal(report.summary.warningCount, 0, '链接目标在候选 tree 中，不应告 W-LINK-101')
    assert.ok(!report.files.some((f) => f.issues.some((i) => i.code === 'W-LINK-101')))
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('hook ≡ lint --staged：hook --json 子进程报告与进程内 lintStaged() 报告 deepEqual（失败态）', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'notegit-t5-l9-'))
  try {
    await seedRepo(repo)
    await mkdir(path.join(repo, 'notes'))
    await writeFile(path.join(repo, 'notes', 'bad.md'), INVALID_DOC)
    await writeFile(path.join(repo, 'notes', 'warn.md'), '---\ntitle: t\n---\n\n[missing](./nope.md)\n')
    git(repo, 'add', '.')
    const expected = (await lintStaged(repo)).report

    const r = spawnSync(process.execPath, [HOOK_DIST, '--json'], { cwd: repo, encoding: 'utf8' })
    assert.equal(r.status, expected.exitCode)
    const actual = JSON.parse(r.stdout) as Report
    assert.deepEqual(actual, JSON.parse(JSON.stringify(expected)))
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('hook ≡ lint --staged：通过态（含 warning）deepEqual；从子目录运行解析仓库根', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'notegit-t5-l10-'))
  try {
    await seedRepo(repo)
    await mkdir(path.join(repo, 'docs', 'deep'), { recursive: true })
    await writeFile(path.join(repo, 'docs', 'deep', 'ok.md'), VALID_DOC)
    git(repo, 'add', '.')
    const expected = (await lintStaged(repo)).report

    // git 运行 hook 时 cwd=仓库根，但手动从子目录调用也应正确解析（lint --staged 语义）
    const r = spawnSync(process.execPath, [HOOK_DIST, '--json'], { cwd: path.join(repo, 'docs', 'deep'), encoding: 'utf8' })
    assert.equal(r.status, 0, `stderr：${r.stderr}`)
    const actual = JSON.parse(r.stdout) as Report
    assert.deepEqual(actual, JSON.parse(JSON.stringify(expected)))
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})
