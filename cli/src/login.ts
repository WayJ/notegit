/**
 * notegit login（S6-T2）：username+token 登录。
 *
 * 形态依据 identity §3.1（ngt_ + 43 字符 base64url；Basic 用户名任意 + token 作口令）。
 * 引导码端点在 api.md 不存在（bootstrap 仅为实例初始化）→ 缺口记录于任务 note。
 * 红线：令牌不接受命令行参数（进程列表泄漏）、不写 remote URL/仓库文件/日志（identity §3.1）；
 * 唯一落盘 = credentials.ts 的 0600 凭据文件；stdout 只出现掩码（ngt_ab…wxyz 形，api.md §4 display_hint 同款）。
 */
import { createInterface } from 'node:readline'
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import process from 'node:process'
import { credentialsFilePath, storeCredential } from './credentials.ts'
import { EXIT_FAIL, EXIT_OK, EXIT_ERROR } from './exit-codes.ts'

const TOKEN_SHAPE = /^ngt_[A-Za-z0-9_-]{43}$/

interface ParsedServer {
  protocol: string
  host: string
  apiBase: string
  path: string
}

function parseServer(raw: string): ParsedServer | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  return { protocol: url.protocol.slice(0, -1), host: url.host, apiBase: `${url.protocol}//${url.host}`, path: url.pathname }
}

/** 掩码：前缀 + 首 2 末 4（api.md §4 display_hint「ngt_ab…wxyz」同款；绝不含完整 token）。 */
function maskToken(token: string): string {
  return `ngt_${token.slice(4, 6)}…${token.slice(-4)}`
}

/**
 * 交互输入（S6-T2）：单个 readline 实例 + 常驻行队列，多问不丢行
 * （两个独立实例会在各自缓冲里吞掉未读行）；提示走 stderr，stdout 保持纯净。
 * promptSecret 在 TTY 下抑制回显（凭据不进终端回滚缓冲）；管道输入本就无回显。
 */
interface Prompter {
  line(prompt: string): Promise<string | null>
  secret(prompt: string): Promise<string | null>
  close(): void
}

function createPrompter(): Prompter {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: process.stderr.isTTY === true })
  const queue: string[] = []
  let closed = false
  rl.on('line', (line: string) => queue.push(line.replace(/\r$/, '')))
  rl.on('close', () => {
    closed = true
  })
  const take = (prompt: string, hidden: boolean): Promise<string | null> => {
    const iface = rl as unknown as { _writeToOutput: (s: string) => void }
    const original = iface._writeToOutput
    if (hidden && rl.terminal) iface._writeToOutput = () => {}
    process.stderr.write(prompt)
    const restore = (): void => {
      if (hidden && rl.terminal) {
        iface._writeToOutput = original
        process.stderr.write('\n')
      }
    }
    if (queue.length > 0) {
      const value = queue.shift() ?? null
      restore()
      return Promise.resolve(value === '' ? '' : value)
    }
    if (closed) {
      restore()
      return Promise.resolve(null)
    }
    return new Promise((resolve) => {
      let settled = false
      const done = (value: string | null): void => {
        if (settled) return
        settled = true
        restore()
        resolve(value)
      }
      const poll = (): void => {
        if (queue.length > 0) done(queue.shift() ?? null)
        else if (closed) done(null)
        else setTimeout(poll, 25)
      }
      poll()
    })
  }
  return {
    line: (prompt) => take(prompt, false),
    secret: (prompt) => take(prompt, true),
    close: () => rl.close(),
  }
}

function fail(message: string): number {
  process.stderr.write(`notegit login: ${message}\n`)
  return EXIT_FAIL
}

/**
 * 注册按 host 作用域的 helper 配置，两条值、顺序固定：
 *   credential.<proto>://<host>.helper = ""（空值重置继承链）
 *   credential.<proto>://<host>.helper = !"<本 CLI 绝对路径>" credential
 * 空值重置让本 helper 成为该 host 的唯一凭据来源（git 标准语义，实测验证）：
 * 不把 ngt_ token 透传给 osxkeychain/libsecret 等其他 helper（避免第二份明文副本、
 * headless 环境的 keychain UI 阻塞），也不影响用户其他 host 的 helper 配置。
 * 幂等：已是目标序列则不重写。
 */
