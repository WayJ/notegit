import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, rm, mkdir, writeFile, readdir, readFile, chmod } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { startMockServer, type MockServer, type MockVault } from '../test-support/mock-server.ts'

// S7-T7 黑盒层：托管 Harness 按员工隔离三断言（breakdown §2.6 S7-T7 行；架构
// §7.2「不同员工的可写工作目录不共享」、§4.1「托管 Harness 必须按员工或任务隔离
// 凭据和工作目录」；DOD-10）。世界模型取最苛刻形态：同一台托管机、同一 OS 账号
// （HOME 与 GIT_CONFIG_GLOBAL 共享），两员工仅靠环境变量布局隔离——
// NOTEGIT_LOCAL_ROOT 与 NOTEGIT_CREDENTIALS_FILE 各指员工私有路径；同一 Notegit
// 实例（同一 mock server），不同令牌、不同可见库、含一个两员工共享库。
// 测试目标 = dist 产物（与 sync.test.ts 同约定；npm test 先 build 再跑测试）。
const BIN = new URL('../dist/bin/notegit.js', import.meta.url).pathname

// 两员工令牌（identity §3.1 形态：ngt_ + 43 字符；互不相同——凭据隔离的断言对象）
const ALICE_TOKEN = `ngt_${'A'.repeat(43)}`
const BOB_TOKEN = `ngt_${'B'.repeat(43)}`

const GIT = { PATH: process.env['PATH']!, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } as const

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, env: GIT, stdio: 'pipe' })
}

function rev(cwd: string, ref: string): string {
  return execFileSync('git', ['rev-parse', ref], { cwd, env: GIT, encoding: 'utf8' }).trim()
}

interface Run {
  status: number | null
  stdout: string
  stderr: string
  startedAt: number
  endedAt: number
}

// 异步 spawn（自死锁教训见 login-integration.test.ts）：父进程需持续应答子进程的
// mock server 请求；记录起止时刻供「真实双进程并行」交集断言。
function run(args: string[], env: Record<string, string>, input?: string): Promise<Run> {
  const startedAt = Date.now()
  const child = spawn(process.execPath, [BIN, ...args], { env })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (d: string) => (stdout += d))
  child.stderr.on('data', (d: string) => (stderr += d))
  if (input !== undefined) child.stdin.write(input)
  child.stdin.end()
  return new Promise((resolve) => {
    child.on('close', (code) => resolve({ status: code, stdout, stderr, startedAt, endedAt: Date.now() }))
  })
}

/** 造 seed 工作库并推 bare（projectRoot/<slug>.git，被 mock server 以 Smart HTTP 服务；同 sync.test.ts）。 */
async function seedVault(projectRoot: string, worksRoot: string, slug: string, files: string[]): Promise<string[]> {
  const work = path.join(worksRoot, slug)
  await mkdir(work, { recursive: true })
  git(work, 'init', '-b', 'main')
  git(work, 'config', 'user.name', 'seed')
  git(work, 'config', 'user.email', 'seed@notegit.invalid')
  const shas: string[] = []
  for (const name of files) {
    await writeFile(path.join(work, name), `# ${slug} ${name}\n`)
    git(work, 'add', '.')
    git(work, 'commit', '-m', name)
    shas.push(rev(work, 'HEAD'))
  }
  git(worksRoot, 'clone', '--quiet', '--bare', work, path.join(projectRoot, `${slug}.git`))
  return shas
}

function vault(slug: string): MockVault {
  return { slug, name: slug, role: 'reader', default_branch: 'main', main_admin_only: false }
}

function modeOf(p: string): number {
  return statSync(p).mode & 0o777
}

/** 员工会话布局（托管运行手册 docs/harness/）：员工私有目录 = 凭据 + 本地根目录。 */
interface Employee {
  username: string
  token: string
  dir: string // <托管基目录>/employees/<name>/（员工私有；含凭据与本地根）
  root: string // NOTEGIT_LOCAL_ROOT = <dir>/knowbase
  credFile: string // NOTEGIT_CREDENTIALS_FILE = <dir>/credentials
}

