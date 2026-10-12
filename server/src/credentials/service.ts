import type { DatabaseSync } from 'node:sqlite';
import type { PepperFile, PepperKey } from '../bootstrap/pepper.ts';
import { generateToken, hashToken, displayHint } from './token.ts';

/**
 * 员工访问凭据域服务（identity §3 唯一语义源；api.md §4 端点行为；storage-model §3.4/§4 落库形态）。
 * - token：`ngt_` + 32B CSPRNG base64url；明文仅创建响应返回一次，库内只存 `hmacv1$<hex>`；
 * - 认证：authn.token 规范查询（实时查库、无缓存——D-IC-05），四状态映射 E-AUTH-001..004；
 * - scope：两维（access / vaults 清单），使用时与员工当前权限取交集，只能收窄（§3.4）；
 * - 到期必填（默认上限 90 天）、每员工上限（默认 20）、last_used_at ≥60s 节流写（§3.3/§3.5）。
 */

/** storage-model §4 `-- @query authn.token` 规范 SQL（逐字；防漂移测试对照契约原文） */
export const AUTHN_TOKEN_SQL = `-- 认证层（Git HTTP Basic / API Bearer）：token 存在、未撤销、未过期、账号 active。
-- 覆盖四状态中的「过期 / 撤销 / 停用」三种（identity §5.2）；无行 = 401。
-- 参数：?1 = token_hash（HMAC 后），?2 = now
SELECT c.id AS credential_id, c.employee_id, c.scope_access, c.scope_vaults,
       e.is_instance_admin
FROM credentials c
JOIN employees e ON e.id = c.employee_id
WHERE c.token_hash = ?
  AND c.revoked_at IS NULL
  AND c.expires_at > ?
  AND e.active = 1;`;

/** 凭据哈希未命中规范查询后，用于区分四状态的归因查询（不参与放行判定） */
const ATTRIBUTION_SQL = `
SELECT c.id, c.revoked_at, c.expires_at, e.active
FROM credentials c
JOIN employees e ON e.id = c.employee_id
WHERE c.token_hash = ?`;

const DEFAULT_MAX_CREDENTIALS = 20; // identity §3.5 每员工上限（可配）
const DEFAULT_MAX_LIFETIME_DAYS = 90; // identity §3.3 到期上限（可配）
const LAST_USED_THROTTLE_MS = 60_000; // identity §3.3 last_used_at 节流间隔

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export type ScopeAccess = 'read' | 'read_write';

export interface CredentialPublic {
  id: number;
  name: string;
  display_hint: string;
  scope_access: ScopeAccess;
  scope_vaults: string[];
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}

export interface AuthTokenContext {
  credentialId: number;
  employeeId: number;
  isInstanceAdmin: boolean;
  scopeAccess: ScopeAccess;
  scopeVaultIds: number[];
}

/** 授权层 scope 判定结果：not_found 与「库不存在」不可区分（identity §5.2/D-IC-06，404 语义） */
export type VaultAccessDecision =
  | { allowed: true; access: ScopeAccess }
  | { allowed: false; reason: 'not_found' };

export interface CreateCredentialInput {
  name?: unknown;
  expires_at?: unknown;
  scope?: unknown;
}

export interface ServiceConfig {
  readonly db: DatabaseSync;
  readonly pepper: PepperFile;
  readonly now?: () => string;
  readonly maxCredentialsPerEmployee?: number;
  readonly maxTokenLifetimeDays?: number;
}

interface ResolvedScope {
  access: ScopeAccess;
  vaultIds: number[];
  slugs: string[];
}

export class CredentialsService {
  private readonly db: DatabaseSync;
  private readonly pepper: PepperFile;
  private readonly now: () => string;
  private readonly maxCredentials: number;
  private readonly maxLifetimeMs: number;

  constructor(config: ServiceConfig) {
    this.db = config.db;
    this.pepper = config.pepper;
    this.now = config.now ?? (() => new Date().toISOString());
    this.maxCredentials = config.maxCredentialsPerEmployee ?? DEFAULT_MAX_CREDENTIALS;
    this.maxLifetimeMs = (config.maxTokenLifetimeDays ?? DEFAULT_MAX_LIFETIME_DAYS) * 86_400_000;
  }

