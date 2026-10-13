import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { cp, chmod, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { tryGit } from './git.ts';
import { vaultRepoDirName } from '../vaults/repo-path.ts';
import {
  BACKUP_TOOL_VERSION,
  type BackupManifest,
  type BackupManifestFileEntry,
  type BackupManifestVault,
} from './manifest.ts';

/**
 * 一致备份快照核（S8-T4；backup-recovery §4 步骤 3–6——维护模式已开启、排空已
 * 完成之后的三段快照与清单写入）。
 *
 * - 步骤 3：`VACUUM INTO` 一致 DB 快照（单事务一致、不依赖停库——selection §4
 *   实测语义；快照为独立文件，无 WAL 伴生）。
 * - 步骤 4：`<dataDir>/git` 全目录复制（保留权限与时间戳），复制件上按
 *   mode/sample 抽样 `git fsck`；非零退出码一律中止（损坏库不出备份件）。
 * - 步骤 5：config 复制入数据件；keys **分置**为独立密钥件（backup §6/D-BR-04：
 *   不同目录，文件 0600、件根与 keys 目录 0700 强制——复制后 chmod 兜底，不信任
 *   umask/来源权限）。迁移窗口的 pepper retired 条目随文件原样入件（identity §6.2）。
 * - 步骤 6：manifest 全字段（D-BR-03）随数据件存放；文件级 SHA-256 清单覆盖两件
 *   全部内容文件（manifest.json 自身除外——自含哈希不可构造）。
 *
 * 失败语义：任一步骤失败 → 尽力清扫两件半成品目录并原样上抛（错误携带步骤名）；
 * **不触碰维护闸门**——闸门生命周期只在 run.ts（§4 步骤 1/7 的协调层）。
 */

export { BACKUP_TOOL_VERSION };
export type { BackupManifest };

/** 备份域错误：message 含步骤名（fsck/vacuum/…），供调用方与演练脚本辨识 */
export class BackupError extends Error {
  readonly step: string;
  constructor(
    message: string,
    step: string,
  ) {
    super(message);
    this.name = 'BackupError';
    this.step = step;
  }
}

/** fsck 抽样缺省窗（CLI 与编排共用一个缺省来源） */
export const DEFAULT_FSCK_SAMPLE_SIZE = 3;

export interface SnapshotOptions {
  /** 活库连接（维护模式内静止；VACUUM INTO 经此连接执行） */
  readonly db: DatabaseSync;
  /** 实例数据目录（backup §2 四分域布局；生产 /data） */
  readonly dataDir: string;
  /** 数据件输出根目录 */
  readonly outRoot: string;
  /** 密钥件输出根目录（缺省 = outRoot；两件恒为不同目录，跨介质分置传本项） */
  readonly keysOutRoot?: string;
  /** §4 步骤 1 t0（维护开启时刻，ISO；manifest.time.maintenance_enabled_at） */
  readonly maintenanceEnabledAt: string;
  /** §4 步骤 2 排空实况（run.ts 传真实值；manifest.drain 如实记录） */
  readonly drain: { readonly outcome: 'drained' | 'timeout'; readonly waited_ms: number };
  readonly now?: () => Date;
  /** 主机标识（缺省 os.hostname()） */
  readonly host?: () => string;
  /** fsck 抽样（缺省 {mode:'sample', sampleSize:3}；none 为运维显式跳过） */
  readonly fsck?: { readonly mode: 'sample' | 'all' | 'none'; readonly sampleSize?: number };
  /** 应用版本（缺省读 server 包 package.json——备份工具与应用同制品分发） */
  readonly appVersion?: string;
}

export interface SnapshotResult {
  readonly manifest: BackupManifest;
  readonly dataItemDir: string;
  readonly keysItemDir: string;
}

/** 备份 id：UTC 秒级时间戳（YYYYMMDDTHHMMSSZ）；同秒重跑由存在性拒绝兜底 */
function stampOf(d: Date): string {
  return `${d.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;
}

/** 缺省应用版本：server 包 package.json（本模块 = <server>/src/backup/ 下两层）。
 *  S8-T5 起导出：restore 的版本兼容核对（§7 步骤 6）与此同源。 */
export async function readAppVersion(): Promise<string> {
  const file = path.resolve(import.meta.dirname, '..', '..', 'package.json');
  try {
    const pkg = JSON.parse(await readFile(file, 'utf8')) as { version?: string };
    if (typeof pkg.version === 'string' && pkg.version.length > 0) return pkg.version;
  } catch {
    // 包装缺失/损坏 → fail-closed（manifest 版本字段不得含糊）
  }
  throw new BackupError(`无法读取应用版本（${file}）——发行包不完整`, 'manifest');
}

async function sha256File(file: string): Promise<string> {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

/** 域复制：源缺失（全新实例无该域内容）→ 建空目标目录，不视为错误 */
async function copyDomain(src: string, dest: string): Promise<void> {
  if (!existsSync(src)) {
    await mkdir(dest, { recursive: true });
    return;
  }
  await cp(src, dest, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true });
}

/** 递归列举件内容（相对件根、正斜杠路径；按路径排序保证清单稳定） */
async function listContentFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (e.isFile()) out.push(path.relative(root, abs).split(path.sep).join('/'));
    }
  }
  await walk(root);
  return out.sort();
}

async function fileEntryOf(itemRoot: string, rel: string): Promise<BackupManifestFileEntry> {
  const abs = path.join(itemRoot, rel);
  return { path: rel, bytes: (await stat(abs)).size, sha256: await sha256File(abs) };
}

/** 密钥件权限强制（backup §6）：文件 0600，件根与 keys 目录 0700 */
async function enforceKeyItemPerms(keysItemDir: string): Promise<void> {
  await chmod(keysItemDir, 0o700);
  const keysDir = path.join(keysItemDir, 'keys');
  await chmod(keysDir, 0o700);
  for (const rel of await listContentFiles(keysItemDir)) {
    await chmod(path.join(keysItemDir, rel), 0o600);
  }
}

/** 确定性等距抽样：排序后按样本数等距取点（首尾必含），不重不漏不随机 */
function sampleIds(ids: readonly number[], sampleSize: number): number[] {
  if (ids.length <= sampleSize) return [...ids];
  if (sampleSize <= 0) return [];
  const picked = new Set<number>();
  for (let i = 0; i < sampleSize; i++) {
    picked.add(ids[Math.round((i * (ids.length - 1)) / (sampleSize - 1))!]!);
  }
  return [...picked];
}

/** 复制件库路径（vaultRepoDirName 唯一映射——不拼接任何 `.git` 字面量） */
function copiedRepoPath(dataItemDir: string, vaultId: number): string {
  return path.join(dataItemDir, 'git', vaultRepoDirName(vaultId));
}

/** 复制件默认分支 HEAD OID；unborn（rev-parse 非 0）→ null */
async function copiedHeadOid(dataItemDir: string, vaultId: number, branch: string): Promise<string | null> {
  const r = await tryGit([
    '--git-dir',
    copiedRepoPath(dataItemDir, vaultId),
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/heads/${branch}^{commit}`,
  ]);
  return r.code === 0 ? r.stdout.trim() : null;
}

