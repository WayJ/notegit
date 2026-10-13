import { readdir, stat, statfs } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';

/**
 * 磁盘水位面（S8-T2；架构 §10「磁盘容量」、backup §2 四分域）：
 *
 * - **分域用量**：/data 下 git/ db/ config/ keys/ 四分域逐目录递归求和
 *   （与 receive-audit.measureVaultBytes 同口径的「文件字节合计」；本面按分域
 *   聚合整棵 dataDir，不复用 per-repo 计量——粒度不同）。缺失域如实 0；
 *   分域外内容（stray 目录、种子工作区等）不计入。
 * - **容量与水位**：容量/空闲取 dataDir 所在文件系统 statfs（生产单卷四分域
 *   共享一 fs；bind mount 分卷形态下按目录各自 statfs 亦成立——本面逐次对
 *   dataDir 根取值，容器部署即 /data 卷本身）。used_ratio = (blocks−bfree)/blocks，
 *   对 warn(默认 0.80)/critical(默认 0.90) 两档阈值判定；容量不可知 → unknown
 *   不告警（不伪造比值）。阈值可注入（测试缝——磁盘填充测试以微阈值/注入用量
 *   跨阈），生产默认常量。
 *
 * 派生只读面：不写任何状态；扫描失败上抛由路由层如实呈现（metrics/routes.ts）。
 */

/** backup §2 四分域（呈现顺序即此） */
export const DISK_DOMAINS = ['git', 'db', 'config', 'keys'] as const;

export type DiskDomain = (typeof DISK_DOMAINS)[number];

export interface DomainUsage {
  readonly name: DiskDomain;
  readonly usedBytes: number;
}

export interface DiskUsageSnapshot {
  /** dataDir 所在文件系统容量（statfs blocks×bsize；null = 不可知） */
  readonly capacityBytes: number | null;
  readonly freeBytes: number | null;
  readonly domains: readonly DomainUsage[];
}

export interface WatermarkThresholds {
  readonly warn: number;
  readonly critical: number;
}

/** 生产默认阈值（架构 §10 未定数值；80%/90% 两档为运维惯例，选型记录于建议稿） */
export const DEFAULT_WATERMARK_THRESHOLDS: Readonly<WatermarkThresholds> = { warn: 0.8, critical: 0.9 };

export type WatermarkLevel = 'ok' | 'warn' | 'critical' | 'unknown';

export interface WatermarkView {
  readonly used_ratio: number | null;
  readonly level: WatermarkLevel;
  /** true ⇔ level ∈ {warn, critical}（unknown 不告警——缺数据不是告警） */
  readonly alert: boolean;
  readonly warn_ratio: number;
  readonly critical_ratio: number;
}

/** 单目录递归字节合计（符号链接不计入——stat 而非 lstat，与库容量计量同口径） */
async function dirBytes(dir: string): Promise<number> {
  let total = 0;
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0; // 域目录缺失 → 0（未建库/未生成的分域是正常形态）
  }
  for (const entry of entries) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await dirBytes(child);
    } else if (entry.isFile()) {
      total += (await stat(child)).size;
    }
  }
  return total;
}

export async function scanDiskUsage(dataDir: string): Promise<DiskUsageSnapshot> {
  let capacityBytes: number | null = null;
  let freeBytes: number | null = null;
  try {
    const fs = await statfs(dataDir);
    capacityBytes = Number(fs.blocks) * Number(fs.bsize);
    freeBytes = Number(fs.bfree) * Number(fs.bsize);
  } catch {
    // 容量不可知（statfs 不可用）：如实 null，水位层呈现 unknown
  }
  const domains: DomainUsage[] = [];
  for (const name of DISK_DOMAINS) {
    domains.push({ name, usedBytes: await dirBytes(path.join(dataDir, name)) });
  }
  return { capacityBytes, freeBytes, domains };
}

export function evaluateWatermark(
  usage: Pick<DiskUsageSnapshot, 'capacityBytes' | 'freeBytes'>,
  thresholds: WatermarkThresholds = DEFAULT_WATERMARK_THRESHOLDS,
): WatermarkView {
  if (usage.capacityBytes === null || usage.freeBytes === null || usage.capacityBytes <= 0) {
    return {
      used_ratio: null,
      level: 'unknown',
      alert: false,
      warn_ratio: thresholds.warn,
      critical_ratio: thresholds.critical,
    };
  }
  const ratio = Math.max(0, Math.min(1, (usage.capacityBytes - usage.freeBytes) / usage.capacityBytes));
  const level: WatermarkLevel = ratio >= thresholds.critical ? 'critical' : ratio >= thresholds.warn ? 'warn' : 'ok';
  return {
    used_ratio: ratio,
    level,
    alert: level === 'warn' || level === 'critical',
    warn_ratio: thresholds.warn,
    critical_ratio: thresholds.critical,
  };
}
