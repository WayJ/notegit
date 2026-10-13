/**
 * 限制配置引擎（S3-T8；validation-defaults.json 全键管理员可配置且真实生效）：
 *
 * 覆盖链（三级，越右越权威）：
 *   契约默认值（validation-defaults.json，经 notegit-validation defaultConfig）
 *   ← 环境变量（NOTEGIT_<大写下划线键名>——部署级静态覆盖，随进程启动读取）
 *   ← app_settings 行（storage-model §3.10——管理员运行时配置；同键胜环境：
 *     管理员运行时配置是权威配置面，环境值仅为缺行时的部署级缺省，避免环境
 *     静默凌驾管理面造成「配置了不生效」）。
 *
 * 生效语义（T8 裁决，记录于 notes §decision）：
 * - 全部键（判定型 validation.limits.* / validation.exemptions.* 与运维型
 *   validation.runtime.*）在每次判定点实时读取——热生效。pre-receive 每次推送
 *   开库读行（hook 进程与 app 进程同一 DB 文件，管理员改行下一次推送/提交即
 *   生效）；发布组件每请求读取。配置 ≠ 规则版本（validation.md §7.3-4），改
 *   配置不动 rulesVersion。
 * - 唯一的进程级例外：并发闸门（maxConcurrentValidations）持有共享计数状态，
 *   配置代次切换时闸门按新限制重建——重建瞬间的在途计数不跨代累计（运维型
 *   资源行为语义，瞬态窗口自愈，不涉及内容判定）。
 * - HTTP 传输护栏（bodyLimit，防滥用天花板）在应用组装时读取一次（重启生效）；
 *   正式判定（E-LIMIT-004）仍逐推送热生效——护栏只升不降（max(配置, 1GiB)），
 *   不会先于判定给出费解错误。
 *
 * fail-closed：环境值或 DB 行非法（非 JSON、类型不符、非正整数）→ 判定面抛错
 * 拒绝（宁可拒推送，不静默回退默认值——默认值可能松于管理员本意）。错误消息
 * 指名配置键。未知键忽略（向前兼容：新版本写入的键不破坏旧版本加载）。
 */
import type { DatabaseSync } from 'node:sqlite';
import {
  defaultConfig,
  withOverrides,
  createValidator,
  type ConfigOverrides,
  type Report,
  type ValidateInput,
  type ValidationConfig,
} from 'notegit-validation';
import { LIMIT_KEY_FIELDS, LIMIT_KEYS, envNameOf, parseLimitValue, validateLimitValue, type LimitKey, type LimitValue } from './keys.ts';
import { GIT_LIMIT_KEY_FIELDS, type GitLimitKey } from './git-gate.ts';
import { metricsCollector } from '../metrics/collector.ts';

export { LIMIT_KEY_FIELDS, LIMIT_KEYS, envNameOf, parseLimitValue, validateLimitValue } from './keys.ts';
export type { LimitKey, LimitValue } from './keys.ts';

/** 覆盖链输入：env 可注入（缺省 process.env）；db 可选（无 app_settings 表 = 零覆盖） */
export interface LimitsSource {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly db?: DatabaseSync;
}

/** 环境通道覆盖（键存在且值合法才进覆盖面） */
function envOverrides(env: Readonly<Record<string, string | undefined>>): ConfigOverrides {
  const out: Record<string, LimitValue> = {};
  for (const key of LIMIT_KEYS) {
    const raw = env[envNameOf(key)];
    if (raw === undefined || raw === '') continue;
    out[LIMIT_KEY_FIELDS[key]] = parseLimitValue(key, raw);
  }
  return out as ConfigOverrides;
}

/** app_settings 行覆盖；未知键忽略；缺表容忍（未迁移形态返回零覆盖）。
 *  git 域键（S8-T8，git-gate.ts 独立注册表）静默跳过——非本面键但非未知键，
 *  由 effectiveGitLimits 自行读行。 */
