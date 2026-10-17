import type { DatabaseSync } from 'node:sqlite';

/**
 * 审计查询面（S19-T1；api.md §9 契约在册，严格按契约文本）：
 *
 * - 只读零写：本模块不产生任何 audit 行，不经过任何写面。
 * - 行形状 = §9 `{occurred_at, actor_kind, actor, credential_ref, entry,
 *   event_kind, ref_name, old_commit, new_commit, status, detail}`；不增不减
 *   （不含行 id 与库标识——cursor 不透明，客户端无需行锚点）。
 * - actor = 员工展示名（空则回退用户名；activity/query.ts 同源 JOIN employees）；
 *   非 employee 主体（bootstrap/system）actor 如实 null（LEFT JOIN）。
 * - credential_ref 原样透传（DDL 注释契约：仅 credential:<id> / session:<id>
 *   标识，不含任何 token 材料——写侧 guardDetail/CARRIER_REF_PATTERN 已保证）。
 * - detail 优先解析对象；畸形 JSON 原文串如实降级（不崩，activity 面同纪律）。
 * - 排序 occurred_at DESC, id DESC（与 activity 同序）；分页 = keyset 游标
 *   （锚点=页尾行 occurred_at+id，base64url 编码为不透明 cursor；§1 分页语义：
 *   limit 默认 50 上限 200，next_cursor=null 表示结束）。
 * - 过滤全部可选组合：actor（用户名或展示名命中）/ event_kind / status /
 *   since / until（含端点值：>=since 且 <=until）。
 */

/** §1 分页语义：默认 50、上限 200（路由层校验，超出 422 E-RES-007） */
export const AUDIT_LIMIT_DEFAULT = 50;
export const AUDIT_LIMIT_MAX = 200;

export interface AuditQueryFilters {
  readonly actor?: string;
  readonly eventKind?: string;
  readonly status?: string;
  readonly since?: string;
  readonly until?: string;
}

/** 游标锚点（页尾行）：keyset 元组 (occurred_at, id) */
export interface AuditCursorAnchor {
  readonly occurredAt: string;
  readonly id: number;
}

/** 不透明游标编码：base64url(JSON({t, i}))——往返由测试锁定 */
export function encodeAuditCursor(row: { occurred_at: string; id: number | bigint }): string {
  return Buffer.from(JSON.stringify({ t: row.occurred_at, i: Number(row.id) }), 'utf8').toString('base64url');
}

/** 游标解码：任何形态不符（畸形 base64/JSON/类型）→ undefined（路由层 422） */
export function decodeAuditCursor(cursor: string): AuditCursorAnchor | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (parsed !== null && typeof parsed === 'object') {
      const { t, i } = parsed as Record<string, unknown>;
      if (typeof t === 'string' && typeof i === 'number' && Number.isInteger(i)) {
        return { occurredAt: t, id: i };
      }
    }
  } catch {
    // 畸形游标如实拒识
  }
  return undefined;
}

interface AuditRowShape {
  id: number;
  occurred_at: string;
  actor_kind: string;
  actor_username: string | null;
  actor_display: string | null;
  credential_ref: string | null;
  credential_origin: string | null;
  entry: string;
  event_kind: string;
  ref_name: string | null;
  old_commit: string | null;
  new_commit: string | null;
  status: string;
  detail: string;
}

