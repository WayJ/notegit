import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { openDatabase } from '../db/connection.ts';
import { httpMaintenanceControl } from '../backup/run.ts';
import { vaultRepoDirName } from '../vaults/repo-path.ts';
import { runRecoveryReconciliation, ReconciliationError } from './reconciliation.ts';

/**
 * 恢复对账 CLI 入口（S8-T6；backup-recovery §7 步骤 7 的触发形态）。
 *
 * 【选型记录：CLI（脚本形态）而非启动可选项】与 S8-T4 备份触发同裁决（建议稿
 * B1 同则）：维护闸门是应用进程内同步标志（backup §3 生效机制），对账器作为
 * 另一进程只能经运行实例的维护端点诚实断言维护态——启动可选项形态在应用
 * listen 之前无从断言；且恢复对账是恢复流程（§7 步骤 7）中的一次性显式动作，
 * 非常规启动步骤，自动形态会把「改写审计终态」耦合进每次重启（启动清扫已把
 * pending 标 unresolved，终态化留给显式恢复动作）。被拒备选：启动可选项。
 *
 * 用法（容器内 WORKDIR=/app/server；主机侧同仓 `node src/audit/reconcile-cli.ts`）：
 *
 *   node src/audit/reconcile-cli.ts reconcile --data-dir /data \
 *     --url http://127.0.0.1:3000 --token-file /run/secrets/admin.token [--json]
 *
 * 流程：断言实例处于维护模式（未开 → 退出码 2，不动任何行）→ pending/unresolved
 * 行按 refs 实际 OID 定终态 → 全库成链核对 → 孤儿双向核对 → 逐项+汇总报告
 * （--json 输出机器可读报告）。退出码：0 = 全部通过；1 = 存在不通过项（留人工
 * 裁决，维护不退出）；2 = 维护断言失败。完成不退维护——退出维护走维护生命周期
 * 端点（§7 步骤 10），本 CLI 结构上不触碰闸门。
 *
 * 凭据卫生：管理令牌只接受 --token-file 或 NOTEGIT_ADMIN_TOKEN 环境变量（argv
 * 明文在 ps/历史里可见，不提供）；输出一律不含令牌。
 */

export interface ParsedReconcileArgs {
  command: 'reconcile';
  dataDir?: string;
  url?: string;
  tokenFile?: string;
  envToken?: string;
  json?: boolean;
}

const USAGE = `用法：
  node src/audit/reconcile-cli.ts reconcile --data-dir /data --url http://127.0.0.1:3000 \\
        --token-file <file> [--json]
令牌来源：--token-file 或环境变量 NOTEGIT_ADMIN_TOKEN（不接受 argv 明文）。`;

/** 参数解析（纯函数；执行面在 main——测试直接消费本函数） */
export function parseReconcileArgs(argv: readonly string[]): ParsedReconcileArgs {
  const [command, ...rest] = argv;
  if (command !== 'reconcile') {
    throw new Error(`未知子命令「${command ?? '(空)'}」\n${USAGE}`);
  }
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  const known = new Set(['--data-dir', '--url', '--token-file']);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--json') {
      bools.add(arg);
      continue;
    }
    if (!arg.startsWith('--')) throw new Error(`未知参数「${arg}」\n${USAGE}`);
    const value = rest[i + 1];
    if (value === undefined) throw new Error(`参数 ${arg} 缺值\n${USAGE}`);
    if (!known.has(arg)) throw new Error(`未知参数「${arg}」\n${USAGE}`);
    flags.set(arg, value);
    i++;
  }
  const dataDir = flags.get('--data-dir');
  const url = flags.get('--url');
  if (!dataDir) throw new Error(`reconcile 需要 --data-dir <实例数据目录>\n${USAGE}`);
  if (!url) {
    throw new Error(`reconcile 需要 --url <实例基地址>（维护态断言经实例端点——backup §3）\n${USAGE}`);
  }
  const tokenFile = flags.get('--token-file');
  const envToken = process.env.NOTEGIT_ADMIN_TOKEN;
  if (tokenFile === undefined && (envToken === undefined || envToken.length === 0)) {
    throw new Error(`缺少管理令牌来源：--token-file <file> 或环境变量 NOTEGIT_ADMIN_TOKEN\n${USAGE}`);
  }
  return { command, dataDir, url, tokenFile, envToken, json: bools.has('--json') };
}

/** CLI 主入口（返回进程退出码；打印不含令牌材料） */
export async function main(argv: readonly string[]): Promise<number> {
  const args = parseReconcileArgs(argv);
  const token = args.tokenFile !== undefined ? (await readFile(args.tokenFile, 'utf8')).trim() : args.envToken!;
  const control = httpMaintenanceControl({ baseUrl: args.url!, token });
  // 独立连接（不占用应用进程句柄；WAL/busy_timeout 同款约定——维护中实例静止）
  const db = openDatabase(path.join(args.dataDir!, 'db', 'notegit.sqlite'));
  try {
    let report;
    try {
      report = await runRecoveryReconciliation({ db, dataDir: args.dataDir!, control });
    } catch (err) {
      if (err instanceof ReconciliationError) {
        console.error(`对账中止（${err.stage}）：${err.message}`);
        return 2;
      }
      throw err;
    }
    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
      return report.summary.ok ? 0 : 1;
    }
    for (const s of report.settled) {
      console.log(
        `· 审计行 #${s.id}（vault=${s.vaultId ?? '已删'} ${s.refName ?? '无 ref'}）：${s.from} → ${s.to}（new=${s.newCommit ?? '?'} 实际=${s.actualOid ?? '无'}）`,
      );
    }
    for (const chain of report.chains) {
      for (const p of chain.vaultProblems) {
        console.log(`✗ 库 ${chain.vaultId}：${p}`);
      }
      for (const r of chain.refs) {
        if (r.problems.length > 0) {
          console.log(`✗ 库 ${chain.vaultId} ${r.ref}：${r.problems.join('、')}（实际=${r.actualOid ?? '无'} 记录末条=${r.lastRecordedNew ?? '无'}）`);
        }
      }
    }
    for (const id of report.orphanRepoIds) {
      console.log(`✗ 孤儿仓库：git/${vaultRepoDirName(id)} 无 DB 行`);
    }
    for (const id of report.missingRepoIds) {
      console.log(`✗ 孤儿配置行：vaults#${id} 无仓库目录`);
    }
    const m = report.summary;
    console.log(
      `汇总：定终态 ${m.settled}（成功 ${m.succeeded} / 拒绝 ${m.rejected}）、残留 ${m.pendingResidue}、成链违例引用 ${m.chainViolationRefs}、孤儿仓库 ${m.orphanRepos}、缺失目录 ${m.missingRepos} → ${m.ok ? '全部通过' : '存在不通过项'}`,
    );
    console.log(
      `维护：起算已断言 ${report.maintenance.assertedAtStart}、收尾仍处维护 ${report.maintenance.stillEnabledAtEnd}——退出维护走维护端点（backup §7 步骤 10），本命令不退。`,
    );
    return m.ok ? 0 : 1;
  } finally {
    db.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (err) {
    console.error(`恢复对账失败：${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
