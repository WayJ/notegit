import type { DatabaseSync } from 'node:sqlite';
import { drainCount } from '../audit/audit.ts';

/**
 * §4 步骤 2 排空原语（S8-T3；backup-recovery §4 唯一语义源）：
 *
 * - 排空条件 = 权威数据上无 pending/unresolved 写操作（架构 §4.4「预先记录操作，
 *   再在引用更新后核对结果」：receive 开始预记录 pending，完成或拒绝后置终态）。
 *   判据即 storage-model §4 audit.drain_count 规范查询（drainCount）。
 * - 开启时机：单进程传播上界 0（backup §3）——闸门开启生效后立即可查，无需等待。
 * - 有界等待：默认 300 秒可配（timeoutMs）；轮询节奏 pollMs（快照方与测试可调）。
 * - 超时语义：返回 timeout，由调用方（备份流程 T4）**中止本次备份并保持维护模式**
 *   （backup §4 步骤 2：不半退出——管理员可显式选择继续，此时按 §5 异常态处理
 *   并记录）。本原语**不持有闸门**：结构上不存在「排空超时顺手关闸」的路径，
 *   维持/退出维护只能走维护生命周期端点（routes.ts）。
 * - 进度面：GET /api/v1/admin/maintenance 的 drain.pending（T2 指标面可直接消费）。
 */

/** backup §4 步骤 2：等待有界超时默认 300 秒（可配——DrainWaitOptions.timeoutMs） */
export const DRAIN_TIMEOUT_DEFAULT_MS = 300_000;

/** 缺省轮询节奏：250ms（无契约约束；快照窗口内的观察粒度） */
const DRAIN_POLL_DEFAULT_MS = 250;

export interface DrainWaitOptions {
  /** 有界等待上限（默认 300_000 = backup §4 步骤 2） */
  readonly timeoutMs?: number;
  /** 轮询节奏（默认 250ms；测试注入缩窗） */
  readonly pollMs?: number;
}

export type DrainOutcome =
  | { readonly outcome: 'drained'; readonly pending: 0; readonly waitedMs: number }
  | {
      readonly outcome: 'timeout';
      /** 到界时如实的在途计数（>0） */
      readonly pending: number;
      /** 实际生效的上限（缺省或注入值） */
      readonly timeoutMs: number;
      readonly waitedMs: number;
    };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 等待排空：首轮先查判据（无在途写立即返回，waitedMs=0）；在途则轮询至清零或到界。
 * 到界的最后一次检查仍以判据优先——恰在窗口边缘清零时按 drained 报告。
 */
export async function waitForDrain(db: DatabaseSync, opts: DrainWaitOptions = {}): Promise<DrainOutcome> {
  const timeoutMs = opts.timeoutMs ?? DRAIN_TIMEOUT_DEFAULT_MS;
  const pollMs = opts.pollMs ?? DRAIN_POLL_DEFAULT_MS;
  const startedAt = Date.now();
  for (;;) {
    const pending = drainCount(db);
    if (pending === 0) return { outcome: 'drained', pending: 0, waitedMs: Date.now() - startedAt };
    const waitedMs = Date.now() - startedAt;
    if (waitedMs >= timeoutMs) return { outcome: 'timeout', pending, timeoutMs, waitedMs };
    await sleep(Math.max(0, Math.min(pollMs, timeoutMs - waitedMs))); // 不睡过窗口边界
  }
}