/** detail：解析对象优先；畸形 JSON 原文串如实降级（§9 精神，不崩） */
function detailOf(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** 行 → §9 契约形状（字段不增不减；actor=展示名||用户名，非员工主体如实 null）；
 *  credential_origin = S37 增补：actor 为凭据时其来源（self/admin_delegated），否则 null。 */
function toEvent(row: AuditRowShape): Record<string, unknown> {
  return {
    occurred_at: row.occurred_at,
    actor_kind: row.actor_kind,
    actor: row.actor_display !== null && row.actor_display !== '' ? row.actor_display : row.actor_username,
    credential_ref: row.credential_ref,
    credential_origin: row.credential_origin,
    entry: row.entry,
    event_kind: row.event_kind,
    ref_name: row.ref_name,
    old_commit: row.old_commit,
    new_commit: row.new_commit,
    status: row.status,
    detail: detailOf(row.detail),
  };
}

const SELECT_BASE = `
  SELECT a.id AS id, a.occurred_at AS occurred_at, a.actor_kind AS actor_kind,
         emp.username AS actor_username, emp.display_name AS actor_display,
         a.credential_ref AS credential_ref, a.entry AS entry, a.event_kind AS event_kind,
         a.ref_name AS ref_name, a.old_commit AS old_commit, a.new_commit AS new_commit,
         a.status AS status, a.detail AS detail,
         cred.origin AS credential_origin
  FROM audit_events a
  LEFT JOIN employees emp ON emp.id = a.employee_id
  LEFT JOIN credentials cred ON a.credential_ref = 'credential:' || cred.id`;

export interface AuditPage {
  readonly events: ReturnType<typeof toEvent>[];
  readonly nextCursor: string | null;
}

interface PageQuery {
  /** vault 收窄（slug）；undefined = 实例全域（admin 面） */
  readonly vaultSlug?: string;
  readonly filters: AuditQueryFilters;
  readonly limit: number;
  readonly cursor?: AuditCursorAnchor;
}

function queryAudit(db: DatabaseSync, q: PageQuery): AuditPage {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (q.vaultSlug !== undefined) {
    where.push('a.vault_id = (SELECT id FROM vaults WHERE slug = ?)');
    params.push(q.vaultSlug);
  }
  if (q.filters.actor !== undefined) {
    where.push('(emp.username = ? OR emp.display_name = ?)');
    params.push(q.filters.actor, q.filters.actor);
  }
  if (q.filters.eventKind !== undefined) {
    where.push('a.event_kind = ?');
    params.push(q.filters.eventKind);
  }
  if (q.filters.status !== undefined) {
    where.push('a.status = ?');
    params.push(q.filters.status);
  }
  if (q.filters.since !== undefined) {
    where.push('a.occurred_at >= ?');
    params.push(q.filters.since);
  }
  if (q.filters.until !== undefined) {
    where.push('a.occurred_at <= ?');
    params.push(q.filters.until);
  }
  if (q.cursor !== undefined) {
    where.push('(a.occurred_at < ? OR (a.occurred_at = ? AND a.id < ?))');
    params.push(q.cursor.occurredAt, q.cursor.occurredAt, q.cursor.id);
  }
  const sql = `${SELECT_BASE}
    ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY a.occurred_at DESC, a.id DESC
    LIMIT ?`;
  // 多取一行判定是否还有下一页（页外行不呈现——next_cursor 语义）
  const rows = db.prepare(sql).all(...params, q.limit + 1) as unknown as AuditRowShape[];
  const hasMore = rows.length > q.limit;
  const page = hasMore ? rows.slice(0, q.limit) : rows;
  return {
    events: page.map(toEvent),
    nextCursor: hasMore ? encodeAuditCursor(page[page.length - 1]!) : null,
  };
}

/** 库审计（vault 端点）：路由层门槛判定后按 slug 收窄——只回该库行，越权行零出现 */
export function queryVaultAudit(
  db: DatabaseSync,
  slug: string,
  filters: AuditQueryFilters,
  limit: number,
  cursor?: AuditCursorAnchor,
): AuditPage {
  return queryAudit(db, { vaultSlug: slug, filters, limit, ...(cursor !== undefined ? { cursor } : {}) });
}

/** 实例全域审计（admin 端点）：含实例级事件（vault_id NULL 行）；vault 过滤按 slug（未知 slug → 空态） */
export function queryInstanceAudit(
  db: DatabaseSync,
  filters: AuditQueryFilters,
  limit: number,
  cursor?: AuditCursorAnchor,
  vaultSlug?: string,
): AuditPage {
  return queryAudit(db, {
    ...(vaultSlug !== undefined ? { vaultSlug } : {}),
    filters,
    limit,
    ...(cursor !== undefined ? { cursor } : {}),
  });
}

/** slug→id（架构 §7.2）：token scope 收窄判定用（实例管理员非成员形态）；不在 → undefined */
export function vaultIdBySlug(db: DatabaseSync, slug: string): number | undefined {
  const row = db.prepare('SELECT id FROM vaults WHERE slug = ?').get(slug) as { id: number } | undefined;
  return row?.id;
}
