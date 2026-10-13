/**
 * 真实服务实例测试支撑（S7-T8）：按 server/ 现码启动（startApp——不复制、不打桩），
 * 覆盖管理员 bootstrap → 邀请员工 → 口令重置 → 登录 → 创建访问凭据 → 建库 → 授权
 * 的完整 HTTP 编排，供两处消费：
 *   - cli/test/harness-guide.test.ts：docs/harness/README.md 指引步骤「可照做跑通」冒烟；
 *   - cli/test-support/load-sync-datapoint.mjs：并发 sync 负载数据点（selection §7 量化）。
 *
 * 种子内容推送走 git http.extraHeader（Basic 临时头，凭据不落 URL/配置——测试种子
 * 路径；员工面的凭据流由 notegit login 的 credential helper 承担，login-integration
 * 与 harness-guide 冒烟另证）。所有 git/network 子调用在调用方异步执行（S6-T2/T3
 * 教训：sync spawn 会冻结本进程事件循环，令在听的服务无法应答而自死锁）。
 */
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { startApp, type StartedApp } from '../../server/src/main.ts'

export interface RealInstance {
  readonly app: StartedApp
  readonly baseUrl: string
  readonly dataDir: string
  /** 管理员会话 Cookie（ngt_sid）。 */
  readonly adminCookie: string
  close(): Promise<void>
}

export interface ApiReply {
  status: number
  body: Record<string, unknown>
}

/** 带 Cookie 的实例 API 调用（管理员或员工会话）。会话写操作附同源 Origin（CSRF 校验）。 */
export async function api(
  baseUrl: string,
  cookie: string | undefined,
  method: string,
  urlPath: string,
  body?: Record<string, unknown>,
): Promise<ApiReply> {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: {
      'content-type': 'application/json',
      origin: baseUrl,
      ...(cookie !== undefined ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  const parsed: Record<string, unknown> = text === '' ? {} : (JSON.parse(text) as Record<string, unknown>)
  return { status: res.status, body: parsed }
}

function cookieOf(res: Response): string {
  const raw = res.headers.get('set-cookie')
  if (raw === null) throw new Error('登录响应缺 set-cookie')
  const m = raw.match(/ngt_sid=([^;]+)/)
  if (m === null) throw new Error(`登录响应 cookie 非 ngt_sid 形态：${raw}`)
  return `ngt_sid=${m[1]}`
}

/** 启动实例并完成管理员初始化（bootstrap 端点一次性；口令满足策略 ≥12 字符）。 */
export async function bootRealInstance(dataDir: string, adminPassword = 'bootstrap-admin-passw0rd'): Promise<RealInstance> {
  const app = await startApp({ dataDir, host: '127.0.0.1', port: 0 })
  const baseUrl = `http://127.0.0.1:${app.port}`
  const token = readFileSync(path.join(dataDir, 'config', 'admin-bootstrap.token'), 'utf8').trim()
  const boot = await api(baseUrl, undefined, 'POST', '/api/v1/auth/bootstrap', {
    bootstrap_token: token,
    username: 'admin',
    display_name: 'Instance Admin',
    password: adminPassword,
  })
  if (boot.status !== 201) throw new Error(`bootstrap 应 201，实际 ${boot.status}：${JSON.stringify(boot.body)}`)
  const login = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: adminPassword }),
  })
  if (login.status !== 200) throw new Error(`管理员登录应 200，实际 ${login.status}`)
  return { app, baseUrl, dataDir, adminCookie: cookieOf(login), close: () => app.close() }
}

/** 邀请 + 口令重置：产出可直接登录的员工口令。 */
export async function createEmployee(
  inst: RealInstance,
  username: string,
  password = 'employee-passw0rd-x',
): Promise<{ username: string; password: string }> {
  const invite = await api(inst.baseUrl, inst.adminCookie, 'POST', '/api/v1/admin/employees', {
    username,
    display_name: username,
  })
  if (invite.status !== 201) throw new Error(`邀请 ${username} 应 201，实际 ${invite.status}：${JSON.stringify(invite.body)}`)
  const resetToken = invite.body['password_reset_token']
  if (typeof resetToken !== 'string') throw new Error('邀请响应缺 password_reset_token')
  const reset = await api(inst.baseUrl, undefined, 'POST', '/api/v1/auth/password-reset', {
    reset_token: resetToken,
    new_password: password,
  })
  if (reset.status !== 204 && reset.status !== 200) {
    throw new Error(`口令重置应 204/200，实际 ${reset.status}：${JSON.stringify(reset.body)}`)
  }
  return { username, password }
}

