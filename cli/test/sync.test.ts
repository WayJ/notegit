import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, mkdir, writeFile, readdir, readFile, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { startMockServer } from '../test-support/mock-server.ts'

// S7-T1 黑盒层：测试目标 = dist 产物（与 ls.test.ts 同约定）。六类工作副本状态策略表
// （架构 §7.3 唯一语义源）逐态断言：真实 git clone/fetch/merge 经 test-support
// mock-server（真实 git http-backend Smart HTTP + Basic 认证，凭据走 login 注册的
// credential helper——与生产同链路；S7-T3 前报告契约仅最小 stderr/stdout 行）。
const BIN = new URL('../dist/bin/notegit.js', import.meta.url).pathname
const FAKE_TOKEN = 'ngt_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE'
const FAKE_USERNAME = 'sync-user'

interface Run {
  status: number | null
  stdout: string
  stderr: string
}

// 异步 spawn（自死锁教训见 login-integration.test.ts）：本进程起 mock server，
// 子进程的 fetch/clone 需要父进程事件循环持续应答。
function run(args: string[], env: Record<string, string>): Promise<Run> {
  const child = spawn(process.execPath, [BIN, ...args], { env })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (d: string) => (stdout += d))
  child.stderr.on('data', (d: string) => (stderr += d))
  return new Promise((resolve) => {
    child.on('close', (code) => resolve({ status: code, stdout, stderr }))
  })
}

function gitEnv(home: string): Record<string, string> {
  return {
    PATH: process.env['PATH']!,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    NOTEGIT_CREDENTIALS_FILE: path.join(home, 'credentials'),
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  }
}

const GIT = { PATH: process.env['PATH']!, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } as const

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, env: GIT, stdio: 'pipe' })
}

function rev(cwd: string, ref: string): string {
  return execFileSync('git', ['rev-parse', ref], { cwd, env: GIT, encoding: 'utf8' }).trim()
}

function branchOf(cwd: string): string {
  return execFileSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd, env: GIT, encoding: 'utf8' }).trim()
}

/** 造 seed 工作库并推 bare（projectRoot/<slug>.git，被 mock server 以 Smart HTTP 服务）。 */
async function seedVault(projectRoot: string, worksRoot: string, slug: string, n: number): Promise<{ shas: string[]; work: string; bare: string }> {
  const work = path.join(worksRoot, slug)
  await mkdir(work, { recursive: true })
  git(work, 'init', '-b', 'main')
  git(work, 'config', 'user.name', 'seed')
  git(work, 'config', 'user.email', 'seed@notegit.invalid')
  const shas: string[] = []
  for (let i = 0; i < n; i++) {
    await writeFile(path.join(work, `f${i}.md`), `# ${slug} note ${i}\n`)
    git(work, 'add', '.')
    git(work, 'commit', '-m', `c${i}`)
    shas.push(rev(work, 'HEAD'))
  }
  const bare = path.join(projectRoot, `${slug}.git`)
  git(worksRoot, 'clone', '--quiet', '--bare', work, bare)
  return { shas, work, bare }
}

/** seed 工作库追加一次提交并推 bare，返回新 tip。 */
async function advance(work: string, bare: string, name: string): Promise<string> {
  await writeFile(path.join(work, `${name}.md`), `# ${name}\n`)
  git(work, 'add', '.')
  git(work, 'commit', '-m', name)
  const sha = rev(work, 'HEAD')
  git(work, 'push', bare, 'main')
  return sha
}

/** 在本地副本内追加一次提交（不推送），返回新 head。 */
async function localCommit(dir: string, name: string): Promise<string> {
  git(dir, 'config', 'user.name', 'local')
  git(dir, 'config', 'user.email', 'local@notegit.invalid')
  await writeFile(path.join(dir, `${name}.md`), `# ${name}\n`)
  git(dir, 'add', '.')
  git(dir, 'commit', '-m', name)
  return rev(dir, 'HEAD')
}

interface World {
  home: string
  localRoot: string
  serverUrl: string
  shas: Record<string, { c1: string; c2?: string; local?: string }>
}

