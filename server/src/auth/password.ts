import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';
import type { Algorithm } from '@node-rs/argon2';

/**
 * 口令哈希（identity §2/D-IC-02）：Argon2id，参数严格按契约 m=19456 KiB、t=2、p=1
 * （OWASP Password Storage Cheat Sheet 最低推荐配置），盐随机内嵌于 modular（PHC）串。
 *
 * 选型：@node-rs/argon2 2.2.2（napi-rs 预编译二进制，含 linux-musl——node:24-alpine
 * 部署关键；PHC 格式与实现解耦，换库不影响已存哈希）。S2-T2 落地，S2-T3 复用并做
 * 验证性评审（含参数断言，经协调人 2026-10-12 批复）。
 */

/** 受邀未设口令的哨兵（非 PHC 形态，任何口令校验一律拒绝）。 */
export const INVITED_PASSWORD_SENTINEL = '!invited-no-password';

export async function hashPassword(password: string): Promise<string> {
  return argon2Hash(password, {
    algorithm: 2 as Algorithm, // Algorithm.Argon2id（ambient const enum 与 verbatimModuleSyntax 不兼容，以字面量钉住）
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
}

export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await argon2Verify(storedHash, password);
  } catch {
    // 库对畸形串（哨兵/空串/损坏数据）抛 InvalidArg：一律按校验失败处理（fail-closed，
    // 最坏情形是拒真，绝不认假——受邀未设口令的账号因此不可通过任何口令登录）
    return false;
  }
}
