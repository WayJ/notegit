/** 契约文件定位：docs/contracts/ 相对本模块（仓库内运行时读取；部署期打包随 S8 定稿，见 docs/dev/architecture-notes.md）。 */
import { readFileSync } from 'node:fs'

export const contractsDir = new URL('../../../docs/contracts/', import.meta.url)

const cache = new Map<string, unknown>()

export function readContractJson<T = any>(name: string): T {
  if (!cache.has(name)) {
    cache.set(name, JSON.parse(readFileSync(new URL(name, contractsDir), 'utf8')))
  }
  return cache.get(name) as T
}
