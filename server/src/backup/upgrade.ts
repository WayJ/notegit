import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '../db/migrations.ts';
import { recordAuditEvent } from '../audit/audit.ts';
import { waitForDrain, DRAIN_TIMEOUT_DEFAULT_MS } from '../maintenance/drain.ts';
import { runBackupSnapshot, type SnapshotResult } from './snapshot.ts';
import { verifyBackupSet } from './verify.ts';
import { currentSchemaVersion } from './restore.ts';
import type { BackupManifest } from './manifest.ts';
import type { MaintenanceControl } from './run.ts';

/**
 * 升级编排（S8-T7；backup-recovery §9 升级迁移与回退框架的应用侧落地面）。
 *
 * §9 升级流程的机器可断言三件：
 *
 * 1. **preUpgradeBackup（升级前一致备份）**——T4 全链复用（经运行实例端点开闸 →
 *    T3 排空 → 快照核），差异仅一处：**维护不关闭**。§9 升级全程处于维护模式
 *    （备份 → 换镜像 → 启动自动迁移 → 冒烟 → 对账 → 显式退出），T4 备份完成即
 *    关闸（§4 步骤 7）是备份自身的收尾，不是升级的收尾——升级前备份若顺手关闸，
 *    换镜像窗口即脱离维护，违背 §9「升级全程维护、业务零写入」前提。完成审计行
 *    同为 backup.completed（注册表 kind），detail 增 upgrade_pre_backup 注记——
 *    回退按 §9 丢弃运维行时可辨。
 * 2. **enforcePreUpgradeBackupGate（D-BR-08 强制面）**——「升级前备份强制、未完成
 *    不得升级」：跳过被拒（无门）、无证据被拒、证据不可信（T4 离线验证全量复算）
 *    被拒、备份 schema 高于当前镜像被拒（该备份当前二进制读不懂，回退失据——
 *    D-BR-05 方向核对）。放行 = 备份件可验证且可回退。
 * 3. **verifyUpgradeMigration（启动后核对）**——新版本启动自动迁移（main.ts
 *    migrate → schema_version 有序可重入）之后的核对面：schema_version 恰为
 *    1..N 连续（N = 当前迁移链终点），每行恰一次、带 applied_at。旧库（缺末版）
 *    点名缺版本——「尚未升级完成」与「升级后被回退过」在此同形可检。
 *
 * 回退（§9 D-BR-05）不经本模块：回退 = 恢复升级前一致备份（T5 restore 两相位），
 * 不提供 schema 降级；回退后版本核对（schema_version == manifest 版本，无降级
 * 机构运转）由 restore 装载核对 + 本模块 verifyUpgradeMigration 在恢复实例上复跑
 * 共同覆盖（演练 deploy/scripts/upgrade-drill.mjs 断言化）。
 */

/** 升级域错误：stage 供调用方与演练脚本辨识（skip-pre-backup / evidence-invalid / migration-incomplete / drain） */
export class UpgradeError extends Error {
  readonly stage: string;
  constructor(
    message: string,
    stage: string,
  ) {
    super(message);
    this.name = 'UpgradeError';
    this.stage = stage;
  }
}

// ───────────────────── §9 升级前一致备份（维护不关闭） ─────────────────────

export interface PreUpgradeBackupOptions {
  /** 活库连接（维护模式内静止；与 backup CLI 同款独立连接） */
  readonly db: DatabaseSync;
  readonly dataDir: string;
  /** 备份输出根目录（升级前备份件——回退的唯一依据） */
  readonly outRoot: string;
  readonly keysOutRoot?: string;
  /** 运行实例的维护控制（与 T4 backup 同一条缝） */
  readonly control: MaintenanceControl;
  readonly now?: () => Date;
  readonly host?: () => string;
  readonly fsck?: { readonly mode: 'sample' | 'all' | 'none'; readonly sampleSize?: number };
  readonly appVersion?: string;
  /** 排空有界超时（缺省 300 秒，同 T4） */
  readonly drainTimeoutMs?: number;
  readonly drainPollMs?: number;
}

/** §9 升级前一致备份：开闸（幂等）→ 排空 → 快照核 → 完成审计行；**维护保持开启** */
export async function preUpgradeBackup(opts: PreUpgradeBackupOptions): Promise<SnapshotResult> {
  const now = opts.now ?? (() => new Date());
  const t0 = now();

  await opts.control.enable(); // 幂等：操作员已先开闸（§9 步骤序）则无迁移继续

  const drain = await waitForDrain(opts.db, {
    timeoutMs: opts.drainTimeoutMs ?? DRAIN_TIMEOUT_DEFAULT_MS,
    ...(opts.drainPollMs !== undefined ? { pollMs: opts.drainPollMs } : {}),
  });
  if (drain.outcome === 'timeout') {
    // T4 同款保守姿态：超时中止、维护保持开启（升级前备份没有「显式继续」通道——
    // §9 升级前备份是回退唯一依据，异常态下继续升级不可接受）
    throw new UpgradeError(
      `排空超时（${drain.timeoutMs}ms 内在途写未清零，pending=${drain.pending}）——已中止本次升级前备份；维护模式保持开启，请排查后重试`,
      'drain',
    );
  }

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

  // 完成审计行（运行态写入，不入备份一致性集合）：T4 同源 kind，detail 增升级注记
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
      upgrade_pre_backup: true,
    },
  });

  // §9：不关闸——换镜像/启动迁移/冒烟仍在维护内；退出维护是升级末步的显式操作
  return result;
}

