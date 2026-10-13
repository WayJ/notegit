import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, rm, mkdir, writeFile, readFile, stat, chmod } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { installPreCommit, uninstallPreCommit } from '../src/setup/hooks.ts'
import { isNotegitHook, HOOK_MARKER } from '../src/hooks/install.ts'

// S6-T6 setup 生命周期（breakdown §2.5 S6-T6 行）：安装组合 T5 installHook、外来 hook
// 兼容两模式（默认明确拒绝 / --chain 兼容链）、卸载还原 .git/hooks 原状、重复安装幂等。
// 进程内测试直接打 src/setup（黑盒 CLI 层在 setup-cli.test.ts）。
const CLI_DIR = fileURLToPath(new URL('..', import.meta.url))
const HOOK_SRC = path.join(CLI_DIR, 'src', 'hooks', 'pre-commit.ts')
const HOOK_DIST = path.join(CLI_DIR, 'dist', 'src', 'hooks', 'pre-commit.js')

// 隔离 git 全局/系统配置（core.hooksPath 等不干扰 hooks 目录解析；src/setup 内部 git 继承本进程 env）
process.env.GIT_CONFIG_GLOBAL = '/dev/null'
process.env.GIT_CONFIG_NOSYSTEM = '1'
process.env.GIT_TERMINAL_PROMPT = '0'

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

const hookPath = (repo: string): string => path.join(repo, '.git', 'hooks', 'pre-commit')
const userHookPath = (repo: string): string => path.join(repo, '.git', 'hooks', 'pre-commit.user')

const FOREIGN_HOOK = '#!/bin/sh\necho ran >> ./USER-RAN\n'
const VALID_DOC = '---\ntitle: 差旅报销制度\nowner: zhangsan\n---\n\n# 差旅报销制度\n'
const INVALID_DOC = '# 没有 frontmatter 的知识文档\n'

async function plantForeignHook(repo: string, content = FOREIGN_HOOK, mode = 0o755): Promise<void> {
  await mkdir(path.dirname(hookPath(repo)), { recursive: true })
  await writeFile(hookPath(repo), content, { mode })
  await chmod(hookPath(repo), mode)
}

