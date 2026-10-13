import { recordAuditEvent } from '../audit/audit.ts';
import { waitForDrain, DRAIN_TIMEOUT_DEFAULT_MS } from '../maintenance/drain.ts';
import { BackupError, runBackupSnapshot, type SnapshotResult } from './snapshot.ts';

export { BackupError };

/**
 * 备份编排（S8-T4；backup-recovery §4 步骤 1–2、7——快照核之外的两段协调）：
 *
 * - 步骤 1：经**运行实例**的维护端点开启（POST /api/v1/admin/maintenance）。闸门是
 *   应用进程内同步标志（backup §3 生效机制）——备份执行者是另一进程，唯一诚实的
 *   开闸路径是实例自己的端点；enable 后经 GET 复核 enabled=true（fail-closed：
 *   控制面谎报则在快照前失败）。已处于维护态时幂等（POST 无迁移），t0 记编排起点。
 * - 步骤 2：消费 T3 排空原语 waitForDrain（判据 = audit.drain_count，含待核对行）。
 *   超时默认**中止本次备份并保持维护模式**（不半退出——编排层在超时路径不调用
 *   disable，结构上无「排空超时顺手关闸」）；`forceAfterDrainTimeout` 为管理员
 *   显式继续的异常态通道（§5 异常由恢复对账处置），manifest.drain 如实记 timeout。
 * - 步骤 3–6：runBackupSnapshot（快照核，失败清扫半成品且**不触碰闸门**——保持
 *   维护模式供排查，与排空超时同一保守姿态）。
 * - 步骤 7：关闭维护（DELETE 端点 + GET 复核）→ 健康检查（/healthz 200）通过 →
 *   记 `backup.completed` 审计行（storage-model §5 注册表 kind：直接终态、运行态
 *   写入、不入备份一致性集合）——「备份完成时间」指标（GET /api/v1/admin/metrics
 *   的 backup.last_completed_at，T2 预留字段）以审计行为唯一来源呈现最新行。
 *
 * 审计行主体形态：actor_kind=system（备份编排自身；操作者身份已由紧邻的
 * maintenance.enable 行携带——触发管理员在端点处归因）。
 */

/** 维护闸门控制缝：HTTP 实现（httpMaintenanceControl）面向运行实例；测试/内嵌形态可注入 */
export interface MaintenanceControl {
  /** 开启维护（幂等）；返回后实例已确证处于维护态（实现含复核） */
  enable(): Promise<void>;
  /** 关闭维护；返回后实例已确证退出维护态 */
  disable(): Promise<void>;
  /** 当前维护态（实例端点如实呈现） */
  isEnabled(): Promise<boolean>;
  /** 健康检查（backup §4 步骤 7：健康检查通过后才记完成时间） */
  healthCheck(): Promise<void>;
}

export interface HttpControlOptions {
  /** 实例基地址（如容器内 http://127.0.0.1:3000） */
  readonly baseUrl: string;
  /** 实例管理员 Bearer 凭据（仅内存传递；不落日志——凭据卫生，DOD-09 同则） */
  readonly token: string;
}

async function apiCall(
  method: string,
  path: string,
  opts: HttpControlOptions,
  expected: readonly number[],
): Promise<{ status: number; body: string }> {
  const res = await fetch(`${opts.baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${opts.token}` },
  });
  const body = await res.text();
  if (!expected.includes(res.status)) {
    let code = '';
    let message = '';
    try {
      const parsed = JSON.parse(body) as { error?: { code?: string; message?: string } };
      code = parsed.error?.code ?? '';
      message = parsed.error?.message ?? '';
    } catch {
      // 非信封响应（反代 502 等）——原样截断呈现
    }
    throw new BackupError(
      `维护控制请求失败：${method} ${path} → ${res.status}${code ? ` ${code}` : ''}${message ? ` ${message}` : ''}`,
      'control',
    );
  }
  return { status: res.status, body };
}