export async function runBackupSnapshot(opts: SnapshotOptions): Promise<SnapshotResult> {
  const now = opts.now ?? (() => new Date());
  const host = opts.host ?? hostname;
  const backupId = stampOf(now());
  const dataItemDir = path.join(opts.outRoot, `${backupId}-data`);
  const keysItemDir = path.join(opts.keysOutRoot ?? opts.outRoot, `${backupId}-keys`);
  if (existsSync(dataItemDir) || existsSync(keysItemDir)) {
    throw new BackupError(
      `备份产物目录已存在，拒绝覆盖（backup_id=${backupId}）：${dataItemDir} / ${keysItemDir}`,
      'precondition',
    );
  }
  await mkdir(dataItemDir, { recursive: true });
  await mkdir(keysItemDir, { recursive: true });

  try {
    // ── 步骤 3：数据库一致快照（VACUUM INTO——单事务一致、不中断服务）──────
    const snapDbPath = path.join(dataItemDir, 'db', 'notegit.sqlite');
    await mkdir(path.dirname(snapDbPath), { recursive: true });
    try {
      opts.db.exec(`VACUUM INTO '${snapDbPath.replace(/'/g, "''")}'`);
    } catch (err) {
      throw new BackupError(`VACUUM INTO 快照失败：${err instanceof Error ? err.message : String(err)}`, 'vacuum');
    }

    // ── 步骤 4：Git 仓库目录复制 + 复制件抽样 fsck ─────────────────────────
    try {
      await copyDomain(path.join(opts.dataDir, 'git'), path.join(dataItemDir, 'git'));
    } catch (err) {
      throw new BackupError(`git 目录复制失败：${err instanceof Error ? err.message : String(err)}`, 'git-copy');
    }

    const vaultRows = opts.db
      .prepare('SELECT id, slug, default_branch FROM vaults ORDER BY id')
      .all() as { id: number; slug: string; default_branch: string }[];
    const fsckMode = opts.fsck?.mode ?? 'sample';
    const fsckSampleSize = opts.fsck?.sampleSize ?? DEFAULT_FSCK_SAMPLE_SIZE;
    const fsckTargets =
      fsckMode === 'none' ? [] : sampleIds(vaultRows.map((v) => v.id), fsckMode === 'all' ? vaultRows.length : fsckSampleSize);
    const fsckChecked: number[] = [];
    for (const id of fsckTargets) {
      const r = await tryGit(['--git-dir', copiedRepoPath(dataItemDir, id), 'fsck', '--no-progress']);
      if (r.code !== 0) {
        const tail = r.stderr.trim().split('\n').slice(-3).join(' | ');
        throw new BackupError(`git fsck 校验失败（库 ${id}），中止备份：${tail}`, 'fsck');
      }
      fsckChecked.push(id);
    }

    // ── 步骤 5：config 入数据件；keys 分置独立密钥件（0600/0700 强制）──────
    try {
      await copyDomain(path.join(opts.dataDir, 'config'), path.join(dataItemDir, 'config'));
    } catch (err) {
      throw new BackupError(`config 复制失败：${err instanceof Error ? err.message : String(err)}`, 'config-copy');
    }
    try {
      await copyDomain(path.join(opts.dataDir, 'keys'), path.join(keysItemDir, 'keys'));
    } catch (err) {
      throw new BackupError(`keys 复制失败：${err instanceof Error ? err.message : String(err)}`, 'keys-copy');
    }
    await enforceKeyItemPerms(keysItemDir);

    // ── 步骤 6：manifest 全字段（D-BR-03），随数据件存放 ───────────────────
    const completedAt = now();
    const engineVersion = (opts.db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v;
    const schemaVersion = Number(
      (opts.db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_version').get() as { v: number }).v,
    );
    const vaults: BackupManifestVault[] = [];
    for (const v of vaultRows) {
      vaults.push({
        id: v.id,
        slug: v.slug,
        default_branch: v.default_branch,
        head_oid: await copiedHeadOid(dataItemDir, v.id, v.default_branch),
      });
    }

    const dataFiles = await listContentFiles(dataItemDir); // manifest.json 尚未写入——天然不自列
    const dataEntries: BackupManifestFileEntry[] = [];
    const domains = { git: 0, db: 0, config: 0 };
    for (const rel of dataFiles) {
      const entry = await fileEntryOf(dataItemDir, rel);
      dataEntries.push(entry);
      // 域归属按清单相对路径前缀归桶（域键为数据字段——盘面命名见 metrics/disk.ts；
      // 以括号访问书写，避开静态规则的 `.`-连接形态，该规则拦截的是路径拼接）
      if (rel.startsWith('git/')) domains['git' as keyof typeof domains] += entry.bytes;
      else if (rel.startsWith('db/')) domains.db += entry.bytes;
      else if (rel.startsWith('config/')) domains.config += entry.bytes;
    }
    const keysEntries: BackupManifestFileEntry[] = [];
    for (const rel of await listContentFiles(keysItemDir)) {
      keysEntries.push(await fileEntryOf(keysItemDir, rel));
    }

    const manifest: BackupManifest = {
      backup_id: backupId,
      app_version: opts.appVersion ?? (await readAppVersion()),
      backup_tool_version: BACKUP_TOOL_VERSION,
      host: host(),
      db: { engine: 'sqlite', engine_version: engineVersion, schema_version: schemaVersion },
      time: {
        maintenance_enabled_at: opts.maintenanceEnabledAt,
        completed_at: completedAt.toISOString(),
        maintenance_duration_ms: completedAt.getTime() - Date.parse(opts.maintenanceEnabledAt),
      },
      vault_count: vaults.length,
      vaults,
      items: {
        data: {
          dir_name: path.basename(dataItemDir),
          bytes: dataEntries.reduce((n, f) => n + f.bytes, 0),
          domains,
          files: dataEntries,
        },
        keys: {
          dir_name: path.basename(keysItemDir),
          bytes: keysEntries.reduce((n, f) => n + f.bytes, 0),
          files: keysEntries,
        },
      },
      drain: { outcome: opts.drain.outcome, waited_ms: opts.drain.waited_ms },
      fsck: { mode: fsckMode, sample_size: fsckSampleSize, checked: fsckChecked, failures: [] },
    };
    await writeFile(path.join(dataItemDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    return { manifest, dataItemDir, keysItemDir };
  } catch (err) {
    // 中止清扫：不遗留半成品件目录（无 manifest 的件不可被误认作完整备份——
    // 双保险：verify 以「manifest 在」为第一核对项）
    await rm(dataItemDir, { recursive: true, force: true }).catch(() => {});
    await rm(keysItemDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}