let world: World
let mainServer: { close(): Promise<void> } | undefined

before(async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'ngt-sync-home-'))
  const localRoot = await mkdtemp(path.join(tmpdir(), 'ngt-sync-local-'))
  const projectRoot = path.join(home, 'vaults')
  const worksRoot = path.join(home, 'works')
  await mkdir(projectRoot, { recursive: true })
  await mkdir(worksRoot, { recursive: true })

  const shas: Record<string, { c1: string; c2?: string; local?: string }> = {}
  const cloneLocal = async (slug: string, bare: string): Promise<string> => {
    const dir = path.join(localRoot, slug)
    git(localRoot, 'clone', '--quiet', bare, dir)
    return rev(dir, 'HEAD')
  }

  // v-new：仅远端存在，本地无副本
  const vNew = await seedVault(projectRoot, worksRoot, 'v-new', 1)
  shas['v-new'] = { c1: vNew.shas[0]! }

  // v-clean：本地 c1，远端前进到 c2 → 应 fetch 后快进
  const vClean = await seedVault(projectRoot, worksRoot, 'v-clean', 1)
  await cloneLocal('v-clean', vClean.bare)
  shas['v-clean'] = { c1: vClean.shas[0]!, c2: await advance(vClean.work, vClean.bare, 'remote-advance') }

  // v-dirty：本地 c1 + 未提交修改，远端前进 → 跳过且字节不动
  const vDirty = await seedVault(projectRoot, worksRoot, 'v-dirty', 1)
  await cloneLocal('v-dirty', vDirty.bare)
  shas['v-dirty'] = { c1: vDirty.shas[0]!, c2: await advance(vDirty.work, vDirty.bare, 'remote-advance') }
  await writeFile(path.join(localRoot, 'v-dirty', 'f0.md'), '# 本地未提交修改（不可被覆盖）\n')

  // v-ahead：本地领先（未推送提交），远端停在 c1 → 跳过
  const vAhead = await seedVault(projectRoot, worksRoot, 'v-ahead', 1)
  shas['v-ahead'] = { c1: vAhead.shas[0]!, local: await (async () => {
    const dir = path.join(localRoot, 'v-ahead')
    git(localRoot, 'clone', '--quiet', vAhead.bare, dir)
    return localCommit(dir, 'local-work')
  })() }

  // v-diverged：本地 cL + 远端 c2（互不为祖先）→ 跳过（克隆须在远端前进之前，才是真分叉）
  const vDiverged = await seedVault(projectRoot, worksRoot, 'v-diverged', 1)
  const divergedDir = path.join(localRoot, 'v-diverged')
  git(localRoot, 'clone', '--quiet', vDiverged.bare, divergedDir)
  const divergedLocal = await localCommit(divergedDir, 'local-work')
  shas['v-diverged'] = { c1: vDiverged.shas[0]!, c2: await advance(vDiverged.work, vDiverged.bare, 'remote-advance'), local: divergedLocal }

  // v-other：本地检出 feature 分支，远端前进 → 跳过
  const vOther = await seedVault(projectRoot, worksRoot, 'v-other', 1)
  const otherHead = await cloneLocal('v-other', vOther.bare)
  git(path.join(localRoot, 'v-other'), 'checkout', '--quiet', '-b', 'feature')
  shas['v-other'] = { c1: otherHead, c2: await advance(vOther.work, vOther.bare, 'remote-advance') }

  const vaults = ['v-new', 'v-clean', 'v-dirty', 'v-ahead', 'v-diverged', 'v-other'].map((slug) => ({
    slug,
    name: slug,
    role: 'reader',
    default_branch: 'main',
    main_admin_only: false,
  }))
  const server = await startMockServer(projectRoot, { username: FAKE_USERNAME, token: FAKE_TOKEN, apiOutcome: 'ok', gitBasicAccepted: true, vaults })

  const env = gitEnv(home)
  const login = await run(['login', server.baseUrl, '--username', FAKE_USERNAME], { ...env, NOTEGIT_TOKEN: FAKE_TOKEN })
  assert.equal(login.status, 0, `login 应成功，stderr：${login.stderr}`)

  world = { home, localRoot, serverUrl: server.baseUrl, shas }
  mainServer = server
})

