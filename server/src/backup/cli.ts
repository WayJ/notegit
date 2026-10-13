import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { openDatabase } from '../db/connection.ts';
import { DRAIN_TIMEOUT_DEFAULT_MS } from '../maintenance/drain.ts';
import { runBackup, httpMaintenanceControl } from './run.ts';
import { DEFAULT_FSCK_SAMPLE_SIZE } from './snapshot.ts';
import { verifyBackupSet } from './verify.ts';

/**
 * 备份 CLI 入口（S8-T4；备份触发 = 脚本模式——运行形态与理由见
 * docs/s1/backup-face-amendments.md B1）。
 *
 * 用法（容器内 WORKDIR=/app/server；主机侧同仓 `node src/backup/cli.ts`）：
 *
 *   node src/backup/cli.ts backup --data-dir /data --out /backup \
 *     --url http://127.0.0.1:3000 --token-file /run/secrets/admin.token \
 *     [--keys-out /other-media] [--drain-timeout-ms 300000] \
 *     [--fsck sample|sample:N|all|none] [--force-drain-timeout]
 *
 *   node src/backup/cli.ts verify --data-item <数据件目录> \
 *     [--keys-item <密钥件目录>] [--fsck]
 *
 * 备份触发流程（backup-recovery §4）：经运行实例维护端点开闸（t0）→ 排空
 * （T3 原语，超时中止且保持维护）→ 快照核（VACUUM INTO / git 复制+fsck / config
 * 与 keys 分置两件）→ manifest → 关闸 → 健康检查 → backup.completed 审计行
 * （指标面「备份完成时间」随即更新）。步骤 8 离线验证独立执行（verify）。
 *
 * 凭据卫生：管理令牌只接受 --token-file 或 NOTEGIT_ADMIN_TOKEN 环境变量（argv
 * 明文在 ps/历史里可见，不提供）；输出一律不含令牌。
 */

export interface ParsedArgs {
  command: 'backup' | 'verify';
  /** backup：实例数据目录；verify：数据件目录 */
  dataDir?: string;
  dataItem?: string;
  out?: string;
  keysOut?: string;
  keysItem?: string;
  url?: string;
  tokenFile?: string;
  envToken?: string;
  drainTimeoutMs?: number;
  /** backup：fsck 抽样形态；verify：全量 fsck 复核开关 */
  fsck?: { mode: 'sample' | 'all' | 'none'; sampleSize?: number } | boolean;
  forceAfterDrainTimeout?: boolean;
}

const USAGE = `用法：
  node src/backup/cli.ts backup --data-dir /data --out /backup --url http://127.0.0.1:3000 \\
        --token-file <file> [--keys-out <dir>] [--drain-timeout-ms 300000] \\
        [--fsck sample|sample:N|all|none] [--force-drain-timeout]
  node src/backup/cli.ts verify --data-item <数据件目录> [--keys-item <密钥件目录>] [--fsck]
令牌来源：--token-file 或环境变量 NOTEGIT_ADMIN_TOKEN（不接受 argv 明文）。`;

function parseFsck(value: string): { mode: 'sample' | 'all' | 'none'; sampleSize?: number } {
  if (value === 'all') return { mode: 'all' };
  if (value === 'none') return { mode: 'none' };
  if (value === 'sample') return { mode: 'sample', sampleSize: 3 };
  const m = /^sample:(\d+)$/.exec(value);
  if (m !== null && Number(m[1]) > 0) return { mode: 'sample', sampleSize: Number(m[1]) };
  throw new Error(`--fsck 形态非法：${value}（可用 sample|sample:N|all|none）`);
}

