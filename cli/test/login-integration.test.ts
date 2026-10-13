import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { startMockServer, FAKE_TOKEN, FAKE_USERNAME, type MockServer } from '../test-support/mock-server.ts'

// S6-T2 集成验收（breakdown 完成标准逐条）：
// - 登录后 git ls-remote 免交互通过 credential helper 取凭据（本地模拟 git serve 选型见任务 note）
// - 泄漏扫描断言：remote URL、.git/config、CLI 日志（stdout/stderr）均无明文 token
// - credential helper 子命令（get/store/erase）真实协议往返
// 同步 spawn 与本进程 mock server 自死锁（spike route-b 教训）→ 对我们服务的调用一律异步。

const execFileP = promisify(execFile)
const BIN = new URL('../dist/bin/notegit.js', import.meta.url).pathname
const MASKED = `ngt_${FAKE_TOKEN.slice(4, 6)}…${FAKE_TOKEN.slice(-4)}`

let root: string
let server: MockServer
let gitEnv: Record<string, string>
let loginOut: { status: number | null; stdout: string; stderr: string }
let cloneDir: string
let headRef: string

function runBin(args: string[], opts: { input?: string } = {}): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: gitEnv })
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

before(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'ngt-int-'))
  const projectRoot = path.join(root, 'vaults')
  const bare = path.join(projectRoot, 'v001.git')
  execFileSync('git', ['init', '--bare', '-b', 'main', bare])
  {
    const seed = path.join(root, 'seed')
    execFileSync('git', ['init', '-b', 'main', seed])
    execFileSync('git', ['-C', seed, 'config', 'user.email', 'seed@notegit-test'])
    execFileSync('git', ['-C', seed, 'config', 'user.name', 'seed'])
    writeFileSync(path.join(seed, 'README.md'), '# nav\n')
    execFileSync('git', ['-C', seed, 'add', '.'])
    execFileSync('git', ['-C', seed, 'commit', '-m', 'seed'])
    execFileSync('git', ['-C', seed, 'push', bare, 'main'])
  }
  headRef = execFileSync('git', ['--git-dir', bare, 'rev-parse', 'main']).toString().trim()

  server = await startMockServer(projectRoot, {
    username: FAKE_USERNAME,
    token: FAKE_TOKEN,
    apiOutcome: 'ok',
    gitBasicAccepted: true,
  })

  gitEnv = { ...process.env } as Record<string, string>
  gitEnv['HOME'] = root
  gitEnv['XDG_CONFIG_HOME'] = path.join(root, '.config')
  gitEnv['NOTEGIT_CREDENTIALS_FILE'] = path.join(root, 'credentials')
  gitEnv['GIT_CONFIG_GLOBAL'] = path.join(root, '.gitconfig')
  gitEnv['GIT_CONFIG_SYSTEM'] = '/dev/null'
  gitEnv['GIT_TERMINAL_PROMPT'] = '0'
  gitEnv['NOTEGIT_TOKEN'] = FAKE_TOKEN
  delete gitEnv['GIT_ASKPASS']
  delete gitEnv['SSH_ASKPASS']

  // 登录一次，后续全部断言基于这一状态
  loginOut = await runBin(['login', server.baseUrl, '--username', FAKE_USERNAME])
  assert.equal(loginOut.status, 0, `login 应成功，stderr：${loginOut.stderr}`)
})

after(async () => {
  await server.close()
  rmSync(root, { recursive: true, force: true })
})

test('login 输出：stdout 掩码显示凭据（ngt_ab…wxyz 形），stdout/stderr 全文无完整 token（CLI 日志红线）', () => {
  assert.ok(loginOut.stdout.includes(MASKED), `stdout 应含掩码 ${MASKED}，实际：${loginOut.stdout}`)
  assert.ok(!loginOut.stdout.includes(FAKE_TOKEN))
  assert.ok(!loginOut.stderr.includes(FAKE_TOKEN))
})

test('凭据文件存在且权限 0600（breakdown「凭据文件权限受限」）', () => {
  const file = gitEnv['NOTEGIT_CREDENTIALS_FILE'] as string
  assert.ok(existsSync(file))
  assert.equal(statSync(file).mode & 0o777, 0o600)
})

test('login 注册的 helper 配置：空值重置 + 本 CLI helper 的固定序列（接管该 host，不透传其他 helper）', () => {
  const key = `credential.${server.baseUrl}.helper`
  const raw = execFileSync('git', ['config', '--global', '--get-all', key], { env: gitEnv }).toString()
  const values = raw.split('\n').filter((line, idx, arr) => !(line === '' && idx === arr.length - 1))
  assert.equal(values.length, 2, `应为两条值，实际：${JSON.stringify(values)}`)
  assert.equal(values[0], '', '首值必须为空（重置继承链）')
  assert.match(values[1] ?? '', /notegit/)
  assert.match(values[1] ?? '', /credential/)
})

