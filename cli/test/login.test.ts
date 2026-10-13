import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { startMockServer, FAKE_TOKEN, type MockServer } from '../test-support/mock-server.ts'

// notegit login（S6-T2）：username+token 登录（引导码端点不存在——api.md 无此端点，缺口记录于任务 note）。
// 本文件覆盖：参数/交互输入、服务端校验结局映射（E-AUTH-00x）、凭据落盘 0600、输出掩码不泄漏。
// ls-remote 免交互与泄漏扫描三对象（remote URL/.git/config/CLI 日志）在 login-integration.test.ts。

const BIN = new URL('../dist/bin/notegit.js', import.meta.url).pathname
const MASKED = `ngt_${FAKE_TOKEN.slice(4, 6)}…${FAKE_TOKEN.slice(-4)}`

let server: MockServer
const scratchDirs: string[] = []
let env: Record<string, string>

before(async () => {
  server = await startMockServer(path.join(tmpdir()), {
    username: 'alice',
    token: FAKE_TOKEN,
    apiOutcome: 'ok',
    gitBasicAccepted: false,
  })
})

beforeEach(() => {
  const home = mkdtempSync(path.join(tmpdir(), 'ngt-login-'))
  scratchDirs.push(home)
  env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    NOTEGIT_CREDENTIALS_FILE: path.join(home, 'credentials'),
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1', // Apple Git 无视 GIT_CONFIG_SYSTEM，仍注入系统 osxkeychain（实测）
    GIT_TERMINAL_PROMPT: '0',
    NOTEGIT_TOKEN: '',
  } as Record<string, string>
})

after(async () => {
  await server.close()
  for (const d of scratchDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

// 异步 spawn（spike route-b 教训）：同步 spawn 会阻塞本进程事件循环，
// mock server 无法应答子进程的 fetch → 自死锁（唯一「快」路径是超时）。
interface LoginResult {
  status: number
  stdout: string
  stderr: string
}

function runLogin(args: string[], opts: { input?: string; env?: Record<string, string> } = {}): Promise<LoginResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, 'login', ...args], { env: { ...env, ...opts.env } })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')))
    child.on('error', () => resolve({ status: 2, stdout, stderr }))
    child.on('close', (code) => resolve({ status: code ?? 2, stdout, stderr }))
    child.stdin.write(opts.input ?? '')
    child.stdin.end()
  })
}

function storeFile(): string {
  return env['NOTEGIT_CREDENTIALS_FILE'] as string
}

test('无 server 参数：exit 2，stderr 给出用法提示', async () => {
  const r = await runLogin([], { env: { NOTEGIT_TOKEN: FAKE_TOKEN } })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /server/)
  assert.match(r.stderr, /用法|notegit login/)
})

test('server 非 URL：exit 2，stderr 提示 URL 无效', async () => {
  const r = await runLogin(['notaurl'], { env: { NOTEGIT_TOKEN: FAKE_TOKEN } })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /URL|无效/)
})

test('--token 旗标被拒：exit 2，说明令牌不经命令行参数（防进程列表泄漏），指向环境变量/交互输入', async () => {
  const r = await runLogin([server.baseUrl, '--token', 'ngt_whatever'])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /--token/)
  assert.match(r.stderr, /NOTEGIT_TOKEN/)
})

test('未知旗标：exit 2', async () => {
  const r = await runLogin([server.baseUrl, '--nonsense'], { env: { NOTEGIT_TOKEN: FAKE_TOKEN } })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /未知选项|--nonsense/)
})

test('token 形态不符（非 ngt_+43）：exit 1，stderr 提示形态；不落盘', async () => {
  const r = await runLogin([server.baseUrl, '--username', 'alice'], { env: { NOTEGIT_TOKEN: 'not-a-token' } })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /ngt_/)
  assert.ok(!existsSync(storeFile()), '不应创建凭据文件')
})

test('有效 token（Bearer 校验 200）：exit 0；stdout 掩码显示（前缀+末 4 位）且全文无完整 token；凭据文件 0600 含 username+token', async () => {
  const r = await runLogin([server.baseUrl, '--username', 'alice'], { env: { NOTEGIT_TOKEN: FAKE_TOKEN } })
  assert.equal(r.status, 0)
  assert.ok(r.stdout.includes(MASKED), `stdout 应含掩码 ${MASKED}，实际：${r.stdout}`)
  assert.ok(!`${r.stdout}${r.stderr}`.includes(FAKE_TOKEN), 'stdout/stderr 不得出现完整 token')
  assert.ok(existsSync(storeFile()), '凭据文件应存在')
  assert.equal(statSync(storeFile()).mode & 0o777, 0o600)
  const stored = readFileSync(storeFile(), 'utf8')
  assert.match(stored, /username=alice/)
  assert.ok(stored.includes(`password=${FAKE_TOKEN}`), '凭据文件（0600）按设计存 token 明文')
})

test('凭据无效（E-AUTH-001）：exit 1，提示核对；不落盘', async () => {
  const r = await runLogin([server.baseUrl, '--username', 'alice'], { env: { NOTEGIT_TOKEN: `ngt_${'x'.repeat(43)}` } })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /无效|核对/)
  assert.ok(!existsSync(storeFile()))
})

test('凭据过期（E-AUTH-002）：exit 1，提示不可续期须新建；不落盘', async () => {
  server.state.apiOutcome = 'E-AUTH-002'
  try {
    const r = await runLogin([server.baseUrl, '--username', 'alice'], { env: { NOTEGIT_TOKEN: FAKE_TOKEN } })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /过期/)
    assert.match(r.stderr, /新建/)
    assert.ok(!existsSync(storeFile()))
  } finally {
    server.state.apiOutcome = 'ok'
  }
})

test('服务不可达：exit 1，提示无法连接', async () => {
  const r = await runLogin(['http://127.0.0.1:9', '--username', 'alice'], { env: { NOTEGIT_TOKEN: FAKE_TOKEN } })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /无法连接/)
  assert.ok(!existsSync(storeFile()))
})

test('交互式管道输入（无 --username、无 NOTEGIT_TOKEN）：stdin 依序提供用户名与令牌，exit 0 且落盘', async () => {
  const r = await runLogin([server.baseUrl], { input: `alice\n${FAKE_TOKEN}\n` })
  assert.equal(r.status, 0)
  const stored = readFileSync(storeFile(), 'utf8')
  assert.match(stored, /username=alice/)
  assert.ok(stored.includes(`password=${FAKE_TOKEN}`))
})

test('参数式用户名 + 交互式令牌（stdin 只供令牌）：exit 0', async () => {
  const r = await runLogin([server.baseUrl, '--username', 'alice'], { input: `${FAKE_TOKEN}\n` })
  assert.equal(r.status, 0)
  assert.match(readFileSync(storeFile(), 'utf8'), /username=alice/)
})

test('stdin EOF 未提供令牌：exit 1，不落盘', async () => {
  const r = await runLogin([server.baseUrl, '--username', 'alice'], { input: '' })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /令牌/)
  assert.ok(!existsSync(storeFile()))
})

test('server URL 带路径：路径被忽略（警告到 stderr），仍以 protocol+host 登录成功', async () => {
  const r = await runLogin([`${server.baseUrl}/some/prefix`, '--username', 'alice'], { env: { NOTEGIT_TOKEN: FAKE_TOKEN } })
  assert.equal(r.status, 0)
  assert.match(r.stderr, /路径/)
})
