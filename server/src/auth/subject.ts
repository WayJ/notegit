import type { FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { Subject } from '../app.ts'; // type-only（运行时擦除，无环）
import { authenticateSession, diagnoseSessionFailure, sidHash, touchSession, DEFAULT_SESSION_TIMEOUTS } from './sessions.ts';

/**
 * 会话载体解析（identity §5.1 第 1 层）：ngt_sid Cookie → Subject。
 * 请求级双载体缝（Bearer + Cookie、四状态精确映射）在 auth/lifecycle.ts
 * （S2-T5 统一，替换并吸收 T2 的 createSubjectResolver 缝）。
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
  | { ok: false; reason: 'no_cookie' | 'invalid' | 'account_disabled' };

/** 认证 + 判别（实时查库，D-IC-05 无缓存）：成功滑动续期，失败给出 401 映射用原因。 */
export function resolveSession(
  db: DatabaseSync,
  pepper: Uint8Array,
  sid: string | null,
  now: Date,
  idleTimeoutMs: number = DEFAULT_SESSION_TIMEOUTS.idleTimeoutMs,
): SessionResolution {
  if (!sid) return { ok: false, reason: 'no_cookie' };
  const hash = sidHash(sid, pepper);
  const auth = authenticateSession(db, hash, now, idleTimeoutMs);
  if (auth) {
    const row = db.prepare('SELECT username FROM employees WHERE id = ?').get(auth.employeeId) as { username: string } | undefined;
    if (row) {
      touchSession(db, auth.sessionId, now);
      return {
        ok: true,
        sessionId: auth.sessionId,
        subject: { employee_id: auth.employeeId, username: row.username, is_instance_admin: auth.isInstanceAdmin },
      };
    }
  }
  const failure = diagnoseSessionFailure(db, hash, now, idleTimeoutMs);
  return { ok: false, reason: failure === 'account_disabled' ? 'account_disabled' : 'invalid' };
}
