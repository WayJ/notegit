import type { FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { Subject } from '../app.ts'; // type-only（运行时擦除，无环）
import type { PepperFile } from '../bootstrap/pepper.ts';
import { authenticateSession, diagnoseSessionFailure, sidHash, touchSession, DEFAULT_SESSION_TIMEOUTS } from './sessions.ts';

/**
 * 会话载体解析（identity §5.1 第 1 层）：ngt_sid Cookie → Subject。
 * 请求级双载体缝（Bearer + Cookie、四状态精确映射）在 auth/lifecycle.ts
 * （S2-T5 统一，替换并吸收 T2 的 createSubjectResolver 缝）。
 *
 * pepper 轮换（identity §6.2，S2-T8）：按 active→retired 顺序以各版本键计算 sid_hash
 * 查表；命中 retired 键的会话验证成功后立即以 active 键重算并回写 sid_hash
 * （rehash-on-use，与凭据域 CredentialsService.authenticate 同一语义——对用户透明）。
 */

export const COOKIE_NAME = 'ngt_sid';

export function readSidCookie(req: FastifyRequest): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE_NAME) return v.join('=') || null;
  }
  return null;
}

export type SessionResolution =
  | { ok: true; sessionId: number; subject: Subject }
  | { ok: false, reason: 'no_cookie' | 'invalid' | 'account_disabled' };

/** 认证 + 判别（实时查库，D-IC-05 无缓存）：成功滑动续期（retired 命中另做 rehash-on-use），
 *  失败给出 401 映射用原因（多键逐一判别——停用归因优先于 invalid）。 */
export function resolveSession(
  db: DatabaseSync,
  pepper: PepperFile,
  sid: string | null,
  now: Date,
  idleTimeoutMs: number = DEFAULT_SESSION_TIMEOUTS.idleTimeoutMs,
): SessionResolution {
  if (!sid) return { ok: false, reason: 'no_cookie' };
  const keys = [pepper.active, ...pepper.retired];
  for (const key of keys) {
    const auth = authenticateSession(db, sidHash(sid, key.key), now, idleTimeoutMs);
    if (!auth) continue;
    const row = db.prepare('SELECT username FROM employees WHERE id = ?').get(auth.employeeId) as { username: string } | undefined;
    if (!row) continue; // FK 保证下不可达；fail-closed 继续试下一键
    if (key.version !== pepper.active.version) {
      // rehash-on-use（identity §6.2 步骤 2）：旧键命中的 sid_hash 迁移到 active 版本
      db.prepare('UPDATE sessions SET sid_hash = ? WHERE id = ?').run(sidHash(sid, pepper.active.key), auth.sessionId);
    }
    touchSession(db, auth.sessionId, now);
    return {
      ok: true,
      sessionId: auth.sessionId,
      subject: { employee_id: auth.employeeId, username: row.username, is_instance_admin: auth.isInstanceAdmin },
    };
  }
  // 失败判别（仅失败路径）：任一键能定位会话行即用其归因；停用优先呈现
  for (const key of keys) {
    const failure = diagnoseSessionFailure(db, sidHash(sid, key.key), now, idleTimeoutMs);
    if (failure === 'account_disabled') return { ok: false, reason: 'account_disabled' };
  }
  return { ok: false, reason: 'invalid' };
}