function commit(repo: string): { status: number | null; out: string } {
  const r = spawnSync('git', ['commit', '-m', 't'], { cwd: repo, env: GIT_ENV, encoding: 'utf8' })
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` }
}

// ---------- 安装（默认模式） ----------

test('setup 安装（默认）：写入可执行 launcher（组合 T5 原语，指向默认 hook 本体）', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'notegit-t6-u1-'))
  try {
    await seedRepo(repo)
    const r = await installPreCommit(repo)
    assert.equal(r.exitCode, 0, `应成功：${r.stderr.join('\n')}`)
    assert.ok(r.stdout.some((l) => /已安装/.test(l) && l.includes(hookPath(repo))), 'stdout 应报告安装与路径')
    const st = await stat(hookPath(repo))
    assert.equal(st.mode & 0o111, 0o111, 'launcher 应可执行')
    const content = await readFile(hookPath(repo), 'utf8')
    assert.ok(isNotegitHook(content), '含 notegit 标识')
    assert.ok(content.includes(HOOK_SRC), `默认指向工具分发 hook 本体：${content}`)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('setup 安装幂等：重复安装内容不变（同 interpreter/hookTarget）', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'notegit-t6-u2-'))
  try {
    await seedRepo(repo)
    const first = await installPreCommit(repo, { interpreter: process.execPath, hookTarget: HOOK_DIST })
    assert.equal(first.exitCode, 0)
    const before = await readFile(hookPath(repo), 'utf8')
    const second = await installPreCommit(repo, { interpreter: process.execPath, hookTarget: HOOK_DIST })
    assert.equal(second.exitCode, 0, `重复安装应幂等成功：${second.stderr.join('\n')}`)
    assert.equal(await readFile(hookPath(repo), 'utf8'), before, '重复安装不应改变 launcher 内容')
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

// ---------- 兼容模式 b：默认明确报告冲突拒绝安装 ----------

test('兼容模式 b（默认）：已有外来 pre-commit → 拒绝安装并明确报告，原文件一字节不动', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'notegit-t6-u3-'))
  try {
    await seedRepo(repo)
    await plantForeignHook(repo)
    const before = await readFile(hookPath(repo), 'utf8')
    const beforeStat = await stat(hookPath(repo))

    const r = await installPreCommit(repo)
    assert.equal(r.exitCode, 1, '拒绝安装应是业务失败（退出码 1），不是崩溃')
    assert.ok(r.stderr.some((l) => /外来|非 notegit/.test(l)), '应说明存在外来 hook')
    assert.ok(r.stderr.some((l) => l.includes('--chain')), '应给出 --chain 兼容链指引')
    assert.equal(await readFile(hookPath(repo), 'utf8'), before, '原 hook 内容不动')
    assert.equal((await stat(hookPath(repo))).mode, beforeStat.mode, '原 hook 权限不动')
    assert.equal(existsSync(userHookPath(repo)), false, '拒绝时不应产生 pre-commit.user')
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

// ---------- 兼容模式 a：--chain 兼容链 ----------

test('兼容模式 a（--chain）：原 hook 保留为 pre-commit.user（内容与权限原样），launcher 先链原 hook 再跑 notegit 校验', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'notegit-t6-u4-'))
  try {
    await seedRepo(repo)
    await plantForeignHook(repo)
    const r = await installPreCommit(repo, { chain: true, interpreter: process.execPath, hookTarget: HOOK_DIST })
    assert.equal(r.exitCode, 0, `应成功：${r.stderr.join('\n')}`)
    assert.ok(r.stdout.some((l) => /兼容链/.test(l)), 'stdout 应说明按兼容链安装')

    // 原用户 hook：内容与权限原样保留在 pre-commit.user
    assert.equal(await readFile(userHookPath(repo), 'utf8'), FOREIGN_HOOK, '原 hook 内容原样保留')
    assert.equal((await stat(userHookPath(repo))).mode & 0o111, 0o111, '原 hook 可执行位保留')

    // launcher：notegit 标识 + 先原 hook（-x 守卫，git 自身激活语义）后 notegit 校验（exec 最后）
    // （git 返回的是物理路径，macOS tmpdir 逻辑路径 /var ≠ /private/var，按 realpath 比较——T5 同款）
    const content = await readFile(hookPath(repo), 'utf8')
    const physicalUserHook = realpathSync(userHookPath(repo))
    assert.ok(isNotegitHook(content), '兼容链 launcher 也是 notegit 自有（重装/卸载识别）')
    assert.ok(content.includes(HOOK_MARKER))
    assert.ok(content.includes(`-x "${physicalUserHook}"`), `应以 -x 守卫引用原 hook：${content}`)
    const guardIdx = content.indexOf('if [ -x')
    const execIdx = content.indexOf('exec "')
    assert.ok(guardIdx >= 0 && execIdx > guardIdx, '原 hook 调用应在 notegit 校验之前（追加调用）')
    assert.ok(content.includes(`"${process.execPath}"`), '解释器绝对路径')
    assert.ok(content.includes(`"${HOOK_DIST}"`), 'hook 本体绝对路径')
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('--chain 重复安装幂等：不二次包裹，pre-commit.user 与 launcher 内容均不变', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'notegit-t6-u5-'))
  try {
    await seedRepo(repo)
    await plantForeignHook(repo)
    await installPreCommit(repo, { chain: true, interpreter: process.execPath, hookTarget: HOOK_DIST })
    const beforeUser = await readFile(userHookPath(repo), 'utf8')
    const beforeLauncher = await readFile(hookPath(repo), 'utf8')

    const r = await installPreCommit(repo, { chain: true, interpreter: process.execPath, hookTarget: HOOK_DIST })
    assert.equal(r.exitCode, 0, `重复 --chain 应幂等成功：${r.stderr.join('\n')}`)
    assert.equal(await readFile(userHookPath(repo), 'utf8'), beforeUser, '原 hook 保留件不被二次包裹/改写')
    assert.equal(await readFile(hookPath(repo), 'utf8'), beforeLauncher, 'launcher 内容稳定')
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('--chain 冲突防护：pre-commit.user 已存在且当前 pre-commit 为外来 → 拒绝且两者都不动', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'notegit-t6-u6-'))
  try {
    await seedRepo(repo)
    await plantForeignHook(repo, '#!/bin/sh\necho first user hook\n')
    await installPreCommit(repo, { chain: true, interpreter: process.execPath, hookTarget: HOOK_DIST })
    // 用户此后用自己的新 hook 覆盖了我们的 launcher（当前 pre-commit 又变外来）
    await plantForeignHook(repo, '#!/bin/sh\necho second user hook\n')

    const r = await installPreCommit(repo, { chain: true, interpreter: process.execPath, hookTarget: HOOK_DIST })
    assert.equal(r.exitCode, 1, '应拒绝而非覆盖已有保留件')
    assert.ok(r.stderr.some((l) => l.includes('pre-commit.user')), '应指名冲突对象')
    assert.equal(await readFile(userHookPath(repo), 'utf8'), '#!/bin/sh\necho first user hook\n', '保留件不动')
    assert.equal(await readFile(hookPath(repo), 'utf8'), '#!/bin/sh\necho second user hook\n', '当前外来 hook 不动')
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('--chain 遇不可执行的外来 hook：保留但不激活（git 对非可执行 hook 本就不运行）', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'notegit-t6-u7-'))
  try {
    await seedRepo(repo)
    await plantForeignHook(repo, FOREIGN_HOOK, 0o644)
    const r = await installPreCommit(repo, { chain: true, interpreter: process.execPath, hookTarget: HOOK_DIST })
    assert.equal(r.exitCode, 0)
    assert.equal((await stat(userHookPath(repo))).mode & 0o111, 0, '非可执行位原样保留')
    // 真实提交：有效内容放行，且用户 hook 未被激活（未写 USER-RAN）
    await writeFile(path.join(repo, 'ok.md'), VALID_DOC)
    git(repo, 'add', 'ok.md')
    const { status, out } = commit(repo)
    assert.equal(status, 0, `有效内容应放行，输出：${out}`)
    assert.equal(existsSync(path.join(repo, 'USER-RAN')), false, '不可执行原 hook 应保持休眠（与安装前一致）')
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('--chain 在无外来 hook 时退化为普通安装（不产生 pre-commit.user）', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'notegit-t6-u8-'))
  try {
    await seedRepo(repo)
    const r = await installPreCommit(repo, { chain: true, interpreter: process.execPath, hookTarget: HOOK_DIST })
    assert.equal(r.exitCode, 0)
    assert.ok(existsSync(hookPath(repo)), '应安装 launcher')
    assert.equal(existsSync(userHookPath(repo)), false, '无外来 hook 不产生保留件')
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

// ---------- 端到端：兼容链安装 → 提交 → 卸载还原 ----------

test('e2e 兼容链：有效提交原 hook 与 notegit 校验都运行；无效提交被 notegit 阻断', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'notegit-t6-u9-'))
  try {
    await seedRepo(repo)
    await plantForeignHook(repo)
    const r = await installPreCommit(repo, { chain: true, interpreter: process.execPath, hookTarget: HOOK_DIST })
    assert.equal(r.exitCode, 0)

    await writeFile(path.join(repo, 'ok.md'), VALID_DOC)
    git(repo, 'add', 'ok.md')
    let c = commit(repo)
    assert.equal(c.status, 0, `有效内容应放行，输出：${c.out}`)
    assert.ok(existsSync(path.join(repo, 'USER-RAN')), '原用户 hook 在兼容链下继续运行')

    await writeFile(path.join(repo, 'bad.md'), INVALID_DOC)
    git(repo, 'add', 'bad.md')
    c = commit(repo)
    assert.notEqual(c.status, 0, '无效内容提交应被阻断')
    assert.match(c.out, /E-FM-001/, '阻断来自 notegit 校验')
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

// ---------- 卸载：还原 ----------

test('卸载（普通安装）：移除 launcher，.git/hooks 其余文件不受影响，二次卸载幂等', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'notegit-t6-u10-'))
  try {
    await seedRepo(repo)
    // 用户既有的其他 hook（非 notegit 面）：卸载不得触碰
    await writeFile(path.join(repo, '.git', 'hooks', 'post-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    await writeFile(path.join(repo, '.git', 'hooks', 'pre-push'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    await installPreCommit(repo)
    assert.ok(existsSync(hookPath(repo)))

    const r = await uninstallPreCommit(repo)
    assert.equal(r.exitCode, 0)
    assert.ok(r.stdout.some((l) => /已卸载|还原/.test(l)), '应报告卸载')
    assert.equal(existsSync(hookPath(repo)), false, 'notegit launcher 应被移除')
    assert.equal(await readFile(path.join(repo, '.git', 'hooks', 'post-commit'), 'utf8'), '#!/bin/sh\nexit 0\n')
    assert.equal(await readFile(path.join(repo, '.git', 'hooks', 'pre-push'), 'utf8'), '#!/bin/sh\nexit 0\n')

    const again = await uninstallPreCommit(repo)
    assert.equal(again.exitCode, 0, '二次卸载应幂等成功')
    assert.ok(again.stdout.some((l) => /未发现|无需/.test(l)), '应说明本就没有 notegit hook')
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('卸载（兼容链）：原 hook 还原回 pre-commit（内容/权限/可运行），保留件消失', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'notegit-t6-u11-'))
  try {
    await seedRepo(repo)
    await plantForeignHook(repo)
    await installPreCommit(repo, { chain: true, interpreter: process.execPath, hookTarget: HOOK_DIST })
    assert.ok(existsSync(userHookPath(repo)))

    const r = await uninstallPreCommit(repo)
    assert.equal(r.exitCode, 0)
    assert.ok(r.stdout.some((l) => /还原/.test(l)), '应报告还原原 hook')
    assert.equal(existsSync(userHookPath(repo)), false, '保留件应消失')
    assert.equal(await readFile(hookPath(repo), 'utf8'), FOREIGN_HOOK, '原 hook 内容还原')
    assert.equal((await stat(hookPath(repo))).mode & 0o111, 0o111, '可执行位还原')

    // 还原后：原用户 hook 独立继续工作（空提交也走 pre-commit，隔离验证原 hook 运行）
    const marker = path.join(repo, 'USER-RAN')
    await rm(marker, { force: true })
    const empty = spawnSync('git', ['commit', '--allow-empty', '-m', 't2'], { cwd: repo, env: GIT_ENV, encoding: 'utf8' })
    assert.equal(empty.status, 0, `空提交应放行，输出：${empty.stdout}\n${empty.stderr}`)
    assert.ok(existsSync(marker), '卸载后原用户 hook 继续运行')

    // 且 notegit 校验已不在：无效内容提交成功（证明 hook 被还原而非残留）
    await writeFile(path.join(repo, 'bad.md'), INVALID_DOC)
    git(repo, 'add', 'bad.md')
    const c2 = commit(repo)
    assert.equal(c2.status, 0, `notegit 校验应已移除，输出：${c2.out}`)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('卸载遇外来 hook：不动它，退出码 0（无 notegit hook 可卸）', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'notegit-t6-u12-'))
  try {
    await seedRepo(repo)
    await plantForeignHook(repo)
    const r = await uninstallPreCommit(repo)
    assert.equal(r.exitCode, 0, '没有 notegit hook 时卸载应为幂等成功')
    assert.ok(r.stdout.some((l) => /非 notegit|未改动/.test(l)), '应说明外来 hook 未被触碰')
    assert.equal(await readFile(hookPath(repo), 'utf8'), FOREIGN_HOOK, '外来 hook 不动')
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('卸载遇孤立保留件（无 notegit hook 但 pre-commit.user 存在）：只提示不自动还原', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'notegit-t6-u13-'))
  try {
    await seedRepo(repo)
    await plantForeignHook(repo)
    await installPreCommit(repo, { chain: true, interpreter: process.execPath, hookTarget: HOOK_DIST })
    // 用户手动删了我们的 launcher，保留件还在
    await rm(hookPath(repo))
    const r = await uninstallPreCommit(repo)
    assert.equal(r.exitCode, 0)
    assert.ok(r.stdout.some((l) => l.includes('pre-commit.user')), '应提示孤立保留件')
    assert.equal(existsSync(userHookPath(repo)), true, '不应擅自移动保留件')
    assert.equal(existsSync(hookPath(repo)), false, '不应擅自安装还原')
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

// ---------- 解析与运行错误 ----------

test('非 git 仓库：退出码 2，stderr 说明不在工作树内', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'notegit-t6-u14-'))
  try {
    const r = await installPreCommit(dir)
    assert.equal(r.exitCode, 2)
    assert.ok(r.stderr.some((l) => /工作树/.test(l)))
    const u = await uninstallPreCommit(dir)
    assert.equal(u.exitCode, 2)
    assert.ok(u.stderr.some((l) => /工作树/.test(l)))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('从仓库子目录运行：定位仓库根安装（rev-parse 语义）', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'notegit-t6-u15-'))
  try {
    await seedRepo(repo)
    await mkdir(path.join(repo, 'sub'))
    const r = await installPreCommit(path.join(repo, 'sub'))
    assert.equal(r.exitCode, 0)
    assert.ok(existsSync(hookPath(repo)), '应装入仓库根 .git/hooks')
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('core.hooksPath 重定位：经 rev-parse --git-path hooks 解析（尊重用户 hooks 目录配置）', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'notegit-t6-u16-'))
  try {
    await seedRepo(repo)
    git(repo, 'config', 'core.hooksPath', '.githooks')
    const r = await installPreCommit(repo)
    assert.equal(r.exitCode, 0, `应成功：${r.stderr.join('\n')}`)
    assert.ok(existsSync(path.join(repo, '.githooks', 'pre-commit')), '应装入 core.hooksPath 指定目录')
    assert.equal(existsSync(hookPath(repo)), false, '不应写入默认 .git/hooks')
    const u = await uninstallPreCommit(repo)
    assert.equal(u.exitCode, 0)
    assert.equal(existsSync(path.join(repo, '.githooks', 'pre-commit')), false, '卸载应还原该目录')
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})
