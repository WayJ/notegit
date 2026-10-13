/**
 * S7-T4 跨进程锁测试夹具：以真实子进程身份对同一状态文件并发写不同 slug。
 * 用法：node state-write-child.ts <root> <slug> <iterations>
 * 退出码 0 = 全部写入成功；非 0 = 写入抛错（stderr 带首错）。
 */
import { writeVaultEntry } from '../src/sync/state.ts'

const [root, slug, iterationsRaw] = process.argv.slice(2) as [string, string, string | undefined]
if (root === undefined || slug === undefined) {
  console.error('用法：state-write-child.ts <root> <slug> <iterations>')
  process.exit(2)
}
const iterations = Number(iterationsRaw ?? '10')
const entry = { head: '2222222222222222222222222222222222222222', last_sync: '2026-10-13T09:00:00.000Z', revoked: false }
try {
  for (let i = 0; i < iterations; i++) {
    await writeVaultEntry(root, slug, entry)
  }
  process.exit(0)
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}
