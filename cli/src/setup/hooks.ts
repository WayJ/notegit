/**
 * setup 的 hook 生命周期核心（S6-T6）：安装（默认拒绝外来 / --chain 兼容链两模式）、
 * 卸载还原、幂等收敛。安装的「无外来 hook」路径直接组合 T5 的 installHook 原语
 * （install.ts：自有→替换、缺目录创建、core.hooksPath 解析）；本文件补齐 T5 明确
 * 留给 T6 的面：外来 hook 的两种兼容处置、pre-commit.user 保管与还原。
 *
 * 兼容模式决策（记录于 .agents/notes/2026-10-13-S6-T6-setup.md）：
 * - 默认 = 模式 b「明确报告冲突拒绝安装」：与 T5 installHook 的保守立场一致（外来→
 *   拒绝且不动原文件），DOD-09「不破坏现有 hook」的最小惊奇路径。
 * - --chain = 模式 a「兼容链」：原 hook 原样（内容+权限）移至 pre-commit.user；
 *   launcher 先调用原 hook 再追加 notegit 校验（追加调用语义：原 hook 改写暂存内容时，
 *   notegit 校验的是最终将被提交的内容）。原 hook 位于 .git/hooks（用户本地配置，
 *   非知识库内容），保留其执行 = 保留用户既有行为，不违 DOD-09「不执行库内脚本」
 *   （该红线指知识库（工作树）内的脚本——launcher 绝不执行工作树内任何路径）。
 * - -x 守卫对齐 git 自身的 hook 激活语义：不可执行的原 hook 安装前就不运行，保留后
 *   也保持休眠；卸载按字节+权限还原，不激活。
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile, chmod, rename, unlink } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { runGitText } from '../hooks/git.ts'
import { installHook, isNotegitHook, HOOK_MARKER, HOOK_NAME } from '../hooks/install.ts'

/** 兼容链模式下原用户 hook 的保管名（卸载时还原回 pre-commit）。 */
export const USER_HOOK_NAME = 'pre-commit.user'

/** 命令步骤结果：退出码 + 输出行（由 index.ts 渲染到 stdout/stderr）。 */
export interface SetupStep {
  exitCode: number
  stdout: string[]
  stderr: string[]
}

export interface InstallPreCommitOptions {
  /** 兼容链模式：外来 hook 保留为 pre-commit.user 并追加 notegit 校验 */
  chain?: boolean
  /** 覆盖解释器路径（测试注入口，语义同 T5 installHook） */
  interpreter?: string
  /** 覆盖 hook 本体路径（测试注入口，语义同 T5 installHook） */
  hookTarget?: string
}

/** hooks 目录解析（与 T5 install.ts 同语义：--git-path hooks 尊重 core.hooksPath；cwd 可为仓库内任意目录）。 */
async function hooksDirOf(cwd: string): Promise<{ hooksDir: string }> {
  const top = (await runGitText(['rev-parse', '--show-toplevel'], { cwd })).trim()
  if (top === '') throw new Error('不在 git 工作树内（rev-parse --show-toplevel 为空）')
  const rel = (await runGitText(['rev-parse', '--git-path', 'hooks'], { cwd: top })).trim()
  return { hooksDir: isAbsolute(rel) ? rel : resolve(top, rel) }
}

/** 默认 hook 本体 = hooks 模块同形态的 pre-commit（源码树 .ts / dist .js，与 T5 defaultHookTarget 同约定）。 */
function defaultHookTarget(): string {
  const self = fileURLToPath(import.meta.url)
  return join(dirname(self), '..', 'hooks', `pre-commit${extname(self)}`)
}

/** 兼容链 launcher：先被保留的原用户 hook（-x 守卫 = git 激活语义），后 notegit 校验；仍是 notegit 自有（含标识）。 */
export function chainScriptSource(opts: { interpreter: string; hookTarget: string; userHookPath: string }): string {
  return [
    '#!/bin/sh',
    `# ${HOOK_MARKER} — 由 notegit 分发；只运行随工具分发的校验程序，不执行本仓库（知识库）内任何脚本。`,
    '# 兼容链（notegit setup --chain）：先运行保留下来的原用户 hook（pre-commit.user），',
    '# 再追加 notegit 校验；任一环节非 0 即阻断。卸载（notegit setup --uninstall）把原 hook 还原回 pre-commit。',
    `if [ -x "${opts.userHookPath}" ]; then`,
    `  "${opts.userHookPath}" "$@" || exit $?`,
    'fi',
    `exec "${opts.interpreter}" "${opts.hookTarget}" "$@"`,
    '',
  ].join('\n')
}

interface HookFacts {
  hooksDir: string
  hookPath: string
  userHookPath: string
  hookExists: boolean
  hookIsOurs: boolean
  userHookExists: boolean
}

async function inspect(cwd: string): Promise<HookFacts> {
  const { hooksDir } = await hooksDirOf(cwd)
  const hookPath = join(hooksDir, HOOK_NAME)
  const userHookPath = join(hooksDir, USER_HOOK_NAME)
  let hookExists = false
  let hookIsOurs = false
  if (existsSync(hookPath)) {
    hookExists = true
    hookIsOurs = isNotegitHook(await readFile(hookPath, 'utf8'))
  }
  return { hooksDir, hookPath, userHookPath, hookExists, hookIsOurs, userHookExists: existsSync(userHookPath) }
}