  /** 创建凭据：明文仅随本返回值出现一次；写路径 BEGIN IMMEDIATE（storage-model §1） */
  createCredential(employeeId: number, input: CreateCredentialInput): { record: CredentialPublic; token: string } {
    if (typeof input.name !== 'string' || input.name.length === 0) {
      throw new ApiError(400, 'E-RES-004', '请求形态错误：name 必填且为非空字符串');
    }
    const expiresAt = this.validateExpiresAt(input.expires_at);
    const scope = this.validateScope(employeeId, input.scope);

    const token = generateToken();
    const tokenHash = hashToken(this.pepper.active, token);
    const hint = displayHint(token);
    const createdAt = this.now();

    this.db.exec('BEGIN IMMEDIATE');
    try {
      // 名额计数在写事务内复查（单进程同步模型下本无窗口；多进程共享库时防超额）
      const activeCount = (
        this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM credentials
             WHERE employee_id = ? AND revoked_at IS NULL AND expires_at > ?`,
          )
          .get(employeeId, this.now()) as { n: number }
      ).n;
      if (activeCount >= this.maxCredentials) {
        throw new ApiError(409, 'E-RES-005', `凭据数量超上限（每员工 ${this.maxCredentials} 条）`);
      }
      const info = this.db
        .prepare(
          `INSERT INTO credentials (employee_id, name, token_hash, display_hint, scope_access, scope_vaults, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(employeeId, input.name, tokenHash, hint, scope.access, JSON.stringify(scope.vaultIds), createdAt, expiresAt);
      const id = Number(info.lastInsertRowid);
      this.audit(employeeId, `credential:${id}`, 'credential.create', { name: input.name });
      this.db.exec('COMMIT');
      return {
        record: {
          id,
          name: input.name,
          display_hint: hint,
          scope_access: scope.access,
          scope_vaults: scope.slugs,
          created_at: createdAt,
          expires_at: expiresAt,
          revoked_at: null,
          last_used_at: null,
        },
        token,
      };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** 员工凭据列表：无明文、无 token 字段；scope_vaults 以 slug 呈现（api.md §4） */
  listCredentials(employeeId: number): CredentialPublic[] {
    const rows = this.db
      .prepare(`SELECT * FROM credentials WHERE employee_id = ? ORDER BY created_at, id`)
      .all(employeeId) as Record<string, string | number | null>[];
    const slugById = new Map(
      (this.db.prepare(`SELECT id, slug FROM vaults`).all() as { id: number; slug: string }[]).map((r) => [r.id, r.slug] as const),
    );
    return rows.map((r) => {
      const ids = JSON.parse(String(r['scope_vaults'])) as number[];
      return {
        id: Number(r['id']),
        name: String(r['name']),
        display_hint: String(r['display_hint']),
        scope_access: String(r['scope_access']) as ScopeAccess,
        scope_vaults: ids.map((id) => slugById.get(id)).filter((s): s is string => s !== undefined),
        created_at: String(r['created_at']),
        expires_at: String(r['expires_at']),
        revoked_at: r['revoked_at'] === null ? null : String(r['revoked_at']),
        last_used_at: r['last_used_at'] === null ? null : String(r['last_used_at']),
      };
    });
  }

  /**
   * 撤销：置位 revoked_at（不删行，不可复活——identity §3.5），即时生效；
   * 他人凭据与不存在的凭据同报 404（不可见语义）；重复撤销幂等且不重复审计。
   * 审计主体 = 认证员工（identity §8）：自助撤销为本人，代管撤销为管理员（detail 记代管目标）。
   */
  revokeCredential(
    credentialId: number,
    ownerEmployeeId: number,
    auditInfo: { actorEmployeeId: number; managedByUsername?: string },
  ): void {
    const row = this.db
      .prepare(`SELECT id, revoked_at FROM credentials WHERE id = ? AND employee_id = ?`)
      .get(credentialId, ownerEmployeeId) as { id: number; revoked_at: string | null } | undefined;
    if (!row) {
      throw new ApiError(404, 'E-RES-001', '资源不存在或无权访问');
    }
    if (row.revoked_at !== null) return;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`UPDATE credentials SET revoked_at = ? WHERE id = ?`).run(this.now(), credentialId);
      const detail =
        auditInfo.managedByUsername !== undefined ? { managed_for: auditInfo.managedByUsername } : {};
      this.audit(auditInfo.actorEmployeeId, `credential:${credentialId}`, 'credential.revoke', detail);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * 认证（identity §5.1 第 1 层）：按 active→retired 顺序以各版本 pepper 计算 HMAC 查表
   * （§6.2 校验按版本选键；轮换的 rehash-on-use 操作留 S2-T8）。四状态分别映射：
   * 未提交/未知凭据 E-AUTH-001、过期 E-AUTH-002、撤销 E-AUTH-003、账号停用 E-AUTH-004。
   * 成功后按 ≥60 秒节流回写 last_used_at（观测字段，不参与任何授权判断）。
   */
  authenticate(token: string): AuthTokenContext {
    if (typeof token !== 'string' || !token.startsWith('ngt_')) {
      throw new ApiError(401, 'E-AUTH-001', '未认证');
    }
    const keys: readonly PepperKey[] = [this.pepper.active, ...this.pepper.retired];
    for (const key of keys) {
      const tokenHash = hashToken(key, token);
      const hit = this.db.prepare(AUTHN_TOKEN_SQL).get(tokenHash, this.now()) as
        | { credential_id: number; employee_id: number; scope_access: ScopeAccess; scope_vaults: string; is_instance_admin: number }
        | undefined;
      if (hit) {
        this.touchLastUsed(hit.credential_id);
        return {
          credentialId: hit.credential_id,
          employeeId: hit.employee_id,
          isInstanceAdmin: hit.is_instance_admin === 1,
          scopeAccess: hit.scope_access,
          scopeVaultIds: JSON.parse(hit.scope_vaults) as number[],
        };
      }
      // 归因：哈希命中存量行但被规范查询过滤 → 按四状态区分错误码
      const stored = this.db.prepare(ATTRIBUTION_SQL).get(tokenHash) as
        | { revoked_at: string | null; expires_at: string; active: number }
        | undefined;
      if (stored) {
        if (stored.revoked_at !== null) {
          throw new ApiError(401, 'E-AUTH-003', '凭据已撤销', { reason: 'revoked' });
        }
        if (stored.expires_at <= this.now()) {
          throw new ApiError(401, 'E-AUTH-002', '凭据已过期', { reason: 'expired' });
        }
        if (stored.active !== 1) {
          throw new ApiError(401, 'E-AUTH-004', '账号已停用', { reason: 'account_disabled' });
        }
      }
    }
    throw new ApiError(401, 'E-AUTH-001', '未认证');
  }

  /**
   * 授权层 scope 判定（identity §3.4/§5.1 第 2 层）：scope 与员工当前成员关系取交集，
   * 只能收窄。越范围、非成员、库不存在一律 not_found（与 404 同响应，D-IC-06）。
   * effective access = scope.access 与角色的较严者（reader 无论 scope 一律 read）。
   */
  resolveVaultAccess(
    employeeId: number,
    scope: { access: ScopeAccess; vaultIds: readonly number[] },
    vaultSlug: string,
  ): VaultAccessDecision {
    const notFound: VaultAccessDecision = { allowed: false, reason: 'not_found' };
    const vault = this.db.prepare(`SELECT id FROM vaults WHERE slug = ?`).get(vaultSlug) as { id: number } | undefined;
    if (!vault) return notFound;
    const member = this.db
      .prepare(`SELECT role FROM vault_members WHERE vault_id = ? AND employee_id = ?`)
      .get(vault.id, employeeId) as { role: string } | undefined;
    if (!member) return notFound;
    if (scope.vaultIds.length > 0 && !scope.vaultIds.includes(vault.id)) return notFound;
    const roleAccess: ScopeAccess = member.role === 'reader' ? 'read' : 'read_write';
    const access: ScopeAccess = scope.access === 'read' ? 'read' : roleAccess;
    return { allowed: true, access };
  }

  /** last_used_at 节流写：距上次记录 ≥60 秒才更新（identity §3.3） */
  private touchLastUsed(credentialId: number): void {
    const now = this.now();
    const threshold = new Date(Date.parse(now) - LAST_USED_THROTTLE_MS).toISOString();
    this.db
      .prepare(`UPDATE credentials SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at <= ?)`)
      .run(now, credentialId, threshold);
  }

  /**
   * 到期必填、≤ 实例上限（默认 90 天）、须在未来（identity §3.3；api.md E-RES-004/007）。
   * 输入宽松解析（Date.parse），但一律归一为规范 UTC ISO 后存储/比较——storage-model §1
   * 的字典序不变量（`expires_at > ?` 直接字符串比较）依赖此归一，原始串入库会被
   * "Nov 5, 2026" 类非数字开头串绕过（字典序恒大 → 永不过期）。
   */
  private validateExpiresAt(input: unknown): string {
    if (typeof input !== 'string' || input.length === 0) {
      throw new ApiError(400, 'E-RES-004', '请求形态错误：expires_at 必填');
    }
    const ts = Date.parse(input);
    if (Number.isNaN(ts)) {
      throw new ApiError(400, 'E-RES-004', '请求形态错误：expires_at 须为可解析的时间');
    }
    const nowTs = Date.parse(this.now());
    if (ts <= nowTs) {
      throw new ApiError(422, 'E-RES-007', '参数语义不符：expires_at 须晚于当前时间');
    }
    if (ts > nowTs + this.maxLifetimeMs) {
      throw new ApiError(422, 'E-RES-007', `参数语义不符：expires_at 超实例上限（${this.maxLifetimeMs / 86_400_000} 天）`);
    }
    return new Date(ts).toISOString();
  }

  /**
   * scope 两维（identity §3.4）：access ∈ {read, read_write}；vaults 为 slug 清单，仅解析
   * 员工当前有成员关系的库（scope 只能收窄员工权限，非成员/不存在的 slug 静默剔除且
   * 响应只回显生效清单——D-IC-06：422-on-unknown 会构成私有库存在性探测口）。
   * 清单非空而全部未命中 → 统一 422（文案不区分「不存在」与「非成员」，防探测，也防
   * 「声明收窄、实得空清单=全部有权库」的放大陷阱）。
   */
  private validateScope(employeeId: number, input: unknown): ResolvedScope {
    if (input === undefined) return { access: 'read_write', vaultIds: [], slugs: [] };
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new ApiError(422, 'E-RES-007', '参数语义不符：scope 须为对象');
    }
    const scope = input as { access?: unknown; vaults?: unknown };
    let access: ScopeAccess = 'read_write';
    if (scope.access !== undefined) {
      if (scope.access !== 'read' && scope.access !== 'read_write') {
        throw new ApiError(422, 'E-RES-007', '参数语义不符：scope.access 须为 read 或 read_write');
      }
      access = scope.access;
    }
    const vaults = scope.vaults ?? [];
    if (!Array.isArray(vaults) || vaults.some((v) => typeof v !== 'string')) {
      throw new ApiError(422, 'E-RES-007', '参数语义不符：scope.vaults 须为 slug 字符串数组');
    }
    const slugs = [...new Set(vaults as string[])];
    const memberVaults = this.db
      .prepare(
        `SELECT v.id, v.slug FROM vaults v
         JOIN vault_members m ON m.vault_id = v.id
         WHERE m.employee_id = ?`,
      )
      .all(employeeId) as { id: number; slug: string }[];
    const memberBySlug = new Map(memberVaults.map((r) => [r.slug, r.id] as const));
    const vaultIds: number[] = [];
    const resolvedSlugs: string[] = [];
    for (const slug of slugs) {
      const id = memberBySlug.get(slug);
      if (id !== undefined) {
        vaultIds.push(id);
        resolvedSlugs.push(slug);
      }
    }
    if (slugs.length > 0 && vaultIds.length === 0) {
      throw new ApiError(422, 'E-RES-007', '参数语义不符：scope.vaults 未命中任何当前有权库');
    }
    return { access, vaultIds, slugs: resolvedSlugs };
  }

  /** 审计事件（identity §8；storage-model §5：直接终态、credential_ref 不含 token 材料） */
  private audit(employeeId: number, credentialRef: string, eventKind: 'credential.create' | 'credential.revoke', detail: Record<string, unknown>): void {
    this.db
      .prepare(
        `INSERT INTO audit_events (occurred_at, actor_kind, employee_id, credential_ref, entry, event_kind, vault_id, status, detail)
         VALUES (?, 'employee', ?, ?, 'api', ?, NULL, 'succeeded', ?)`,
      )
      .run(this.now(), employeeId, credentialRef, eventKind, JSON.stringify(detail));
  }
}
