import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { openDatabase } from '../db/connection.ts';
import { DRAIN_TIMEOUT_DEFAULT_MS } from '../maintenance/drain.ts';
import { runBackup, httpMaintenanceControl } from './run.ts';
import { DEFAULT_FSCK_SAMPLE_SIZE } from './snapshot.ts';
import { verifyBackupSet } from './verify.ts';
import { restoreOffline, restoreFinalize } from './restore.ts';

/**
 * 备份/恢复 CLI 入口（S8-T4 备份；S8-T5 恢复。备份触发 = 脚本模式——运行形态与
 * 理由见 docs/s1/backup-face-amendments.md B1；恢复运行手册见 restore-face-amendments）。
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
 *   node src/backup/cli.ts restore --data-item <数据件目录> --keys-item <密钥件目录> \
 *     --data-dir </data（目标须四域全新）>
 *
 *   node src/backup/cli.ts finalize --data-dir /data --url http://127.0.0.1:3000 \
 *     --token-file <file>
 *
 * 恢复流程（backup-recovery §7 十步，S8-T5 两相位）：restore（离线：pre-verify
 * 复用 T4 离线验证 → 目标全新 → 版本兼容 → §7 顺序装载 → 装载后完整性）→
 * 以 NOTEGIT_MAINTENANCE_ON_START=1 启动实例（§7 步骤 1）→ finalize（维护内：
 * §7 步骤 7 只读对账 + 步骤 9 触发 S5-T5 全量重建；不退出维护）→ §8 R1–R14
 * 清单全绿 → 显式退出维护（§7 步骤 10）。
 *
 * 凭据卫生：管理令牌只接受 --token-file 或 NOTEGIT_ADMIN_TOKEN 环境变量（argv
 * 明文在 ps/历史里可见，不提供）；输出一律不含令牌。
 */