after(async () => {
  if (mainServer !== undefined) await mainServer.close()
  if (world === undefined) return // before() 中途失败时无需清理（各测试也不会运行）
  await rm(world.home, { recursive: true, force: true })
  await rm(world.localRoot, { recursive: true, force: true })
})

function syncEnv(extra: Record<string, string> = {}): Record<string, string> {
  return { ...gitEnv(world.home), NOTEGIT_SERVER: world.serverUrl, NOTEGIT_TOKEN: FAKE_TOKEN, NOTEGIT_LOCAL_ROOT: world.localRoot, ...extra }
}

function runSyncCli(args: string[] = []): Promise<Run> {
  return run(['sync', ...args], syncEnv())
}

// ── 六态策略表（架构 §7.3；验收场景 S1） ─────────────────────────────────────

test('六态单次同步：新库克隆、干净快进、脏/领先/分叉/他分支跳过；跳过不判失败（退出码 0）', async () => {
  const r = await runSyncCli()
  assert.equal(r.status, 0, `stderr：${r.stderr}\nstdout：${r.stdout}`)

  // 新库 → 完整克隆（默认分支、远端 tip、工作树就位）
  const newDir = path.join(world.localRoot, 'v-new')
  assert.equal(rev(newDir, 'HEAD'), world.shas['v-new']!.c1, 'v-new 应克隆到远端 tip')
  assert.equal(branchOf(newDir), 'main')
  assert.ok((await readdir(newDir)).includes('f0.md'), '克隆应含工作树文件')

  // 干净 → fetch 后快进，工作树随更新
  const cleanDir = path.join(world.localRoot, 'v-clean')
  assert.equal(rev(cleanDir, 'HEAD'), world.shas['v-clean']!.c2, 'v-clean 应快进到远端 tip')
  assert.ok((await readdir(cleanDir)).includes('remote-advance.md'), '快进后新文件应出现在工作树')

  // 脏 → 跳过：head 不动、未提交字节逐字节保留
  const dirtyDir = path.join(world.localRoot, 'v-dirty')
  assert.equal(rev(dirtyDir, 'HEAD'), world.shas['v-dirty']!.c1, '脏副本 head 不得移动')
  assert.equal(await readFile(path.join(dirtyDir, 'f0.md'), 'utf8'), '# 本地未提交修改（不可被覆盖）\n', '未提交内容必须逐字节保留（D7）')

  // 领先 → 跳过：本地提交保留
  assert.equal(rev(path.join(world.localRoot, 'v-ahead'), 'HEAD'), world.shas['v-ahead']!.local, '领先副本 head 不得移动')

  // 分叉 → 跳过
  assert.equal(rev(path.join(world.localRoot, 'v-diverged'), 'HEAD'), world.shas['v-diverged']!.local, '分叉副本 head 不得移动')

  // 他分支 → 跳过：仍在 feature
  assert.equal(branchOf(path.join(world.localRoot, 'v-other')), 'feature', '他分支副本不得被切回默认分支')
  assert.equal(rev(path.join(world.localRoot, 'v-other'), 'HEAD'), world.shas['v-other']!.c1)

  // 报告面：成功走 stdout，四类跳过各占一行 stderr 且含原因关键词
  assert.match(r.stdout, /v-new：已克隆/)
  assert.match(r.stdout, /v-clean：已快进/)
  assert.match(r.stderr, /v-dirty：跳过——.*未提交修改/)
  assert.match(r.stderr, /v-ahead：跳过——.*未推送/)
  assert.match(r.stderr, /v-diverged：跳过——.*分叉/)
  assert.match(r.stderr, /v-other：跳过——.*feature/)
  assert.match(r.stdout, /共 6 库/)
  assert.match(r.stdout, /成功 2、跳过 4、失败 0/)
})