function dbOverrides(db: DatabaseSync | undefined): ConfigOverrides {
  if (db === undefined) return {};
  let rows: { key: string; value: string }[];
  try {
    rows = db.prepare('SELECT key, value FROM app_settings').all() as { key: string; value: string }[];
  } catch (err) {
    console.warn(`[notegit limits] app_settings 表不可读（按默认值继续）：${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
  const out: Record<string, LimitValue> = {};
  for (const row of rows) {
    const key = row.key as LimitKey;
    if (!(key in LIMIT_KEY_FIELDS)) {
      if (!(row.key in GIT_LIMIT_KEY_FIELDS)) {
        console.warn(`[notegit limits] 忽略未知配置键（向前兼容）：${row.key}`);
      }
      continue;
    }
    out[LIMIT_KEY_FIELDS[key]] = parseLimitValue(key, row.value);
  }
  return out as ConfigOverrides;
}

/** 合并覆盖（环境 ← DB，DB 同键胜） */
export function effectiveOverrides(source: LimitsSource = {}): ConfigOverrides {
  const env = source.env ?? process.env;
  return { ...envOverrides(env), ...dbOverrides(source.db) } as ConfigOverrides;
}

/** 全链生效配置（每次调用实时读取——热生效语义的实现面） */
export function effectiveConfig(source: LimitsSource = {}): ValidationConfig {
  return withOverrides(defaultConfig(), effectiveOverrides(source));
}

/** 写入一个配置行（upsert；键与值域校验；S8-T8 起兼收 git 域键）。HTTP 管理
 *  端点随 api.md 契约补录（storage-model §3.10「变更走管理端点并记审计」——
 *  audit kind 注册表已有 config.update 行、端点未入册，open 项见建议稿 G5）；
 *  本面先服务 ops/基准与未来端点。 */
export function setAppSetting(
  db: DatabaseSync,
  input: { key: LimitKey | GitLimitKey; value: LimitValue; updatedBy?: number; now?: string },
): void {
  if (!(input.key in LIMIT_KEY_FIELDS) && !(input.key in GIT_LIMIT_KEY_FIELDS)) {
    throw new Error(`未知配置键（不在 validation-defaults.json / git 域键集）：${String(input.key)}`);
  }
  const value = validateLimitValue(input.key, input.value);
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ).run(input.key, JSON.stringify(value), input.updatedBy ?? null, input.now ?? new Date().toISOString());
}

// ── 共享校验运行器 ─────────────────────────────────────────────────────────

type Validator = ReturnType<typeof createValidator>;

/** 进程级共享校验器缓存：同配置代次共用一个实例（并发闸门状态跨请求存续）；
 *  配置变化（覆盖面序列不同）→ 按新代次重建。多代实例并存无害（旧代仅服务
 *  在途调用，终态自然消亡）。 */
const validatorCache = new Map<string, Validator>();
const validatorOf = (overrides: ConfigOverrides): Validator => {
  const gen = JSON.stringify(overrides);
  let v = validatorCache.get(gen);
  if (v === undefined) {
    v = createValidator(overrides);
    validatorCache.set(gen, v);
  }
  return v;
};

/** 判定点统一入口：实时读取覆盖链（热生效）→ 共享闸门 → 单一来源校验。
 *  pre-receive（每推送一进程，闸门计 1）与发布组件（app 进程内跨请求共享）同源。
 *  input.config 若显式传入则叠加于生效覆盖之上（测试缝，生产路径不传）。
 *  S8-T2 起计时入指标采集器（架构 §10「校验耗时」；两 server scope 的唯一
 *  计时挂接点——web-submit 样本驻留 app 进程；pre-receive 样本随 hook 子进程
 *  消亡，指标面如实只呈现 web-submit 分布，失败次数类不受影响——走审计面）。 */
export async function runServerValidation(input: ValidateInput, source: LimitsSource = {}): Promise<Report> {
  const overrides = effectiveOverrides(source);
  const validator = validatorOf(overrides);
  const startedAt = performance.now();
  try {
    return await validator.validate(input);
  } finally {
    if (input.scope === 'web-submit' || input.scope === 'pre-receive') {
      metricsCollector.recordValidationRun(input.scope, performance.now() - startedAt);
    }
  }
}
