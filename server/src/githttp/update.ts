import { pathToFileURL } from 'node:url';

/**
 * update hook 挂接点（S3-T2 占位直通；**T5 消费**）：git 在每个 ref 实际更新
 * 前逐 ref 调用（参数：refname、old、new；exit 非 0 只拒绝该 ref）。T5 在此
 * 叠加写路径执行点复查（identity §5.1 第 3 层：权限/分支规则实时复查，在途
 * 撤权拒绝）与分支范围规则。占位期必须直通——授权与内容校验由 pre-receive
 * 承担，此处置非零会误伤合法推送。
 */

const invokedAsHook =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsHook) {
  drainStdinThenExit();
}

function drainStdinThenExit(): void {
  process.stdin.resume();
  process.stdin.on('end', () => process.exit(0));
  process.stdin.on('error', () => process.exit(0)); // stdin 不可读不阻塞推送
}
