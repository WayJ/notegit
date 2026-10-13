/**
 * 测试用本地 git serve（S6-T2 选型：本地模拟而非真实服务实例——记录于任务 note）。
 * 真实 git http-backend CGI（与生产同一 Git 栈，docs/s1 spike route B 验证过的包裹模式）
 * + Basic/Bearer 双入口鉴权，模拟服务端的 /api/v1/credentials 与 Smart HTTP 行为。
 */
import http from 'node:http'
import { spawn } from 'node:child_process'
import type { AddressInfo } from 'node:net'

/** 形如 identity §3.1：ngt_ + 43 字符 base64url（测试常量，非真实凭据）。 */
export const FAKE_TOKEN = 'ngt_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE'
export const FAKE_USERNAME = 'alice'

/** /api/v1/credentials 的可变认证结局（模拟四状态；api.md §2.3 信封）。 */
export type ApiOutcome = 'ok' | 'E-AUTH-001' | 'E-AUTH-002' | 'E-AUTH-003' | 'E-AUTH-004'

const MESSAGES: Record<Exclude<ApiOutcome, 'ok'>, string> = {
  'E-AUTH-001': '未认证',
  'E-AUTH-002': '凭据已过期',
  'E-AUTH-003': '凭据已撤销',
  'E-AUTH-004': '账号已停用',
}
const REASONS: Record<Exclude<ApiOutcome, 'ok'>, string> = {
  'E-AUTH-001': 'invalid',
  'E-AUTH-002': 'expired',
  'E-AUTH-003': 'revoked',
  'E-AUTH-004': 'account_disabled',
}

/** GET /api/v1/vaults 的库列表项（api.md §5，与 cli/src/ls/api.ts 的 VaultSummary 同构）。 */
export interface MockVault {
  readonly slug: string
  readonly name: string
  readonly role: string
  readonly default_branch: string
  readonly main_admin_only: boolean
}

export interface MockState {
  username: string
  token: string
  apiOutcome: ApiOutcome
  gitBasicAccepted: boolean
  /** GET /api/v1/vaults 返回面（S7-T1 sync e2e；缺省空列表；可变——测试中改 slug 模拟改名）。 */
  vaults?: MockVault[]
}

export interface MockServer {
  port: number
  baseUrl: string
  state: MockState
  close(): Promise<void>
}

function denyBasic(res: http.ServerResponse): void {
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="notegit-test"' })
  res.end('auth required')
}

/** 启动模拟服务：GET /api/v1/credentials 与 /api/v1/vaults 走 Bearer；其余路径走 Basic + git http-backend CGI。 */
export function startMockServer(projectRoot: string, state: MockState): Promise<MockServer> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://notegit-test')
    if (url.pathname === '/api/v1/credentials') return handleApi(req, res, state)
    if (url.pathname === '/api/v1/vaults') return handleVaults(req, res, state)
    return handleGit(req, res, url, projectRoot, state)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        state,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}

function handleApi(req: http.IncomingMessage, res: http.ServerResponse, state: MockState): void {
  const auth = String(req.headers['authorization'] ?? '')
  if (state.apiOutcome === 'ok' && auth === `Bearer ${state.token}`) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ credentials: [] }))
    return
  }
  const code = state.apiOutcome === 'ok' ? 'E-AUTH-001' : state.apiOutcome
  res.writeHead(401, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: { code, message: MESSAGES[code as Exclude<ApiOutcome, 'ok'>], details: { reason: REASONS[code as Exclude<ApiOutcome, 'ok'>] } } }))
}

/** GET /api/v1/vaults（api.md §5 形态；Bearer 认证同 credentials——CLI 发现面）。 */
function handleVaults(req: http.IncomingMessage, res: http.ServerResponse, state: MockState): void {
  const auth = String(req.headers['authorization'] ?? '')
  if (req.method !== 'GET' || state.apiOutcome !== 'ok' || auth !== `Bearer ${state.token}`) {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { code: 'E-AUTH-001', message: '未认证', details: { reason: 'invalid' } } }))
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ vaults: state.vaults ?? [] }))
}

function handleGit(req: http.IncomingMessage, res: http.ServerResponse, url: URL, projectRoot: string, state: MockState): void {
  if (!state.gitBasicAccepted) return denyBasic(res)
  const auth = req.headers['authorization']
  if (typeof auth !== 'string' || !auth.startsWith('Basic ')) return denyBasic(res)
  const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8')
  const sep = decoded.indexOf(':')
  const user = decoded.slice(0, sep)
  const pass = decoded.slice(sep + 1)
  if (user !== state.username || pass !== state.token) return denyBasic(res)

  // S7-T1：接受生产同构的 /git/<slug>[.git] 前缀（server cgi.ts GIT_URL_RE；CLI
  // cloneUrlOf 生成该形态）；裸根 /<slug>.git 兼容保留（login 集成测试用）。
  const m = url.pathname.match(/^\/(?:git\/)?([A-Za-z0-9][A-Za-z0-9-]*?)(?:\.git)?(\/.*)?$/)
  if (!m) {
    res.writeHead(404)
    res.end('not found')
    return
  }
  const [, repo, pathInfo = ''] = m
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GATEWAY_INTERFACE: 'CGI/1.1',
    REQUEST_METHOD: req.method ?? 'GET',
    QUERY_STRING: url.searchParams.toString(),
    PATH_INFO: `/${repo}.git${pathInfo}`,
    GIT_PROJECT_ROOT: projectRoot,
    GIT_HTTP_EXPORT_ALL: '1',
    REMOTE_USER: user,
    REMOTE_ADDR: req.socket.remoteAddress ?? '127.0.0.1',
    CONTENT_TYPE: req.headers['content-type'] ?? '',
    SERVER_PROTOCOL: 'HTTP/1.1',
  }
  if (req.headers['content-length'] !== undefined) env['CONTENT_LENGTH'] = String(req.headers['content-length'])
  if (req.headers['content-encoding'] !== undefined) env['HTTP_CONTENT_ENCODING'] = String(req.headers['content-encoding'])
  if (req.headers['accept-encoding'] !== undefined) env['HTTP_ACCEPT_ENCODING'] = String(req.headers['accept-encoding'])

  const backend = spawn('git', ['http-backend'], { env })
  req.pipe(backend.stdin)
  let headerBuf = Buffer.alloc(0)
  backend.stdout.on('data', (chunk: Buffer) => {
    if (res.headersSent) return res.write(chunk)
    headerBuf = Buffer.concat([headerBuf, chunk])
    const idx = headerBuf.indexOf('\r\n\r\n')
    if (idx === -1) return
    const headers: Record<string, string> = {}
    let status = 200
    for (const line of headerBuf.subarray(0, idx).toString('utf8').split('\r\n')) {
      const i = line.indexOf(':')
      if (i === -1) continue
      const k = line.slice(0, i).trim().toLowerCase()
      const v = line.slice(i + 1).trim()
      if (k === 'status') status = parseInt(v, 10)
      else headers[k] = v
    }
    res.writeHead(status, headers)
    res.write(headerBuf.subarray(idx + 4))
  })
  backend.stdout.on('end', () => res.end())
  backend.on('close', () => {
    if (!res.writableEnded) res.end()
  })
  backend.on('error', () => {
    if (!res.headersSent) res.writeHead(502)
    res.end('backend error')
  })
  req.on('aborted', () => backend.stdin.destroy())
}
