import type { DatabaseSync } from 'node:sqlite';

/**
 * 最近变更流查询面（S11-T2；sprint S11 D3「派生即审计、零新表」——数据源 =
 * 审计发布事件成功行 vault.push / vault.web_submit，不新增任何存储）。
 *
 * - 事件形状见 server/src/audit/audit.ts 与 storage-model §3.8/§5：行携带
 *   actor（employee_id）、occurred_at、vault_id、ref_name、old/new commit 与
 *   detail（JSON：pushId/rulesVersion/计量值等——**无 commit message 字段**，
 *   identity §8 定位 commit author/committer 为客户端可填元数据，不入审计；
 *   故条目「主题」呈现=分支+入口动作+commit 短码链接，按实际 schema 如实取材）。
 * - 只读审计（本模块不写任何 audit 行）；呈现层无写操作。
 * - 跨库面（首页）按当前员工成员关系过滤：查询 SQL 实时 JOIN vault_members
 *   （identity §5.1 第 2 层同一张表——与检索 search/query.ts 同一判定面、无
 *   缓存，撤权=DELETE 行，下一查询立即消失）。
 * - 排序新→旧（occurred_at DESC，id DESC 决胜插入序）；上限 ACTIVITY_LIMIT
 *   （超出行不呈现——如实标注「最近 N 条」，不承诺分页）。
 */

/** 单次呈现条数上限（首页与库页同值） */
export const ACTIVITY_LIMIT = 20;

/** 一条最近变更（审计成功发布行 + 关联行派生字段） */
export interface ActivityEntry {
  /** 审计行 id（窗口内序稳定锚点） */
  readonly id: number;
  /** 服务端时钟 ISO（架构 §4.4） */
  readonly occurredAt: string;
  /** 操作主体=认证员工（DOD-03——不信 Git 提交元数据） */
  readonly actorUsername: string;
  readonly actorDisplay: string;
  readonly vaultSlug: string;
  readonly vaultName: string;
  /** 入口（identity §8）：web=站内编辑（vault.web_submit）、git=推送（vault.push） */
  readonly entry: 'web' | 'api' | 'git';
  readonly eventKind: 'vault.push' | 'vault.web_submit';
  /** refs/heads/<branch>（审计行原值） */
  readonly refName: string | null;
  readonly newCommit: string | null;
  /** detail 携带路径则生成 view 链接（当前发布面不写路径——条件呈现，有为则链） */
  readonly paths: readonly string[];
}

interface RowShape {
  id: number;
  occurred_at: string;
  actor_username: string;
  actor_display: string;
  vault_slug: string;
  vault_name: string;
  entry: string;
  event_kind: string;
  ref_name: string | null;
  new_commit: string | null;
  detail: string;
}

/** detail 内路径字段提取（paths: string[] / path: string 两形态；无则空） */
function pathsOf(detailText: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(detailText);
  } catch {
    return []; // 畸形 detail 如实降级（不呈现路径链接）
  }
  if (parsed === null || typeof parsed !== 'object') return [];
  const d = parsed as Record<string, unknown>;
  if (Array.isArray(d.paths)) return d.paths.filter((p): p is string => typeof p === 'string');
  if (typeof d.path === 'string') return [d.path];
  return [];
}

/** 行 → 条目（共用装配：JOIN 面差异在 SQL，条目形状一致） */
function toEntry(row: RowShape): ActivityEntry {
  return {
    id: row.id,
    occurredAt: row.occurred_at,
    actorUsername: row.actor_username,
    actorDisplay: row.actor_display,
    vaultSlug: row.vault_slug,
    vaultName: row.vault_name,
    entry: row.entry as ActivityEntry['entry'],
    eventKind: row.event_kind as ActivityEntry['eventKind'],
    refName: row.ref_name,
    newCommit: row.new_commit,
    paths: pathsOf(row.detail),
  };
}

/** 行选择与排序（两查询面共用子句）：仅成功终态发布行，新→旧 */
const SELECT_BASE = `
  SELECT a.id AS id, a.occurred_at AS occurred_at,
         emp.username AS actor_username, emp.display_name AS actor_display,
         v.slug AS vault_slug, v.name AS vault_name,
         a.entry AS entry, a.event_kind AS event_kind,
         a.ref_name AS ref_name, a.new_commit AS new_commit, a.detail AS detail
  FROM audit_events a
  JOIN vaults v ON v.id = a.vault_id
  JOIN employees emp ON emp.id = a.employee_id`;

const PUBLISH_SUCCESS_WHERE = `a.event_kind IN ('vault.push','vault.web_submit') AND a.status = 'succeeded'`;

/**
 * 跨库最近变更（首页区块）：当前员工全部成员库的最近发布，按时间新→旧。
 * 实时 JOIN vault_members 过滤（与检索同一判定面——无权库条目不出现）。
 */
export function recentChangesForEmployee(
  db: DatabaseSync,
  employeeId: number,
  limit: number = ACTIVITY_LIMIT,
): ActivityEntry[] {
  const rows = db
    .prepare(
      `${SELECT_BASE}
       JOIN vault_members m ON m.vault_id = a.vault_id AND m.employee_id = ?
       WHERE ${PUBLISH_SUCCESS_WHERE}
       ORDER BY a.occurred_at DESC, a.id DESC
       LIMIT ?`,
    )
    .all(employeeId, limit) as unknown as RowShape[];
  return rows.map(toEntry);
}

/**
 * 库内最近变更（activity 页）：该库全部最近发布（门槛=read 成员——路由层
 * authorize 判定后调用；本查询不再重复成员过滤，按 vault_id 收窄）。
 */
export function recentChangesForVault(
  db: DatabaseSync,
  vaultId: number,
  limit: number = ACTIVITY_LIMIT,
): ActivityEntry[] {
  const rows = db
    .prepare(
      `${SELECT_BASE}
       WHERE a.vault_id = ? AND ${PUBLISH_SUCCESS_WHERE}
       ORDER BY a.occurred_at DESC, a.id DESC
       LIMIT ?`,
    )
    .all(vaultId, limit) as unknown as RowShape[];
  return rows.map(toEntry);
}
