import type { FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { Subject } from '../app.ts';
import { COOKIE_NAME, readSidCookie, resolveSession } from './subject.ts';

/**
 * 生命周期语义统一模块（S2-T5；identity §5 是唯一语义源）：
 *
 * 1) 认证层四状态 → 401 映射（identity §5.1 第 1 层 / §5.2 前三行 + api.md §2.3
 *    E-AUTH-001..004）：Bearer token 与 ngt_sid 会话两载体统一为 AuthOutcome，
 *    路由不再各自判别。凭据过期/撤销/账号停用在 token 入口分别精确到
 *    E-AUTH-002/003/004；会话入口的停用为 E-AUTH-004（「被登出」），会话自身
 *    过期为 E-AUTH-001（会话是独立凭据，identity §1/§4）。
 * 2) 载体并存优先级（architecture-notes §7 定稿）：`Authorization` 头为显式
 *    凭据，在场即优先（非 Bearer scheme → E-AUTH-001，不静默回退 Cookie）；
 *    否则用 ngt_sid 会话 Cookie。
 * 3) 授权层接口（identity §5.1 第 2 层）：authorize() 经 MembershipSource 实时
 *    查成员关系（无缓存，D-IC-05）；撤权/无权/不存在/not in scope 一律
 *    not_found（404，D-IC-06）；成员而角色或范围不足写 → forbidden（403
 *    E-AUTHZ-001）。vaults/vault_members 表属 S2-T6，T6 以 storage-model §4
 *    `authz.role` 规范查询实现本接口。
 * 4) 写路径执行点复查钩子（identity §5.1 第 3 层）：S3 的 pre-receive / Web
 *    发布组件 update-ref 前调用；维护模式标志复查位随 S2-T7 接入。
 *
 * 每次调用都发起全新的查库/查源——本模块及其调用方不得缓存任何判定结果。
 */

// ── 认证层：四状态 → AuthOutcome ─────────────────────────────────────────────

export type AuthCarrier = 'session' | 'token';

/** identity §5.2 四状态在 401 细分上的归因（api.md §2.3：002/003/004 附 reason） */
export type AuthFailureReason = 'unauthenticated' | 'expired' | 'revoked' | 'account_disabled';

export type AuthFailureCode = 'E-AUTH-001' | 'E-AUTH-002' | 'E-AUTH-003' | 'E-AUTH-004';

/** 审计入口归因（identity §8；api.md §8.5）：会话载体=web、token 载体（CLI/程序化 API）=api；
 *  Git Smart HTTP Basic 入口=git 属 S3 落地。T7 审计基座消费本字段。 */
export type AuditEntry = 'web' | 'api';

export interface AuthSuccess {
  ok: true;
  carrier: AuthCarrier;
  subject: Subject;
  /** 载体标识（identity §8：credential_id / session 标识；不含任何凭据材料） */
  carrierRef: string;
  entry: AuditEntry;
  /** 会话载体附带（滑动续期已在解析内完成；logout 按此删会话行） */
  session?: { sid: string; sessionId: number };
  /** token 载体附带（scope 收窄随授权层取交集，identity §3.4） */
  token?: { credentialId: number; scopeAccess: AccessLevel; scopeVaultIds: readonly number[] };
}

export interface AuthFailure {
  ok: false;
  /** null = 未提交任何可识别载体；'session'|'token' = 提交了该载体且其状态导致失败 */
  carrier: AuthCarrier | null;
  code: AuthFailureCode;
  reason: AuthFailureReason;
}

export type AuthOutcome = AuthSuccess | AuthFailure;

/** 请求级认证缝（替换 T2 的 SubjectResolver——其丢失失败原因，停用账号在 T2 路由
 *  被误报 E-AUTH-001；S2-T5 收尾 b 统一）。可注入覆盖（测试用桩）。 */
export type RequestAuthenticator = (req: FastifyRequest) => AuthOutcome | Promise<AuthOutcome>;

/** token 载体认证结果（CredentialsService.authenticate 的结构面；凭据域实现） */
export interface TokenAuthResult {
  credentialId: number;
  employeeId: number;
  isInstanceAdmin: boolean;
  scopeAccess: AccessLevel;
  scopeVaultIds: readonly number[];
}

export type AccessLevel = 'read' | 'read_write';

function unauthenticated(carrier: AuthCarrier | null): AuthFailure {
  return { ok: false, carrier, code: 'E-AUTH-001', reason: 'unauthenticated' };
}

/** Authorization 头解析：present = 头在场；token = null 表示 scheme 非 Bearer。 */
export function bearerTokenOf(req: FastifyRequest): { present: boolean; token: string | null } {
  const header = req.headers.authorization;
  if (header === undefined) return { present: false, token: null };
  const m = /^(\w+)\s+(.+)$/.exec(header);
  // RFC 7235：auth scheme 大小写不敏感（bearer/BEARER 同样受理）
  if (!m || m[1]!.toLowerCase() !== 'bearer') return { present: true, token: null };
  return { present: true, token: m[2]! };
}

/** 凭据域 ApiError 形状（401 + E-AUTH-00x）→ AuthFailure；非该形状错误原样上抛。 */
function authFailureFromError(err: unknown): AuthFailure {
  const e = err as { status?: number; code?: string; details?: { reason?: string } };
  if (e && e.status === 401 && typeof e.code === 'string' && /^E-AUTH-00[1-4]$/.test(e.code)) {
    const reason = e.details?.reason;
    return {
      ok: false,
      carrier: 'token',
      code: e.code as AuthFailureCode,
      reason:
        reason === 'expired' || reason === 'revoked' || reason === 'account_disabled'
          ? reason
          : 'unauthenticated',
    };
  }
  throw err;
}

export function createRequestAuthenticator(deps: {
  db: DatabaseSync;
  /** K1 active 键（会话与 token 的 HMAC 同源，identity §4） */
  pepper: Uint8Array;
  /** token 载体认证（CredentialsService.authenticate）；缺省 = fail-closed（Bearer → E-AUTH-001） */
  authenticateToken?: (token: string) => TokenAuthResult;
  now?: () => Date;
  idleTimeoutMs?: number;
}): RequestAuthenticator {
  const now = deps.now ?? (() => new Date());
  return (req: FastifyRequest) => {
    // 载体优先级：Authorization 头在场即优先（显式凭据）；非 Bearer scheme 不回退 Cookie
    const auth = bearerTokenOf(req);
    if (auth.present) {
      if (auth.token === null || deps.authenticateToken === undefined) return unauthenticated('token');
      try {
        const t = deps.authenticateToken(auth.token);
        const row = deps.db.prepare('SELECT username FROM employees WHERE id = ?').get(t.employeeId) as
          | { username: string }
          | undefined;
        if (!row) return unauthenticated('token'); // FK 保证下不可达；fail-closed
        return {
          ok: true,
          carrier: 'token',
          subject: { employee_id: t.employeeId, username: row.username, is_instance_admin: t.isInstanceAdmin },
          carrierRef: `credential:${t.credentialId}`,
          entry: 'api',
          token: { credentialId: t.credentialId, scopeAccess: t.scopeAccess, scopeVaultIds: t.scopeVaultIds },
        };
      } catch (err) {
        return authFailureFromError(err);
      }
    }
    // 会话载体（identity §4/§5.1 第 1 层；实时查库 + 滑动续期）
    const sid = readSidCookie(req);
    if (sid === null) return unauthenticated(null);
    const r = resolveSession(deps.db, deps.pepper, sid, now(), deps.idleTimeoutMs);
    if (r.ok) {
      return {
        ok: true,
        carrier: 'session',
        subject: r.subject,
        carrierRef: `session:${r.sessionId}`,
        entry: 'web',
        session: { sid, sessionId: r.sessionId },
      };
    }
    if (r.reason === 'account_disabled') {
      return { ok: false, carrier: 'session', code: 'E-AUTH-004', reason: 'account_disabled' };
    }
    // 会话自身过期/无效 → E-AUTH-001（会话是独立凭据，token 的过期/撤销不适用于此入口）
    return { ok: false, carrier: 'session', code: 'E-AUTH-001', reason: 'unauthenticated' };
  };
}

const FAILURE_MESSAGES: Record<AuthFailureCode, string> = {
  'E-AUTH-001': '未认证',
  'E-AUTH-002': '凭据已过期',
  'E-AUTH-003': '凭据已撤销',
  'E-AUTH-004': '账号已停用',
};

/** 四状态 401 文案（api.md §2.3 触发场景列；信封呈现统一走 rejectAuth） */
export function authFailureMessage(code: AuthFailureCode): string {
  return FAILURE_MESSAGES[code];
}

/** 401 统一呈现（api.md §2.1 信封 + §2.3 reason 细分）：
 *  会话载体失败同时清 Cookie——identity §5.2 停用行的「被登出」呈现。 */
export function rejectAuth(reply: FastifyReply, failure: AuthFailure): FastifyReply {
  if (failure.carrier === 'session') {
    reply.header('set-cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
  }
  return reply.code(401).send({
    error: { code: failure.code, message: FAILURE_MESSAGES[failure.code], details: { reason: failure.reason } },
  });
}

// ── 授权层：authorize 缝（identity §5.1 第 2 层；T6 接真实表） ───────────────

export type VaultRole = 'reader' | 'editor' | 'admin';

export interface MembershipLookup {
  vaultId: number;
  role: VaultRole;
}

/**
 * 成员关系源：identity §5.1 第 2 层的接口化（storage-model §4 `authz.role` 规范查询
 * 的调用面）。非成员与库不存在一律 undefined——两者不可区分（D-IC-06）。
 * S2-T6 以 vaults/vault_members 真实表实现（slug → id 映射同源）。
 */
export interface MembershipSource {
  lookup(vaultSlug: string, employeeId: number): MembershipLookup | undefined;
}

/** refs 发现 / 对象与内容读取 = read；push / Web 发布 = write（读写路径一致查源） */
export type VaultAction = 'read' | 'write';

/** 凭据 scope（identity §3.4）：vaultIds 空 = 全部有权库；非空 = 库 id 允许清单 */
export interface VaultScope {
  access: AccessLevel;
  vaultIds: readonly number[];
}

export type AuthorizeDecision =
  | { allowed: true; role: VaultRole; access: AccessLevel }
  /** → 404 E-RES-001：撤权/无权/不存在/越出 scope 清单，同响应（D-IC-06） */
  | { allowed: false; reason: 'not_found' }
  /** → 403 E-AUTHZ-001：已认证成员、库存在已知，但角色或 scope 不足以写 */
  | { allowed: false; reason: 'forbidden' };

/**
 * 授权层判定（identity §5.1 第 2 层 / §3.4）：每次调用实时查源——scope 与员工当前
 * 成员关系取交集、只能收窄；effective access = scope.access 与角色的较严者。
 * Web 会话入口不传 scope（员工全量权限）；Git/API token 入口传凭据 scope。
 */
export function authorize(
  source: MembershipSource,
  employeeId: number,
  vaultSlug: string,
  action: VaultAction,
  scope?: VaultScope,
): AuthorizeDecision {
  const hit = source.lookup(vaultSlug, employeeId);
  if (hit === undefined) return { allowed: false, reason: 'not_found' };
  if (scope !== undefined && scope.vaultIds.length > 0 && !scope.vaultIds.includes(hit.vaultId)) {
    return { allowed: false, reason: 'not_found' }; // 越范围与不存在不可区分（D-IC-06）
  }
  const roleAccess: AccessLevel = hit.role === 'reader' ? 'read' : 'read_write';
  const access: AccessLevel = scope !== undefined && scope.access === 'read' ? 'read' : roleAccess;
  if (action === 'write' && access !== 'read_write') return { allowed: false, reason: 'forbidden' };
  return { allowed: true, role: hit.role, access };
}

/**
 * 写路径执行点复查钩子（identity §5.1 第 3 层；S3 挂接点）：pre-receive /
 * 网页发布组件 update-ref 前再次实时授权。撤权发生在检查后、执行点前的在途
 * push 在此被拒（identity §5.2 行 4；审计记 rejected 随 S2-T7）。
 * 分支规则复查（架构 §4.3）与维护模式标志复查（backup-recovery §3）由 S3/T7
 * 在同一执行点叠加——本钩子固定权限维度的复查语义。
 */
export function reauthorizeAtExecutionPoint(
  source: MembershipSource,
  employeeId: number,
  vaultSlug: string,
  scope?: VaultScope,
): AuthorizeDecision {
  return authorize(source, employeeId, vaultSlug, 'write', scope);
}