export interface ParsedArgs {
  command: 'backup' | 'verify' | 'restore' | 'finalize';
  /** backup/finalize/restore：实例数据目录（restore 为目标目录）；verify：数据件目录 */
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
  node src/backup/cli.ts restore --data-item <数据件目录> --keys-item <密钥件目录> --data-dir </data>
        （离线相位：装载前复用离线验证；目标四域须全新——§7 步骤 2–6）
  node src/backup/cli.ts finalize --data-dir /data --url http://127.0.0.1:3000 --token-file <file>
        （实例侧相位：实例以 NOTEGIT_MAINTENANCE_ON_START=1 启动后执行——§7 步骤 7/9）
令牌来源：--token-file 或环境变量 NOTEGIT_ADMIN_TOKEN（不接受 argv 明文）。`;

function parseFsck(value: string): { mode: 'sample' | 'all' | 'none'; sampleSize?: number } {
  if (value === 'all') return { mode: 'all' };
  if (value === 'none') return { mode: 'none' };
  if (value === 'sample') return { mode: 'sample', sampleSize: 3 };
  const m = /^sample:(\d+)$/.exec(value);
  if (m !== null && Number(m[1]) > 0) return { mode: 'sample', sampleSize: Number(m[1]) };
  throw new Error(`--fsck 形态非法：${value}（可用 sample|sample:N|all|none）`);
}

/** 各子命令接受的值参数（互不混用：restore 不吃 --fsck，finalize 不吃 --out 等） */
const COMMAND_FLAGS: Readonly<Record<'backup' | 'verify' | 'restore' | 'finalize', ReadonlySet<string>>> = {
  backup: new Set(['--data-dir', '--out', '--keys-out', '--url', '--token-file', '--drain-timeout-ms', '--fsck']),
  verify: new Set(['--data-item', '--keys-item']),
  restore: new Set(['--data-item', '--keys-item', '--data-dir']),
  finalize: new Set(['--data-dir', '--url', '--token-file']),
};

/** 参数解析（纯函数；执行面在 main——测试直接消费本函数） */
export function parseBackupArgs(argv: readonly string[]): ParsedArgs {
  const [command, ...rest] = argv;
  if (command !== 'backup' && command !== 'verify' && command !== 'restore' && command !== 'finalize') {
    throw new Error(`未知子命令「${command ?? '(空)'}」\n${USAGE}`);
  }
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  const known = COMMAND_FLAGS[command];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--force-drain-timeout' && command === 'backup') {
      bools.add(arg);
      continue;
    }
    if (command === 'verify' && arg === '--fsck') {
      bools.add('--fsck-bool'); // verify 的 --fsck 是无值开关
      continue;
    }
    if (!arg.startsWith('--')) throw new Error(`未知参数「${arg}」\n${USAGE}`);
    if (!known.has(arg)) throw new Error(`未知参数「${arg}」（子命令 ${command} 不接受）\n${USAGE}`);
    const value = rest[i + 1];
    if (value === undefined) throw new Error(`参数 ${arg} 缺值\n${USAGE}`);
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

  if (command === 'restore') {
    const dataItem = flags.get('--data-item');
    const keysItem = flags.get('--keys-item');
    const dataDir = flags.get('--data-dir');
    if (!dataItem) throw new Error('restore 需要 --data-item <数据件目录>\n' + USAGE);
    if (!keysItem) throw new Error('restore 需要 --keys-item <密钥件目录>（分置两件——不猜测同级）\n' + USAGE);
    if (!dataDir) throw new Error('restore 需要 --data-dir <目标数据目录>（须四域全新——§7 前置）\n' + USAGE);
    return { command, dataItem, keysItem, dataDir };
  }

  if (command === 'finalize') {
    const dataDir = flags.get('--data-dir');
    const url = flags.get('--url');
    if (!dataDir) throw new Error('finalize 需要 --data-dir <实例数据目录>\n' + USAGE);
    if (!url) throw new Error('finalize 需要 --url <恢复实例基地址>\n' + USAGE);
    const tokenFile = flags.get('--token-file');
    const envToken = process.env.NOTEGIT_ADMIN_TOKEN;
    if (tokenFile === undefined && (envToken === undefined || envToken.length === 0)) {
      throw new Error('缺少管理令牌来源：--token-file <file> 或环境变量 NOTEGIT_ADMIN_TOKEN\n' + USAGE);
    }
    return { command, dataDir, url, tokenFile, envToken };
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
  if (args.command === 'restore' || args.command === 'finalize') {
    return runRestoreSubcommand(args);
  }
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

/** restore / finalize 执行面（§7 两相位——runbook 见文件头注释） */
async function runRestoreSubcommand(args: ParsedArgs): Promise<number> {
  if (args.command === 'restore') {
    const result = await restoreOffline({
      dataItemDir: args.dataItem!,
      keysItemDir: args.keysItem!,
      dataDir: args.dataDir!,
    });
    for (const c of result.checks) {
      console.log(`${c.ok ? '✓' : '✗'} ${c.name}${c.detail !== undefined ? ` — ${c.detail}` : ''}`);
    }
    console.log(`离线装载完成：backup_id=${result.manifest.backup_id}（${result.manifest.vault_count} 库）→ ${args.dataDir}`);
    console.log('下一步（backup §7）：');
    console.log(`  1. 以维护态启动实例：NOTEGIT_MAINTENANCE_ON_START=1（数据目录 ${args.dataDir}）`);
    console.log(`  2. node src/backup/cli.ts finalize --data-dir ${args.dataDir} --url http://127.0.0.1:3000 --token-file <恢复实例的管理员令牌>`);
    console.log('  3. §8 R1–R14 恢复验证清单全绿后，显式退出维护（DELETE /api/v1/admin/maintenance）');
    return 0;
  }

  const token = args.tokenFile !== undefined ? (await readFile(args.tokenFile, 'utf8')).trim() : args.envToken!;
  const result = await restoreFinalize({
    baseUrl: args.url!,
    token,
    dataDir: args.dataDir!,
  });
  console.log(`✓ 对账（§7 步骤 7）：无残留；${result.reconcile.refsChecked} 个 ref 与审计 old→new 成链一致`);
  console.log(
    `✓ 索引全量重建（§7 步骤 9）：state=${result.rebuild.state} done=${result.rebuild.done}/${result.rebuild.total}（finished_at=${result.rebuild.finished_at ?? '—'}）`,
  );
  console.log('finalize 完成：实例仍处维护模式——执行 §8 R1–R14 清单，全绿后显式退出维护（§7 步骤 10）');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (err) {
    console.error(`备份失败：${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