/** 员工会话环境：HOME/GIT_CONFIG_GLOBAL 共享（同一 OS 账号——最苛刻形态），仅两变量隔离。 */
function sessionEnv(home: string, serverUrl: string, emp: Employee, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env['PATH']!,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    NOTEGIT_CREDENTIALS_FILE: emp.credFile,
    NOTEGIT_LOCAL_ROOT: emp.root,
    NOTEGIT_SERVER: serverUrl,
    NOTEGIT_TOKEN: emp.token,
    ...extra,
  }
}

function mkEmployee(employeesDir: string, name: string, token: string): Employee {
  const dir = path.join(employeesDir, name)
  return { username: name, token, dir, root: path.join(dir, 'knowbase'), credFile: path.join(dir, 'credentials') }
}

interface World {
  base: string
  home: string
  serverUrl: string
  alice: Employee
  bob: Employee
  sharedTip: string
  aliceCredBefore: string
  bobCredBefore: string
}

let world: World
let mainServer: MockServer | undefined

before(async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'ngt-hosted-'))
  const home = await mkdtemp(path.join(tmpdir(), 'ngt-hosted-home-'))
  const employees = path.join(base, 'employees')
  const projectRoot = path.join(base, 'vaults')
  const worksRoot = path.join(base, 'works')
  await mkdir(employees) // Harness 共享父目录（mkdtemp 根为 0700，显式放开为共享遍历形态）
  await chmod(employees, 0o755)
  await mkdir(projectRoot, { recursive: true })
  await mkdir(worksRoot, { recursive: true })

  const sharedShas = await seedVault(projectRoot, worksRoot, 'shared-docs', ['a.md', 'b.md'])
  await seedVault(projectRoot, worksRoot, 'alice-notes', ['a.md'])
  await seedVault(projectRoot, worksRoot, 'bob-notes', ['a.md'])

  const alice = mkEmployee(employees, 'alice', ALICE_TOKEN)
  const bob = mkEmployee(employees, 'bob', BOB_TOKEN)
  const server = await startMockServer(projectRoot, {
    username: 'legacy',
    token: ALICE_TOKEN,
    apiOutcome: 'ok',
    gitBasicAccepted: true,
    identities: [
      { username: alice.username, token: alice.token, vaults: [vault('shared-docs'), vault('alice-notes')] },
      { username: bob.username, token: bob.token, vaults: [vault('shared-docs'), vault('bob-notes')] },
    ],
  })

  // 两员工先后 login（各自私有凭据文件）；快照各自文件内容——供「一方 login 不改写另一方文件」断言
  const loginA = await run(['login', server.baseUrl, '--username', alice.username], sessionEnv(home, server.baseUrl, alice))
  assert.equal(loginA.status, 0, `alice login 应成功，stderr：${loginA.stderr}`)
  const aliceCredBefore = await readFile(alice.credFile, 'utf8')
  const loginB = await run(['login', server.baseUrl, '--username', bob.username], sessionEnv(home, server.baseUrl, bob))
  assert.equal(loginB.status, 0, `bob login 应成功，stderr：${loginB.stderr}`)
  const bobCredBefore = await readFile(bob.credFile, 'utf8')

  world = { base, home, serverUrl: server.baseUrl, alice, bob, sharedTip: sharedShas[1]!, aliceCredBefore, bobCredBefore }
  mainServer = server
})

after(async () => {
  if (mainServer !== undefined) await mainServer.close()
  if (world === undefined) return // before() 中途失败时无需清理（各测试也不会运行）
  await rm(world.base, { recursive: true, force: true })
  await rm(world.home, { recursive: true, force: true })
})

// ── 断言一：目录隔离（两员工托管目录互相读取被拒——0700 权限断言） ─────────────

