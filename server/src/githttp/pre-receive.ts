import { rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDatabase } from '../db/connection.ts';
import { createDbMembershipSource } from '../vaults/membership.ts';
import { branchWriteRules } from '../vaults/branch-rules.ts';
import { parseRemoteUser } from './cgi.ts';
import { runGit } from './git-spawn.ts';
import { isZeroOid, refCommandRejection, type RefCommand } from './ref-rules.ts';
import { collectRefDeltas, hookGitTraversal, knownPathsOfTip } from './validation-input.ts';
import { createValidator, type RefInput, type Report } from 'notegit-validation';
import { measureVaultBytes, newPushId, preRecordPendingPush, readPushBytes, settlePushRejected } from './receive-audit.ts';

/**
 * pre-receive hook（S3-T2 挂接 + S3-T4 逐提交校验 + S3-T5 ref 级规则唯一判定源
 * + S3-T6 receive 审计预记录；git receive-pack 在更新任何 ref 之前、全部命令已
 * 读入之后调用；拒绝即整包回滚——多 ref 全有或全无的原生语义）。
 *
 * 认证主体经 CGI 层透传的 REMOTE_USER 取得（api.md §8.4；不信任 commit author，
 * 架构 §4.4）；成员/角色与库配置实时直连库文件查询（NOTEGIT_DB 透传——与
 * Web/API 入口同一 vaults/vault_members 源，D-IC-05 无缓存；在途撤权在
 * HTTP 授权之后、执行点之前发生时在此 fail-closed 拒绝）。
 *
 * 判定层次（S3-T5 起 ref 级规则唯一判定源为 ref-rules.ts，与 update hook
 * 执行点复查同构；集成裁决 2026-10-13：授权先行、内容随后——廉价检查先失败）：
 * 1. 逐 ref 授权（refCommandRejection，架构 §4.3）：非 refs/heads 命名空间一律
 *    拒；默认分支删除全员拒；main_admin_only 开启时仅库管理员可写默认分支；
 *    reader 任何写拒；非默认分支编辑者创建/更新/删除放行。force push 由原生
 *    receive.denyNonFastForwards 拦截（不在本层）。任何授权拒绝即整包拒
 *    （内容校验不再运行——推送已被否决）。
 * 2. 逐提交内容校验（S3-T4，packages/validation 单一来源——sprint D7）：推送
 *    范围内全部新提交经 git 遍历组装为 CommitDelta（合并按父展开、根提交全
 *    检、E-PATH-004 全 tree 基线），报告按 validation.md §6.3 协议输出到
 *    stderr（含 rulesVersion）；报告原子落盘 <GIT_DIR>/notegit-validation.json
 *    （post-receive 终态 detail 消费）。拒绝时退出码取报告 exitCode（1=校验错误、
 *    2=运行错误，均整包拒绝）；任何遍历异常 fail-closed 拒绝。
 *
 * 审计链（S3-T6，storage-model §6）：receive 开始即预记 pending 行（每 ref 命令
 * 一行、主体/库/时间/旧新 commit + pushId + E-LIMIT-004/005 计量），预记录先于
 * 成员检查/校验/引用更新，写失败 fail-closed 整包拒绝；本 hook 的任何拒绝把全部
 * 行 settle 为 rejected；放行则行停留 pending，由 post-receive 按引用实际 OID 置
 * 终态（中断残留 → unresolved，见 receive-audit.ts / audit/reconciliation.ts）。
 *
 * 本文件既被 git 作为子进程执行（entry guard），也被单元测试导入其纯判定面
 * （refCommandRejection 已移驻 ref-rules.ts）——导入不触发 hook 行为。
 */

/** 审计挂接点落盘路径（T6 消费；裸库根目录，git 不入对象库） */
export function auditReportPath(gitDir: string): string {
  return path.join(path.resolve(gitDir), 'notegit-validation.json');
}

