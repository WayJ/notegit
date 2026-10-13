import type { DatabaseSync } from 'node:sqlite';
import type { Issue } from 'notegit-validation';
import { checkFileLimits, validatePathShape } from 'notegit-validation';
import { effectiveConfig } from '../limits/engine.ts';

/**
 * S4-T6 草稿存储服务（api.md §7；storage-model §3.7——迁移 0008 落表）。
 *
 * - **按作者私有**：一切读写以 (vault_id, employee_id, path) 为主键面——他人
 *   草稿在本服务的取数路径上不可达（同事读 = 无自己的现行草稿 = 不存在，
 *   D-IC-06 反存在性同判）。库权限复查在路由层 authorize（identity §5.1
 *   第 2 层，实时查表无缓存——撤权下一请求即拒）。
 * - **现行草稿（active）语义**：status='committed' 的行是「已提交」终态标记
 *   （架构 §6「发布后清理或标为已提交」——取标记路径，行保留可追溯）；列表/
 *   单读/删除只作用于 active 行（「私有草稿可恢复」指恢复未发布草稿）。
 *   同路径再保存把 committed 行重置为 active（UNIQUE(vault_id, employee_id,
 *   path) + upsert——每作者每路径一份，覆盖旧稿）。
 * - **保存不产生 Git 版本**：本模块只写 DB，不经发布组件（正式提交才走
 *   T3 submit 面 submitEditForm → publishWebSubmit；发布成功由 submitEditForm
 *   调 markCommitted 流转状态）。
 * - **保存时校验面（提前反馈，不阻断保存的完整校验属提交链）**：路径形状
 *   （E-PATH-001）+ 草稿全文按 maxDocumentBytes 拒绝（E-LIMIT-001——
 *   storage-model §7「大字段超长控制」；checkFileLimits 的 knowledge 判定，
 *   热配置逐请求读取）。frontmatter 不校验——草稿允许不完整（那是提交链的
 *   事）。issue 交路由层组装 T2 报告（422）。
 * - base_commit 列 NOT NULL：空库（null）以 '' 哨兵存储，读出还原 null。
 */

export interface DraftsServiceOptions {
  readonly db: DatabaseSync;
  /** 时钟注入（测试确定性；缺省真实时钟） */
  readonly now?: () => string;
}

export interface DraftSummary {
  readonly path: string;
  readonly base_commit: string | null;
  readonly updated_at: string;
}

/** §7 单读响应体（content + base_commit + updated_at——无 path，与契约键集一致） */
export interface DraftContent {
  readonly content: string;
  readonly base_commit: string | null;
  readonly updated_at: string;
}

export type PutDraftResult =
  | { readonly kind: 'saved'; readonly updatedAt: string }
  | { readonly kind: 'rejected'; readonly issues: readonly Issue[] };

export class DraftsService {
  readonly #db: DatabaseSync;
  readonly #now: () => string;

  constructor(opts: DraftsServiceOptions) {
    this.#db = opts.db;
    this.#now = opts.now ?? (() => new Date().toISOString());
  }

  /** 保存（upsert 每作者每路径一份现行草稿）；路径/超限拒绝返回 T2 issues（422 面） */
  put(vaultId: number, employeeId: number, path: string, content: string, baseCommit: string | null): PutDraftResult {
    const issues: Issue[] = [
      ...validatePathShape(path),
      ...checkFileLimits(path, Buffer.byteLength(content, 'utf8'), 'knowledge', effectiveConfig({ db: this.#db })),
    ];
    if (issues.length > 0) return { kind: 'rejected', issues };
    const at = this.#now();
    this.#db
      .prepare(
        `INSERT INTO drafts (vault_id, employee_id, path, content, base_commit, status, committed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', NULL, ?, ?)
         ON CONFLICT (vault_id, employee_id, path) DO UPDATE SET
           content = excluded.content,
           base_commit = excluded.base_commit,
           status = 'active',
           committed_at = NULL,
           updated_at = excluded.updated_at`,
      )
      .run(vaultId, employeeId, path, content, baseCommit ?? '', at, at);
    return { kind: 'saved', updatedAt: at };
  }

  /** 单读现行草稿（active）；无自己的现行草稿 = null（他人草稿不可达） */
  get(vaultId: number, employeeId: number, path: string): DraftContent | null {
    const row = this.#db
      .prepare(
        'SELECT content, base_commit, updated_at FROM drafts WHERE vault_id = ? AND employee_id = ? AND path = ? AND status = \'active\'',
      )
      .get(vaultId, employeeId, path) as { content: string; base_commit: string; updated_at: string } | undefined;
    if (row === undefined) return null;
    return { content: row.content, base_commit: row.base_commit === '' ? null : row.base_commit, updated_at: row.updated_at };
  }

  /** 列出本人现行草稿（active；最近更新在前，同刻按路径稳定排序） */
  list(vaultId: number, employeeId: number): readonly DraftSummary[] {
    const rows = this.#db
      .prepare(
        'SELECT path, base_commit, updated_at FROM drafts WHERE vault_id = ? AND employee_id = ? AND status = \'active\' ORDER BY updated_at DESC, path',
      )
      .all(vaultId, employeeId) as { path: string; base_commit: string; updated_at: string }[];
    return rows.map((r) => ({ path: r.path, base_commit: r.base_commit === '' ? null : r.base_commit, updated_at: r.updated_at }));
  }

  /** 删除本人现行草稿（active）；@returns 是否删除了行 */
  delete(vaultId: number, employeeId: number, path: string): boolean {
    const res = this.#db
      .prepare('DELETE FROM drafts WHERE vault_id = ? AND employee_id = ? AND path = ? AND status = \'active\'')
      .run(vaultId, employeeId, path);
    return res.changes > 0;
  }

  /**
   * 发布成功后标记已提交（submitEditForm 消费——T3 submit 面的唯一流转挂点）：
   * 仅提交者本人的现行草稿（按作者私有——他人草稿留待其 base 过时的 T7 冲突面）；
   * 无现行草稿 = no-op（幂等）。slug 入参：submitEditForm 持 slug 不持 vaultId。
   */
  markCommitted(vaultSlug: string, employeeId: number, path: string, at?: string): void {
    const vault = this.#db.prepare('SELECT id FROM vaults WHERE slug = ?').get(vaultSlug) as { id: number } | undefined;
    if (vault === undefined) return; // 库已不存在（删除竞态）——无可标记
    this.#db
      .prepare(
        'UPDATE drafts SET status = \'committed\', committed_at = ? WHERE vault_id = ? AND employee_id = ? AND path = ? AND status = \'active\'',
      )
      .run(at ?? this.#now(), vault.id, employeeId, path);
  }
}
