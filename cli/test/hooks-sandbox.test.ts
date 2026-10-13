import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdtemp, rm, mkdir, writeFile, chmod, readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// S6-T5 沙箱断言（breakdown §2.5 完成标准；validation §1「库内脚本攻击 hook」行）：
// hook 使用随工具分发的校验程序，绝不执行知识库内的任意脚本/hook 样本。
// 黑盒层（与 ls.test.ts 同约定）：目标 = dist 产物 + 真实 git commit 全链路。
const CLI_DIR = fileURLToPath(new URL('..', import.meta.url))
const HOOK_DIST = path.join(CLI_DIR, 'dist', 'src', 'hooks', 'pre-commit.js')

// 测试环境隔离：禁系统/全局配置（core.hooksPath、gpgsign 等不干扰）
const GIT_ENV = {
  PATH: process.env['PATH']!,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function gitOk(cwd: string, ...args: string[]): boolean {
  const r = spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' })
  return r.status === 0
}

async function seedRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  git(dir, 'init', '-b', 'main')
  git(dir, 'config', 'user.name', 't')
  git(dir, 'config', 'user.email', 't@notegit.invalid')
}

/** 恶意样本：若被执行则向仓库根写 MARKER-<name>（断言其绝不出现）。 */
async function plantMaliciousSamples(dir: string): Promise<string[]> {
  const samples: Array<[string, string]> = [
    // 仓库根 pre-commit —— 冒充 hook 本体（若 hook runner 从库内取脚本就会执行）
    ['pre-commit', '#!/bin/sh\necho pwned > ./MARKER-root-pre-commit\n./evil.sh\n'],
    // husky 风格约定目录
    ['.githooks/pre-commit', '#!/bin/sh\necho pwned > ./MARKER-githooks\n'],
    // 「安装脚本」社工样本
    ['scripts/setup-hooks.sh', '#!/bin/sh\necho pwned > ./MARKER-setup-hooks\ncp ./.githooks/pre-commit .git/hooks/pre-commit\n'],
    // 笔记正文引用的脚本
    ['evil.sh', '#!/bin/sh\necho pwned > ./MARKER-evil-sh\nrm -rf "$PWD"\n'],
  ]
  for (const [rel, content] of samples) {
    const p = path.join(dir, rel)
    await mkdir(path.dirname(p), { recursive: true })
    await writeFile(p, content)
    await chmod(p, 0o755)
  }
  // npm 生命周期脚本样本：hook 全程不运行 npm
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'pwned',
      version: '0.0.0',
      scripts: { precommit: 'sh ./evil.sh', postinstall: 'sh ./evil.sh', prepare: 'sh ./scripts/setup-hooks.sh' },
    }),
  )
  return ['MARKER-root-pre-commit', 'MARKER-githooks', 'MARKER-setup-hooks', 'MARKER-evil-sh']
}

const VALID_DOC = '---\ntitle: 差旅报销制度\nowner: zhangsan\n---\n\n# 差旅报销制度\n'
const INVALID_DOC = '# 没有 frontmatter 的知识文档\n'

/** 安装 hook 并跑真实 git commit（黑盒：launcher 指向 dist 产物）。 */
async function installHook(repo: string): Promise<void> {
  const { installHook: install } = await import('../src/hooks/install.ts')
  await install({ cwd: repo, interpreter: process.execPath, hookTarget: HOOK_DIST })
}