function registerCredentialHelper(server: ParsedServer): string | null {
  const key = `credential.${server.protocol}://${server.host}.helper`
  try {
    const selfPath = realpathSync(process.argv[1] as string)
    const value = `!"${selfPath}" credential`
    let existing: string[] = []
    try {
      existing = execFileSync('git', ['config', '--global', '--get-all', key], { encoding: 'utf8' })
        .split('\n')
        .filter((line, idx, arr) => !(line === '' && idx === arr.length - 1))
    } catch {
      existing = [] // --get-all 在无值时 exit 1
    }
    const desired = ['', value]
    if (existing.length !== desired.length || existing.some((line, i) => line !== desired[i])) {
      try {
        execFileSync('git', ['config', '--global', '--unset-all', key])
      } catch {
        // 键不存在时 --unset-all 报错，忽略
      }
      execFileSync('git', ['config', '--global', '--add', key, ''])
      execFileSync('git', ['config', '--global', '--add', key, value])
    }
    return key
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    process.stderr.write(`notegit login: 警告：未能注册 Git credential helper（${reason}）。凭据已保存，但 git 需手动配置 helper 才能免交互。\n`)
    return null
  }
}

function usageError(message: string): number {
  process.stderr.write(`notegit login: ${message}（notegit login --help 查看用法）\n`)
  return EXIT_ERROR
}

/** login 主流程：解析参数 → 取用户名/令牌 → Bearer 校验（GET /api/v1/credentials）→ 0600 落盘。 */
export async function runLogin(args: string[]): Promise<number> {
  let serverRaw: string | undefined
  let username: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === '--username') {
      const value = args[i + 1]
      if (value === undefined) return usageError('--username 需要一个值')
      username = value
      i++
    } else if (arg.startsWith('--token')) {
      process.stderr.write(
        'notegit login: 不接受 --token 命令行参数（令牌会随进程列表泄漏）。请改用环境变量 NOTEGIT_TOKEN 或交互输入。\n',
      )
      return EXIT_ERROR
    } else if (arg.startsWith('-')) {
      return usageError(`未知选项：${arg}`)
    } else if (serverRaw === undefined) {
      serverRaw = arg
    } else {
      return usageError(`多余参数：${arg}`)
    }
  }
  if (serverRaw === undefined) {
    return usageError('需要 server（如 https://notegit.example.com）。用法：notegit login <server> [--username <用户名>]')
  }
  const server = parseServer(serverRaw)
  if (server === null) {
    return usageError(`server URL 无效：${serverRaw}（需 http(s)://host[:port]）`)
  }
  if (server.path !== '' && server.path !== '/') {
    process.stderr.write(`notegit login: 注意：server 路径「${server.path}」将被忽略（凭据按 ${server.protocol}://${server.host} 归属）。\n`)
  }

  const prompter = createPrompter()
  try {
    if (username === undefined) {
      username = (await prompter.line('用户名：'))?.trim() ?? ''
      if (username === '') return fail('未提供用户名')
    }
    const envToken = process.env['NOTEGIT_TOKEN']
    const token =
      envToken && envToken !== '' ? envToken : ((await prompter.secret('访问令牌（ngt_…，输入不回显）：'))?.trim() ?? '')
    if (token === '') return fail('未提供访问令牌')
    if (!TOKEN_SHAPE.test(token)) {
      return fail('令牌形态不符（应为 ngt_ 前缀 + 43 字符，identity §3.1）。凭据请在网页端「查看访问凭据」页创建。')
    }
    return await completeLogin(server, username, token)
  } finally {
    prompter.close()
  }
}

/** 校验 + 落盘 + 注册 helper（校验通过才写存储；token 只进 0600 文件与内存）。 */
async function completeLogin(server: ParsedServer, username: string, token: string): Promise<number> {
  let res: Response
  try {
    res = await fetch(`${server.apiBase}/api/v1/credentials`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return fail(`无法连接服务端 ${server.apiBase}（${reason}）。请核对 server 地址。`)
  }

  if (res.status !== 200) {
    if (res.status === 401) {
      let code: string | undefined
      try {
        const body = (await res.json()) as { error?: { code?: string } }
        code = body.error?.code
      } catch {
        code = undefined
      }
      const hint =
        code === 'E-AUTH-002'
          ? '凭据已过期：过期凭据不可续期，请在网页端新建凭据后重试'
          : code === 'E-AUTH-003'
            ? '凭据已撤销：请在网页端新建凭据后重试'
            : code === 'E-AUTH-004'
              ? '账号已停用：请联系实例管理员'
              : '凭据无效：请核对令牌（在网页端「查看访问凭据」确认）'
      return fail(`${hint}${code === undefined ? '' : `（${code}）`}。`)
    }
    return fail(`服务端返回意外状态 ${res.status}，登录未完成。`)
  }

  storeCredential({ protocol: server.protocol, host: server.host, username, password: token })
  process.stdout.write(`已登录 ${username}@${server.host}（凭据 ${maskToken(token)}）\n`)
  process.stdout.write(`凭据已保存（权限 0600）：${credentialsFilePath()}\n`)
  const helperKey = registerCredentialHelper(server)
  if (helperKey !== null) {
    process.stdout.write(`已注册 Git credential helper：${helperKey}\n`)
    process.stdout.write(`现在可免交互访问：git ls-remote ${server.protocol}://${server.host}/<vault>.git\n`)
  }
  return EXIT_OK
}
