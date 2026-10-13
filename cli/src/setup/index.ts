/**
 * notegit setup（S6-T6）：安装/卸载/兼容 pre-commit hook + 本地根目录持久化 + 凭据 helper 提示性检查。
 *
 * 生命周期语义见 hooks.ts（默认拒绝外来 hook / --chain 兼容链 / 卸载还原 / 幂等）。
 * 本文件只做参数解析、输出渲染与 setup 附带面：
 * - --local-root <路径>（缺省取环境变量 NOTEGIT_LOCAL_ROOT）：解析为绝对路径（~ 按当前
 *   HOME 展开）后持久化到 CLI 配置（config.ts）；notegit ls 的本地状态按该根对照。
 * - 凭据 helper 注册检查为提示性（breakdown 任务条款 4）：只报告、不阻断、不代改。
 */
import path from 'node:path'
import os from 'node:os'
import process from 'node:process'
import { installPreCommit, uninstallPreCommit } from './hooks.ts'
import { cliConfigPath, writeCliConfig } from './config.ts'
import { localRootOf } from '../ls/local-status.ts'
import { readCredentials } from '../credentials.ts'
import { runGitText } from '../hooks/git.ts'
import { EXIT_OK, EXIT_ERROR } from '../exit-codes.ts'

function usageError(message: string): number {
  process.stderr.write(`notegit setup: ${message}（notegit setup --help 查看用法）\n`)
  return EXIT_ERROR
}

/** ~ / ~/x 按当前 HOME 展开（壳层引号下用户习惯写法），再解析为绝对路径。 */
function expandTilde(value: string): string {
  if (value === '~') return os.homedir()
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2))
  return path.resolve(value)
}

/** 凭据 helper 注册检查（提示性）：按已存凭据的 protocol+host 核对 login 注册的 helper 键。 */
async function credentialHelperReport(): Promise<string[]> {
  const entries = readCredentials()
  if (entries.length === 0) return ['凭据：未登录（运行 notegit login 登录后，git 推拉可免交互）。']
  const lines: string[] = []
  const seen = new Set<string>()
  for (const e of entries) {
    const scope = `${e.protocol}://${e.host}`
    if (seen.has(scope)) continue
    seen.add(scope)
    const key = `credential.${scope}.helper`
    let registered = false
    try {
      const out = await runGitText(['config', '--global', '--get-all', key])
      registered = out.split('\n').some((v) => v.trim() !== '')
    } catch {
      registered = false // --get-all 在键缺失时退出码 1（同 login.ts 语义）
    }
    lines.push(registered ? `凭据 helper：已注册（${key}）。` : `凭据 helper：未注册（${scope}）——运行 notegit login 重新登录可注册。`)
  }
  return lines
}

/** setup 主流程：解析参数 → hook 安装/卸载 → 本地根目录持久化/提示 → 凭据检查（提示性）。 */
export async function runSetup(args: string[]): Promise<number> {
  let chain = false
  let uninstall = false
  let localRootArg: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === '--chain') chain = true
    else if (arg === '--uninstall') uninstall = true
    else if (arg === '--local-root') {
      const value = args[i + 1]
      if (value === undefined || value === '') return usageError('--local-root 需要一个路径值')
      localRootArg = value
      i++
    } else if (arg.startsWith('-')) {
      return usageError(`未知选项：${arg}`)
    } else {
      return usageError(`多余参数：${arg}`)
    }
  }

  const step = uninstall ? await uninstallPreCommit(process.cwd()) : await installPreCommit(process.cwd(), { chain })
  for (const line of step.stdout) process.stdout.write(`${line}\n`)
  for (const line of step.stderr) process.stderr.write(`${line}\n`)
  if (step.exitCode !== EXIT_OK) return step.exitCode

  // 本地根目录：--local-root 显式 > 环境变量 NOTEGIT_LOCAL_ROOT；两者皆无则只提示当前生效值。
  const envRoot = (process.env['NOTEGIT_LOCAL_ROOT'] ?? '').trim()
  const rootToPersist = localRootArg !== undefined ? expandTilde(localRootArg) : envRoot !== '' ? path.resolve(envRoot) : undefined
  if (rootToPersist !== undefined) {
    writeCliConfig({ localRoot: rootToPersist })
    const source = localRootArg !== undefined ? '--local-root' : '环境变量 NOTEGIT_LOCAL_ROOT'
    process.stdout.write(`本地根目录已保存到 CLI 配置（${cliConfigPath()}，来源 ${source}）：${rootToPersist}\n`)
  } else {
    process.stdout.write(`本地根目录：${localRootOf(process.env)}（notegit ls 按 <根>/<slug> 对照；--local-root 可修改并持久化）\n`)
  }

  for (const line of await credentialHelperReport()) process.stdout.write(`${line}\n`)
  return EXIT_OK
}