test('干净且已是最新：再次同步报「已是最新」，不发起变更（clean 的 head==tip 分支）', async () => {
  const r = await runSyncCli()
  assert.equal(r.status, 0, `stderr：${r.stderr}`)
  assert.match(r.stdout, /v-new：已是最新/)
  assert.match(r.stdout, /v-clean：已是最新/)
  assert.equal(rev(path.join(world.localRoot, 'v-clean'), 'HEAD'), world.shas['v-clean']!.c2, '已最新副本 head 不变')
})

// ── 判定失败 → 逐库失败 + 退出码非零（退出码语义与 S7-T3 验收口径一致） ────────

test('目录存在但不是 git 仓库：该库失败（stderr 含原因），退出码 1；其余库不受牵连', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'ngt-sync-fail-'))
  const localRoot = path.join(home, 'local')
  await mkdir(path.join(localRoot, 'v-x'), { recursive: true }) // 非 git 目录
  const server = await startMockServer(home, {
    username: FAKE_USERNAME,
    token: FAKE_TOKEN,
    apiOutcome: 'ok',
    gitBasicAccepted: false,
    vaults: [{ slug: 'v-x', name: 'X', role: 'reader', default_branch: 'main', main_admin_only: false }],
  })
  try {
    const r = await run(['sync'], { ...gitEnv(home), NOTEGIT_SERVER: server.baseUrl, NOTEGIT_TOKEN: FAKE_TOKEN, NOTEGIT_LOCAL_ROOT: localRoot })
    assert.equal(r.status, 1, '有失败库 → 退出码非零')
    assert.match(r.stderr, /v-x：失败——.*不是 git 仓库/)
    assert.match(r.stdout, /失败 1/)
  } finally {
    await server.close()
    await rm(home, { recursive: true, force: true })
  }
})

// ── slug 改名：提示映射变化，不擅动目录（架构 §7.2） ──────────────────────────

test('slug 改名：新 slug 正常克隆，旧目录保留并提示（不移动/不删除）', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'ngt-sync-rename-'))
  const localRoot = path.join(home, 'local')
  const works = path.join(home, 'works')
  const projectRoot = path.join(home, 'vaults')
  await mkdir(works, { recursive: true })
  await mkdir(projectRoot, { recursive: true })
  const seeded = await seedVault(projectRoot, works, 'alpha', 1)
  const vaults = [{ slug: 'alpha', name: 'Alpha', role: 'reader', default_branch: 'main', main_admin_only: false }]
  const server = await startMockServer(projectRoot, { username: FAKE_USERNAME, token: FAKE_TOKEN, apiOutcome: 'ok', gitBasicAccepted: true, vaults })
  const env = { ...gitEnv(home), NOTEGIT_SERVER: server.baseUrl, NOTEGIT_TOKEN: FAKE_TOKEN, NOTEGIT_LOCAL_ROOT: localRoot }
  try {
    const login = await run(['login', server.baseUrl, '--username', FAKE_USERNAME], { ...gitEnv(home), NOTEGIT_TOKEN: FAKE_TOKEN })
    assert.equal(login.status, 0, `login 应成功，stderr：${login.stderr}`)
    const r1 = await run(['sync'], env)
    assert.equal(r1.status, 0, `首次同步失败：${r1.stderr}`)
    assert.equal(rev(path.join(localRoot, 'alpha'), 'HEAD'), seeded.shas[0]!)

    // 服务端改名：alpha → renamed（库列表与磁盘 bare 同步更名）；旧目录 alpha 成为「不对应当前可见库」的本地副本
    vaults[0] = { ...vaults[0]!, slug: 'renamed' }
    await rename(path.join(projectRoot, 'alpha.git'), path.join(projectRoot, 'renamed.git'))
    const r2 = await run(['sync'], env)
    assert.equal(r2.status, 0, `改名后同步失败：${r2.stderr}`)
    assert.match(r2.stdout, /renamed：已克隆/)
    assert.match(r2.stderr, /alpha.*不对应当前任何可见库|不对应当前任何可见库.*alpha/, '应对旧目录给出提示')
    assert.match(r2.stderr, /不会移动或删除/, '提示需明示不擅动目录')
    assert.equal(rev(path.join(localRoot, 'alpha'), 'HEAD'), seeded.shas[0]!, '旧目录原样保留')
    assert.ok((await readdir(localRoot)).includes('alpha'), '旧目录不得被删除/改名')
  } finally {
    await server.close()
    await rm(home, { recursive: true, force: true })
  }
})

