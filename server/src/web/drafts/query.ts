import type { DatabaseSync } from 'node:sqlite';

/**
 * S12-T2「我的草稿」跨库查询面（sprint S12 D3；G08/DOD-E2-08 跨库列表——
 * research P1-2「草稿只能逐路径撞见」的汇总面）。
 *
 * - 只读 drafts 表（写入面属既有编辑页/§7 端点——src/drafts/ DraftsService
 *   按作者私有存储；本模块零写入、不复制判定逻辑）。
 * - 现行草稿（status='active'）语义与 DraftsService.list 一致：committed 终态
 *   行不列（「私有草稿可恢复」指恢复未发布草稿）。
 * - 跨库按当前员工成员关系过滤：SQL 实时 JOIN vault_members（identity §5.1
 *   第 2 层同一张表——与检索 search/query.ts、最近变更 activity/query.ts 同一
 *   判定面、无缓存，撤权=DELETE 行，下一渲染立即消失）。撤权库的草稿行**不
 *   呈现**（呈现形态裁决：其「继续编辑」链接将 404（D-IC-06 反存在性），呈现
 *   不可达入口不如如实隐藏——草稿数据保留，重新获权后恢复可见；页面标注过滤
 *   口径）。无上限截断：本页是本人现行草稿的唯一汇总入口（截断即不可达），
 *   行数天然受库内路径数约束。
 */

/** 一条本人现行草稿（跨库行：库 slug/name + 草稿路径与更新时间） */
export interface MyDraftRow {
  readonly vaultSlug: string;
  readonly vaultName: string;
  readonly path: string;
  readonly updatedAt: string;
}

/** 跨库列出本人现行草稿（成员关系实时过滤；更新时间新→旧，同刻库 slug/路径稳定排序） */
export function myDraftsAcrossVaults(db: DatabaseSync, employeeId: number): MyDraftRow[] {
  const rows = db
    .prepare(
      `SELECT v.slug AS vault_slug, v.name AS vault_name, d.path AS path, d.updated_at AS updated_at
       FROM drafts d
       JOIN vaults v ON v.id = d.vault_id
       JOIN vault_members m ON m.vault_id = d.vault_id AND m.employee_id = ?
       WHERE d.employee_id = ? AND d.status = 'active'
       ORDER BY d.updated_at DESC, v.slug, d.path`,
    )
    .all(employeeId, employeeId) as unknown as {
    vault_slug: string;
    vault_name: string;
    path: string;
    updated_at: string;
  }[];
  return rows.map((r) => ({
    vaultSlug: r.vault_slug,
    vaultName: r.vault_name,
    path: r.path,
    updatedAt: r.updated_at,
  }));
}
