import type { FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { Subject, SubjectResolver } from '../app.ts'; // type-only（运行时擦除，无环）
import { authenticateSession, diagnoseSessionFailure, sidHash, touchSession, DEFAULT_SESSION_TIMEOUTS } from './sessions.ts';

/**
 * 会话主体解析（identity §5.1 第 1 层）：S2-T3 的 ngt_sid Cookie 载体解析，
 * 供本域路由（routes.ts）与 app.ts 的 SubjectResolver 缝共用——S2-T2 的注释
 * 「真实载体解析随 S2-T3 落地」的落点。Bearer ngt_（token 域）随 S2-T4/T5 并入。
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

/** SubjectResolver 缝的真实实现（api.md §1 Cookie 载体）：失败一律 null → 调用方 401。 */
export function createSubjectResolver(deps: {
  db: DatabaseSync;
  pepper: Uint8Array;
  now?: () => Date;
  idleTimeoutMs?: number;
}): SubjectResolver {
  const now = deps.now ?? (() => new Date());
  return (req: FastifyRequest) => {
    const r = resolveSession(deps.db, deps.pepper, readSidCookie(req), now(), deps.idleTimeoutMs);
    return r.ok ? r.subject : null;
  };
}
