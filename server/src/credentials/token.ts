import { createHmac, randomBytes } from 'node:crypto';
import type { PepperKey } from './pepper.ts';

/**
 * 员工访问凭据的 token 形态与哈希（identity §3.1/§3.2，D-IC-01/03）：
 * - token = `ngt_` + 32B CSPRNG 的 base64url（43 字符随机部，无填充）；
 * - 服务端存 `HMAC-SHA256(pepper, token)`，存储串内嵌 pepper 版本：`hmacv<id>$<hex>`；
 * - 明文只在创建响应出现一次；此后仅 display_hint（前缀 + 前 2 字符 + … + 末 4 位）。
 */

export function generateToken(): string {
  return `ngt_${randomBytes(32).toString('base64url')}`;
}

export function hashToken(pepper: PepperKey, token: string): string {
  const hex = createHmac('sha256', pepper.key).update(token, 'utf8').digest('hex');
  return `hmacv${pepper.id}$${hex}`;
}

/** 解析存储串内嵌的 pepper 版本；非 hmacv<数字>$ 形态返回 undefined */
export function pepperVersionOf(tokenHash: string): number | undefined {
  const m = /^hmacv(\d+)\$/.exec(tokenHash);
  return m ? Number(m[1]) : undefined;
}

/** identity §3.1：此后仅显示前缀与末 4 位；api.md §4：形如 `ngt_ab…wxyz` */
export function displayHint(token: string): string {
  return `ngt_${token.slice(4, 6)}…${token.slice(-4)}`;
}
