/**
 * 凭据存储（S6-T2）：git credential-helper 协议的文件存储后端。
 *
 * 选型（记录于 .agents/notes/2026-10-13-S6-T2-login.md）：不引入 OS keyring 原生依赖
 * （破坏 T1 的纯 JS 分发、headless Linux 无 secret-tool），改为自带 helper 子命令 +
 * 0600 权限文件（breakdown「凭据文件权限受限」）。凭据永不写入 remote URL、仓库文件或日志。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { EXIT_OK } from './exit-codes.ts'

/** 一条凭据：protocol/host 定位服务端（host 含端口），username/password 供 HTTP Basic（api.md §1：用户名任意 + token 作口令）。 */
export interface CredentialEntry {
  protocol: string
  host: string
  username: string
  password: string
}

/** 查询键：username 缺省 = 该 protocol+host 下任一账目（git get 查询常不带 username）。 */
export interface CredentialKey {
  protocol: string
  host: string
  username?: string
}

/** 存储文件位置：测试覆盖 > XDG_CONFIG_HOME > ~/.config（跨 macOS/Linux 惯例）。 */
export function credentialsFilePath(): string {
  const override = process.env['NOTEGIT_CREDENTIALS_FILE']
  if (override && override !== '') return override
  const xdg = process.env['XDG_CONFIG_HOME']
  const base = xdg && xdg !== '' ? xdg : path.join(homedir(), '.config')
  return path.join(base, 'notegit', 'credentials')
}

/** 读全部条目；文件缺失返回空（git credential-store 同语义）。条目以空行分隔、每行 k=v。 */
export function readCredentials(file: string = credentialsFilePath()): CredentialEntry[] {
  if (!existsSync(file)) return []
  const entries: CredentialEntry[] = []
  for (const stanza of readFileSync(file, 'utf8').split(/\n[ \t]*\n/)) {
    if (stanza.trim() === '') continue
    const kv = new Map<string, string>()
    for (const raw of stanza.split('\n')) {
      const line = raw.replace(/\r$/, '')
      const i = line.indexOf('=')
      if (i <= 0) continue
      kv.set(line.slice(0, i), line.slice(i + 1))
    }
    const protocol = kv.get('protocol')
    const host = kv.get('host')
    const username = kv.get('username')
    const password = kv.get('password')
    if (protocol !== undefined && host !== undefined && username !== undefined && password !== undefined) {
      entries.push({ protocol, host, username, password })
    }
  }
  return entries
}

function writeCredentials(entries: readonly CredentialEntry[], file: string = credentialsFilePath()): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const text = entries.map((e) => `protocol=${e.protocol}\nhost=${e.host}\nusername=${e.username}\npassword=${e.password}`).join('\n\n')
  writeFileSync(file, `${text}\n`, { mode: 0o600 })
  chmodSync(file, 0o600) // writeFileSync 的 mode 仅创建时生效；显式收紧防历史文件宽松权限
}

function sameKey(entry: CredentialEntry, key: CredentialKey): boolean {
  return entry.protocol === key.protocol && entry.host === key.host && (key.username === undefined || entry.username === key.username)
}

/** upsert：同 protocol+host+username 覆盖（重新 login 换 token 即更新）。 */
export function storeCredential(entry: CredentialEntry): void {
  const key: CredentialKey = { protocol: entry.protocol, host: entry.host, username: entry.username }
  writeCredentials([...readCredentials().filter((e) => !sameKey(e, key)), entry])
}

/** 删除：带 username 精确删；不带则删该 protocol+host 全部账目（git erase 语义）。 */
export function eraseCredential(key: CredentialKey): void {
  writeCredentials(readCredentials().filter((e) => !sameKey(e, key)))
}

/** 查询：protocol+host 必须匹配；带 username 再过滤；返回首条命中，未命中 null。 */
export function lookupCredential(key: CredentialKey): CredentialEntry | null {
  return readCredentials().find((e) => sameKey(e, key)) ?? null
}

/** 解析 git credential-helper 协议的 stdin 查询（空行结束，之后内容忽略；容忍 CRLF）。 */
export function parseCredentialQuery(input: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of input.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line === '') break
    const i = line.indexOf('=')
    if (i <= 0) continue
    out[line.slice(0, i)] = line.slice(i + 1)
  }
  return out
}

/** get 响应：四行 k=v（含 git 所需的 password= 行）——这是 helper 协议本体，非日志。 */
export function formatCredentialForGet(entry: CredentialEntry): string {
  return `protocol=${entry.protocol}\nhost=${entry.host}\nusername=${entry.username}\npassword=${entry.password}\n`
}

/** git credential-helper 协议动词（get/store/erase；git fill→get、approve→store、reject→erase）。 */
export type CredentialVerb = 'get' | 'store' | 'erase'

/**
 * 以 helper 身份跑一个动词：stdin 读完整查询（空行终止）→ 操作存储 → stdout 写 get 响应。
 * get 未命中输出空（git 语义：本 helper 无凭据，继续问下一个 helper/终端）。
 */
export function runCredentialHelper(verb: CredentialVerb): Promise<number> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let settled = false
    const finalize = (): void => {
      if (settled) return
      settled = true
      const query = parseCredentialQuery(Buffer.concat(chunks).toString('utf8'))
      const protocol = query['protocol']
      const host = query['host']
      const username = query['username']
      const password = query['password']
      const usernameOf = (): string | undefined => (typeof username === 'string' && username !== '' ? username : undefined)
      if (verb === 'get') {
        if (typeof protocol === 'string' && typeof host === 'string') {
          const entry = lookupCredential({ protocol, host, username: usernameOf() })
          if (entry !== null) process.stdout.write(formatCredentialForGet(entry))
        }
      } else if (verb === 'store') {
        if (typeof protocol === 'string' && typeof host === 'string' && typeof username === 'string' && typeof password === 'string') {
          storeCredential({ protocol, host, username, password })
        }
      } else if (typeof protocol === 'string' && typeof host === 'string') {
        eraseCredential({ protocol, host, username: usernameOf() })
      }
      resolve(EXIT_OK)
    }
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk))
    process.stdin.on('end', finalize)
    process.stdin.on('close', finalize)
    process.stdin.on('error', finalize)
  })
}
