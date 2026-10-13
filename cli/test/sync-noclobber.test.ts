import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, rm, mkdir, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { startMockServer } from '../test-support/mock-server.ts'
import { captureWorktreeFingerprint, firstFingerprintMismatch } from '../src/sync/worktree-snapshot.ts'
import { readLastSync } from '../src/sync/last-sync.ts'

// S7-T2 黑盒层：不覆盖保证（D7 红线；epic 风险行 4 应对——「本地数据前后对比」）。
// 测试目标 = dist 产物（与 sync.test.ts 同约定）；指纹采集器是测试仪器（源码导入，
// 非被测面）。四类跳过态 + 边角态（未跟踪/暂存/unmerged/分离头指针）在「同一轮
// 真实 sync」前后各采一次本地指纹（status/diff 全量 + 索引 + refs + 工作树逐文件
// sha256），断言逐字节不变；同轮内 v-new 克隆与 v-clean 快进照常发生——证明
// 「不动」是逐库策略而非全局空转。跳过报告须含原因+离线副本 commit+上次同步时间。
const BIN = new URL('../dist/bin/notegit.js', import.meta.url).pathname
const FAKE_TOKEN = 'ngt_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE'
const FAKE_USERNAME = 'sync-user'

interface Run {
  status: number | null
  stdout: string
  stderr: string
}

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

async function seedVault(projectRoot: string, worksRoot: string, slug: string): Promise<{ work: string; bare: string }> {
  const work = path.join(worksRoot, slug)
  await mkdir(work, { recursive: true })
  git(work, 'init', '-b', 'main')
  git(work, 'config', 'user.name', 'seed')
  git(work, 'config', 'user.email', 'seed@notegit.invalid')
  await writeFile(path.join(work, 'f0.md'), `# ${slug} note 0\n`)
  git(work, 'add', '.')
  git(work, 'commit', '-m', 'c0')
  const bare = path.join(projectRoot, `${slug}.git`)
  git(worksRoot, 'clone', '--quiet', '--bare', work, bare)
  return { work, bare }
}

/** 远端追加一次提交并推 bare（新增文件，不与本地冲突）。 */
async function advance(work: string, bare: string, name: string): Promise<string> {
  await writeFile(path.join(work, `${name}.md`), `# ${name}\n`)
  git(work, 'add', '.')
  git(work, 'commit', '-m', name)
  const sha = rev(work, 'HEAD')
  git(work, 'push', '-q', bare, 'main')
  return sha
}

/** 远端改写 f0.md 并推 bare（制造与本地 f0.md 改动的真冲突）。 */
async function advanceTouching(work: string, bare: string, content: string): Promise<string> {
  await writeFile(path.join(work, 'f0.md'), content)
  git(work, 'add', '.')
  git(work, 'commit', '-m', 'remote-touch')
  const sha = rev(work, 'HEAD')
  git(work, 'push', '-q', bare, 'main')
  return sha
}

/** 本地副本内追加一次提交（不推送）。 */
async function localCommit(dir: string, name: string): Promise<string> {
  git(dir, 'config', 'user.name', 'local')
  git(dir, 'config', 'user.email', 'local@notegit.invalid')
  await writeFile(path.join(dir, `${name}.md`), `# ${name}\n`)
  git(dir, 'add', '.')
  git(dir, 'commit', '-m', name)
  return rev(dir, 'HEAD')
}

/** 四类规范跳过态 + 四类边角态 + 两个活性见证（v-new 克隆 / v-clean 快进）。 */
const SKIP_STATES = ['v-dirty', 'v-ahead', 'v-diverged', 'v-other', 'v-untracked', 'v-staged', 'v-unmerged', 'v-detached'] as const

interface World {
  home: string
  localRoot: string
  serverUrl: string
  /** 各状态库的本地 head/分支（phase B 定格后），供前后断言。 */
  heads: Record<string, string>
  branches: Record<string, string>
  cleanTip: string
  newTip: string
}

let world: World
let mainServer: { close(): Promise<void> } | undefined

