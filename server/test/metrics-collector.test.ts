import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createMetricsCollector,
  MAX_TIMING_SAMPLES,
} from '../src/metrics/collector.ts';

// S8-T2 运维指标采集器单元面：进程内计数器（认证失败——identity §8「不逐条
// 入审计」的替代呈现）+ 校验耗时样本（架构 §10「校验耗时」；P50/P95 累计
// 分布）。递增/百分位语义先行 RED——端到端递增断言见 metrics-routes.test.ts。

test('认证失败计数：按入口累计 + total + last_at（identity §8 失败计数指标）', () => {
  const c = createMetricsCollector();
  const before = c.authFailureSnapshot();
  assert.equal(before.total, 0);
  assert.equal(before.last_at, null);

  c.recordAuthFailure('api');
  c.recordAuthFailure('api');
  c.recordAuthFailure('git');

  const after = c.authFailureSnapshot();
  assert.equal(after.total, 3);
  assert.equal(after.by_entry.api, 2);
  assert.equal(after.by_entry.git, 1);
  assert.equal(after.by_entry.web, 0);
  assert.equal(typeof after.last_at, 'string', '最近失败时间应呈现（ISO 字符串）');
  assert.ok(!Number.isNaN(Date.parse(after.last_at!)));
});

test('校验耗时：样本按 scope 独立累计，P50/P95 取最近邻秩（nearest-rank）', () => {
  const c = createMetricsCollector();
  // 4 样本 [10,20,30,40]：p50 秩 = ceil(0.5*4)=2 → 20；p95 秩 = ceil(0.95*4)=4 → 40
  for (const ms of [10, 20, 30, 40]) c.recordValidationRun('web-submit', ms);
  c.recordValidationRun('pre-receive', 7); // scope 独立，不混入 web-submit 分布

  const t = c.validationTimingSnapshot();
  assert.equal(t['web-submit']!.count, 4);
  assert.equal(t['web-submit']!.p50_ms, 20);
  assert.equal(t['web-submit']!.p95_ms, 40);
  assert.equal(t['web-submit']!.max_ms, 40);
  assert.equal(t['pre-receive']!.count, 1);
  assert.equal(t['pre-receive']!.p50_ms, 7);
  assert.equal(t['pre-receive']!.p95_ms, 7);
});

test('校验耗时：无样本时如实空（count 0、分位 null——不伪造 0ms）', () => {
  const c = createMetricsCollector();
  const t = c.validationTimingSnapshot();
  assert.equal(t['web-submit']!.count, 0);
  assert.equal(t['web-submit']!.p50_ms, null);
  assert.equal(t['web-submit']!.p95_ms, null);
  assert.equal(t['web-submit']!.max_ms, null);
});

test('校验耗时：样本窗口有界——count 记终身累计，分位取最近样本窗口', () => {
  const c = createMetricsCollector();
  const total = MAX_TIMING_SAMPLES + 8;
  for (let i = 1; i <= total; i++) c.recordValidationRun('web-submit', i); // 1..total
  const t = c.validationTimingSnapshot();
  assert.equal(t['web-submit']!.count, total, 'count = 终身累计次数');
  // 窗口保留最后 MAX_TIMING_SAMPLES 个：9..total；max = total
  assert.equal(t['web-submit']!.max_ms, total);
  const retained = Array.from({ length: MAX_TIMING_SAMPLES }, (_, k) => k + 9); // 9..520
  retained.sort((a, b) => a - b);
  const rank = (p: number): number => retained[Math.ceil((p / 100) * retained.length) - 1]!;
  assert.equal(t['web-submit']!.p50_ms, rank(50));
  assert.equal(t['web-submit']!.p95_ms, rank(95));
});

test('毫秒值取整呈现（performance.now 浮点差不进响应面）', () => {
  const c = createMetricsCollector();
  c.recordValidationRun('web-submit', 12.7);
  const t = c.validationTimingSnapshot();
  assert.equal(t['web-submit']!.p50_ms, 13);
});

test('快照只读：snapshot 返回的是拷贝，外部突变不污染后续快照', () => {
  const c = createMetricsCollector();
  c.recordAuthFailure('web');
  const snap = c.authFailureSnapshot();
  (snap.by_entry as Record<string, number>).web = 999;
  assert.equal(c.authFailureSnapshot().by_entry.web, 1);
});
