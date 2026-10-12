import { spawn } from 'node:child_process';

/**
 * 发布组件 git 执行（S3-T7）：与 githttp/git-spawn.ts 同语义（退出码 0 → stdout，
 * 否则 reject 含 stderr 尾部摘要；超时 SIGKILL；异步强制——N4 自死锁教训），
 * 额外支持 stdin 字节注入（hash-object/commit-tree -F -）与按调用附加 env
 * （请求级临时 index 的 GIT_INDEX_FILE、commit-tree 的身份/时间戳）——发布组件
 * 的 plumbing 形态需要这两项，githttp 既有导出面按「不动」约束不被扩改。
 */

export interface GitExecOptions {
  readonly cwd: string;
  /** 喂给子进程 stdin 的字节（hash-object --stdin / commit-tree -F -） */
  readonly stdin?: Buffer;
  /** 附加/覆盖环境变量（与 process.env 合并；undefined 值剔除该键） */
  readonly env?: Record<string, string | undefined>;
  readonly timeoutMs?: number;
}

export function execGit(args: readonly string[], options: GitExecOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: options.cwd,
      env: options.env === undefined ? process.env : { ...process.env, ...options.env },
    });
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
    if (options.stdin === undefined) child.stdin.end();
    else child.stdin.end(options.stdin);
  });
}
