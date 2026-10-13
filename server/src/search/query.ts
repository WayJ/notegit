import type { DatabaseSync } from 'node:sqlite';

/**
 * 查找查询面（S5-T4；架构 §9「内容搜索基于已发布分支派生索引，按权限过滤」、
 * §4.2「未授权的库不进入列表和搜索结果」）。
 *
 * 实现形态选型（breakdown 第 1 点「SQL LIKE 或等价——规模内不做全文引擎，
 * 选型记录」）：**SQLite LIKE 子串匹配**（ASCII 大小写不敏感——SQLite 内建
 * 语义；CJK 等其他文字精确子串）。用户输入中的 `%`/`_`/`\` 一律转义为字面
 * 字符（ESCAPE '\'），不充当通配符。不引 FTS5/外部全文引擎：当前容量（单
 * 实例、库级千行量级派生表）LIKE 走主键序扫即可；劣化时升级路径为 FTS5
 * 迁移（T5 重建入口同源），不改变授权过滤语义。选型记录随建议稿
 * docs/s1/search-index-amendments.md C3 待 D13 归档。
 *
 * 鉴权过滤（D7：与授权层同一无缓存原则）：查询 SQL 实时 JOIN vault_members
 * （identity §5.1 第 2 层同一张表——成员关系逐请求查库，撤权 = DELETE 行，
 * 下一查询立即消失；不在此建任何权限缓存）。token 载体的 scope 清单非空时
 * 再取交集（identity §3.4，与 GET /api/v1/vaults 同一收窄面）。
 *
 * tags 匹配语义：候选行按 JSON 文本 LIKE 粗筛（与 title/summary 同一模式），
 * 命中字段在应用层按**逐标签**精确复核（跨标签 JSON 边界的子串不算命中），
 * 无字段精确认证的行整行丢弃——粗筛只放大候选集，不产生假阳性结果。
 */

/** 关键词长度上界（路由层校验消费：超长 422 E-RES-007） */
export const SEARCH_MAX_Q_CHARS = 200;
/** 单次结果行数上限（超出行丢弃、truncated=true 如实标注——不承诺分页） */
export const SEARCH_RESULT_LIMIT = 100;

/** 单条命中：库/路径/commit 三要素（S5-T6 引用规范同形）+ 元数据片段 + 命中字段 */
export interface SearchHit {
  readonly vaultSlug: string;
  readonly vaultName: string;
  readonly path: string;
  readonly commitOid: string;
  readonly title: string | null;
  readonly tags: readonly string[];
  readonly summary: string;
  /** 关键词命中的字段（title→tags→summary 固定顺序；至少一项） */
  readonly matched: readonly ('title' | 'tags' | 'summary')[];
}

export interface SearchResult {
  readonly hits: readonly SearchHit[];
  /** 命中超过上限被截断（如实标注，不静默丢弃） */
  readonly truncated: boolean;
}

/** LIKE 模式转义：%/_/\ 一律字面化（ESCAPE '\' 子句配对） */
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** LIKE 的 ASCII 大小写折叠（与 SQLite 内建语义一致——仅 A-Z；其他文字不折叠） */
function foldAscii(input: string): string {
  let out = '';
  for (const ch of input) {
    const code = ch.codePointAt(0)!;
    out += code >= 0x41 && code <= 0x5a ? String.fromCodePoint(code + 0x20) : ch;
  }
  return out;
}

/** 应用层精确认证（与 LIKE 同口径：ASCII 大小写不敏感子串） */
function matches(keyword: string, text: string): boolean {
  return foldAscii(text).includes(foldAscii(keyword));
}

interface CandidateRow {
  slug: string;
  name: string;
  path: string;
  commit_oid: string;
  title: string | null;
  tags: string;
  summary: string;
}

/**
 * 按关键词查找本人有权库的已发布元数据（title/tags/summary 子串）。
 * 每次调用发起全新查库（授权过滤无任何跨调用状态——D-IC-05/D7）。
 * 空/纯空白关键词返回空结果（防御面；路由层另有 400 校验）。
 */
export function searchKeyword(
  db: DatabaseSync,
  employeeId: number,
  keyword: string,
  scopeVaultIds?: readonly number[],
): SearchResult {
  if (keyword.trim() === '') return { hits: [], truncated: false };
  const pattern = `%${escapeLike(keyword)}%`;
  const scopeSql =
    scopeVaultIds !== undefined && scopeVaultIds.length > 0
      ? ` AND i.vault_id IN (${scopeVaultIds.map(() => '?').join(',')})`
      : '';
  const sql =
    `SELECT v.slug AS slug, v.name AS name, i.path AS path, i.commit_oid AS commit_oid,
            i.title AS title, i.tags AS tags, i.summary AS summary
     FROM search_index i
     JOIN vault_members m ON m.vault_id = i.vault_id AND m.employee_id = ?
     JOIN vaults v ON v.id = i.vault_id
     WHERE (i.title LIKE ? ESCAPE '\\' OR i.tags LIKE ? ESCAPE '\\' OR i.summary LIKE ? ESCAPE '\\')${scopeSql}
     ORDER BY v.slug, i.path
     LIMIT ?`;
  const params: (number | string)[] = [
    employeeId,
    pattern,
    pattern,
    pattern,
    ...(scopeSql !== '' ? [...scopeVaultIds!] : []),
    SEARCH_RESULT_LIMIT + 1,
  ];
  const rows = db.prepare(sql).all(...params) as unknown as CandidateRow[];
  const truncated = rows.length > SEARCH_RESULT_LIMIT;
  const hits: SearchHit[] = [];
  for (const row of rows.slice(0, SEARCH_RESULT_LIMIT)) {
    // 命中字段应用层复核（tags 逐标签）：无精确认证的候选行（JSON 文本假阳性）丢弃
    const tags = JSON.parse(row.tags) as string[];
    const matched: ('title' | 'tags' | 'summary')[] = [];
    if (row.title !== null && matches(keyword, row.title)) matched.push('title');
    if (tags.some((tag) => matches(keyword, tag))) matched.push('tags');
    if (matches(keyword, row.summary)) matched.push('summary');
    if (matched.length === 0) continue;
    hits.push({
      vaultSlug: row.slug,
      vaultName: row.name,
      path: row.path,
      commitOid: row.commit_oid,
      title: row.title,
      tags,
      summary: row.summary,
      matched,
    });
  }
  return { hits, truncated };
}