// ── 浅克隆仅显式选项（--depth） ───────────────────────────────────────────────

test('--depth 1 → 浅克隆；缺省 → 完整克隆', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'ngt-sync-depth-'))
  const localRoot = path.join(home, 'local')
  const works = path.join(home, 'works')
  const projectRoot = path.join(home, 'vaults')
  await mkdir(works, { recursive: true })
  await mkdir(projectRoot, { recursive: true })
  await seedVault(projectRoot, works, 'v-deep', 2)
  const server = await startMockServer(projectRoot, {
    username: FAKE_USERNAME,
    token: FAKE_TOKEN,
    apiOutcome: 'ok',
    gitBasicAccepted: true,
    vaults: [{ slug: 'v-deep', name: 'Deep', role: 'reader', default_branch: 'main', main_admin_only: false }],
  })
  const env = { ...gitEnv(home), NOTEGIT_SERVER: server.baseUrl, NOTEGIT_TOKEN: FAKE_TOKEN, NOTEGIT_LOCAL_ROOT: localRoot }
  try {
    const login = await run(['login', server.baseUrl, '--username', FAKE_USERNAME], { ...gitEnv(home), NOTEGIT_TOKEN: FAKE_TOKEN })
    assert.equal(login.status, 0, `login 应成功，stderr：${login.stderr}`)

    const shallow = (dir: string): boolean =>
      execFileSync('git', ['-C', dir, 'rev-parse', '--is-shallow-repository'], { env: GIT, encoding: 'utf8' }).trim() === 'true'

    const r1 = await run(['sync', '--depth', '1'], env)
    assert.equal(r1.status, 0, `--depth 1 同步失败：${r1.stderr}`)
    assert.equal(shallow(path.join(localRoot, 'v-deep')), true, '--depth 1 应产出浅克隆')

    await rm(path.join(localRoot, 'v-deep'), { recursive: true, force: true })
    const r2 = await run(['sync'], env)
    assert.equal(r2.status, 0, `缺省同步失败：${r2.stderr}`)
    assert.equal(shallow(path.join(localRoot, 'v-deep')), false, '缺省应完整克隆')
  } finally {
    await server.close()
    await rm(home, { recursive: true, force: true })
  }
})

// ── 用法与退出码（0 成功 / 1 业务失败 / 2 用法错误；同 ls 契约） ────────────────

test('未配置凭据：退出码 1，stderr 提示配置面', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'ngt-sync-nocred-'))
  try {
    const r = await run(['sync'], gitEnv(home))
    assert.equal(r.status, 1)
    assert.match(r.stderr, /未配置/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('token 无效（401）：退出码 1，stderr 提示认证失败', async () => {
  const bad = await run(['sync'], syncEnv({ NOTEGIT_TOKEN: `ngt_${'z'.repeat(43)}` }))
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /认证失败|401/)
})

test('服务器不可达：退出码 1，stderr 提示无法连接', async () => {
  const r = await run(['sync'], syncEnv({ NOTEGIT_SERVER: 'http://127.0.0.1:1' }))
  assert.equal(r.status, 1)
  assert.match(r.stderr, /无法连接/)
})

test('未知选项 / 位置参数 / 非法 --depth：退出码 2（用法错误）', async () => {
  // 注：--json 已是合法选项（S7-T3 交付，契约见 sync-report.test.ts），不再属用法错误
  for (const args of [['--definitely-not-a-flag'], ['positional'], ['--depth', '0'], ['--depth', 'x']] as const) {
    const r = await run(['sync', ...args], syncEnv())
    assert.equal(r.status, 2, `${args.join(' ')} 应为用法错误`)
    assert.ok(r.stderr.length > 0)
  }
})