async function writeExecutable(file: string, source: string): Promise<void> {
  await writeFile(file, source, { mode: 0o755 })
  await chmod(file, 0o755) // 覆盖安装时 writeFile 不改既有 mode，显式确保可执行
}

function notInWorktree(err: unknown): boolean {
  return err instanceof Error && /工作树|not a git repository/i.test(err.message)
}

/** 安装。退出码：0 成功（含幂等重装）；1 明确拒绝（外来 hook 两类冲突）；2 运行错误。 */
export async function installPreCommit(cwd: string, opts: InstallPreCommitOptions = {}): Promise<SetupStep> {
  let facts: HookFacts
  try {
    facts = await inspect(cwd)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      exitCode: 2,
      stdout: [],
      stderr: [notInWorktree(err) ? `notegit setup: 不在 git 工作树内，无法安装（${message}）。请在已克隆的知识库内运行。` : `notegit setup: 解析 hooks 目录失败（${message}）。`],
    }
  }

  // 外来 hook：两种合法处置（breakdown S6-T6 行），默认模式 b 明确拒绝。
  if (facts.hookExists && !facts.hookIsOurs) {
    if (!opts.chain) {
      return {
        exitCode: 1,
        stdout: [],
        stderr: [
          `notegit setup: ${facts.hookPath} 已存在非 notegit 的外来 pre-commit hook，未做任何改动（保留现有 hook）。`,
          '兼容链安装（保留原 hook 并追加 notegit 校验）请加 --chain；或自行处理既有 hook 后重试。',
        ],
      }
    }
    if (facts.userHookExists) {
      return {
        exitCode: 1,
        stdout: [],
        stderr: [
          `notegit setup: 冲突——保留件 ${facts.userHookPath} 已存在，而当前 ${facts.hookPath} 又是外来 hook。`,
          '为避免覆盖此前的原 hook，已拒绝安装；请先运行 notegit setup --uninstall 还原，或手动处理后再试。',
        ],
      }
    }
  }

  const interpreter = opts.interpreter ?? process.execPath
  const hookTarget = opts.hookTarget ?? defaultHookTarget()

  try {
    if (opts.chain) {
      // 兼容链：外来 hook 移交保管（字节+权限原样，rename 保留 inode 元数据）。
      if (facts.hookExists && !facts.hookIsOurs) {
        await rename(facts.hookPath, facts.userHookPath)
      }
      await mkdir(facts.hooksDir, { recursive: true })
      await writeExecutable(facts.hookPath, chainScriptSource({ interpreter, hookTarget, userHookPath: facts.userHookPath }))
      return {
        exitCode: 0,
        stdout: facts.userHookExists || (facts.hookExists && !facts.hookIsOurs)
          ? [`已按兼容链安装 notegit pre-commit hook：${facts.hookPath}`, `原 hook 已原样保留为 ${facts.userHookPath}（先运行原 hook，再追加 notegit 校验）。`]
          : [`已安装 notegit pre-commit hook：${facts.hookPath}`],
        stderr: [],
      }
    }
    // 普通安装（无外来 hook / 重装自有）：组合 T5 原语。
    const { hookPath } = await installHook({ cwd, interpreter: opts.interpreter, hookTarget: opts.hookTarget })
    return { exitCode: 0, stdout: [`已安装 notegit pre-commit hook：${hookPath}`], stderr: [] }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { exitCode: 2, stdout: [], stderr: [`notegit setup: 安装失败（${message}）。`] }
  }
}

/** 卸载还原（幂等）。退出码：0（含无可卸载/外来 hook 不触碰）；2 运行错误。 */
export async function uninstallPreCommit(cwd: string): Promise<SetupStep> {
  let facts: HookFacts
  try {
    facts = await inspect(cwd)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      exitCode: 2,
      stdout: [],
      stderr: [notInWorktree(err) ? `notegit setup: 不在 git 工作树内，无法卸载（${message}）。` : `notegit setup: 解析 hooks 目录失败（${message}）。`],
    }
  }

  try {
    if (!facts.hookExists) {
      if (facts.userHookExists) {
        return {
          exitCode: 0,
          stdout: [`未发现 notegit pre-commit hook；存在孤立保留件 ${facts.userHookPath}（未自动还原，如需请手动移动回 ${facts.hookPath}）。`],
          stderr: [],
        }
      }
      return { exitCode: 0, stdout: ['未发现 notegit pre-commit hook，无需卸载。'], stderr: [] }
    }
    if (!facts.hookIsOurs) {
      return { exitCode: 0, stdout: [`现有 ${facts.hookPath} 非 notegit 安装，未改动。`], stderr: [] }
    }
    if (facts.userHookExists) {
      // 兼容链还原：保留件移回原位（rename 覆盖我们的 launcher，内容/权限原样回归）。
      await rename(facts.userHookPath, facts.hookPath)
      return { exitCode: 0, stdout: [`已卸载 notegit pre-commit hook，原用户 hook 已还原：${facts.hookPath}`], stderr: [] }
    }
    await unlink(facts.hookPath)
    return { exitCode: 0, stdout: [`已卸载 notegit pre-commit hook：${facts.hookPath}（.git/hooks 其余文件未触碰）`], stderr: [] }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { exitCode: 2, stdout: [], stderr: [`notegit setup: 卸载失败（${message}）。`] }
  }
}
