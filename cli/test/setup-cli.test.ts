import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// S6-T6 setup 黑盒层（与 ls/login 同约定）：目标 = dist 产物，真实子进程退出码与输出。
const BIN = new URL('../dist/bin/notegit.js', import.meta.url).pathname

const scratchDirs: string[] = []
let home: string
let repo: string
let env: Record<string, string>

function gitIn(dir: string, gitEnv: Record<string, string>, ...args: string[]): void {
  const r = spawnSync('git', args, { cwd: dir, env: gitEnv, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr}`)
}

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'ngt-setup-'))
  scratchDirs.push(home)
  repo = path.join(home, 'repo')
  mkdirSync(repo, { recursive: true })
  const gitEnv = {
    PATH: process.env['PATH']!,
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  }
  gitIn(repo, gitEnv, 'init', '-b', 'main')
  gitIn(repo, gitEnv, 'config', 'user.name', 't')
  gitIn(repo, gitEnv, 'config', 'user.email', 't@notegit.invalid')
  env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    NOTEGIT_CONFIG_FILE: path.join(home, 'notegit-config'),
    NOTEGIT_CREDENTIALS_FILE: path.join(home, 'credentials'),
    NOTEGIT_LOCAL_ROOT: '',
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  } as Record<string, string>
})

after(() => {
  for (const d of scratchDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

interface RunResult {
  status: number | null
  stdout: string
  stderr: string
}

// 异步 spawn（login.test 教训：同步 spawn 阻塞事件循环）
function runSetup(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, 'setup', ...args], {
      cwd: opts.cwd ?? repo,
      env: { ...env, ...opts.env },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')))
    child.on('error', () => resolve({ status: 2, stdout, stderr }))
    child.on('close', (code) => resolve({ status: code ?? 2, stdout, stderr }))
  })
}

const hookPath = (): string => path.join(repo, '.git', 'hooks', 'pre-commit')
const userHookPath = (): string => path.join(repo, '.git', 'hooks', 'pre-commit.user')

test('setup --help：退出码 0，列出 --chain/--uninstall/--local-root，状态已实现', async () => {
  const r = await runSetup(['--help'])
  assert.equal(r.status, 0)
  assert.match(r.stdout, /notegit setup/)
  for (const flag of ['--chain', '--uninstall', '--local-root']) assert.match(r.stdout, new RegExp(flag))
  assert.match(r.stdout, /已实现/)
  assert.doesNotMatch(r.stdout, /尚未实现/)
})

test('setup（默认安装）：退出码 0，launcher 落盘且指向 dist 分发 hook 本体；重复安装幂等', async () => {
  const r = await runSetup([])
  assert.equal(r.status, 0, `stderr：${r.stderr}`)
  assert.match(r.stdout, /已安装/)
  assert.ok(existsSync(hookPath()), 'pre-commit 应存在')
  const content = readFileSync(hookPath(), 'utf8')
  assert.ok(content.includes('dist'), `launcher 应指向 dist 分发产物：${content}`)
  const again = await runSetup([])
  assert.equal(again.status, 0, '重复安装应幂等成功')
})

test('setup 未知选项：退出码 2，stderr 给出用法指引', async () => {
  const r = await runSetup(['--bogus'])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /未知选项|--help/)
})

test('setup --local-root <路径>：持久化到 CLI 配置；纯 setup 不覆盖既有值；环境变量值也会被持久化', async () => {
  const target = path.join(home, 'mybase')
  let r = await runSetup(['--local-root', target])
  assert.equal(r.status, 0, `stderr：${r.stderr}`)
  assert.match(r.stdout, /本地根目录/)
  assert.equal(readFileSync(env['NOTEGIT_CONFIG_FILE'] as string, 'utf8'), `localRoot=${target}\n`)

  // 再跑一次不带 --local-root：不覆盖既有值
  r = await runSetup([])
  assert.equal(r.status, 0)
  assert.equal(readFileSync(env['NOTEGIT_CONFIG_FILE'] as string, 'utf8'), `localRoot=${target}\n`)

  // 环境变量值持久化：换一个新配置文件验证写入来源是 env
  const cfg2 = path.join(home, 'cfg2')
  r = await runSetup([], { env: { NOTEGIT_CONFIG_FILE: cfg2, NOTEGIT_LOCAL_ROOT: '/env/vaults' } })
  assert.equal(r.status, 0)
  assert.equal(readFileSync(cfg2, 'utf8'), 'localRoot=/env/vaults\n')
})

test('setup --local-root ~/x：展开为 HOME 下的绝对路径', async () => {
  const r = await runSetup(['--local-root', '~/mybase'])
  assert.equal(r.status, 0)
  assert.equal(readFileSync(env['NOTEGIT_CONFIG_FILE'] as string, 'utf8'), `localRoot=${path.join(home, 'mybase')}\n`)
})

test('setup 凭据检查（提示性）：未登录 → 提示 login；已登录未注册 → 提示未注册；已注册 → 报告已注册', async () => {
  // 1) 无凭据文件
  let r = await runSetup([])
  assert.equal(r.status, 0)
  assert.match(r.stdout, /未登录/)

  // 2) 有凭据、无 helper 注册
  writeFileSync(
    env['NOTEGIT_CREDENTIALS_FILE'] as string,
    'protocol=https\nhost=notegit.example.com\nusername=alice\npassword=ngt_x\n',
    { mode: 0o600 },
  )
  r = await runSetup([])
  assert.equal(r.status, 0)
  assert.match(r.stdout, /未注册/)

  // 3) 有凭据、helper 已按 login 注册形态配置（空值重置 + 本 CLI helper）
  writeFileSync(
    env['GIT_CONFIG_GLOBAL'] as string,
    '[credential "https://notegit.example.com"]\n\thelper = \n\thelper = !"/usr/local/bin/notegit" credential\n',
  )
  r = await runSetup([])
  assert.equal(r.status, 0)
  assert.match(r.stdout, /已注册/)
  // 凭据检查是提示性的：不影响安装结果
  assert.ok(existsSync(hookPath()))
})

test('setup（黑盒兼容模式 b）：外来 hook → 退出码 1，stderr 指引 --chain，原 hook 不动', async () => {
  const foreign = '#!/bin/sh\necho user hook\n'
  mkdirSync(path.dirname(hookPath()), { recursive: true })
  writeFileSync(hookPath(), foreign, { mode: 0o755 })
  const r = await runSetup([])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /外来|非 notegit/)
  assert.match(r.stderr, /--chain/)
  assert.equal(readFileSync(hookPath(), 'utf8'), foreign)
  assert.equal(existsSync(userHookPath()), false)
})

test('setup --chain（黑盒）：原 hook 保留为 pre-commit.user；--uninstall 还原且幂等；配置不随卸载删除', async () => {
  const foreign = '#!/bin/sh\necho user hook\n'
  mkdirSync(path.dirname(hookPath()), { recursive: true })
  writeFileSync(hookPath(), foreign, { mode: 0o755 })

  let r = await runSetup(['--chain'])
  assert.equal(r.status, 0, `stderr：${r.stderr}`)
  assert.equal(readFileSync(userHookPath(), 'utf8'), foreign, '原 hook 保留')

  // 顺手持久化一个本地根目录（验证卸载不清理配置）
  r = await runSetup(['--chain', '--local-root', '/keep/me'])
  assert.equal(r.status, 0)

  r = await runSetup(['--uninstall'])
  assert.equal(r.status, 0, `stderr：${r.stderr}`)
  assert.equal(readFileSync(hookPath(), 'utf8'), foreign, '卸载后原 hook 还原回 pre-commit')
  assert.equal(existsSync(userHookPath()), false)
  assert.equal(readFileSync(env['NOTEGIT_CONFIG_FILE'] as string, 'utf8'), 'localRoot=/keep/me\n', '配置独立于 hook，不随卸载删除')

  r = await runSetup(['--uninstall'])
  assert.equal(r.status, 0, '二次卸载幂等')
  assert.equal(readFileSync(hookPath(), 'utf8'), foreign)
})

test('setup 非 git 仓库：退出码 2，stderr 说明', async () => {
  const notRepo = path.join(home, 'plain')
  mkdirSync(notRepo, { recursive: true })
  const r = await runSetup([], { cwd: notRepo })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /工作树/)
})
