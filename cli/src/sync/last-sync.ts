/**
 * 上次同步时间标记（S7-T2 本地形状）。
 *
 * 形态：每库一个标记文件 <副本>/.git/notegit-last-sync（ISO 8601 时间串）。
 * 放在 .git 内：不进工作树（不会把副本变脏），单库粒度避免引入全局状态写
 * （锁与全局状态 JSON 属 S7-T4）。
 *
 * 【T4 集成点】S7-T4 状态文件（丢失可重建的缓存 JSON）落地后：读取面
 * readLastSync 改为优先消费 T4 状态文件的 last_sync 字段、本标记作为缺失时的
 * 重建来源；写入面 writeLastSync 与 T4 状态写入合并为同一事务。切换时同步更新
 * 本文件头与 sync-noclobber 测试（不新增第二套并行真相）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** 标记文件路径（导出供测试与 T4 集成时定位）。 */
export function lastSyncMarkerPath(dir: string): string {
  return path.join(dir, '.git', 'notegit-last-sync')
}

/** 读上次同步时间（ISO 串）；无标记/坏内容/不可读 → null（读侧容忍，不抛出）。 */
export function readLastSync(dir: string): string | null {
  try {
    const raw = readFileSync(lastSyncMarkerPath(dir), 'utf8').trim()
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(raw)) return null
    if (Number.isNaN(Date.parse(raw))) return null
    return raw
  } catch {
    return null
  }
}

/** 写上次同步时间（缺省当前时刻）；无 .git 的目录静默跳过（非本工具管理的副本）。 */
export async function writeLastSync(dir: string, when: Date = new Date()): Promise<void> {
  try {
    writeFileSync(lastSyncMarkerPath(dir), `${when.toISOString()}\n`, 'utf8')
  } catch {
    // 目录无 .git（非 git 副本）等——标记写不进去即放弃，不影响同步结果
  }
}
