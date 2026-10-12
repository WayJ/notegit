import { spawn } from 'node:child_process';

/**
 * 异步 git 执行（S3-T2；N4 教训：对自家 HTTP 服务的 git 子命令一律异步 spawn——
 * execFileSync 阻塞事件循环自死锁，spike 两次踩中。同步形态被
 * gitrepo-static-rules.test.ts 静态规则 + 代码审查双重拦截）。
 *
 * 与 gitrepo/lifecycle.ts 的同名助手语义一致（退出码 0 → stdout，否则 reject
 * 含 stderr 尾部摘要）；S3-T2 起供 githttp 域共用。
 */
export function runGit(
  args: readonly string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: options.cwd });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, options.timeoutMs ?? 30_000);
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString('utf8'));
        return;
      }
      const tail = Buffer.concat(stderr).toString('utf8').trim().split('\n').slice(-3).join(' | ');
      reject(new Error(`git ${args[0]} failed (code=${code}${signal ? ` signal=${signal}` : ''}): ${tail}`));
    });
  });
}
