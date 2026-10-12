import type { DatabaseSync } from 'node:sqlite';
import type { VaultRepoOps } from '../gitrepo/lifecycle.ts';
import type { VaultRole } from '../auth/lifecycle.ts';
import { ApiError } from '../credentials/service.ts';

/**
 * 库与成员域服务（api.md §5 端点行为；storage-model §3.5/§3.6 落库形态）。
 *
 * 权限判定不经本类：路由经共用 authorize（auth/lifecycle.ts + vaults/membership.ts）
 * 完成 404/403 语义后调用本类做数据操作；列表类查询以成员关系 JOIN 收窄
 * （架构 §4.2「未授权的库不进入列表」）。写路径 BEGIN IMMEDIATE（storage-model §1）。
 * 审计：vault.create / vault.update / member.grant / member.revoke 直接终态
 * （storage-model §5 注册表），主体 = 认证员工（identity §8，不信任 commit author）。
 */

/** slug 字符集（api.md §5：小写字母/数字/`-`，长度 1–64；应用层校验） */
const SLUG_PATTERN = /^[a-z0-9-]{1,64}$/;

export interface VaultActor {
  /** 认证员工（identity §8 审计主体） */
  readonly employeeId: number;
  /** 入口归因（web=会话载体 / api=token 载体） */
  readonly entry: 'web' | 'api';
  /** 载体标识（session:<id> / credential:<id>，不含凭据材料） */
  readonly carrierRef: string;
}

export interface VaultPublic {
  id: number;
  slug: string;
  name: string;
  default_branch: string;
  main_admin_only: boolean;
}

export interface VaultListItem {
  slug: string;
  name: string;
  role: 'reader' | 'editor' | 'admin';
  default_branch: string;
  main_admin_only: boolean;
}

export interface MemberPublic {
  username: string;
  display_name: string;
  role: 'reader' | 'editor' | 'admin';
  granted_at: string;
}

interface VaultRow {
  id: number;
  slug: string;
  name: string;
  default_branch: string;
  main_admin_only: number;
}

const ROLES: readonly VaultRole[] = ['reader', 'editor', 'admin'];

function validateSlug(input: unknown): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new ApiError(400, 'E-RES-004', '请求形态错误：slug 必填且为非空字符串');
  }
  if (!SLUG_PATTERN.test(input)) {
    throw new ApiError(422, 'E-RES-007', '参数语义不符：slug 须为小写字母/数字/-，长度 1–64');
  }
  return input;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

export class VaultService {
  private readonly db: DatabaseSync;
  private readonly now: () => string;
  private readonly repoOps: VaultRepoOps | undefined;

  constructor(config: { db: DatabaseSync; now?: () => string; repoOps?: VaultRepoOps }) {
    this.db = config.db;
    this.now = config.now ?? (() => new Date().toISOString());
    this.repoOps = config.repoOps;
  }

