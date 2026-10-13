import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, mkdir, writeFile, readFile, stat, chmod } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { hookScriptSource, installHook, isNotegitHook, HOOK_NAME, HOOK_MARKER } from '../src/hooks/install.ts'

// S6-T5 最小安装面：hook 本体随工具分发，launcher 只 exec 绝对路径的工具分发校验程序。
// 完整 setup（卸载/兼容链/还原/幂等语义收敛）属 S6-T6；本面交付 T6 可组合的原语。
const CLI_DIR = fileURLToPath(new URL('..', import.meta.url))
const HOOK_SRC = path.join(CLI_DIR, 'src', 'hooks', 'pre-commit.ts')
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

const hookPath = (repo: string): string => path.join(repo, '.git', 'hooks', HOOK_NAME)

test('hookScriptSource：#!/bin/sh launcher，exec 绝对解释器 + 绝对工具分发 hook，含标识注释', () => {
  const src = hookScriptSource({ interpreter: '/usr/local/bin/node', hookTarget: '/opt/notegit/dist/src/hooks/pre-commit.js' })
  assert.match(src, /^#!\/bin\/sh\n/)
  assert.ok(src.includes(HOOK_MARKER), '含 notegit 标识注释（重装识别用）')
  assert.ok(src.includes('"/usr/local/bin/node"'), '解释器绝对路径加引号')
  assert.ok(src.includes('"/opt/notegit/dist/src/hooks/pre-commit.js"'), 'hook 目标绝对路径加引号')
  assert.match(src, /\n$/, '以换行结尾')
  // 安全注释：声明不执行库内脚本（validation §1）
  assert.match(src, /不执行.{0,30}脚本/)
  assert.ok(!src.includes('$PWD') && !src.includes('$(dirname'), '不引用运行时路径推导')
})

test('installHook：默认解析自身同目录 hook 本体（源码树 .ts / dist .js）并写入可执行 launcher', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'notegit-t5-i1-'))
  try {
    await seedRepo(repo)
    const { hookPath: installed } = await installHook({ cwd: repo })
    // macOS tmpdir 逻辑路径(/var)与 git 返回的物理路径(/private/var)不同，按 realpath 比较
    assert.equal(installed, realpathSync(hookPath(repo)))
    const st = await stat(installed)
    assert.equal(st.mode & 0o111, 0o111, 'launcher 应可执行')
    const content = await readFile(installed, 'utf8')
    assert.ok(isNotegitHook(content))
    // 默认目标 = 本模块同目录的 hook 本体（测试导入源码树 → src/hooks/pre-commit.ts）
    assert.ok(content.includes(HOOK_SRC), `launcher 应指向默认 hook 本体：${content}`)
    assert.ok(existsSync(HOOK_SRC), '默认目标应真实存在')
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('installHook：显式覆盖 interpreter/hookTarget（测试与 T6 setup 复用的注入口）', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'notegit-t5-i2-'))
  try {
    await seedRepo(repo)
    await installHook({ cwd: repo, interpreter: '/custom/node', hookTarget: '/custom/hook.js' })
    const content = await readFile(hookPath(repo), 'utf8')
    assert.ok(content.includes('"/custom/node"'))
    assert.ok(content.includes('"/custom/hook.js"'))
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('installHook：.git/hooks 缺失时创建', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'notegit-t5-i3-'))
  try {
    await seedRepo(repo)
    await rm(path.join(repo, '.git', 'hooks'), { recursive: true, force: true })
    await installHook({ cwd: repo })
    assert.ok(existsSync(hookPath(repo)))
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('installHook：已有外来 hook → 明确拒绝且原文件不动（兼容链/两模式属 T6）', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'notegit-t5-i4-'))
  try {
    await seedRepo(repo)
    const existing = '#!/bin/sh\necho user hook\n'
    await mkdir(path.dirname(hookPath(repo)), { recursive: true })
    await writeFile(hookPath(repo), existing, { mode: 0o755 })
    await assert.rejects(
      installHook({ cwd: repo }),
      (e: Error) => /已存在非 notegit|外来/.test(e.message),
      '应拒绝并说明存在外来 hook',
    )
    assert.equal(await readFile(hookPath(repo), 'utf8'), existing, '原 hook 不被覆盖')
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('installHook：重装自有 hook → 原地替换（识别标识，无需兼容处理）', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'notegit-t5-i5-'))
  try {
    await seedRepo(repo)
    await installHook({ cwd: repo, interpreter: '/old/node', hookTarget: '/old/hook.js' })
    await installHook({ cwd: repo, interpreter: '/new/node', hookTarget: '/new/hook.js' })
    const content = await readFile(hookPath(repo), 'utf8')
    assert.ok(content.includes('"/new/node"'))
    assert.ok(!content.includes('/old/'), '旧 launcher 应被替换')
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('isNotegitHook：识别自有 launcher，不误认外来脚本', () => {
  assert.ok(isNotegitHook(hookScriptSource({ interpreter: '/n', hookTarget: '/h' })))
  assert.equal(isNotegitHook('#!/bin/sh\necho mine\n'), false)
  assert.equal(isNotegitHook(''), false)
})

test('installHook：从子目录运行定位仓库根（git rev-parse 语义）', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'notegit-t5-i6-'))
  try {
    await seedRepo(repo)
    await mkdir(path.join(repo, 'sub'))
    await installHook({ cwd: path.join(repo, 'sub'), interpreter: '/n', hookTarget: '/h' })
    assert.ok(existsSync(hookPath(repo)))
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})
