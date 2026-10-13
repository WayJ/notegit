/**
 * 备份 manifest 形状（S8-T4；backup-recovery §4 步骤 6 全字段 + §6 分置两件）。
 *
 * manifest 是 §7/§8 一切核对的依据（D-BR-03）：离线验证（verify.ts）与恢复流程
 * （S8-T5）逐字段消费本形状；字段演进必须同时过 verify 的必填字段清单
 * （REQUIRED_MANIFEST_FIELDS）。
 *
 * 「各件字节数」口径：件的**内容**字节合计（data 件不含 manifest.json 自身——
 * 自含哈希不可构造；文件级清单 files[] 同样不含 manifest.json）。
 */

/** 备份工具版本（随 server 包演进；manifest.backup_tool_version 记录用） */
export const BACKUP_TOOL_VERSION = '0.1.0';

/** 单文件完整性条目：路径相对所在件根（正斜杠），字节与 SHA-256 */
export interface BackupManifestFileEntry {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

/** 每库条目（D-BR-03：每库默认分支 HEAD OID；空库 unborn → null） */
export interface BackupManifestVault {
  readonly id: number;
  readonly slug: string;
  readonly default_branch: string;
  readonly head_oid: string | null;
}

/** 备份清单（随数据件存放：<backup_id>-data/manifest.json） */
export interface BackupManifest {
  readonly backup_id: string;
  readonly app_version: string;
  readonly backup_tool_version: string;
  /** 主机标识（任务补记字段：跨机核对产物来源） */
  readonly host: string;
  readonly db: {
    readonly engine: 'sqlite';
    readonly engine_version: string;
    readonly schema_version: number;
  };
  readonly time: {
    /** §4 步骤 1 t0（维护开启时刻；亦为 M4(a) 口径下快照内运维行的时序界标） */
    readonly maintenance_enabled_at: string;
    readonly completed_at: string;
    readonly maintenance_duration_ms: number;
  };
  readonly vault_count: number;
  readonly vaults: readonly BackupManifestVault[];
  readonly items: {
    readonly data: {
      readonly dir_name: string;
      /** 内容字节合计（不含 manifest.json） */
      readonly bytes: number;
      readonly domains: { readonly git: number; readonly db: number; readonly config: number };
      readonly files: readonly BackupManifestFileEntry[];
    };
    readonly keys: {
      readonly dir_name: string;
      readonly bytes: number;
      readonly files: readonly BackupManifestFileEntry[];
    };
  };
  /** §4 步骤 2 排空实况（timeout 仅出现在管理员显式继续的异常态路径——backup §4） */
  readonly drain: { readonly outcome: 'drained' | 'timeout'; readonly waited_ms: number };
  /**
   * 步骤 4 抽样 fsck 记录。failures 非空不会出现在成功产物里：fsck 非零一律
   * 中止备份（损坏库不出备份件），字段为消费方保持稳定形状。
   */
  readonly fsck: {
    readonly mode: 'sample' | 'all' | 'none';
    readonly sample_size: number;
    readonly checked: readonly number[];
    readonly failures: readonly string[];
  };
}

/** 离线验证的必填字段清单（verify.ts 逐项核对；新字段在此登记） */
export const REQUIRED_MANIFEST_FIELDS: readonly string[] = [
  'backup_id',
  'app_version',
  'backup_tool_version',
  'host',
  'db.engine',
  'db.engine_version',
  'db.schema_version',
  'time.maintenance_enabled_at',
  'time.completed_at',
  'time.maintenance_duration_ms',
  'vault_count',
  'vaults',
  'items.data.dir_name',
  'items.data.bytes',
  'items.data.domains',
  'items.data.files',
  'items.keys.dir_name',
  'items.keys.bytes',
  'items.keys.files',
  'drain.outcome',
  'drain.waited_ms',
  'fsck.mode',
  'fsck.checked',
  'fsck.failures',
];