/** 员工登录（会话）→ 创建访问凭据（ngt_，明文仅此一次；expires_at 必填且须晚于当前）。 */
export async function createCredentialFor(inst: RealInstance, username: string, password: string): Promise<string> {
  const login = await fetch(`${inst.baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  if (login.status !== 200) throw new Error(`${username} 登录应 200，实际 ${login.status}`)
  const cookie = cookieOf(login)
  const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString()
  const created = await api(inst.baseUrl, cookie, 'POST', '/api/v1/credentials', { name: 'harness', expires_at: expiresAt })
  if (created.status !== 201) throw new Error(`创建凭据应 201，实际 ${created.status}：${JSON.stringify(created.body)}`)
  const token = created.body['token']
  if (typeof token !== 'string' || !token.startsWith('ngt_')) throw new Error('凭据响应缺 ngt_ token')
  return token
}

/** 建库（管理员会话）+ 授予成员角色。 */
export async function createVault(
  inst: RealInstance,
  slug: string,
  name: string,
  members: ReadonlyArray<{ username: string; role: string }> = [],
): Promise<void> {
  const created = await api(inst.baseUrl, inst.adminCookie, 'POST', '/api/v1/vaults', { name, slug })
  if (created.status !== 201) throw new Error(`建库 ${slug} 应 201，实际 ${created.status}：${JSON.stringify(created.body)}`)
  for (const m of members) {
    const granted = await api(inst.baseUrl, inst.adminCookie, 'PUT', `/api/v1/vaults/${slug}/members/${m.username}`, { role: m.role })
    if (granted.status !== 200 && granted.status !== 201 && granted.status !== 204) {
      throw new Error(`授权 ${slug}/${m.username} 应 2xx，实际 ${granted.status}：${JSON.stringify(granted.body)}`)
    }
  }
}

/** 异步 git（对在听服务的调用绝不可 sync spawn——事件循环冻结自死锁，S6 教训）。 */
export function git(cwd: string, ...args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', ['-c', 'user.name=notegit-test', '-c', 'user.email=notegit-test@example.invalid', ...args], { cwd })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')))
    child.on('error', () => resolve({ status: null, stdout, stderr }))
    child.on('close', (code) => resolve({ status: code, stdout, stderr }))
  })
}

export interface SeedFile {
  readonly path: string
  readonly content: string
}

/**
 * 种子内容：临时工作树提交指定文件并推送 <baseUrl>/git/<slug>.git（经服务端
 * pre-receive 真实校验）。Basic 凭据走 http.extraHeader（不落盘）；README.md 免
 * frontmatter，知识文档须带 title（validation 契约 §2/§3）。
 */
export async function seedVaultContent(
  baseUrl: string,
  slug: string,
  token: string,
  files: ReadonlyArray<SeedFile>,
  username = 'seed',
): Promise<{ head: string }> {
  const work = mkdtempSync(path.join(tmpdir(), `ngt-seed-${slug}-`))
  try {
    await git(work, 'init', '-b', 'main', '.')
    for (const f of files) {
      mkdirSync(path.dirname(path.join(work, f.path)), { recursive: true })
      writeFileSync(path.join(work, f.path), f.content)
    }
    await git(work, 'add', '.')
    await git(work, 'commit', '-m', `seed ${slug}`)
    const basic = Buffer.from(`${username}:${token}`).toString('base64')
    const url = `${baseUrl}/git/${slug}.git`
    const push = await git(work, '-c', `http.extraHeader=AUTHORIZATION: Basic ${basic}`, 'push', url, 'main')
    if (push.status !== 0) throw new Error(`种子推送 ${slug} 失败（${push.status}）：${push.stderr.slice(0, 800)}`)
    const rev = await git(work, 'rev-parse', 'HEAD')
    return { head: rev.stdout.trim() }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}
