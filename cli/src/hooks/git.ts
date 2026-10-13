/** CLI 侧 git 执行助手（S6-T5；语义对齐 server/src/githttp/git-spawn.ts——异步 spawn 强制，
 * N4 自死锁教训：同步 execFile 阻塞事件循环，测试进程内起服务/子进程时双向冻结）。
 * 只做 git  plumbing 查询（rev-parse/ls-files/ls-tree/cat-file），绝不执行仓库内任何脚本。 */
import { spawn } from 'node:child_process'

/** 异步收集 git 输出；退出码非 0 → reject（含 stderr 尾部摘要）。超时 SIGKILL 防挂起。 */
export function runGitCollect(
  args: readonly string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: options.cwd })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let settled = false
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
    }, options.timeoutMs ?? 30_000)
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) {
        resolve(Buffer.concat(stdout))
        return
      }
      const tail = Buffer.concat(stderr).toString('utf8').trim().split('\n').slice(-3).join(' | ')
      reject(new Error(`git ${args[0]} failed (code=${code}${signal ? ` signal=${signal}` : ''}): ${tail}`))
    })
  })
}

/** 文本输出版（-z 输出按 utf8 解码——与 server 侧同约定：路径不经 C 引号包裹）。 */
export function runGitText(args: readonly string[], options: { cwd?: string; timeoutMs?: number } = {}): Promise<string> {
  return runGitCollect(args, options).then((b) => b.toString('utf8'))
}

/** blob 原始字节（附件/二进制按字节精确进校验）。 */
export function runGitBuffer(args: readonly string[], options: { cwd?: string; timeoutMs?: number } = {}): Promise<Buffer> {
  return runGitCollect(args, options)
}
