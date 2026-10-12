import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { hmacTokenHash, type PepperFile } from '../bootstrap/pepper.ts';
import { TokenError } from '../bootstrap/token.ts';
import { INVITED_PASSWORD_SENTINEL } from '../auth/password.ts';

/**
 * 邀请创建账号（identity §2/§7.2，api.md §3.1）：实例管理员建员工行（无口令哨兵）+
 * 一次性口令重置令牌（K5：库内哈希+短时效+单次）；员工经 password-reset 设初始口令后激活。
 * 明文令牌仅在创建响应出现一次（响应体外不落任何存储/日志）。
 * 审计 employee.create / employee.password_reset 随 S2-T7 审计基座落地。
 */

/** K5「短时效」：口令重置令牌 30 分钟（bootstrap token 见 bootstrap/token.ts 的 24h）。 */
export const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;

export class InviteError extends Error {
  readonly reason: 'username_taken';
  constructor(reason: 'username_taken') {
    super(`invite rejected: ${reason}`);
    this.reason = reason;
  }
}

export function createInvite(
  db: DatabaseSync,
  pepper: PepperFile,
  input: { username: string; displayName: string; invitedBy: number },
  now: Date,
): { employeeId: number; token: string } {
  const nowIso = now.toISOString();
  db.exec('BEGIN');
  try {
    const dup = db.prepare('SELECT id FROM employees WHERE username = ?').get(input.username);
    if (dup) throw new InviteError('username_taken');
    const ins = db
      .prepare(
        'INSERT INTO employees (username, display_name, password_hash, is_instance_admin, active, invited_by, created_at) VALUES (?, ?, ?, 0, 1, ?, ?)',
      )
      .run(input.username, input.displayName, INVITED_PASSWORD_SENTINEL, input.invitedBy, nowIso);
    const employeeId = Number(ins.lastInsertRowid);
    const token = issuePasswordResetToken(db, pepper, employeeId, now);
    db.exec('COMMIT');
    return { employeeId, token };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** 为既有员工签发一次性口令重置令牌（K5：库内哈希+短时效+单次；明文仅随返回值出现一次）。
 *  S2-T8：管理员管理页「重置口令」消费（api.md §3.1；identity §7.2 普通员工恢复路径）。
 *  调用方负责事务边界（createInvite 内嵌于建号事务）。 */
export function issuePasswordResetToken(
  db: DatabaseSync,
  pepper: PepperFile,
  employeeId: number,
  now: Date,
): string {
  const token = randomBytes(32).toString('base64url');
  db.prepare(
    "INSERT INTO one_time_tokens (purpose, token_hash, employee_id, expires_at, used_at, created_at) VALUES ('password_reset', ?, ?, ?, NULL, ?)",
  ).run(
    hmacTokenHash(pepper, token),
    employeeId,
    new Date(now.getTime() + PASSWORD_RESET_TTL_MS).toISOString(),
    now.toISOString(),
  );
  return token;
}

/** @returns 归属员工 id（审计挂接用，S2-T7：employee.password_reset 记目标员工） */
export function consumePasswordReset(
  db: DatabaseSync,
  pepper: PepperFile,
  input: { token: string; newPasswordHash: string },
  now: Date,
): number {
  const hash = hmacTokenHash(pepper, input.token);
  const nowIso = now.toISOString();
  db.exec('BEGIN');
  try {
    const row = db
      .prepare("SELECT id, employee_id, used_at, expires_at FROM one_time_tokens WHERE token_hash = ? AND purpose = 'password_reset'")
      .get(hash) as { id: number; employee_id: number; used_at: string | null; expires_at: string } | undefined;
    if (!row) throw new TokenError('invalid');
    if (row.used_at !== null) throw new TokenError('used');
    if (row.expires_at <= nowIso) throw new TokenError('expired');
    const upd = db.prepare('UPDATE one_time_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL').run(nowIso, row.id);
    if (upd.changes !== 1) throw new TokenError('used');
    db.prepare('UPDATE employees SET password_hash = ? WHERE id = ?').run(input.newPasswordHash, row.employee_id);
    // 副作用「该账号会话全部失效」（identity §2/§7.2；api.md §3.2）——T2 遗留注释的欠账，
    // S2-T8 随管理员重置流程补齐（token 不自动撤销，identity §1）
    db.prepare('DELETE FROM sessions WHERE employee_id = ?').run(row.employee_id);
    db.exec('COMMIT');
    return row.employee_id;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
