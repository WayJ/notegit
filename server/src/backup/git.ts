import { spawn } from 'node:child_process';

/**
 * 备份域 git 子进程助手（S8-T4；fsck 抽样与 HEAD OID 读取）。
 *
 * 与 gitrepo/lifecycle.ts 的 runGit 同款异步形态（N4 教训：同步 spawn 对自家
 * 服务自死锁；gitrepo-static-rules 静态规则拦截 sync 调用——本模块同受约束）。
 * 差异点：tryGit 不把非零退出码当异常——fsck/rev-parse 需要按退出码分支
 * （空库 unborn rev-parse 以码 1 表达，属预期形态而非失败）。
 */

export interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** 异步执行 git，永不因非零退出码 reject（spawn 错误仍 reject）；调用方按 code 分支 */
export function tryGit(args: readonly string[], options: { timeoutMs?: number } = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args);
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
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

/** 退出码 0 → stdout；否则抛错（含 stderr 摘要）——与 lifecycle.runGit 语义一致 */
export async function runGit(args: readonly string[], options: { timeoutMs?: number } = {}): Promise<string> {
  const r = await tryGit(args, options);
  if (r.code === 0) return r.stdout;
  const tail = r.stderr.trim().split('\n').slice(-3).join(' | ');
  throw new Error(`git ${args[0]} failed (code=${r.code}): ${tail}`);
}