test('目录隔离：两员工各自根目录 0700（组/其他零权限位——跨员工读取被拒），根下仅各自可见库', async () => {
  const sa = await run(['sync'], sessionEnv(world.home, world.serverUrl, world.alice))
  assert.equal(sa.status, 0, `alice sync 应成功，stderr：${sa.stderr}`)
  const sb = await run(['sync'], sessionEnv(world.home, world.serverUrl, world.bob))
  assert.equal(sb.status, 0, `bob sync 应成功，stderr：${sb.stderr}`)

  // 权限断言：员工本地根目录恰 0700——其他员工（不同 OS uid）不可列举/读取/进入
  assert.equal(modeOf(world.alice.root), 0o700, `alice 根目录应为 0700，实际 ${modeOf(world.alice.root).toString(8)}`)
  assert.equal(modeOf(world.bob.root), 0o700, `bob 根目录应为 0700，实际 ${modeOf(world.bob.root).toString(8)}`)
  // 员工私有目录（含凭据文件）同为 0700
  assert.equal(modeOf(world.alice.dir), 0o700, `alice 员工目录应为 0700，实际 ${modeOf(world.alice.dir).toString(8)}`)
  assert.equal(modeOf(world.bob.dir), 0o700, `bob 员工目录应为 0700，实际 ${modeOf(world.bob.dir).toString(8)}`)

  // 内容互不可读的另一面：各自根下恰为各自可见库 + 工具目录 .notegit（无对方库）
  assert.deepEqual((await readdir(world.alice.root)).sort(), ['.notegit', 'alice-notes', 'shared-docs'], 'alice 根下应恰为 alice 可见库')
  assert.deepEqual((await readdir(world.bob.root)).sort(), ['.notegit', 'bob-notes', 'shared-docs'], 'bob 根下应恰为 bob 可见库')
  assert.ok(!sa.stdout.includes('bob-notes'), 'alice 同步输出不得出现 bob 的库')
  assert.ok(!sb.stdout.includes('alice-notes'), 'bob 同步输出不得出现 alice 的库')

  // 状态/锁随根隔离：sync-state.json 在各自根内、条目恰为各自 slug
  const stateA = JSON.parse(await readFile(path.join(world.alice.root, '.notegit', 'sync-state.json'), 'utf8')) as { vaults: Record<string, unknown> }
  const stateB = JSON.parse(await readFile(path.join(world.bob.root, '.notegit', 'sync-state.json'), 'utf8')) as { vaults: Record<string, unknown> }
  assert.deepEqual(Object.keys(stateA.vaults).sort(), ['alice-notes', 'shared-docs'], 'alice 状态文件应恰含 alice 可见库')
  assert.deepEqual(Object.keys(stateB.vaults).sort(), ['bob-notes', 'shared-docs'], 'bob 状态文件应恰含 bob 可见库')
})

test('预存在宽松根目录：sync 收紧为 0700（托管误配 fail-closed 到私有）', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'ngt-hosted-tighten-'))
  const home = await mkdtemp(path.join(tmpdir(), 'ngt-hosted-tighten-home-'))
  const projectRoot = path.join(base, 'vaults')
  const worksRoot = path.join(base, 'works')
  await mkdir(projectRoot, { recursive: true })
  await mkdir(worksRoot, { recursive: true })
  await seedVault(projectRoot, worksRoot, 'docs', ['a.md'])
  const emp = mkEmployee(path.join(base, 'employees'), 'carol', ALICE_TOKEN)
  await mkdir(emp.root, { recursive: true }) // 误配形态：Harness 以默认权限预建了员工根目录
  await chmod(emp.root, 0o755)
  const server = await startMockServer(projectRoot, {
    username: emp.username,
    token: emp.token,
    apiOutcome: 'ok',
    gitBasicAccepted: true,
    vaults: [vault('docs')],
  })
  try {
    const login = await run(['login', server.baseUrl, '--username', emp.username], sessionEnv(home, server.baseUrl, emp))
    assert.equal(login.status, 0, `login 应成功，stderr：${login.stderr}`)
    const r = await run(['sync'], sessionEnv(home, server.baseUrl, emp))
    assert.equal(r.status, 0, `sync 应成功，stderr：${r.stderr}`)
    assert.equal(modeOf(emp.root), 0o700, `预存在的 0755 根目录应被收紧为 0700，实际 ${modeOf(emp.root).toString(8)}`)
    assert.equal(modeOf(emp.credFile), 0o600, '凭据文件应 0600（内容保护不依赖父目录）')
  } finally {
    await server.close()
    await rm(base, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }
})

