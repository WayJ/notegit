/**
 * 上次同步时间：读取面与 .git 标记写面（S7-T2 引入；S7-T4 集成切换完成）。
 *
 * 【T4 集成后形态】单一真相同源双写：
 *   - 真相源：S7-T4 状态文件 <root>/.notegit/sync-state.json 的 last_sync 字段
 *     （见 state.ts；仅缓存，丢失可重建）；
 *   - 重建来源：<副本>/.git/notegit-last-sync（ISO 8601 单行）——放在 .git 内
 *     不进工作树、单库粒度；状态文件缺失/无条目时由此回退（缓存删除后不丢
 *     last_sync）；
 *   - 写面：runSync 以同一 syncedAt 同事务写两处（state.ts 的记录路径 +
 *     本模块 writeLastSync）——不新增第二套并行真相。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { readVaultState } from './state.ts'

/** 标记文件路径（导出供测试与诊断定位）。 */
export function lastSyncMarkerPath(dir: string): string {
  return path.join(dir, '.git', 'notegit-last-sync')
}

function validIsoOrNull(raw: string): string | null {
  const trimmed = raw.trim()
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(trimmed)) return null
  if (Number.isNaN(Date.parse(trimmed))) return null
  return trimmed
}

/**
 * 读上次同步时间（ISO 串）：状态文件条目优先，.git 标记回退（重建来源）；
 * dir=null（无副本）/两处皆无/坏内容 → null（读侧容忍，不抛出）。
 */
export function readLastSync(root: string, dir: string | null): string | null {
  if (dir === null) return null
  const entry = readVaultState(root, path.basename(dir))
  if (entry !== null) return entry.last_sync
  try {
    return validIsoOrNull(readFileSync(lastSyncMarkerPath(dir), 'utf8'))
  } catch {
    return null
  }
}

/** 写 .git 标记（缺省当前时刻）；无 .git 的目录静默跳过（非本工具管理的副本）。 */
export async function writeLastSync(dir: string, when: Date = new Date()): Promise<void> {
  try {
    writeFileSync(lastSyncMarkerPath(dir), `${when.toISOString()}\n`, 'utf8')
  } catch {
    // 目录无 .git（非 git 副本）等——标记写不进去即放弃，不影响同步结果
  }
}
