import { verifyPassword } from './password.ts';

/**
 * S2-T3 对共享口令模块（S2-T2 落地的 server/src/auth/password.ts）的补充：
 * 口令策略校验（E-AUTH-008）与登录等时防枚举。实现放独立文件，保持对共享
 * 模块的零改动（并行分支合并零冲突；协调人 2026-10-12 批复的消费方式）。
 */

// 固定假哈希（PHC 由独立实现 hash-wasm 生成，口令已丢弃）：登录时用户名不存在
// 也执行一次等时 verify，使「用户不存在」与「口令错误」耗时一致，配合统一失败
// 文案防时序枚举。校验经共享模块（@node-rs/argon2）——本身即跨实现互操作性证据。
const DUMMY_HASH = '$argon2id$v=19$m=19456,t=2,p=1$h82b842Ah/0MRO+sARNbDg$/drFLD+k0cUWXXeFfsMPWX374aO2tLo/OcbDa/e9Jqc';

/** 等时失败校验：对任意输入耗时与真实校验一致，结果恒 false。 */
export async function verifyDummy(password: string): Promise<boolean> {
  return verifyPassword(DUMMY_HASH, password);
}

/** 口令策略（identity §2，NIST SP 800-63B 5.1.1）：仅长度 12–64（可配），无组合规则、无周期更换。 */
export interface PasswordPolicy {
  minLength: number;
  maxLength: number;
}

export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = { minLength: 12, maxLength: 64 };

export type PasswordValidation =
  | { ok: true }
  | { ok: false; code: 'E-AUTH-008'; message: string };

export function validateNewPassword(
  password: string,
  policy: PasswordPolicy = DEFAULT_PASSWORD_POLICY,
): PasswordValidation {
  const length = [...password].length; // 按 Unicode 码点计数
  if (length < policy.minLength || length > policy.maxLength) {
    return {
      ok: false,
      code: 'E-AUTH-008',
      message: `口令长度需在 ${policy.minLength}–${policy.maxLength} 个字符之间`,
    };
  }
  return { ok: true };
}
