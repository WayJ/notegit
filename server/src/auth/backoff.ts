/**
 * 登录防暴力破解（identity §2）：按「账号 + 来源 IP」指数退避——连续失败后
 * 延迟随失败次数翻倍、封顶 maxDelayMs；无管理动作不永久锁定。
 * 计数为进程内运行态，不落库（storage-model §2）；api.md：窗口内 → 429 E-AUTH-005 + Retry-After。
 */

export interface LoginBackoffOptions {
  /** 免延迟的连续失败次数（超过后开始退避） */
  maxFails: number;
  /** 首次退避延迟 */
  baseDelayMs: number;
  /** 退避封顶（窗口封顶，identity §2） */
  maxDelayMs: number;
  /** 失败计数衰减窗口：静置超过该时长后重新计数 */
  windowMs: number;
}

/** 默认值（S2 定，identity §2「阈值可配，默认值 S2 实现定」；记录见 architecture-notes §6）。 */
export const DEFAULT_LOGIN_BACKOFF: LoginBackoffOptions = {
  maxFails: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  windowMs: 15 * 60_000,
};

interface Entry {
  fails: number;
  lastFailAt: number;
  lockedUntil: number;
}

export type BackoffCheck = { locked: false } | { locked: true; retryAfterMs: number };

export interface LoginBackoff {
  /** 登录尝试前检查：锁定中则拒绝（429），不校验口令、不计失败。 */
  check(username: string, ip: string, now: number): BackoffCheck;
  /** 口令校验失败后记录（含用户名不存在的失败）。 */
  recordFailure(username: string, ip: string, now: number): void;
  /** 登录成功后清零该键计数。 */
  recordSuccess(username: string, ip: string): void;
}

export function createLoginBackoff(options?: Partial<LoginBackoffOptions>): LoginBackoff {
  const opts = { ...DEFAULT_LOGIN_BACKOFF, ...options };
  const entries = new Map<string, Entry>();
  const key = (username: string, ip: string) => `${username}\u0000${ip}`;

  const delayFor = (fails: number): number =>
    fails <= opts.maxFails ? 0 : Math.min(opts.baseDelayMs * 2 ** (fails - opts.maxFails - 1), opts.maxDelayMs);

  return {
    check(username, ip, now) {
      const e = entries.get(key(username, ip));
      if (!e) return { locked: false };
      if (now < e.lockedUntil) return { locked: true, retryAfterMs: e.lockedUntil - now };
      return { locked: false };
    },
    recordFailure(username, ip, now) {
      const k = key(username, ip);
      const prev = entries.get(k);
      const e: Entry =
        prev && now - prev.lastFailAt <= opts.windowMs
          ? prev
          : { fails: 0, lastFailAt: 0, lockedUntil: 0 };
      e.fails += 1;
      e.lastFailAt = now;
      e.lockedUntil = Math.max(e.lockedUntil, now + delayFor(e.fails));
      entries.set(k, e);
    },
    recordSuccess(username, ip) {
      entries.delete(key(username, ip));
    },
  };
}