// ───────────────────── D-BR-08：升级前备份强制（gate） ─────────────────────

export interface UpgradeGateOptions {
  /** 显式跳过请求——结构上不存在放行路径（D-BR-08 被拒备选「允许跳过」） */
  readonly skipBackup?: boolean;
  /** 升级前备份的数据件目录（含 manifest.json） */
  readonly dataItemDir?: string;
  readonly keysItemDir?: string;
  /** 当前镜像 schema 版本（缺省迁移链终点；测试可注入） */
  readonly schemaVersion?: number;
}

export interface UpgradeGateResult {
  readonly manifest: BackupManifest;
}

/**
 * D-BR-08 强制面：未完成升级前备份不得继续升级。
 * 放行条件 = 备份件通过 T4 离线验证（全量复算）且 schema 版本不高于当前镜像
 * （回退依据可被当前二进制恢复——D-BR-05 方向）。
 */
export async function enforcePreUpgradeBackupGate(opts: UpgradeGateOptions): Promise<UpgradeGateResult> {
  if (opts.skipBackup === true) {
    throw new UpgradeError(
      '升级前备份强制（D-BR-08）：不支持跳过——回退策略依赖该备份存在；先完成 §9 升级前一致备份（upgrade pre-backup），再继续升级',
      'skip-pre-backup',
    );
  }
  if (opts.dataItemDir === undefined || opts.dataItemDir.length === 0) {
    throw new UpgradeError(
      '升级前备份强制（D-BR-08）：未提供升级前备份证据（--data-item <升级前备份数据件>）——未完成备份不得升级',
      'missing-evidence',
    );
  }
  if (!existsSync(opts.dataItemDir)) {
    throw new UpgradeError(`升级前备份证据目录不存在：${opts.dataItemDir}——未完成备份不得升级（D-BR-08）`, 'missing-evidence');
  }

  const verified = await verifyBackupSet({
    dataItemDir: opts.dataItemDir,
    ...(opts.keysItemDir !== undefined ? { keysItemDir: opts.keysItemDir } : {}),
  });
  if (!verified.ok) {
    const bad = verified.checks.filter((c) => !c.ok).map((c) => `${c.name}：${c.detail ?? ''}`).join('；');
    throw new UpgradeError(
      `升级前备份证据未通过离线验证（产物不可信，不得升级——D-BR-08 完成以可验证为准）：${bad}`,
      'evidence-invalid',
    );
  }

  const manifest = JSON.parse(await readFile(path.join(opts.dataItemDir, 'manifest.json'), 'utf8')) as BackupManifest;
  const currentSchema = opts.schemaVersion ?? currentSchemaVersion();
  if (manifest.db.schema_version > currentSchema) {
    throw new UpgradeError(
      `升级前备份的 schema 版本 ${manifest.db.schema_version} 高于当前镜像 ${currentSchema}——该备份当前二进制无法恢复，回退失据（D-BR-05 不降级）；请以不低于备份版本的镜像执行升级`,
      'evidence-invalid',
    );
  }
  return { manifest };
}

// ───────────────────── §9 启动后核对：schema_version 形态 ─────────────────────

export interface MigrationRow {
  readonly version: number;
  readonly applied_at: string;
  readonly description: string;
}

export interface MigrationState {
  readonly rows: readonly MigrationRow[];
  /** 已应用版本（升序） */
  readonly versions: readonly number[];
  readonly maxApplied: number;
  /** 当前镜像迁移链终点（应与 maxApplied 相等——§9 随启动自动迁移到位） */
  readonly currentVersion: number;
}

/**
 * 新版本启动后的迁移核对面：schema_version 恰为 1..N 连续（N = 当前迁移链终点）、
 * 每行恰一次（append-only 触发器 + 主键共保）、带 applied_at（可重入复查的锚点）。
 * 缺行 = 迁移未完成（或被回退过的旧库）；点名缺失版本。
 */
export async function verifyUpgradeMigration(dataDir: string): Promise<MigrationState> {
  const dbFile = path.join(dataDir, 'db', 'notegit.sqlite');
  const db = new (await import('node:sqlite')).DatabaseSync(dbFile, { readOnly: true });
  let rows: MigrationRow[];
  try {
    const raw = db
      .prepare('SELECT version, applied_at, description FROM schema_version ORDER BY version')
      .all() as { version: number; applied_at: string; description: string }[];
    rows = raw;
  } finally {
    db.close();
  }

  const current = Math.max(...MIGRATIONS.map((m) => m.version));
  const versions = rows.map((r) => r.version);
  const missing: number[] = [];
  for (let v = 1; v <= current; v++) {
    if (!versions.includes(v)) missing.push(v);
  }
  const beyond = versions.filter((v) => v > current);
  if (missing.length > 0 || beyond.length > 0 || rows.length !== current) {
    throw new UpgradeError(
      `迁移核对未过：schema_version 应恰为 1..${current} 连续且无缺（§9 有序可重入）——缺失版本 [${missing.join(', ')}]` +
        (beyond.length > 0 ? `；超出当前迁移链的版本 [${beyond.join(', ')}]（库来自更新的镜像？D-BR-05 不降级）` : ''),
      'migration-incomplete',
    );
  }
  if (rows.some((r) => typeof r.applied_at !== 'string' || r.applied_at.length === 0)) {
    throw new UpgradeError('迁移核对未过：schema_version 存在缺 applied_at 的行（历史行不可改——§9 迁移表形态）', 'migration-incomplete');
  }
  return { rows, versions, maxApplied: versions[versions.length - 1] ?? 0, currentVersion: current };
}