// ── 断言二：凭据存储隔离（各自文件互不可读；一方 login 不改写另一方文件） ───────

test('凭据存储隔离：各员工文件 0600 互只含各自令牌；一方 login 不改写另一方文件；helper 按会话环境取各自令牌', async () => {
  const a = await readFile(world.alice.credFile, 'utf8')
  const b = await readFile(world.bob.credFile, 'utf8')

  // 内容面：各文件恰只含各自条目（对方令牌不得出现——凭据互不可见）
  assert.ok(a.includes(ALICE_TOKEN) && !a.includes(BOB_TOKEN), 'alice 凭据文件不得含 bob 令牌')
  assert.ok(b.includes(BOB_TOKEN) && !b.includes(ALICE_TOKEN), 'bob 凭据文件不得含 alice 令牌')

  // 改写面：bob 的 login 未改写 alice 文件（before() 中 alice 先登录并快照、bob 后登录）
  assert.equal(a, world.aliceCredBefore, 'bob login 不得改写 alice 凭据文件')
  assert.equal(b, world.bobCredBefore, 'alice login 不得改写 bob 凭据文件')

  // 权限面：两文件均 0600——其他员工不可读取内容
  assert.equal(modeOf(world.alice.credFile), 0o600, `alice 凭据文件应 0600，实际 ${modeOf(world.alice.credFile).toString(8)}`)
  assert.equal(modeOf(world.bob.credFile), 0o600, `bob 凭据文件应 0600，实际 ${modeOf(world.bob.credFile).toString(8)}`)

  // helper 面（git 传输取数路径）：同一实例、同一共享账号，NOTEGIT_CREDENTIALS_FILE
  // 决定读到哪份——各自会话环境各取各自令牌，绝不串读
  const host = new URL(world.serverUrl).host
  const query = `protocol=http\nhost=${host}\n\n`
  const ga = await run(['credential', 'get'], sessionEnv(world.home, world.serverUrl, world.alice), query)
  assert.equal(ga.status, 0, `helper get（alice 环境）应成功，stderr：${ga.stderr}`)
  assert.ok(ga.stdout.includes(ALICE_TOKEN) && !ga.stdout.includes(BOB_TOKEN), 'alice 会话环境应取到 alice 令牌且不含 bob 令牌')
  const gb = await run(['credential', 'get'], sessionEnv(world.home, world.serverUrl, world.bob), query)
  assert.equal(gb.status, 0, `helper get（bob 环境）应成功，stderr：${gb.stderr}`)
  assert.ok(gb.stdout.includes(BOB_TOKEN) && !gb.stdout.includes(ALICE_TOKEN), 'bob 会话环境应取到 bob 令牌且不含 alice 令牌')
})

// ── 断言三：sync 并行两员工不交叉（真实双进程、双根、首次同步） ────────────────

