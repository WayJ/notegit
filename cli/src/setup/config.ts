/**
 * CLI 配置面（S6-T6）：非敏感用户偏好的持久化（当前仅 localRoot）。
 *
 * 形态与凭据文件（credentials.ts）同族：k=v 行、0600 权限、
 * NOTEGIT_CONFIG_FILE > XDG_CONFIG_HOME > ~/.config 解析（便于测试注入与多环境隔离）。
 * 与凭据文件分开存放：凭据是机密（泄漏面扫描对象），配置是可丢弃的偏好。
 * 合并写：保留未知键（向前兼容后续新增配置项）。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/** 配置文件位置：测试覆盖 > XDG_CONFIG_HOME > HOME/.config（与 credentialsFilePath 同族）。 */
export function cliConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['NOTEGIT_CONFIG_FILE']
  if (override && override !== '') return override
  const xdg = env['XDG_CONFIG_HOME']
  const home = env['HOME'] && env['HOME'] !== '' ? env['HOME'] : homedir()
  const base = xdg && xdg !== '' ? xdg : path.join(home, '.config')
  return path.join(base, 'notegit', 'config')
}

/** 读全部配置；文件缺失返回空；坏行（无 =）忽略；值保留原样（含空串，由消费方判空）。 */
export function readCliConfig(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const file = cliConfigPath(env)
  if (!existsSync(file)) return {}
  const out: Record<string, string> = {}
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.trim() === '') continue
    const i = line.indexOf('=')
    if (i <= 0) continue
    out[line.slice(0, i)] = line.slice(i + 1)
  }
  return out
}

/** 合并写：保留既有其他键，覆盖传入键；目录递归创建，文件 0600（防同机其他账户读取路径偏好）。 */
export function writeCliConfig(entries: Record<string, string>, env: NodeJS.ProcessEnv = process.env): void {
  const merged = { ...readCliConfig(env), ...entries }
  const file = cliConfigPath(env)
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const text = Object.entries(merged)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
  writeFileSync(file, `${text}\n`, { mode: 0o600 })
  chmodSync(file, 0o600) // writeFileSync 的 mode 仅创建时生效；显式收紧防历史宽松权限
}