before(async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'ngt-noclobber-home-'))
  const localRoot = await mkdtemp(path.join(tmpdir(), 'ngt-noclobber-local-'))
  const projectRoot = path.join(home, 'vaults')
  const worksRoot = path.join(home, 'works')
  await mkdir(projectRoot, { recursive: true })
  await mkdir(worksRoot, { recursive: true })

  const works: Record<string, { work: string; bare: string }> = {}
  const slugs = [...SKIP_STATES, 'v-clean', 'v-new']
  for (const slug of slugs) works[slug] = await seedVault(projectRoot, worksRoot, slug)

  // v-new 不进首轮可见列表——留给证明轮作为「克隆」活性见证（库列表可变，同 T1 改名测试）
  const vaultsOf = (extraNew: boolean) =>
    slugs
      .filter((s) => extraNew || s !== 'v-new')
      .map((slug) => ({ slug, name: slug, role: 'reader', default_branch: 'main', main_admin_only: false }))

  const server = await startMockServer(projectRoot, { username: FAKE_USERNAME, token: FAKE_TOKEN, apiOutcome: 'ok', gitBasicAccepted: true, vaults: vaultsOf(false) })
  mainServer = server

  const env = gitEnv(home)
  const login = await run(['login', server.baseUrl, '--username', FAKE_USERNAME], { ...env, NOTEGIT_TOKEN: FAKE_TOKEN })
  assert.equal(login.status, 0, `login 应成功，stderr：${login.stderr}`)

  const syncEnv = { ...env, NOTEGIT_SERVER: server.baseUrl, NOTEGIT_TOKEN: FAKE_TOKEN, NOTEGIT_LOCAL_ROOT: localRoot }
  // Phase A：首轮同步——九库全克隆（写入上次同步标记），v-clean 停在 c0
  const r1 = await run(['sync'], syncEnv)
  assert.equal(r1.status, 0, `首轮同步失败：${r1.stderr}`)
  for (const slug of slugs.filter((s) => s !== 'v-new')) {
    assert.equal(rev(path.join(localRoot, slug), 'HEAD'), rev(works[slug]!.work, 'HEAD'), `${slug} 首轮应克隆到 c0`)
  }

  // Phase B：把八个库定格为各自状态（远端推进在本地改动之后，才是真分叉/真落后）
  const dir = (slug: string): string => path.join(localRoot, slug)

  await writeFile(path.join(dir('v-dirty'), 'f0.md'), '# 本地未提交修改（不可被覆盖）\n')
  await localCommit(dir('v-ahead'), 'local-work')
  await localCommit(dir('v-diverged'), 'local-work')
  await writeFile(path.join(dir('v-untracked'), 'untracked.md'), '# 未跟踪文件（不可被删）\n')
  await mkdir(path.join(dir('v-untracked'), 'notes', 'deep'), { recursive: true })
  await writeFile(path.join(dir('v-untracked'), 'notes', 'deep', 'u.md'), '# 嵌套未跟踪\n')
  await writeFile(path.join(dir('v-staged'), 'f0.md'), '# 已暂存修改（index 不可被动）\n')
  git(dir('v-staged'), 'add', 'f0.md')
  git(dir('v-other'), 'checkout', '--quiet', '-b', 'feature')
  git(dir('v-detached'), 'checkout', '--quiet', '--detach', 'HEAD')

  // v-unmerged：本地与远端各自改 f0.md → 本地 fetch（bare 路径）后 merge 留下冲突态
  await writeFile(path.join(dir('v-unmerged'), 'f0.md'), '# 本地冲突侧\n')
  git(dir('v-unmerged'), 'add', 'f0.md')
  git(dir('v-unmerged'), 'commit', '-m', 'local-side')
  await advanceTouching(works['v-unmerged']!.work, works['v-unmerged']!.bare, '# 远端冲突侧\n')
  git(dir('v-unmerged'), 'fetch', '--quiet', works['v-unmerged']!.bare, 'main')
  let conflicted = false
  try {
    git(dir('v-unmerged'), 'merge', 'FETCH_HEAD')
  } catch {
    conflicted = true // 冲突即预期（退出码非 0）
  }
  assert.equal(conflicted, true, 'v-unmerged 布置应产生真冲突（否则测试场景失效）')

  // 远端推进（v-ahead 留在 c0——领先态的定义）
  for (const slug of ['v-dirty', 'v-diverged', 'v-other', 'v-untracked', 'v-staged', 'v-unmerged', 'v-detached']) {
    await advance(works[slug]!.work, works[slug]!.bare, 'remote-advance')
  }
  const cleanTip = await advance(works['v-clean']!.work, works['v-clean']!.bare, 'remote-advance')
  const newTip = rev(works['v-new']!.work, 'HEAD')

  // 证明轮前把 v-new 加入可见列表（活性见证：同轮克隆）
  server.state.vaults = vaultsOf(true)

  const heads: Record<string, string> = {}
  const branches: Record<string, string> = {}
  for (const slug of SKIP_STATES) {
    heads[slug] = rev(dir(slug), 'HEAD')
    branches[slug] = slug === 'v-detached' ? '' : branchOf(dir(slug))
  }
  world = { home, localRoot, serverUrl: server.baseUrl, heads, branches, cleanTip, newTip }
})

after(async () => {
  if (mainServer !== undefined) await mainServer.close()
  if (world === undefined) return
  await rm(world.home, { recursive: true, force: true })
  await rm(world.localRoot, { recursive: true, force: true })
})

function syncEnv(): Record<string, string> {
  return { ...gitEnv(world.home), NOTEGIT_SERVER: world.serverUrl, NOTEGIT_TOKEN: FAKE_TOKEN, NOTEGIT_LOCAL_ROOT: world.localRoot }
}