test('git ls-remote 免交互通过 helper 取凭据（终端提示禁用下成功；核心验收）', async () => {
  const { stdout } = await execFileP('git', ['ls-remote', `${server.baseUrl}/v001.git`], { env: gitEnv })
  assert.ok(stdout.includes(headRef), `ls-remote 应列出 seed ref ${headRef}，实际：${stdout}`)
})

test('git clone 免交互成功（同一 helper 链路）', async () => {
  cloneDir = path.join(root, 'clone')
  await execFileP('git', ['clone', `${server.baseUrl}/v001.git`, cloneDir], { env: gitEnv })
  assert.ok(existsSync(path.join(cloneDir, 'README.md')))
})

test('泄漏扫描：remote URL 与 .git/config 均无明文 token、无 user:pass@host 形态', async () => {
  const url = (await execFileP('git', ['-C', cloneDir, 'remote', 'get-url', 'origin'], { env: gitEnv })).stdout.trim()
  assert.ok(!url.includes(FAKE_TOKEN), `remote URL 不得含 token：${url}`)
  assert.ok(!url.includes('ngt_'), `remote URL 不得含 ngt_ 前缀：${url}`)
  assert.ok(!url.includes('@'), `remote URL 不得含凭据形态 user:pass@host：${url}`)
  const gitConfig = readFileSync(path.join(cloneDir, '.git', 'config'), 'utf8')
  assert.ok(!gitConfig.includes(FAKE_TOKEN), '.git/config 不得含 token')
  assert.ok(!gitConfig.includes('ngt_'), '.git/config 不得含 ngt_ 前缀')
})

test('helper get（命中）：stdout 输出含 password= 的协议四行', async () => {
  const r = await runBin(['credential', 'get'], {
    input: `protocol=http\nhost=127.0.0.1:${server.port}\n\n`,
  })
  assert.equal(r.status, 0)
  assert.ok(r.stdout.includes(`password=${FAKE_TOKEN}`))
  assert.match(r.stdout, /username=alice/)
})

test('helper get（未命中）：stdout 无 password 行，exit 0', async () => {
  const r = await runBin(['credential', 'get'], { input: 'protocol=https\nhost=nowhere.example.com\n\n' })
  assert.equal(r.status, 0)
  assert.ok(!r.stdout.includes('password='))
})

test('helper store/erase：git 协议往返可增删条目（不触碰已登录条目）', async () => {
  const store = await runBin(
    ['credential', 'store'],
    { input: 'protocol=https\nhost=x.example.com\nusername=u1\npassword=p1\n\n' },
  )
  assert.equal(store.status, 0)
  const stored = readFileSync(gitEnv['NOTEGIT_CREDENTIALS_FILE'] as string, 'utf8')
  assert.ok(stored.includes('host=x.example.com'))
  const erase = await runBin(['credential', 'erase'], { input: 'protocol=https\nhost=x.example.com\nusername=u1\n\n' })
  assert.equal(erase.status, 0)
  const after = readFileSync(gitEnv['NOTEGIT_CREDENTIALS_FILE'] as string, 'utf8')
  assert.ok(!after.includes('x.example.com'))
  assert.ok(after.includes(`password=${FAKE_TOKEN}`), '已登录条目不受影响')
})

test('helper 动词缺失或未知：exit 2', async () => {
  assert.equal((await runBin(['credential'])).status, 2)
  assert.equal((await runBin(['credential', 'bogus'])).status, 2)
})

test('负向：存储凭据被换成错误 token 后 ls-remote 被拒（证明链路真鉴权，非放行）', async () => {
  const file = gitEnv['NOTEGIT_CREDENTIALS_FILE'] as string
  const original = readFileSync(file, 'utf8')
  try {
    const bad = original.replace(`password=${FAKE_TOKEN}`, `password=${'z'.repeat(47)}`)
    writeFileSync(file, bad)
    await assert.rejects(
      execFileP('git', ['ls-remote', `${server.baseUrl}/v001.git`], { env: gitEnv }),
      (err: Error & { code?: number | string }) => {
        assert.notEqual(err.code, 0)
        return true
      },
    )
  } finally {
    writeFileSync(file, original)
  }
  const ok = await execFileP('git', ['ls-remote', `${server.baseUrl}/v001.git`], { env: gitEnv })
  assert.ok(ok.stdout.includes(headRef), '恢复凭据后 ls-remote 应再次成功')
})

test('未登录的 host：helper 不提供凭据，ls-remote 在禁用终端提示下失败而非挂起', async () => {
  await assert.rejects(execFileP('git', ['ls-remote', 'http://127.0.0.1:9/none.git'], { env: gitEnv }))
})
