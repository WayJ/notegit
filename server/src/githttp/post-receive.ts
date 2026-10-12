import { pathToFileURL } from 'node:url';

/**
 * post-receive hook 挂接点（S3-T2 占位直通；**T6 消费**）：git 在全部 ref 已
 * 更新后调用（stdin 收到最终生效的 ref 命令列表）。T6 在此做 receive 审计
 * 预记录的终态核对（pending→succeeded 成链；中断残留标待核对）。占位期直通：
 * pre-receive 已放行即视为成功，退出码在此阶段不影响推送结果。
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
