import { randomBytes } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { hmacTokenHash, type PepperFile } from './pepper.ts';
import { isUninitialized } from './state.ts';

/**
 * bootstrap token 生命周期（identity §7.1 / D-IC-07，K5）：
 * - 空库启动 ensure：32B 随机 token 写 /…/config/admin-bootstrap.token（0600，库内只存
 *   HMAC 哈希 + 过期 + 单次，storage-model §3.9）；
 * - 有效未用行 + 文件在 → 保持不变；文件丢失或已过期 → 重生成（重启不锁死）；
 * - 初始化完成后（employees 非空）永不再发；
 * - completeBootstrap：消费 token 与建管理员同一事务（原子：建号失败则 token 未消耗）。
 * TTL 取 24h（K5「短时效」；未用时过期由重启重生成自愈）。
 */

export const BOOTSTRAP_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/** 一次性令牌拒绝原因（api.md bootstrap：统一映射 401 E-AUTH-001，不外显区分）。 */
export class TokenError extends Error {
  readonly reason: 'invalid' | 'used' | 'expired';
  constructor(reason: 'invalid' | 'used' | 'expired') {
    super(`bootstrap token rejected: ${reason}`);
    this.reason = reason;
  }
}

export interface BootstrapInput {
  readonly token: string;
  readonly username: string;
  readonly displayName: string;
  readonly passwordHash: string;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return false;
  }
}

export async function ensureBootstrapToken(
  db: DatabaseSync,
  pepper: PepperFile,
  tokenFile: string,
  now: Date,
): Promise<boolean> {
  if (!isUninitialized(db)) return false; // §7.1-4：初始化完成后不再发
  const nowIso = now.toISOString();
  const valid = db
    .prepare("SELECT id FROM one_time_tokens WHERE purpose = 'bootstrap' AND used_at IS NULL AND expires_at > ?")
    .get(nowIso);
  if (valid && (await exists(tokenFile))) return false; // 有效未用且文件在：保持
  const token = randomBytes(32).toString('base64url');
  db.prepare(
    "INSERT INTO one_time_tokens (purpose, token_hash, employee_id, expires_at, used_at, created_at) VALUES ('bootstrap', ?, NULL, ?, NULL, ?)",
  ).run(hmacTokenHash(pepper, token), new Date(now.getTime() + BOOTSTRAP_TOKEN_TTL_MS).toISOString(), nowIso);
  await mkdir(path.dirname(tokenFile), { recursive: true });
  await writeFile(tokenFile, token, { mode: 0o600 });
  return true;
}

export function completeBootstrap(
  db: DatabaseSync,
  pepper: PepperFile,
  input: BootstrapInput,
  now: Date,
): { employeeId: number } {
  const hash = hmacTokenHash(pepper, input.token);
  const nowIso = now.toISOString();
  db.exec('BEGIN');
  try {
    const row = db
      .prepare("SELECT id, used_at, expires_at FROM one_time_tokens WHERE token_hash = ? AND purpose = 'bootstrap'")
      .get(hash) as { id: number; used_at: string | null; expires_at: string } | undefined;
    if (!row) throw new TokenError('invalid');
    if (row.used_at !== null) throw new TokenError('used');
    if (row.expires_at <= nowIso) throw new TokenError('expired');
    const upd = db
      .prepare('UPDATE one_time_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL')
      .run(nowIso, row.id);
    if (upd.changes !== 1) throw new TokenError('used');
    const ins = db
      .prepare(
        'INSERT INTO employees (username, display_name, password_hash, is_instance_admin, active, invited_by, created_at) VALUES (?, ?, ?, 1, 1, NULL, ?)',
      )
      .run(input.username, input.displayName, input.passwordHash, nowIso);
    db.exec('COMMIT');
    return { employeeId: Number(ins.lastInsertRowid) };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
