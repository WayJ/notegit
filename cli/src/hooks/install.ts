/** 最小安装面（S6-T5）：把 pre-commit hook 以 launcher 形式装入 .git/hooks/。
 * launcher 只 exec 绝对路径的解释器与随工具分发的 hook 本体（dist 产物），不引用
 * 仓库内任何路径/脚本（validation §1「库内脚本攻击 hook」行的安装侧保证）。
 *
 * 范围边界：完整 setup（卸载还原、外来 hook 兼容链/明确报告两模式、幂等语义收敛、
 * 用户交互）属 S6-T6；本面交付可组合原语——生成 launcher、写入（自有则替换、外来
 * 则拒绝且不动原文件）、缺目录创建。hooks 目录经 `git rev-parse --git-path hooks`
 * 解析（尊重 core.hooksPath 重定位），cwd 可为仓库内任意目录。
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises'
import { isAbsolute, dirname, join, resolve, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { runGitText } from './git.ts'

export const HOOK_NAME = 'pre-commit'

/** launcher 标识注释（重装识别：内容含此标识即视为自有，可原地替换）。 */
export const HOOK_MARKER = 'notegit pre-commit hook'

export interface HookScriptOptions {
  /** 运行 hook 本体的解释器绝对路径（默认安装方进程的 node：process.execPath） */
  interpreter: string
  /** 随工具分发的 hook 本体绝对路径（dist/src/hooks/pre-commit.js） */
  hookTarget: string
}

/** 生成 launcher 脚本内容：仅一处 exec，两个绝对路径参数，无运行时路径推导。 */
export function hookScriptSource(opts: HookScriptOptions): string {
  return [
    '#!/bin/sh',
    `# ${HOOK_MARKER} — 由 notegit 分发；只运行随工具分发的校验程序，不执行本仓库（知识库）内任何脚本。`,
    '# 安装/卸载/兼容：notegit setup（S6-T6）。',
    `exec "${opts.interpreter}" "${opts.hookTarget}" "$@"`,
    '',
  ].join('\n')
}

/** 内容是否为本工具分发的 launcher（重装识别）。 */
export function isNotegitHook(content: string): boolean {
  return content.includes(HOOK_MARKER)
}

export interface InstallOptions {
  /** 仓库内任意目录（默认 process.cwd()） */
  cwd?: string
  /** 覆盖解释器路径（测试/T6 setup 注入） */
  interpreter?: string
  /** 覆盖 hook 本体路径（测试/T6 setup 注入） */
  hookTarget?: string
}

/** 默认 hook 本体 = 本模块同目录同扩展名的 pre-commit（源码树 .ts（Node ≥22.6 类型剥离
 * 直跑）/ dist 产物 .js——import.meta.url 所在形态自动对应）。 */
function defaultHookTarget(): string {
  const self = fileURLToPath(import.meta.url)
  return join(dirname(self), `pre-commit${extname(self)}`)
}

/** 解析仓库 hooks 目录（尊重 core.hooksPath；相对路径以仓库根解析）。 */
async function hooksDirOf(cwd: string): Promise<{ top: string; hooksDir: string }> {
  const top = (await runGitText(['rev-parse', '--show-toplevel'], { cwd })).trim()
  if (top === '') throw new Error('不在 git 工作树内（rev-parse --show-toplevel 为空）')
  const rel = (await runGitText(['rev-parse', '--git-path', 'hooks'], { cwd: top })).trim()
  return { top, hooksDir: isAbsolute(rel) ? rel : resolve(top, rel) }
}

/** 安装（最小面）：外来 hook 存在 → 拒绝且不动原文件；自有/缺失 → 写入可执行 launcher。 */
export async function installHook(opts: InstallOptions = {}): Promise<{ hookPath: string }> {
  const cwd = opts.cwd ?? process.cwd()
  const { hooksDir } = await hooksDirOf(cwd)
  const hookPath = join(hooksDir, HOOK_NAME)

  if (existsSync(hookPath)) {
    const existing = await readFile(hookPath, 'utf8')
    if (!isNotegitHook(existing)) {
      throw new Error(
        `${hookPath} 已存在非 notegit 的 pre-commit hook（保留现有 hook，不覆盖）；` +
          '兼容安装或明确报告冲突请使用 notegit setup（S6-T6）',
      )
    }
  }

  const source = hookScriptSource({
    interpreter: opts.interpreter ?? process.execPath,
    hookTarget: opts.hookTarget ?? defaultHookTarget(),
  })
  await mkdir(hooksDir, { recursive: true })
  await writeFile(hookPath, source, { mode: 0o755 })
  await chmod(hookPath, 0o755) // 覆盖安装时 writeFile 不改既有 mode，显式确保可执行
  return { hookPath }
}