/** 参数解析（纯函数；执行面在 main——测试直接消费本函数） */
export function parseBackupArgs(argv: readonly string[]): ParsedArgs {
  const [command, ...rest] = argv;
  if (command !== 'backup' && command !== 'verify') {
    throw new Error(`未知子命令「${command ?? '(空)'}」\n${USAGE}`);
  }
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  const known = new Set([
    '--data-dir', '--out', '--keys-out', '--url', '--token-file',
    '--drain-timeout-ms', '--fsck', '--data-item', '--keys-item',
  ]);
  const knownBools = new Set(['--force-drain-timeout', '--fsck-bool']);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--force-drain-timeout') {
      bools.add(arg);
      continue;
    }
    if (command === 'verify' && arg === '--fsck') {
      bools.add('--fsck-bool'); // verify 的 --fsck 是无值开关
      continue;
    }
    if (!arg.startsWith('--')) throw new Error(`未知参数「${arg}」\n${USAGE}`);
    const value = rest[i + 1];
    if (value === undefined) throw new Error(`参数 ${arg} 缺值\n${USAGE}`);
    if (!known.has(arg)) throw new Error(`未知参数「${arg}」\n${USAGE}`);
    flags.set(arg, value);
    i++;
  }

  if (command === 'backup') {
    const dataDir = flags.get('--data-dir');
    const out = flags.get('--out');
    const url = flags.get('--url');
    if (!dataDir) throw new Error('backup 需要 --data-dir <实例数据目录>\n' + USAGE);
    if (!out) throw new Error('backup 需要 --out <备份输出根目录>\n' + USAGE);
    if (!url) throw new Error('backup 需要 --url <实例基地址>（维护端点/健康检查经实例——backup §3）\n' + USAGE);
    const tokenFile = flags.get('--token-file');
    const envToken = process.env.NOTEGIT_ADMIN_TOKEN;
    if (tokenFile === undefined && (envToken === undefined || envToken.length === 0)) {
      throw new Error('缺少管理令牌来源：--token-file <file> 或环境变量 NOTEGIT_ADMIN_TOKEN\n' + USAGE);
    }
    const drainRaw = flags.get('--drain-timeout-ms');
    const drainTimeoutMs = drainRaw === undefined ? DRAIN_TIMEOUT_DEFAULT_MS : Number(drainRaw);
    if (!Number.isFinite(drainTimeoutMs) || drainTimeoutMs <= 0) {
      throw new Error(`--drain-timeout-ms 形态非法：${drainRaw}`);
    }
    const fsckRaw = flags.get('--fsck');
    return {
      command,
      dataDir,
      out,
      url,
      tokenFile,
      envToken,
      drainTimeoutMs,
      fsck: fsckRaw === undefined ? { mode: 'sample', sampleSize: DEFAULT_FSCK_SAMPLE_SIZE } : parseFsck(fsckRaw),
      forceAfterDrainTimeout: bools.has('--force-drain-timeout'),
    };
  }

  const dataItem = flags.get('--data-item');
  if (!dataItem) throw new Error('verify 需要 --data-item <数据件目录>\n' + USAGE);
  return {
    command,
    dataItem,
    keysItem: flags.get('--keys-item'),
    fsck: bools.has('--fsck-bool'),
  };
}

/** CLI 主入口（返回进程退出码；打印不含令牌材料） */
export async function main(argv: readonly string[]): Promise<number> {
  const args = parseBackupArgs(argv);
  if (args.command === 'backup') {
    const token = args.tokenFile !== undefined ? (await readFile(args.tokenFile, 'utf8')).trim() : args.envToken!;
    const control = httpMaintenanceControl({ baseUrl: args.url!, token });
    // 独立连接（不占用应用进程句柄；WAL/busy_timeout 同款约定——排空后库静止，
    // VACUUM INTO 经本连接执行；backup.completed 审计行亦经本连接落库）
    const db = openDatabase(path.join(args.dataDir!, 'db', 'notegit.sqlite'));
    try {
      const result = await runBackup({
        db,
        dataDir: args.dataDir!,
        outRoot: args.out!,
        ...(args.keysOut !== undefined ? { keysOut: args.keysOut } : {}),
        control,
        ...(args.drainTimeoutMs !== undefined ? { drainTimeoutMs: args.drainTimeoutMs } : {}),
        ...(args.fsck !== undefined && typeof args.fsck === 'object' ? { fsck: args.fsck } : {}),
        forceAfterDrainTimeout: args.forceAfterDrainTimeout === true,
      });
      console.log(`备份完成：backup_id=${result.manifest.backup_id}`);
      console.log(`  数据件：${result.dataItemDir}`);
      console.log(`  密钥件：${result.keysItemDir}（分置两件；建议移至独立介质/访问控制域）`);
      console.log(
        `  库数：${result.manifest.vault_count}；排空：${result.manifest.drain.outcome}（${result.manifest.drain.waited_ms}ms）；fsck：${result.manifest.fsck.checked.length} 库`,
      );
      console.log('完成时间已记审计行并写入运维指标面（GET /api/v1/admin/metrics → backup.last_completed_at）。');
      console.log(`下一步（backup §4 步骤 8）：node src/backup/cli.ts verify --data-item ${result.dataItemDir}`);
      return 0;
    } finally {
      db.close();
    }
  }

  const res = await verifyBackupSet({
    dataItemDir: args.dataItem!,
    ...(args.keysItem !== undefined ? { keysItemDir: args.keysItem } : {}),
    fsck: args.fsck === true,
  });
  for (const c of res.checks) {
    console.log(`${c.ok ? '✓' : '✗'} ${c.name}${c.detail !== undefined ? ` — ${c.detail}` : ''}`);
  }
  console.log(res.ok ? '离线验证：全部通过' : '离线验证：存在失败项（见上）');
  return res.ok ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (err) {
    console.error(`备份失败：${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