function commit(repo: string): { status: number | null; out: string } {
  const r = spawnSync('git', ['commit', '-m', 't'], { cwd: repo, env: GIT_ENV, encoding: 'utf8' })
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` }
}

test('沙箱：库内植入恶意 hook/脚本样本（含已暂存）不被执行，无效内容提交被阻断', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'notegit-t5-sbx1-'))
  try {
    await seedRepo(repo)
    await installHook(repo)
    const markers = await plantMaliciousSamples(repo)
    // 恶意样本本身也入暂存区（校验器只把它们当数据）+ 一个无效知识文档
    await mkdir(path.join(repo, 'notes'), { recursive: true })
    await writeFile(path.join(repo, 'notes', 'bad.md'), INVALID_DOC)
    git(repo, 'add', '.')

    const { status, out } = commit(repo)
    assert.notEqual(status, 0, '无效内容提交应被 hook 阻断')

    // 核心沙箱断言：所有恶意样本都未被执行（marker 均不存在）
    for (const m of markers) {
      assert.equal(existsSync(path.join(repo, m)), false, `恶意样本被执行了：${m}`)
    }
    // 阻断来自随工具分发的校验程序：报告可见错误码（坏 .md 与清单外 .sh）
    assert.match(out, /E-FM-001/, '应报告知识文档缺 frontmatter')
    assert.match(out, /E-LIMIT-002|E-PATH/, '恶意 .sh 样本应以内容规则被拒（作为数据，不作为代码）')
    // 提交未产生：根提交场景 HEAD 仍不存在
    assert.equal(gitOk(repo, 'rev-parse', 'HEAD'), false, '被阻断后不应产生提交')
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('沙箱：有效内容提交放行（warning 不阻断），库内恶意样本仍不执行', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'notegit-t5-sbx2-'))
  try {
    await seedRepo(repo)
    await installHook(repo)
    const markers = await plantMaliciousSamples(repo)
    // 暂存：合法文档（仅 title → W-FM-101 warning，不阻断）+ 正文引用恶意脚本的合法文档（数据非代码）
    await mkdir(path.join(repo, 'notes'), { recursive: true })
    await writeFile(path.join(repo, 'notes', 'ok.md'), '---\ntitle: 入职指引\n---\n\n参见 [报销](./howto.md)\n')
    await writeFile(path.join(repo, 'notes', 'howto.md'), VALID_DOC + '\n```sh\n./evil.sh\n```\n')
    git(repo, 'add', 'notes')

    const { status, out } = commit(repo)
    assert.equal(status, 0, `有效内容提交应放行，输出：${out}`)
    assert.match(out, /W-FM-101|通过/, 'warning 应可见但不阻断')
    for (const m of markers) {
      assert.equal(existsSync(path.join(repo, m)), false, `恶意样本被执行了：${m}`)
    }
    assert.equal(gitOk(repo, 'rev-parse', 'HEAD'), true, '提交应产生')
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('阻断语义：hook 退出码 0/1/2 —— 通过、校验错误、运行错误', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'notegit-t5-sbx3-'))
  const notRepo = await mkdtemp(path.join(tmpdir(), 'notegit-t5-sbx4-'))
  try {
    await seedRepo(repo)
    await installHook(repo)

    // 1：暂存无效内容 → 直接执行 hook 退出码 1（git commit 阻断语义的来源）
    await writeFile(path.join(repo, 'bad.md'), INVALID_DOC)
    git(repo, 'add', 'bad.md')
    let r = spawnSync(process.execPath, [HOOK_DIST], { cwd: repo, encoding: 'utf8' })
    assert.equal(r.status, 1, `校验错误应退出 1，输出：${r.stdout}\n${r.stderr}`)
    assert.match(`${r.stdout}\n${r.stderr}`, /E-FM-001/)

    // 0：暂存区无待校验内容（重置后）→ 退出 0
    git(repo, 'reset')
    r = spawnSync(process.execPath, [HOOK_DIST], { cwd: repo, encoding: 'utf8' })
    assert.equal(r.status, 0, `无暂存内容应退出 0，输出：${r.stdout}\n${r.stderr}`)

    // 2：非 git 仓库运行 → 运行错误退出 2（fail-closed，E-RUN-002）
    r = spawnSync(process.execPath, [HOOK_DIST], { cwd: notRepo, encoding: 'utf8' })
    assert.equal(r.status, 2, `运行错误应退出 2，输出：${r.stdout}\n${r.stderr}`)
    assert.match(`${r.stdout}\n${r.stderr}`, /E-RUN-002/)
  } finally {
    await rm(repo, { recursive: true, force: true })
    await rm(notRepo, { recursive: true, force: true })
  }
})

test('hook --json：输出 validation-report 协议 JSON（scope=pre-commit，退出码随报告）', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'notegit-t5-sbx5-'))
  try {
    await seedRepo(repo)
    await installHook(repo)
    await writeFile(path.join(repo, 'bad.md'), INVALID_DOC)
    git(repo, 'add', 'bad.md')

    const r = spawnSync(process.execPath, [HOOK_DIST, '--json'], { cwd: repo, encoding: 'utf8' })
    assert.equal(r.status, 1, `校验错误应退出 1，输出：${r.stdout}\n${r.stderr}`)
    const report = JSON.parse(r.stdout) as Record<string, unknown>
    assert.equal(report['scope'], 'pre-commit')
    assert.equal(report['result'], 'fail')
    assert.equal(report['exitCode'], 1)
    assert.equal(typeof report['rulesVersion'], 'string')
    const files = report['files'] as Array<Record<string, unknown>>
    assert.deepEqual(files.map((f) => f['path']), ['bad.md'])
    const issues = files[0]!['issues'] as Array<Record<string, unknown>>
    assert.ok(issues.some((i) => i['code'] === 'E-FM-001'))
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('已安装的 launcher 只引用随工具分发的绝对路径，不引用库内路径或相对路径', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'notegit-t5-sbx6-'))
  try {
    await seedRepo(repo)
    await installHook(repo)
    const hookPath = path.join(repo, '.git', 'hooks', 'pre-commit')
    const content = await readFile(hookPath, 'utf8')
    // launcher 以绝对路径 exec 解释器与工具分发的 hook 程序；无任何库内相对引用
    assert.match(content, /^#!\/bin\/sh\n/)
    const execLine = content.split('\n').find((l) => l.startsWith('exec')) ?? ''
    assert.ok(execLine.length > 0, 'launcher 应有 exec 行')
    assert.ok(execLine.includes(process.execPath), '应引用绝对解释器路径')
    assert.ok(execLine.includes(HOOK_DIST), '应引用工具分发的 hook 绝对路径')
    assert.ok(!/'\.\//.test(execLine) && !/"\.\//.test(execLine), 'exec 行不应引用相对路径')
    // 仓库里再没有任何脚本被引用
    const dir = await readdir(repo)
    for (const name of dir) assert.notEqual(name.startsWith('MARKER'), true)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})
