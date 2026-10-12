/**
 * 口令策略（identity §2，NIST SP 800-63B 5.1.1）：长度优先——最小 12（可配上限至 64），
 * 不强制组合规则、不强制周期更换。可配置化（app_settings）随 T5+ 落地。
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 64;

/** 返回 null 表示通过；否则返回错误文案（映射 422 E-AUTH-008）。 */
export function passwordPolicyError(password: unknown): string | null {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    return `口令长度须在 ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} 个字符之间`;
  }
  return null;
}
