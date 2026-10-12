/**
 * 限制配置键注册表（S3-T8；validation.md §5.1 + validation-defaults.json）：
 * 契约配置键 ↔ packages/validation ValidationConfig 字段的唯一映射。键全集与
 * 契约默认值文件双向一致由测试运行时交叉核对（防漂移，D6——两处清单不手工同步）。
 *
 * 值域（写入与加载双侧校验，fail-closed）：
 * - 数值键：安全正整数（bytes/ms/计数语义，0 或负数无意义）；
 * - 清单键：字符串数组（空清单=合法收紧——附件全拒/特殊文件全拒是管理员选择）。
 * 值的机器形态为 JSON（storage-model §3.10：app_settings.value 与
 * validation-defaults.json 的类型一致；环境变量值同为 JSON 字面量）。
 */

/** 契约键 → ValidationConfig 字段（限 ConfigOverrides 可覆盖面） */
export const LIMIT_KEY_FIELDS = {
  'validation.limits.maxDocumentBytes': 'maxDocumentBytes',
  'validation.limits.maxAttachmentBytes': 'maxAttachmentBytes',
  'validation.limits.attachmentAllowedExtensions': 'attachmentAllowedExtensions',
  'validation.limits.maxPushBytes': 'maxPushBytes',
  'validation.limits.vaultCapacityBytes': 'vaultCapacityBytes',
  'validation.exemptions.additionalNavPatterns': 'additionalNavPatterns',
  'validation.exemptions.specialFilePatterns': 'specialFilePatterns',
  'validation.runtime.validationTimeoutMs': 'validationTimeoutMs',
  'validation.runtime.maxConcurrentValidations': 'maxConcurrentValidations',
  'validation.runtime.maxValidationMemoryMb': 'maxValidationMemoryMb',
} as const;

export type LimitKey = keyof typeof LIMIT_KEY_FIELDS;
export const LIMIT_KEYS = Object.keys(LIMIT_KEY_FIELDS) as readonly LimitKey[];
export type LimitValue = number | string[];

/** 配置键 → 环境变量名：NOTEGIT_ + 全大写、点与驼峰边界转下划线
 *  （maxPushBytes → MAX_PUSH_BYTES；部署级静态覆盖通道） */
export function envNameOf(key: LimitKey): string {
  return `NOTEGIT_${key
    .replaceAll('.', '_')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase()}`;
}

const LIST_KEYS = new Set<LimitKey>([
  'validation.limits.attachmentAllowedExtensions',
  'validation.exemptions.additionalNavPatterns',
  'validation.exemptions.specialFilePatterns',
]);

/** 解析并校验一个配置值（JSON 字面量 → 类型化值）。非法即抛错并指名配置键。 */
export function parseLimitValue(key: LimitKey, raw: string): LimitValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`配置键 ${key} 的值不是合法 JSON（${raw.slice(0, 60)}）：${err instanceof Error ? err.message : String(err)}`);
  }
  return validateLimitValue(key, parsed);
}

/** 类型校验（DB 行绕过写入面时加载侧兜底，defense in depth） */
export function validateLimitValue(key: LimitKey, value: unknown): LimitValue {
  if (LIST_KEYS.has(key)) {
    if (!Array.isArray(value) || value.some((x) => typeof x !== 'string')) {
      throw new Error(`配置键 ${key} 期望字符串数组（JSON），实际：${JSON.stringify(value)?.slice(0, 60)}`);
    }
    return [...(value as string[])];
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`配置键 ${key} 期望正整数的 JSON 数值，实际：${JSON.stringify(value)?.slice(0, 60)}`);
  }
  return value;
}
