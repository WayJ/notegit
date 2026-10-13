/**
 * sync 状态文件（S7-T4；架构 §7.3「状态 JSON 只是缓存，丢失后可重建」）。
 *
 * 形态：<root>/.notegit/sync-state.json =
 *   { version: 1, vaults: { [slug]: { head, last_sync, revoked } } }
 *   - head：该库本地副本当前 HEAD（40 位 sha；new 未克隆前无条目）；
 *   - last_sync：上次成功同步时间（ISO 8601；从未成功同步为 null）；
 *   - revoked：撤权标记位（S7-T5 生命周期：fetch 404 的 skipped/revoked 结局
 *     置位 true；其余任何结局（成功或普通跳过）复位 false——库仍在列表即重新
 *     可见即恢复同步资格，identity §5.2 列表实时反映权限；sync clean 消费本位
 *     决定清理范围，清理成功后条目整体移除〔removeVaultEntry〕）。
 *
 * 仅缓存语义（红线）：文件缺失/损坏/未知版本一律折叠为空缓存，本模块读面绝不
 * 因此抛出；删除整个 .notegit 后 sync 以正常全流程重建（黑盒断言见
 * sync-state.test.ts），工作副本无损。
 *
 * 写面：全局状态锁（lock.ts stateLockPath——「全局状态写入分别加锁」）内
 * 读-改-写、tmp+rename 原子落地（读者无锁直读，rename 原子性保证快照一致）。
 * last_sync 与 T2 的 <副本>/.git/notegit-last-sync 标记同源同值：读取面
 * last-sync.ts 优先本文件、标记为缺失时的重建来源；写入面 runSync 以同一
 * syncedAt 写两处（「同一事务」，见 index.ts）。
 */
import { readFileSync } from 'node:fs'
import { mkdir, writeFile, rename } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { randomUUID } from 'node:crypto'
import { stateLockPath, withFileLock } from './lock.ts'
import type { SyncOutcome } from './engine.ts'

export interface VaultStateEntry {
  readonly head: string | null
  readonly last_sync: string | null
  readonly revoked: boolean
}

export interface SyncStateDoc {
  readonly version: 1
  readonly vaults: Readonly<Record<string, VaultStateEntry>>
}

/** 状态文件路径（锁路径 stateLockPath 与之成对，一致性由 sync-state-unit 测试钉死）。 */
export function stateFilePath(root: string): string {
  return path.join(root, '.notegit', 'sync-state.json')
}

function isEntry(v: unknown): v is VaultStateEntry {
  if (typeof v !== 'object' || v === null) return false
  const { head, last_sync, revoked } = v as Record<string, unknown>
  return (
    (typeof head === 'string' || head === null) &&
    (typeof last_sync === 'string' || last_sync === null) &&
    typeof revoked === 'boolean'
  )
}

/** 读状态文档（同步读；缺失/损坏/未知版本/畸形条目 → 空缓存或剔除畸形条目，不抛出）。 */
export function readSyncState(root: string): SyncStateDoc {
  let doc: unknown
  try {
    doc = JSON.parse(readFileSync(stateFilePath(root), 'utf8'))
  } catch {
    return { version: 1, vaults: {} }
  }
  if (typeof doc !== 'object' || doc === null) return { version: 1, vaults: {} }
  const { version, vaults } = doc as Record<string, unknown>
  if (version !== 1 || typeof vaults !== 'object' || vaults === null) return { version: 1, vaults: {} }
  const clean: Record<string, VaultStateEntry> = {}
  for (const [slug, entry] of Object.entries(vaults)) {
    if (isEntry(entry)) clean[slug] = entry
  }
  return { version: 1, vaults: clean }
}

/** 读单个库条目；无条目 → null。 */
export function readVaultState(root: string, slug: string): VaultStateEntry | null {
  return readSyncState(root).vaults[slug] ?? null
}

/** 全局状态锁内读-改-写 + tmp/rename 原子落盘。 */
async function writeMerged(root: string, merge: (doc: SyncStateDoc) => SyncStateDoc): Promise<void> {
  const file = stateFilePath(root)
  await withFileLock(
    stateLockPath(root),
    async () => {
      const next = merge(readSyncState(root))
      await mkdir(path.dirname(file), { recursive: true })
      const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`
      await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
      await rename(tmp, file)
    },
    { timeoutMs: 60_000 },
  )
}

/** 写单库条目（合并不覆盖他库；同 slug 后写胜）。 */
export async function writeVaultEntry(root: string, slug: string, entry: VaultStateEntry): Promise<void> {
  await writeMerged(root, (doc) => ({ version: 1, vaults: { ...doc.vaults, [slug]: entry } }))
}

/** 置/复位撤权标记（S7-T5 消费面）：只动 revoked，保留 head/last_sync；无条目则以占位建立。 */
export async function setRevoked(root: string, slug: string, revoked: boolean): Promise<void> {
  await writeMerged(root, (doc) => {
    const prev = doc.vaults[slug] ?? { head: null, last_sync: null, revoked: false }
    return { version: 1, vaults: { ...doc.vaults, [slug]: { ...prev, revoked } } }
  })
}

/** 移除单库条目（S7-T5：sync clean 清理成功后调用；未知 slug 幂等）。 */
export async function removeVaultEntry(root: string, slug: string): Promise<void> {
  await writeMerged(root, (doc) => {
    const vaults = { ...doc.vaults }
    delete vaults[slug]
    return { version: 1, vaults }
  })
}

/**
 * outcome → 状态条目（纯推导；runSync 据此写入）：
 *   成功三动作 → head=操作后 HEAD、last_sync=本次 syncedAt；
 *   跳过 → head=当前本地 HEAD、last_sync=上次值（跳过不刷新同步时间）；
 *     其中 revoked 跳过（fetch 404）→ 撤权位置位 true（S7-T5）；
 *   失败 → null（不写——保留旧条目，失败库不产生缓存事实）。
 */
export function stateEntryOfOutcome(outcome: SyncOutcome, syncedAt: string): VaultStateEntry | null {
  switch (outcome.action) {
    case 'cloned':
      return { head: outcome.head, last_sync: syncedAt, revoked: false }
    case 'fast_forwarded':
      return { head: outcome.to, last_sync: syncedAt, revoked: false }
    case 'up_to_date':
      return { head: outcome.head, last_sync: syncedAt, revoked: false }
    case 'skipped':
      return { head: outcome.head, last_sync: outcome.last_sync, revoked: outcome.state === 'revoked' }
    case 'failed':
      return null
  }
}