  /**
   * 建库（api.md §5 POST /vaults）：任意 active 员工可建（active 由认证层逐请求
   * 保证）；新库默认私有，创建者自动成为库管理员（架构 §4.2）。vaults 行 +
   * 创建者 vault_members(admin) 行同一事务；slug 冲突 → 409 E-RES-002。
   * 纯 DB 部分（S2-T6 形态）；bare 仓库初始化经 createVaultWithRepo 挂接（S3-T1）。
   */
  createVault(
    input: { name?: unknown; slug?: unknown },
    actor: VaultActor,
  ): VaultPublic & { role: 'admin' } {
    if (typeof input.name !== 'string' || input.name.length === 0) {
      throw new ApiError(400, 'E-RES-004', '请求形态错误：name 必填且为非空字符串');
    }
    const slug = validateSlug(input.slug);
    const createdAt = this.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const info = this.db
        .prepare(
          `INSERT INTO vaults (slug, name, default_branch, main_admin_only, created_by, created_at)
           VALUES (?, ?, 'main', 0, ?, ?)`,
        )
        .run(slug, input.name, actor.employeeId, createdAt);
      const id = Number(info.lastInsertRowid);
      this.db
        .prepare(`INSERT INTO vault_members (vault_id, employee_id, role, granted_by, granted_at) VALUES (?, ?, 'admin', ?, ?)`)
        .run(id, actor.employeeId, actor.employeeId, createdAt);
      this.audit(actor, 'vault.create', id, { slug, name: input.name });
      this.db.exec('COMMIT');
      return { id, slug, name: input.name, default_branch: 'main', main_admin_only: false, role: 'admin' };
    } catch (err) {
      this.db.exec('ROLLBACK');
      if (isUniqueViolation(err)) {
        throw new ApiError(409, 'E-RES-002', '资源标识已占用：vault slug');
      }
      throw err;
    }
  }

  /**
   * 建库 + bare 仓库初始化（S3-T1；api.md §5「创建 vaults 行 + 成员行 + bare
   * 仓库 /data/git/<id>.git」）。行事务先行（稳定 ID 是路径的唯一来源），提交后
   * 异步 init bare；init 失败 → **补偿事务回滚全部行**（无孤儿配置行，backup §5
   * 不变量 3 的行侧）并放大错误。未注入 repoOps 时退化为纯建行（S2 测试形态）。
   */
  async createVaultWithRepo(
    input: { name?: unknown; slug?: unknown },
    actor: VaultActor,
  ): Promise<VaultPublic & { role: 'admin' }> {
    const vault = this.createVault(input, actor);
    if (!this.repoOps) return vault;
    try {
      await this.repoOps.initBare(vault.id);
    } catch (err) {
      // 补偿：先尽力清除半成品目录（无孤儿仓库），再回滚全部行（无孤儿配置行）。
      // 目录清除尽力而为——失败不掩盖原始错误，残留由一致性核对/reconcile 处置。
      try {
        await this.repoOps.remove(vault.id);
      } catch {
        // 补偿的补偿：保持原始错误优先
      }
      this.undoVaultCreate(vault.id);
      throw err;
    }
    return vault;
  }

  /** 建库补偿：init bare 失败时撤销本次建库全部行（含 vault.create 审计行——操作未成立不留成功记录） */
  private undoVaultCreate(vaultId: number): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`DELETE FROM audit_events WHERE vault_id = ?`).run(vaultId);
      this.db.prepare(`DELETE FROM vault_members WHERE vault_id = ?`).run(vaultId);
      this.db.prepare(`DELETE FROM vaults WHERE id = ?`).run(vaultId);
      this.db.exec('COMMIT');
    } catch (compErr) {
      this.db.exec('ROLLBACK');
      // 补偿失败：行侧孤儿暴露为「缺失目录」——reconcileOrphanRepos/verifyStore
      // 一致性核对可观测；此处只放大，不掩盖。
      throw compErr;
    }
  }

  /** 员工可见列表：仅成员关系的库（架构 §4.2）；token scope 清单非空时再取交集（identity §3.4） */
  listVaults(employeeId: number, scopeVaultIds?: readonly number[]): VaultListItem[] {
    const rows = this.db
      .prepare(
        `SELECT v.id, v.slug, v.name, v.default_branch, v.main_admin_only, m.role
         FROM vaults v JOIN vault_members m ON m.vault_id = v.id
         WHERE m.employee_id = ?
         ORDER BY v.slug`,
      )
      .all(employeeId) as Array<{ id: number; slug: string; name: string; default_branch: string; main_admin_only: number; role: VaultRole }>;
    return rows
      .filter((r) => scopeVaultIds === undefined || scopeVaultIds.length === 0 || scopeVaultIds.includes(r.id))
      .map((r) => ({
        slug: r.slug,
        name: r.name,
        role: r.role,
        default_branch: r.default_branch,
        main_admin_only: r.main_admin_only === 1,
      }));
  }

  /** 单库数据行（存在性；成员判定由共用 authorize 完成） */
  getVaultRow(slug: string): (VaultRow & { created_by: number; created_at: string }) | undefined {
    return this.db
      .prepare(`SELECT id, slug, name, default_branch, main_admin_only, created_by, created_at FROM vaults WHERE slug = ?`)
      .get(slug) as (VaultRow & { created_by: number; created_at: string }) | undefined;
  }

  /** 改库（api.md §5 PATCH：name/slug/main_admin_only 任一；slug 可改名、内部 id 不变） */
  updateVault(
    slug: string,
    patch: { name?: unknown; slug?: unknown; main_admin_only?: unknown },
    actor: VaultActor,
  ): VaultPublic {
    const has = (key: 'name' | 'slug' | 'main_admin_only') => patch[key] !== undefined;
    if (!has('name') && !has('slug') && !has('main_admin_only')) {
      throw new ApiError(400, 'E-RES-004', '请求形态错误：name/slug/main_admin_only 至少一项');
    }
    if (has('name') && (typeof patch.name !== 'string' || patch.name.length === 0)) {
      throw new ApiError(400, 'E-RES-004', '请求形态错误：name 须为非空字符串');
    }
    const newSlug = has('slug') ? validateSlug(patch.slug) : undefined;
    if (has('main_admin_only') && typeof patch.main_admin_only !== 'boolean') {
      throw new ApiError(400, 'E-RES-004', '请求形态错误：main_admin_only 须为 boolean');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const updated = this.db
        .prepare(
          `UPDATE vaults SET
             name = COALESCE(?, name),
             slug = COALESCE(?, slug),
             main_admin_only = COALESCE(?, main_admin_only)
           WHERE slug = ?`,
        )
        .run(
          has('name') ? (patch.name as string) : null,
          newSlug ?? null,
          has('main_admin_only') ? ((patch.main_admin_only as boolean) ? 1 : 0) : null,
          slug,
        );
      if (updated.changes === 0) {
        throw new ApiError(404, 'E-RES-001', '资源不存在或无权访问');
      }
      const row = this.db
        .prepare(`SELECT id, slug, name, default_branch, main_admin_only FROM vaults WHERE slug = ?`)
        .get(newSlug ?? slug) as unknown as VaultRow;
      this.audit(actor, 'vault.update', row.id, {
        ...(has('name') ? { name: patch.name as string } : {}),
        ...(newSlug !== undefined ? { slug: newSlug } : {}),
        ...(has('main_admin_only') ? { main_admin_only: patch.main_admin_only as boolean } : {}),
      });
      this.db.exec('COMMIT');
      return {
        id: row.id,
        slug: row.slug,
        name: row.name,
        default_branch: row.default_branch,
        main_admin_only: row.main_admin_only === 1,
      };
    } catch (err) {
      this.db.exec('ROLLBACK');
      if (isUniqueViolation(err)) {
        throw new ApiError(409, 'E-RES-002', '资源标识已占用：vault slug');
      }
      throw err;
    }
  }

  /** 成员列表（api.md §5 GET members；库管理员经路由 authorize 判定） */
  listMembers(vaultId: number): MemberPublic[] {
    return this.db
      .prepare(
        `SELECT e.username, e.display_name, m.role, m.granted_at
         FROM vault_members m JOIN employees e ON e.id = m.employee_id
         WHERE m.vault_id = ? ORDER BY e.username`,
      )
      .all(vaultId) as unknown as MemberPublic[];
  }

  /**
   * 授权/改角色（api.md §5 PUT members：upsert）。PK (vault_id, employee_id) 使
   * 一员工一库至多一行——重复授权落 UPDATE；granted_by/granted_at 随最近一次
   * 授予动作更新。目标员工不存在 → 404（与库不存在同响应，api.md §5 错误列）。
   */
  putMember(vaultId: number, username: string, role: unknown, actor: VaultActor): { username: string; role: VaultRole } {
    if (typeof role !== 'string' || !ROLES.includes(role as VaultRole)) {
      throw new ApiError(422, 'E-RES-007', '参数语义不符：role 须为 reader/editor/admin');
    }
    const target = this.db.prepare(`SELECT id FROM employees WHERE username = ?`).get(username) as { id: number } | undefined;
    if (!target) throw new ApiError(404, 'E-RES-001', '资源不存在或无权访问');
    const grantedAt = this.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `INSERT INTO vault_members (vault_id, employee_id, role, granted_by, granted_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (vault_id, employee_id) DO UPDATE SET
             role = excluded.role, granted_by = excluded.granted_by, granted_at = excluded.granted_at`,
        )
        .run(vaultId, target.id, role, actor.employeeId, grantedAt);
      this.audit(actor, 'member.grant', vaultId, { username, role });
      this.db.exec('COMMIT');
      return { username, role: role as VaultRole };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** 撤权（api.md §5 DELETE members）：DELETE 成员行，下一请求生效（identity §5.2 行 4）。
   *  不设「最后管理员」保护——与管理员全员锁死同裁决（architecture-notes §6.6-4，
   *  兜底为实例管理员/重新授权路径）。 */
  deleteMember(vaultId: number, username: string, actor: VaultActor): void {
    const target = this.db.prepare(`SELECT id FROM employees WHERE username = ?`).get(username) as { id: number } | undefined;
    if (!target) throw new ApiError(404, 'E-RES-001', '资源不存在或无权访问');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const info = this.db
        .prepare(`DELETE FROM vault_members WHERE vault_id = ? AND employee_id = ?`)
        .run(vaultId, target.id);
      if (info.changes === 0) {
        throw new ApiError(404, 'E-RES-001', '资源不存在或无权访问');
      }
      this.audit(actor, 'member.revoke', vaultId, { username });
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** 审计事件（storage-model §5：vault/member 域直接终态；主体=认证员工） */
  private audit(actor: VaultActor, eventKind: 'vault.create' | 'vault.update' | 'member.grant' | 'member.revoke', vaultId: number, detail: Record<string, unknown>): void {
    this.db
      .prepare(
        `INSERT INTO audit_events (occurred_at, actor_kind, employee_id, credential_ref, entry, event_kind, vault_id, status, detail)
         VALUES (?, 'employee', ?, ?, ?, ?, ?, 'succeeded', ?)`,
      )
      .run(this.now(), actor.employeeId, actor.carrierRef, actor.entry, eventKind, vaultId, JSON.stringify(detail));
  }

  /**
   * 删除库（S3-T1「删除/归档与 DB 映射一致性」：无孤儿仓库、无孤儿配置行，
   * backup §5 不变量 3）。api.md 尚无删除端点——本方法是服务级能力（管理/
   * 运维路径）；端点与 `vault.delete` 审计 kind 待契约修订注册（storage-model §5
   * 注册表为唯一源，不得自行发明）。
   *
   * 顺序：行侧先行同灭（历史审计行保留、vault_id 解除挂靠——storage-model §7
   * 「v1 不清理」；成员行删；映射行删；同一事务），提交后删目录。目录删除失败
   * → 行已灭、错误放大，残留孤儿目录经 verifyVaultStoreConsistency 可观测、
   * reconcileOrphanRepos 可处置（补偿+核对语义）。
   */
  async deleteVault(slug: string): Promise<void> {
    const row = this.getVaultRow(slug);
    if (!row) throw new ApiError(404, 'E-RES-001', '资源不存在或无权访问');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`UPDATE audit_events SET vault_id = NULL WHERE vault_id = ?`).run(row.id);
      this.db.prepare(`DELETE FROM vault_members WHERE vault_id = ?`).run(row.id);
      const info = this.db.prepare(`DELETE FROM vaults WHERE id = ?`).run(row.id);
      if (info.changes === 0) {
        // 读取与事务之间的并发删除竞态：行已不在 → 与不存在同语义
        throw new ApiError(404, 'E-RES-001', '资源不存在或无权访问');
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    if (this.repoOps) await this.repoOps.remove(row.id);
  }
}