async function writeAuditReport(gitDir: string, report: Report): Promise<void> {
  const target = auditReportPath(gitDir);
  const tmp = `${target}.tmp-${process.pid.toString()}`;
  try {
    await writeFile(tmp, `${JSON.stringify(report)}\n`);
    await rename(tmp, target); // 原子替换：并发推送不会读到半写报告
  } catch (err) {
    // 落盘失败不改变推送判定（内容校验是闸门，审计核对是 T6 语义）——留痕继续
    console.error(`[notegit pre-receive] 警告：校验报告落盘失败（${target}）：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 错误 issue 的可读行（客户端 push stderr 直观可见；完整协议在报告 JSON） */
function issueLines(report: Report): string[] {
  const lines: string[] = [];
  for (const file of report.files) {
    for (const issue of file.issues) {
      if (issue.severity !== 'error') continue;
      const at = file.commit === undefined ? '' : `（提交 ${file.commit.slice(0, 7)}）`;
      lines.push(`${file.path}${at}：${issue.code} ${issue.message}`);
    }
  }
  for (const issue of report.issues ?? []) {
    if (issue.severity !== 'error') continue;
    const at = issue.ref === undefined ? '' : `${issue.ref}：`;
    lines.push(`${at}${issue.code} ${issue.message}`);
  }
  return lines;
}


// ── hook 进程入口（仅当 git 以本文件为可执行脚本调用时运行）────────────────

const invokedAsHook =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsHook) {
  void main();
}

async function main(): Promise<void> {
  let code = 1;
  try {
    code = await check();
  } catch (err) {
    console.error(`[notegit pre-receive] 异常拒绝：${err instanceof Error ? err.message : String(err)}`);
  }
  process.exit(code);
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      input += chunk;
    });
    process.stdin.on('end', () => resolve(input));
    process.stdin.on('error', () => resolve(input)); // stdin 不可读不挂死 hook
  });
}

/** 计量采集（E-LIMIT-004/005）：pushBytes=请求体字节（CONTENT_LENGTH 直取，chunked
 *  落盘计数文件）；vaultCurrentBytes=库目录存量占用（排除在途 quarantine）。 */
async function collectMetering(gitDir: string): Promise<Record<string, number>> {
  const metering: Record<string, number> = {};
  const contentLength = process.env['CONTENT_LENGTH'];
  if (contentLength !== undefined && /^\d+$/.test(contentLength)) {
    metering['pushBytes'] = Number(contentLength);
  } else {
    const file = process.env['NOTEGIT_PUSH_BYTES_FILE'];
    if (file !== undefined) {
      const n = await readPushBytes(file);
      if (n !== null) metering['pushBytes'] = n;
    }
  }
  try {
    const vaultBytes = await measureVaultBytes(path.resolve(gitDir));
    metering['vaultCurrentBytes'] = vaultBytes;
  } catch (err) {
    console.error(`[notegit pre-receive] 警告：库容量计量失败：${err instanceof Error ? err.message : String(err)}`);
  }
  return metering;
}

async function check(): Promise<number> {
  const parsed = parseRemoteUser(process.env['REMOTE_USER'] ?? '');
  const dbFile = process.env['NOTEGIT_DB'];
  const slug = process.env['NOTEGIT_VAULT_SLUG'];
  if (parsed === null || dbFile === undefined || slug === undefined) {
    console.error('[notegit pre-receive] 环境缺失（REMOTE_USER/NOTEGIT_DB/NOTEGIT_VAULT_SLUG）——fail-closed 拒绝');
    return 1;
  }
  const commands = (await readStdin())
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [oldOid = '', newOid = '', ref = ''] = line.split(' ');
      return { ref, oldOid, newOid } satisfies RefCommand;
    });

  const gitDir = process.env['GIT_DIR'] ?? '.';
  const pushId = process.env['NOTEGIT_PUSH_ID'] ?? newPushId();
  const vaultIdEnv = Number(process.env['NOTEGIT_VAULT_ID']);

  // 审计库连接（S3-T6 起读写：预记录 + 拒绝终态）
  const db = openDatabase(dbFile);
  try {
    // ── 审计预记录（storage-model §6 步骤 1）：先于成员检查/内容校验/引用更新。
    // 写失败 fail-closed 整包拒绝——宁可拒推送，不产生无审计的引用更新。
    const metering = await collectMetering(gitDir);
    let preRecorded = false;
    if (Number.isSafeInteger(vaultIdEnv) && commands.length > 0) {
      try {
        preRecordPendingPush(db, {
          subject: {
            employeeId: parsed.employeeId,
            carrierRef: `credential:${parsed.credentialId}`,
            entry: 'git',
          },
          vaultId: vaultIdEnv,
          commands,
          pushId,
          occurredAt: new Date().toISOString(),
          detail: metering,
        });
        preRecorded = true;
      } catch (err) {
        console.error(
          `[notegit pre-receive] 审计预记录失败——fail-closed 拒绝：${err instanceof Error ? err.message : String(err)}`,
        );
        return 1;
      }
    }

    const membership = createDbMembershipSource(db).lookup(slug, parsed.employeeId);
    if (membership === undefined) {
      console.error(`[notegit pre-receive] employee=${parsed.employeeId} 于 ${slug} 无成员关系（或授权后已撤权）——拒绝`);
      if (preRecorded) {
        settlePushRejected(db, { pushId, reason: 'authorization', detail: { why: 'membership-revoked-or-absent' } });
      }
      return 1;
    }
    const vault = db
      .prepare('SELECT default_branch, main_admin_only FROM vaults WHERE id = ?')
      .get(membership.vaultId) as { default_branch: string; main_admin_only: number } | undefined;
    if (vault === undefined) {
      console.error(`[notegit pre-receive] vault id=${membership.vaultId} 配置缺失——fail-closed 拒绝`);
      if (preRecorded) {
        settlePushRejected(db, { pushId, reason: 'authorization', detail: { why: 'vault-config-missing' } });
      }
      return 1;
    }
    const rules = branchWriteRules(vault);
    const role = membership.role;
    // 1. 逐 ref 授权：任何拒绝即整包否决（内容校验不再运行——集成裁决：授权先行）
    const rejections: string[] = [];
    for (const cmd of commands) {
      const rejection = refCommandRejection(cmd, rules, role);
      if (rejection !== null) rejections.push(rejection);
    }
    if (rejections.length > 0) {
      for (const rejection of rejections) console.error(`[notegit pre-receive] 拒绝：${rejection}`);
      if (preRecorded) {
        settlePushRejected(db, { pushId, reason: 'authorization', detail: { rules: rejections } });
      }
      return 1;
    }

    // 2. 逐提交内容校验（S3-T4）：git 遍历组装 → packages/validation 判定；
    //    计量输入（pushBytes/vaultCurrentBytes）挂接 E-LIMIT-004/005（阈值随 T8 配置生效）
    const traversal = hookGitTraversal(gitDir);
    const knownPaths = new Set<string>();
    const refs: RefInput[] = [];
    for (const cmd of commands) {
      if (isZeroOid(cmd.newOid)) {
        // 删除类命令无新提交可校验（授权层已放行）
        refs.push({ ref: cmd.ref, headOld: isZeroOid(cmd.oldOid) ? null : cmd.oldOid, headNew: null, commits: [] });
        continue;
      }
      if (!isZeroOid(cmd.oldOid)) {
        for (const p of await knownPathsOfTip(traversal, cmd.oldOid)) knownPaths.add(p);
      }
      const commits = await collectRefDeltas(traversal, cmd.ref, cmd.oldOid, cmd.newOid);
      refs.push({ ref: cmd.ref, headOld: isZeroOid(cmd.oldOid) ? null : cmd.oldOid, headNew: cmd.newOid, commits });
    }

    const report = await createValidator().validate({
      scope: 'pre-receive',
      vaultId: String(membership.vaultId),
      refs,
      knownPaths: [...knownPaths],
      pushBytes: metering['pushBytes'],
      vaultCurrentBytes: metering['vaultCurrentBytes'],
    });
    await writeAuditReport(gitDir, report);

    if (report.result !== 'pass') {
      console.error(
        `[notegit pre-receive] 内容校验未通过（rulesVersion=${report.rulesVersion}，result=${report.result}，exitCode=${report.exitCode}）`,
      );
      // 可读行封顶：海量违规时 stderr 不刷屏，完整清单以报告 JSON 为准
      for (const line of issueLines(report).slice(0, 20)) console.error(`[notegit pre-receive] 拒绝：${line}`);
      console.error(`[notegit pre-receive] report: ${JSON.stringify(report)}`);
      if (preRecorded) {
        settlePushRejected(db, {
          pushId,
          reason: 'validation',
          detail: {
            rulesVersion: report.rulesVersion,
            result: report.result,
            exitCode: report.exitCode,
            errorCount: report.summary.errorCount,
            warningCount: report.summary.warningCount,
          },
        });
      }
      return report.exitCode;
    }
    // 放行：审计行停留 pending，post-receive 核对引用实际结果后置终态
    // （storage-model §6 步骤 2–3；中断残留由 HTTP 层/启动清扫标待核对）
    console.error(
      `[notegit pre-receive] employee=${parsed.employeeId} ${slug}：${commands.length} 个 ref 命令全部通过（rulesVersion=${report.rulesVersion}，files=${report.summary.filesTotal}）`,
    );
    return 0;
  } finally {
    db.close();
  }
}
