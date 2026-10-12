import path from 'node:path';
import { readFile, unlink } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { openDatabase } from '../db/connection.ts';
import { runGit } from './git-spawn.ts';
import { auditReportPath } from './pre-receive.ts';
import { readPushBytes, settlePushByRefState } from './receive-audit.ts';

/**
 * post-receive hook（S3-T6 receive 审计终态核对；storage-model §6 步骤 3）：git 在
 * 全部 ref 更新完成后调用（stdin 为实际生效的 ref 命令列表）。本 hook 与 pre-receive
 * 经 CGI 环境共享 NOTEGIT_PUSH_ID / NOTEGIT_DB，按「引用实际 OID vs 行 new_commit」
 * 核对置终态——相等 succeeded（old→new 成链）、不等 rejected（update 拒绝/非快进等
 * 未到达预期值，不虚报成功）；终态 detail 消费 T4 的 notegit-validation.json
 * （rulesVersion）与计量终值。
 *
 * 中断兜底：本 hook 未跑或未跑完 → 行停留 pending，HTTP 层子进程退出清扫/启动清扫
 * 标待核对（unresolved，S8 恢复对账消费）；quarantine 原子性保证异常终止不落半写
 * 对象。退出码不影响推送结果（refs 已更新），异常只留痕。
 */

const invokedAsHook =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsHook) {
  void main();
}

async function main(): Promise<void> {
  try {
    await settle();
  } catch (err) {
    console.error(`[notegit post-receive] 终态核对异常（行留待清扫标待核对）：${err instanceof Error ? err.message : String(err)}`);
  }
  process.exit(0);
}

function drainStdin(): Promise<void> {
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.on('end', () => resolve());
    process.stdin.on('error', () => resolve()); // stdin 不可读不挂死 hook
  });
}

/** T4 报告（消费输入）：终态 detail 内嵌 rulesVersion 与结果概要 */
async function reportDetail(gitDir: string): Promise<Record<string, unknown>> {
  const detail: Record<string, unknown> = {};
  try {
    const report = JSON.parse(await readFile(auditReportPath(gitDir), 'utf8')) as {
      rulesVersion?: unknown;
      result?: unknown;
      exitCode?: unknown;
      summary?: { errorCount?: unknown };
    };
    if (typeof report.rulesVersion === 'string') detail['rulesVersion'] = report.rulesVersion;
    if (typeof report.result === 'string') detail['result'] = report.result;
    if (typeof report.exitCode === 'number') detail['exitCode'] = report.exitCode;
    if (typeof report.summary?.errorCount === 'number') detail['errorCount'] = report.summary.errorCount;
  } catch {
    // 报告缺失/畸形（并发推送 last-writer-wins 之外不应发生）——detail 只少不少
  }
  const file = process.env['NOTEGIT_PUSH_BYTES_FILE'];
  if (file !== undefined) {
    const pushBytes = await readPushBytes(file, 0); // 推送已结束，终值必已落盘
    if (pushBytes !== null) detail['pushBytes'] = pushBytes;
  }
  return detail;
}

async function settle(): Promise<void> {
  const dbFile = process.env['NOTEGIT_DB'];
  const pushId = process.env['NOTEGIT_PUSH_ID'];
  await drainStdin();
  if (dbFile === undefined || pushId === undefined) {
    // 无推送标识可核对（非 HTTP 接入形态）——行留待启动清扫标待核对
    return;
  }
  const gitDir = path.resolve(process.env['GIT_DIR'] ?? '.');
  const detail = await reportDetail(gitDir);
  const db = openDatabase(dbFile);
  try {
    await settlePushByRefState(db, {
      pushId,
      actualOf: async (ref) => {
        try {
          return (await runGit(['rev-parse', '--verify', ref], { cwd: gitDir })).trim();
        } catch {
          return null; // ref 不存在（如后续被删/从未创建）
        }
      },
      detail,
    });
  } finally {
    db.close();
  }
  const file = process.env['NOTEGIT_PUSH_BYTES_FILE'];
  if (file !== undefined) await unlink(file).catch(() => {}); // 计量文件生命周期=本次推送
}