// ── 核心：四态 + 边角态前后快照逐字节不变（验收场景 S2；D7） ──────────────────

test('四类跳过态与边角态：同一轮真实 sync 前后本地指纹逐字节不变，且同轮克隆/快进照常发生', async () => {
  const dir = (slug: string): string => path.join(world.localRoot, slug)

  // 前指纹（八库全采）
  const before: Record<string, string> = {}
  for (const slug of SKIP_STATES) before[slug] = await captureWorktreeFingerprint(dir(slug))

  const r = await run(['sync'], syncEnv())
  assert.equal(r.status, 0, `跳过不判失败——退出码应为 0；stderr：${r.stderr}`)

  // 活性见证：同一轮里 v-new 克隆、v-clean 快进（证明 sync 在动，跳过库的「不变」是策略）
  assert.equal(rev(dir('v-new'), 'HEAD'), world.newTip, 'v-new 应在本轮被克隆到远端 tip')
  assert.ok((await readdir(dir('v-new'))).includes('f0.md'), '克隆应含工作树文件')
  assert.equal(rev(dir('v-clean'), 'HEAD'), world.cleanTip, 'v-clean 应在本轮快进到远端 tip')
  assert.ok((await readdir(dir('v-clean'))).includes('remote-advance.md'), '快进后新文件应出现在工作树')

  // 后指纹：逐字节相等（失败消息给首差行定位）
  for (const slug of SKIP_STATES) {
    const after = await captureWorktreeFingerprint(dir(slug))
    assert.equal(
      after,
      before[slug],
      `${slug} 同步前后本地指纹必须逐字节不变（D7）；首差：${firstFingerprintMismatch(before[slug], after) ?? '（无）'}`,
    )
  }

  // 显式复核（指纹的子集，便于审查者直读）：HEAD 与检出分支不动
  for (const slug of SKIP_STATES) {
    assert.equal(rev(dir(slug), 'HEAD'), world.heads[slug], `${slug} 的 HEAD 不得移动`)
    if (slug !== 'v-detached') {
      assert.equal(branchOf(dir(slug)), world.branches[slug], `${slug} 的检出分支不得切换`)
    }
  }
  // v-other 仍在 feature；v-detached 仍分离（symbolic-ref 失败即分离）
  assert.equal(branchOf(dir('v-other')), 'feature')
  let detached = true
  try {
    branchOf(dir('v-detached'))
    detached = false
  } catch {
    detached = true
  }
  assert.equal(detached, true, 'v-detached 应保持分离头指针')

  // 汇总：8 跳过 + 2 成功，退出码 0
  assert.match(r.stdout, /共 10 库（成功 2、跳过 8、失败 0）/)
})

test('被跳过库报告：含原因 + 离线副本 commit + 上次同步时间（标记值与 stderr 一致）', async () => {
  const dir = (slug: string): string => path.join(world.localRoot, slug)
  const r = await run(['sync'], syncEnv())
  assert.equal(r.status, 0, `stderr：${r.stderr}`)

  const reasonOf: Record<string, RegExp> = {
    'v-dirty': /未提交修改/,
    'v-ahead': /未推送/,
    'v-diverged': /分叉/,
    'v-other': /feature/,
    'v-untracked': /未提交修改/,
    'v-staged': /未提交修改/,
    'v-unmerged': /未提交修改/,
    'v-detached': /分离头指针/,
  }
  for (const slug of SKIP_STATES) {
    const expectedHead = world.heads[slug]!.slice(0, 7)
    const marker = readLastSync(world.localRoot, dir(slug))
    assert.ok(marker !== null, `${slug} 首轮成功同步应留下时间标记`)
    assert.match(
      r.stderr,
      new RegExp(`${slug}：跳过——.*${reasonOf[slug]!.source}.*；离线副本 ${expectedHead}，上次同步 ${marker!.replace(/[.]/g, '\\.')}`),
      `${slug} 报告须含原因+离线副本 commit+上次同步时间`,
    )
  }

  // 同轮活性库仍成功（部分成功不被吞）
  assert.match(r.stdout, /v-new：(?:已克隆|已是最新)/)
  assert.match(r.stdout, /v-clean：(?:已快进|已是最新)/)
})

test('再同步幂等：第二轮后八库指纹仍逐字节不变（跳过策略稳定，不因重复运行磨损）', async () => {
  const dir = (slug: string): string => path.join(world.localRoot, slug)
  const before: Record<string, string> = {}
  for (const slug of SKIP_STATES) before[slug] = await captureWorktreeFingerprint(dir(slug))
  const r = await run(['sync'], syncEnv())
  assert.equal(r.status, 0, `stderr：${r.stderr}`)
  for (const slug of SKIP_STATES) {
    const after = await captureWorktreeFingerprint(dir(slug))
    assert.equal(after, before[slug], `${slug} 第二轮同步后指纹仍须不变；首差：${firstFingerprintMismatch(before[slug], after) ?? '（无）'}`)
  }
})
