import { createHmac, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/**
 * Web 会话存储（identity §4 / D-IC-04 / storage-model §3.3）：
 * 服务端会话表 + 不透明 session ID（32B 随机 base64url）；
 * sid_hash = HMAC-SHA256(pepper, sid)，键与 token pepper 同源（K1）。
 * 认证 = storage-model §4 `authn.session` 规范查询（逐请求查库、无缓存，D-IC-05）。
 */

export interface SessionDefaults {
  idleTimeoutMs: number;
  absoluteTimeoutMs: number;
}

/** identity §4 默认：idle 7 天（滑动）、absolute 30 天（管理员可配——配置落 app_settings 随后续任务）。 */
export const DEFAULT_SESSION_TIMEOUTS: SessionDefaults = {
  idleTimeoutMs: 7 * 24 * 3600_000,
  absoluteTimeoutMs: 30 * 24 * 3600_000,
};

export function generateSid(): string {
  return randomBytes(32).toString('base64url'); // 43 字符不透明 ID
}

export function sidHash(sid: string, pepper: Uint8Array): string {
  return createHmac('sha256', pepper).update(sid, 'utf8').digest('hex');
}

export interface SessionAuth {
  sessionId: number;
  employeeId: number;
  isInstanceAdmin: boolean;
}

/** storage-model §4 `authn.session`：sid 有效、idle/absolute 未过期、账号 active。无行 = 401。 */
export function authenticateSession(
  db: DatabaseSync,
  hash: string,
  now: Date,
  idleTimeoutMs: number,
): SessionAuth | undefined {
  const nowIso = now.toISOString();
  const idleCutoff = new Date(now.getTime() - idleTimeoutMs).toISOString();
  const row = db
    .prepare(
      `SELECT s.id AS session_id, s.employee_id, e.is_instance_admin
       FROM sessions s
       JOIN employees e ON e.id = s.employee_id
       WHERE s.sid_hash = ?
         AND e.active = 1
         AND s.absolute_expires_at > ?
         AND s.last_seen_at >= ?`,
    )
    .get(hash, nowIso, idleCutoff) as
    | { session_id: number; employee_id: number; is_instance_admin: number }
    | undefined;
  if (!row) return undefined;
  return {
    sessionId: row.session_id,
    employeeId: row.employee_id,
    isInstanceAdmin: row.is_instance_admin === 1,
  };
}

export type SessionFailure = 'invalid' | 'account_disabled';

/** 认证失败后的判别（仅失败路径执行，用于 401 错误码映射 E-AUTH-001/004）。 */
export function diagnoseSessionFailure(
  db: DatabaseSync,
  hash: string,
  now: Date,
  idleTimeoutMs: number,
): SessionFailure {
  const nowIso = now.toISOString();
  const idleCutoff = new Date(now.getTime() - idleTimeoutMs).toISOString();
  const row = db
    .prepare(
      `SELECT e.active
       FROM sessions s
       JOIN employees e ON e.id = s.employee_id
       WHERE s.sid_hash = ?
         AND s.absolute_expires_at > ?
         AND s.last_seen_at >= ?`,
    )
    .get(hash, nowIso, idleCutoff) as { active: number } | undefined;
  if (row && row.active === 0) return 'account_disabled';
  return 'invalid';
}

export function createSession(
  db: DatabaseSync,
  employeeId: number,
  pepper: Uint8Array,
  now: Date,
  timeouts: SessionDefaults,
): { sid: string; id: number } {
  const sid = generateSid();
  const info = db
    .prepare(
      `INSERT INTO sessions (employee_id, sid_hash, created_at, last_seen_at, absolute_expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(employeeId, sidHash(sid, pepper), now.toISOString(), now.toISOString(), new Date(now.getTime() + timeouts.absoluteTimeoutMs).toISOString());
  return { sid, id: Number(info.lastInsertRowid) };
}

/** 滑动续期：活跃请求推进 last_seen_at（identity §4）。 */
export function touchSession(db: DatabaseSync, sessionId: number, now: Date): void {
  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(now.toISOString(), sessionId);
}

/** 登出：删除当前会话行（identity §1：注销会话不撤销 token）。 */
export function deleteSessionByHash(db: DatabaseSync, hash: string): void {
  db.prepare('DELETE FROM sessions WHERE sid_hash = ?').run(hash);
}

/** 口令重置：该账号全部会话失效 = DELETE WHERE employee_id（identity §2 / storage-model §3.3）。 */
export function deleteSessionsForEmployee(db: DatabaseSync, employeeId: number): void {
  db.prepare('DELETE FROM sessions WHERE employee_id = ?').run(employeeId);
}
