/**
 * S9-T5 托管 Harness 收口（breakdown §2.8 S9-T5 行；DOD-10「托管凭据和目录按员工
 * 隔离」复查）。按 docs/harness/hosted-runbook.md §1–§2 布局，对**真实服务实例**
 * （server/ 现码 startApp——真实授权面：可见库即成员关系）起两员工（同一 OS 账号
 * 最苛刻形态），各自 login/ls/sync 后复查目录/凭据/状态隔离与共享库协作。
 *
 * 与 hosted-isolation.test.ts（S7-T7，mock server）的分工：那边守 helper 协议与
 * 并行/收紧边角（三断言），本文件守真实实例上的收口复查（runbook 布局逐行 +
 * 共享库 push/sync 协作不破坏隔离）。收口记录见 docs/s9/harness-hosted-closeout.md，
 * 复跑演练脚本 cli/test-support/harness-closeout-drill.ts。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, chmodSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  bootRealInstance,
  createEmployee,
  createCredentialFor,
  createVault,
  seedVaultContent,
  git,
  type RealInstance,
} from '../test-support/real-instance.ts'

const BIN = new URL('../dist/bin/notegit.js', import.meta.url).pathname

interface Run {
  status: number | null
  stdout: string
  stderr: string
}

function runBin(args: string[], env: Record<string, string>, opts: { cwd?: string; stdin?: string } = {}): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { env, cwd: opts.cwd })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => (stdout += d))
    child.stderr.on('data', (d: string) => (stderr += d))
    if (opts.stdin !== undefined) child.stdin.write(opts.stdin)
    child.stdin.end()
    child.on('close', (code) => resolve({ status: code, stdout, stderr }))
  })
}

interface Employee {
  username: string
  token: string
  dir: string
  root: string
  credFile: string
}

function modeOf(p: string): number {
  return statSync(p).mode & 0o777
}

let base: string
let home: string
let inst: RealInstance
let alice: Employee
let bob: Employee
let aliceCredBefore: string
let envOf: (emp: Employee) => Record<string, string>

before(async () => {
  base = mkdtempSync(path.join(tmpdir(), 'ngt-hosted-closeout-'))
  home = mkdtempSync(path.join(tmpdir(), 'ngt-hosted-closeout-home-'))
  inst = await bootRealInstance(path.join(base, 'server-data'))

  const aliceAcc = await createEmployee(inst, 'alice')
  const bobAcc = await createEmployee(inst, 'bob')
  const mk = (name: string, token: string): Employee => {
    const dir = path.join(base, 'employees', name)
    return { username: name, token, dir, root: path.join(dir, 'knowbase'), credFile: path.join(dir, 'credentials') }
  }
  alice = mk('alice', await createCredentialFor(inst, aliceAcc.username, aliceAcc.password))
  bob = mk('bob', await createCredentialFor(inst, bobAcc.username, bobAcc.password))

  // runbook §1 布局：共享父目录 0755（仅遍历）；员工目录（凭据+本地根）由 CLI 创建/收紧
  mkdirSync(path.join(base, 'employees'), { recursive: true })
  chmodSync(path.join(base, 'employees'), 0o755)

  // 两员工三库两成员集：alice 专属 / bob 专属 / 共享
  await createVault(inst, 'alice-notes', 'Alice 专属', [{ username: alice.username, role: 'editor' }])
  await createVault(inst, 'bob-notes', 'Bob 专属', [{ username: bob.username, role: 'editor' }])
  await createVault(inst, 'team-docs', '团队共享', [
    { username: alice.username, role: 'editor' },
    { username: bob.username, role: 'editor' },
  ])
  await seedVaultContent(inst.baseUrl, 'alice-notes', alice.token, [{ path: 'README.md', content: '# alice\n' }])
  await seedVaultContent(inst.baseUrl, 'bob-notes', bob.token, [{ path: 'README.md', content: '# bob\n' }])
  await seedVaultContent(inst.baseUrl, 'team-docs', alice.token, [{ path: 'README.md', content: '# team\n' }])

  // 同一 OS 账号（HOME 与 git 全局配置共享）——最苛刻形态，仅会话环境隔离
  envOf = (emp: Employee): Record<string, string> => ({
    ...(process.env as Record<string, string>),
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    NOTEGIT_CREDENTIALS_FILE: emp.credFile,
    NOTEGIT_LOCAL_ROOT: emp.root,
    NOTEGIT_SERVER: inst.baseUrl,
    NOTEGIT_TOKEN: emp.token,
  })

  const loginA = await runBin(['login', inst.baseUrl, '--username', alice.username], envOf(alice))
  assert.equal(loginA.status, 0, `alice login 应成功，stderr：${loginA.stderr}`)
  aliceCredBefore = readFileSync(alice.credFile, 'utf8')
  const loginB = await runBin(['login', inst.baseUrl, '--username', bob.username], envOf(bob))
  assert.equal(loginB.status, 0, `bob login 应成功，stderr：${loginB.stderr}`)
})

after(async () => {
  await inst.close()
  rmSync(base, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
})

test('真实授权面：各自 ls 恰列各自可见库，sync 后根下恰克隆各自可见库（目录互不交叉）', async () => {
  const a = await runBin(['ls', '--json'], envOf(alice))
  assert.equal(a.status, 0, `alice ls 应退出 0，stderr：${a.stderr}`)
  const b = await runBin(['ls', '--json'], envOf(bob))
  assert.equal(b.status, 0, `bob ls 应退出 0，stderr：${b.stderr}`)
  const slugsA = (JSON.parse(a.stdout) as { vaults: Array<{ slug: string }> }).vaults.map((x) => x.slug).sort()
  const slugsB = (JSON.parse(b.stdout) as { vaults: Array<{ slug: string }> }).vaults.map((x) => x.slug).sort()
  assert.deepEqual(slugsA, ['alice-notes', 'team-docs'], `alice 可见库应恰为 2：${slugsA}`)
  assert.deepEqual(slugsB, ['bob-notes', 'team-docs'], `bob 可见库应恰为 2：${slugsB}`)

  const syncA = await runBin(['sync'], envOf(alice))
  assert.equal(syncA.status, 0, `alice sync 应成功，stderr：${syncA.stderr}`)
  const syncB = await runBin(['sync'], envOf(bob))
  assert.equal(syncB.status, 0, `bob sync 应成功，stderr：${syncB.stderr}`)
  assert.ok(!syncA.stdout.includes('bob-notes'), 'alice 同步输出不得出现 bob 的库')
  assert.ok(!syncB.stdout.includes('alice-notes'), 'bob 同步输出不得出现 alice 的库')
  assert.deepEqual(readdirSync(alice.root).sort(), ['.notegit', 'alice-notes', 'team-docs'], 'alice 根下应恰为 alice 可见库')
  assert.deepEqual(readdirSync(bob.root).sort(), ['.notegit', 'bob-notes', 'team-docs'], 'bob 根下应恰为 bob 可见库')
})

test('权限位复查（runbook §1 逐行）：员工目录/本地根 0700、凭据 0600、共享父目录 0755', () => {
  assert.equal(modeOf(path.join(base, 'employees')), 0o755, '共享父目录应保持 0755（仅遍历）')
  for (const emp of [alice, bob]) {
    assert.equal(modeOf(emp.dir), 0o700, `${emp.username} 员工目录应 0700`)
    assert.equal(modeOf(emp.root), 0o700, `${emp.username} 本地根应 0700`)
    assert.equal(modeOf(emp.credFile), 0o600, `${emp.username} 凭据文件应 0600`)
  }
})

test('凭据隔离复查：各文件互只含各自令牌；一方 login 未改写另一方文件；helper 按会话各取各自令牌', async () => {
  const a = readFileSync(alice.credFile, 'utf8')
  const b = readFileSync(bob.credFile, 'utf8')
  assert.ok(a.includes(alice.token) && !a.includes(bob.token), 'alice 凭据文件不得含 bob 令牌')
  assert.ok(b.includes(bob.token) && !b.includes(alice.token), 'bob 凭据文件不得含 alice 令牌')
  assert.equal(a, aliceCredBefore, 'bob login 不得改写 alice 凭据文件')

  const host = new URL(inst.baseUrl).host
  const query = `protocol=http\nhost=${host}\n\n`
  const ga = await runBin(['credential', 'get'], envOf(alice), { stdin: query })
  assert.equal(ga.status, 0, `helper get（alice 环境）应成功，stderr：${ga.stderr}`)
  assert.ok(ga.stdout.includes(alice.token) && !ga.stdout.includes(bob.token), 'alice 会话应取到 alice 令牌且不含 bob 令牌')
  const gb = await runBin(['credential', 'get'], envOf(bob), { stdin: query })
  assert.equal(gb.status, 0, `helper get（bob 环境）应成功，stderr：${gb.stderr}`)
  assert.ok(gb.stdout.includes(bob.token) && !gb.stdout.includes(alice.token), 'bob 会话应取到 bob 令牌且不含 alice 令牌')
})

test('状态隔离复查：sync-state.json 各随各根，条目恰为各自可见库', () => {
  const stateA = JSON.parse(readFileSync(path.join(alice.root, '.notegit', 'sync-state.json'), 'utf8')) as { vaults: Record<string, unknown> }
  const stateB = JSON.parse(readFileSync(path.join(bob.root, '.notegit', 'sync-state.json'), 'utf8')) as { vaults: Record<string, unknown> }
  assert.deepEqual(Object.keys(stateA.vaults).sort(), ['alice-notes', 'team-docs'], 'alice 状态文件应恰含 alice 可见库')
  assert.deepEqual(Object.keys(stateB.vaults).sort(), ['bob-notes', 'team-docs'], 'bob 状态文件应恰含 bob 可见库')
})

test('共享库协作不破坏隔离：alice 会话 push team-docs → bob sync 快进同一提交；bob 根仍无 alice 专属库', async () => {
  const teamRepo = path.join(alice.root, 'team-docs')
  mkdirSync(path.join(teamRepo, 'notes'), { recursive: true })
  writeFileSync(path.join(teamRepo, 'notes', 'alice-post.md'), '---\ntitle: Alice 的共享帖\n---\n\n经 alice 托管会话发布。\n')
  await git(teamRepo, 'add', '.')
  const commit = await git(teamRepo, 'commit', '-m', 'S9-T5 alice 共享库提交')
  assert.equal(commit.status, 0, `commit 应成功：${commit.stderr}`)
  const push = await new Promise<Run>((resolve) => {
    const child = spawn('git', ['push', 'origin', 'main'], { cwd: teamRepo, env: envOf(alice) })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')))
    child.on('close', (code) => resolve({ status: code, stdout, stderr }))
  })
  assert.equal(push.status, 0, `alice push team-docs 应成功：${push.stderr}`)
  assert.ok(!push.stdout.includes(alice.token) && !push.stderr.includes(alice.token), 'push 输出不得含明文令牌')
  const aliceHead = (await git(teamRepo, 'rev-parse', 'HEAD')).stdout.trim()

  const syncB = await runBin(['sync'], envOf(bob))
  assert.equal(syncB.status, 0, `bob sync 应成功，stderr：${syncB.stderr}`)
  const bobTeamHead = (await git(path.join(bob.root, 'team-docs'), 'rev-parse', 'HEAD')).stdout.trim()
  assert.equal(bobTeamHead, aliceHead, 'bob 的 team-docs 应快进到 alice 推送的同一提交')
  assert.ok(readFileSync(path.join(bob.root, 'team-docs', 'notes', 'alice-post.md'), 'utf8').includes('alice 托管会话'), 'bob 副本应含 alice 发布的内容')
  assert.ok(!readdirSync(bob.root).includes('alice-notes'), 'bob 根仍不得出现 alice 专属库')
});