/** 运行实例的维护控制（生产脚本形态；经实例端点开/关闸并逐一复核） */
export function httpMaintenanceControl(opts: HttpControlOptions): MaintenanceControl {
  return {
    async enable(): Promise<void> {
      await apiCall('POST', '/api/v1/admin/maintenance', opts, [204]);
      if (!(await this.isEnabled())) {
        throw new BackupError('维护控制复核失败：POST 204 但端点报告 enabled=false', 'control');
      }
    },
    async disable(): Promise<void> {
      await apiCall('DELETE', '/api/v1/admin/maintenance', opts, [204]);
      if (await this.isEnabled()) {
        throw new BackupError('维护控制复核失败：DELETE 204 但端点报告 enabled=true', 'control');
      }
    },
    async isEnabled(): Promise<boolean> {
      const { body } = await apiCall('GET', '/api/v1/admin/maintenance', opts, [200]);
      const parsed = JSON.parse(body) as { enabled?: boolean };
      if (typeof parsed.enabled !== 'boolean') {
        throw new BackupError('维护进度面响应缺 enabled 字段', 'control');
      }
      return parsed.enabled;
    },
    async healthCheck(): Promise<void> {
      const res = await fetch(`${opts.baseUrl}/healthz`);
      const body = await res.text();
      if (res.status !== 200) {
        throw new BackupError(`健康检查未通过：/healthz → ${res.status}`, 'health');
      }
      try {
        const parsed = JSON.parse(body) as { status?: string };
        if (parsed.status !== 'ok') throw new Error(`status=${String(parsed.status)}`);
      } catch {
        throw new BackupError(`健康检查响应异常：${body.slice(0, 80)}`, 'health');
      }
    },
  };
}

export interface RunBackupOptions {
  readonly db: Parameters<typeof waitForDrain>[0];
  readonly dataDir: string;
  readonly outRoot: string;
  readonly keysOutRoot?: string;
  readonly control: MaintenanceControl;
  readonly now?: () => Date;
  readonly host?: () => string;
  readonly fsck?: { readonly mode: 'sample' | 'all' | 'none'; readonly sampleSize?: number };
  readonly appVersion?: string;
  /** §4 步骤 2 有界超时（默认 300 秒，同排空原语缺省） */
  readonly drainTimeoutMs?: number;
  readonly drainPollMs?: number;
  /** 管理员显式继续（异常态；缺省 false = 超时中止并保持维护） */
  readonly forceAfterDrainTimeout?: boolean;
}

/** 全流程编排（§4 步骤 1–7；步骤 8 离线验证独立命令 verify） */
export async function runBackup(opts: RunBackupOptions): Promise<SnapshotResult> {
  const now = opts.now ?? (() => new Date());

  // ── 步骤 1：开启维护（幂等）并复核，t0 = 编排起点 ─────────────────────────
  const t0 = now();
  await opts.control.enable();

  // ── 步骤 2：排空在途写（T3 原语；超时默认中止并保持维护模式）──────────────
  const drain = await waitForDrain(opts.db, {
    timeoutMs: opts.drainTimeoutMs ?? DRAIN_TIMEOUT_DEFAULT_MS,
    ...(opts.drainPollMs !== undefined ? { pollMs: opts.drainPollMs } : {}),
  });
  if (drain.outcome === 'timeout' && !opts.forceAfterDrainTimeout) {
    // 不半退出：超时路径直接上抛，disable 永不执行——闸门留在开启态供排查
    //（backup §4 步骤 2；退出维护只能走显式端点，M2 同语义）
    throw new BackupError(
      `排空超时（${drain.timeoutMs}ms 内在途写未清零，pending=${drain.pending}）——已中止本次备份；维护模式保持开启，请排查后在维护端点显式关闭`,
      'drain',
    );
  }

  // ── 步骤 3–6：快照核（失败清扫半成品、不触碰闸门）────────────────────────
  const result = await runBackupSnapshot({
    db: opts.db,
    dataDir: opts.dataDir,
    outRoot: opts.outRoot,
    ...(opts.keysOutRoot !== undefined ? { keysOutRoot: opts.keysOutRoot } : {}),
    maintenanceEnabledAt: t0.toISOString(),
    drain: { outcome: drain.outcome, waited_ms: drain.waitedMs },
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(opts.host !== undefined ? { host: opts.host } : {}),
    ...(opts.fsck !== undefined ? { fsck: opts.fsck } : {}),
    ...(opts.appVersion !== undefined ? { appVersion: opts.appVersion } : {}),
  });

  // ── 步骤 7：关闭维护 → 健康检查 → 备份完成审计行（运行态写入）────────────
  await opts.control.disable();
  await opts.control.healthCheck();
  recordAuditEvent(opts.db, {
    occurredAt: now().toISOString(),
    actorKind: 'system',
    entry: 'api',
    eventKind: 'backup.completed',
    detail: {
      backup_id: result.manifest.backup_id,
      data_item: result.manifest.items.data.dir_name,
      keys_item: result.manifest.items.keys.dir_name,
      vault_count: result.manifest.vault_count,
      maintenance_duration_ms: result.manifest.time.maintenance_duration_ms,
      drain_outcome: result.manifest.drain.outcome,
      fsck_checked: result.manifest.fsck.checked.length,
      host: result.manifest.host,
    },
  });
  return result;
}