test('并行隔离：两员工真实双进程双根并发首次 sync，目录/状态/共享库互不交叉', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'ngt-hosted-par-'))
  const home = await mkdtemp(path.join(tmpdir(), 'ngt-hosted-par-home-'))
  const employees = path.join(base, 'employees')
  const projectRoot = path.join(base, 'vaults')
  const worksRoot = path.join(base, 'works')
  await mkdir(employees)
  await chmod(employees, 0o755)
  await mkdir(projectRoot, { recursive: true })
  await mkdir(worksRoot, { recursive: true })
  const sharedShas = await seedVault(projectRoot, worksRoot, 'shared-docs', ['a.md', 'b.md'])
  await seedVault(projectRoot, worksRoot, 'alice-notes', ['a.md'])
  await seedVault(projectRoot, worksRoot, 'bob-notes', ['a.md'])

  const alice = mkEmployee(employees, 'alice', ALICE_TOKEN)
  const bob = mkEmployee(employees, 'bob', BOB_TOKEN)
  const server = await startMockServer(projectRoot, {
    username: 'legacy',
    token: ALICE_TOKEN,
    apiOutcome: 'ok',
    gitBasicAccepted: true,
    identities: [
      { username: alice.username, token: alice.token, vaults: [vault('shared-docs'), vault('alice-notes')] },
      { username: bob.username, token: bob.token, vaults: [vault('shared-docs'), vault('bob-notes')] },
    ],
  })
  try {
    // 登记凭据（helper 注册 + 私有文件）后再并行——并行面只考验 sync 本身
    for (const emp of [alice, bob]) {
      const login = await run(['login', server.baseUrl, '--username', emp.username], sessionEnv(home, server.baseUrl, emp))
      assert.equal(login.status, 0, `${emp.username} login 应成功，stderr：${login.stderr}`)
    }

    // 真实双进程：两个子进程先都已 spawn（fork 在 await 之前完成），再等待两者
    const pa = run(['sync'], sessionEnv(home, server.baseUrl, alice))
    const pb = run(['sync'], sessionEnv(home, server.baseUrl, bob))
    const [ra, rb] = await Promise.all([pa, pb])
    assert.equal(ra.status, 0, `alice 并行 sync 应成功，stderr：${ra.stderr}`)
    assert.equal(rb.status, 0, `bob 并行 sync 应成功，stderr：${rb.stderr}`)
    // 并行证据：bob 进程在 alice 进程结束前已存在（两进程时间线相交）
    assert.ok(timelinesOverlap(ra, rb), '两 sync 子进程应真实并行（时间线相交）')

    // 目录不交叉：各自根下恰为各自可见库（共享库两边都有、专属库不越界）
    assert.deepEqual((await readdir(alice.root)).sort(), ['.notegit', 'alice-notes', 'shared-docs'], 'alice 根内容不得混入 bob 的库')
    assert.deepEqual((await readdir(bob.root)).sort(), ['.notegit', 'bob-notes', 'shared-docs'], 'bob 根内容不得混入 alice 的库')

    // 共享库两边一致：同一 commit，且等于服务端 tip
    assert.equal(rev(path.join(alice.root, 'shared-docs'), 'HEAD'), sharedShas[1]!, 'alice 的 shared-docs 应在服务端 tip')
    assert.equal(rev(path.join(bob.root, 'shared-docs'), 'HEAD'), sharedShas[1]!, 'bob 的 shared-docs 应在同一 tip')

    // 状态不交叉：各自状态文件恰含各自 slug
    const stateA = JSON.parse(await readFile(path.join(alice.root, '.notegit', 'sync-state.json'), 'utf8')) as { vaults: Record<string, unknown> }
    const stateB = JSON.parse(await readFile(path.join(bob.root, '.notegit', 'sync-state.json'), 'utf8')) as { vaults: Record<string, unknown> }
    assert.deepEqual(Object.keys(stateA.vaults).sort(), ['alice-notes', 'shared-docs'], 'alice 状态文件不得混入 bob 的库')
    assert.deepEqual(Object.keys(stateB.vaults).sort(), ['bob-notes', 'shared-docs'], 'bob 状态文件不得混入 alice 的库')

    // 并行不破坏隔离面：两根仍为 0700
    assert.equal(modeOf(alice.root), 0o700, `alice 根目录应为 0700，实际 ${modeOf(alice.root).toString(8)}`)
    assert.equal(modeOf(bob.root), 0o700, `bob 根目录应为 0700，实际 ${modeOf(bob.root).toString(8)}`)
  } finally {
    await server.close()
    await rm(base, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }
})

/** 两进程时间线相交：后启动者（later）起于先启动者（earlier）结束之前（spawn 均已在各自 Promise 构造时完成）。 */
function timelinesOverlap(earlier: Run, later: Run): boolean {
  return later.startedAt < earlier.endedAt
}
