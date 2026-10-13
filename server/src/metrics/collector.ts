/**
 * 运维指标采集器（S8-T2；架构 §10 最低清单的进程内计量面）。
 *
 * 两类进程内状态：
 * - **认证失败计数**（identity §8：「认证失败不逐条入审计（防噪音与日志填充），
 *   以失败计数指标呈现」——本计数器即该替代呈现的实现面）。挂接点 = 应用级
 *   onResponse 钩子按 401 响应归因（app.ts 接线）：凡统一认证缝判 E-AUTH-001..004
 *   的 401 都计入，按入口（api/web/git）分桶；登录限速 429、CSRF 403 等非认证
 *   失败不计。**不持久化**：进程生命周期内的运行态计数（重启归零，如实呈现）。
 * - **校验耗时样本**（架构 §10「校验耗时」）：runServerValidation（limits/engine
 *   判定点统一入口——web-submit 与 pre-receive 两 scope 同源）计时后记录。
 *   每样本 = {scope, durationMs}，按 scope 分桶、窗口有界（最近 MAX_TIMING_SAMPLES
 *   个）；P50/P95 取最近邻秩（nearest-rank）。**边界如实记录**：Git 推送的
 *   pre-receive 校验运行于 hook 子进程，其样本随子进程消亡——app 进程内的分布
 *   只覆盖 web-submit scope（生产形态）；失败次数类指标不受此影响（走审计面）。
 *
 * 失败推送/发布次数等**持久化指标不在本模块**：以审计行为唯一计数来源
 * （metrics/routes.ts 查询面——storage-model §5/§6 终态语义，不另立账本）。
 *
 * 形态选型：模块级共享实例 metricsCollector（app 接线与 engine 计时同源；
 * 与 limits/engine.ts 的 validatorCache 同款模块级先例）；createMetricsCollector
 * 供单元测试与未来多实例形态。
 */

/** identity §8 入口归因（与 audit 基座 AuditEntryKind 同集合） */
export type MetricsEntry = 'web' | 'api' | 'git';

/** 校验样本 scope（notegit-validation Report['scope'] 的服务端两个判定面） */
export type ValidationScope = 'web-submit' | 'pre-receive';

/** 分位/最大值呈现窗口（每 scope）；超出丢弃最旧样本——防无界内存增长 */
export const MAX_TIMING_SAMPLES = 512;

const SCOPES: readonly ValidationScope[] = ['web-submit', 'pre-receive'];

export interface AuthFailureSnapshot {
  readonly total: number;
  readonly by_entry: Readonly<Record<MetricsEntry, number>>;
  /** 最近一次认证失败时间（ISO；null = 尚无） */
  readonly last_at: string | null;
}

export interface ValidationTimingView {
  /** 终身累计次数（不受窗口裁剪影响） */
  readonly count: number;
  /** 最近邻秩 P50（窗口内；null = 无样本） */
  readonly p50_ms: number | null;
  readonly p95_ms: number | null;
  readonly max_ms: number | null;
}

export type ValidationTimingSnapshot = Readonly<Record<ValidationScope, ValidationTimingView>>;

export interface MetricsCollector {
  recordAuthFailure(entry: MetricsEntry): void;
  authFailureSnapshot(): AuthFailureSnapshot;
  recordValidationRun(scope: ValidationScope, durationMs: number): void;
  validationTimingSnapshot(): ValidationTimingSnapshot;
}

/** 最近邻秩分位（nearest-rank）：sorted 升序、秩 = ceil(p/100·n)（1 基） */
function nearestRank(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(Math.max(idx, 0), sorted.length - 1)]!;
}

export function createMetricsCollector(opts: { now?: () => Date } = {}): MetricsCollector {
  const now = opts.now ?? (() => new Date());
  const byEntry: Record<MetricsEntry, number> = { web: 0, api: 0, git: 0 };
  let total = 0;
  let lastAt: string | null = null;
  const samples = new Map<ValidationScope, number[]>(SCOPES.map((s) => [s, []]));
  const lifetime = new Map<ValidationScope, number>(SCOPES.map((s) => [s, 0]));

  return {
    recordAuthFailure(entry) {
      byEntry[entry] += 1;
      total += 1;
      lastAt = now().toISOString();
    },
    authFailureSnapshot() {
      return { total, by_entry: { ...byEntry }, last_at: lastAt };
    },
    recordValidationRun(scope, durationMs) {
      const window = samples.get(scope)!;
      window.push(durationMs);
      if (window.length > MAX_TIMING_SAMPLES) window.splice(0, window.length - MAX_TIMING_SAMPLES);
      lifetime.set(scope, lifetime.get(scope)! + 1);
    },
    validationTimingSnapshot() {
      const view = (scope: ValidationScope): ValidationTimingView => {
        const sorted = [...samples.get(scope)!].sort((a, b) => a - b);
        const pct = (p: number): number | null => {
          const v = nearestRank(sorted, p);
          return v === null ? null : Math.round(v);
        };
        return {
          count: lifetime.get(scope)!,
          p50_ms: pct(50),
          p95_ms: pct(95),
          max_ms: sorted.length === 0 ? null : Math.round(sorted[sorted.length - 1]!),
        };
      };
      return { 'web-submit': view('web-submit'), 'pre-receive': view('pre-receive') };
    },
  };
}

/** 模块级共享实例（app 接线 / engine 计时 / 路由读取三方同源） */
export const metricsCollector = createMetricsCollector();
