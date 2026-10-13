import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, rm, mkdir, writeFile, readdir, readFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { startMockServer, type MockServer, type MockVault } from '../test-support/mock-server.ts'
import { captureWorktreeFingerprint, firstFingerprintMismatch } from '../src/sync/worktree-snapshot.ts'
import { stateFilePath, readSyncState, type SyncStateDoc } from '../src/sync/state.ts'

// S7-T4 黑盒层：状态文件（仅缓存——架构 §7.3「状态 JSON 只是缓存，丢失后可重建」）
// 与并发锁（「每库 Git 操作和全局状态写入分别加锁」；breakdown S7-T4 行）。
// 真实 CLI 子进程 + mock Smart HTTP（同 sync-report/sync-noclobber 世界搭法，刻意
// 不抽公共件——并行任务的文件不相交约定）。断言面：
//   1) 状态落盘与 T3 报告同源同值（success last_sync == 状态条目 == .git 标记）；
//   2) 删除状态（整个 .notegit）→ sync 完全重建，工作副本指纹逐字节无损，
//      重建后跳过判断与重建前一致（同世界两跑对比），last_sync 以标记为重建来源；
//   3) 两个真实并发 sync 进程不交叉修改：同一库动作对 = {cloned, up_to_date}
//      （互斥串行化证据）、零失败、终态与状态文件一致、锁文件全部释放。
const BIN = new URL('../dist/bin/notegit.js', import.meta.url).pathname
const FAKE_TOKEN = 'ngt_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE'
const FAKE_USERNAME = 'sync-state-user'

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

/** 两进程同时起跑（真实并发；不 await 第一个再跑第二个）。 */
function runConcurrent(args: string[], env: Record<string, string>): Promise<[Run, Run]> {
  return Promise.all([run(args, env), run(args, env)]) as Promise<[Run, Run]>
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

async function seedVault(projectRoot: string, worksRoot: string, slug: string): Promise<{ sha: string; work: string; bare: string }> {
  const work = path.join(worksRoot, slug)
  await mkdir(work, { recursive: true })
  git(work, 'init', '-b', 'main')
  git(work, 'config', 'user.name', 'seed')
  git(work, 'config', 'user.email', 'seed@notegit.invalid')
  await writeFile(path.join(work, 'f0.md'), `# ${slug} note\n`)
  git(work, 'add', '.')
  git(work, 'commit', '-m', 'c0')
  const sha = rev(work, 'HEAD')
  const bare = path.join(projectRoot, `${slug}.git`)
  git(worksRoot, 'clone', '--quiet', '--bare', work, bare)
  return { sha, work, bare }
}

async function advance(work: string, bare: string, name: string): Promise<string> {
  await writeFile(path.join(work, `${name}.md`), `# ${name}\n`)
  git(work, 'add', '.')
  git(work, 'commit', '-m', name)
  const sha = rev(work, 'HEAD')
  git(work, 'push', '-q', bare, 'main')
  return sha
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

/** 读 .git/notegit-last-sync 标记原文（不动 readLastSync——独立核对第二真相）。 */
async function readMarker(dir: string): Promise<string | null> {
  try {
    return (await readFile(path.join(dir, '.git', 'notegit-last-sync'), 'utf8')).trim()
  } catch {
    return null
  }
}

interface JsonVault {
  slug: string
  status: string
  reason_code: string
  last_sync?: string | null
  head?: string
}

interface JsonDoc {
  generatedAt: string
  vaults: JsonVault[]
  summary: { total: number; success: number; skipped: number; failed: number }
}

function parseJson(run: Run): JsonDoc {
  return JSON.parse(run.stdout) as JsonDoc
}

function bySlug(doc: JsonDoc): Map<string, JsonVault> {
  return new Map(doc.vaults.map((v) => [v.slug, v]))
}

/**
 * 状态测试世界（五库）：
 *   st-new：仅远端（首跑克隆）；
 *   st-behind：本地落后（首跑快进）；
 *   st-tip：已最新；
 *   st-dirty：本地改 + 远端前进（跳过；从未经 notegit 同步 → last_sync null）；
 *   st-was-synced：首跑时干净落后（被 notegit 成功同步——写标记+状态），
 *     随后测试将其改脏 → 次跑跳过，last_sync 应以标记为重建来源回传。
 */
async function buildWorld(): Promise<{
  home: string
  localRoot: string
  serverUrl: string
  server: MockServer
  shas: Record<string, string>
  env: Record<string, string>
  dispose: () => Promise<void>
}> {
  const home = await mkdtemp(path.join(tmpdir(), 'ngt-syncstate-home-'))
  // home 本身做成 git 仓库：localRoot 处于仓库内——.notegit 等非副本目录的
  // revParse 会向上寻到 home 的 .git 而「假性」解析出 HEAD；孤儿提示必须按
  // 点前缀跳过工具内部目录（index.ts hintOrphanDirs 守卫的失效场景）。
  const localRoot = path.join(home, 'local')
  await mkdir(localRoot, { recursive: true })
  git(home, 'init', '--quiet', '-b', 'main')
  git(home, 'config', 'user.name', 'world')
  git(home, 'config', 'user.email', 'world@notegit.invalid')
  await writeFile(path.join(home, 'README.md'), '# enclosing repo（须有提交——HEAD 可解析才会向上假性命中）\n')
  git(home, 'add', 'README.md')
  git(home, 'commit', '--quiet', '-m', 'enclosing')
  const projectRoot = path.join(home, 'vaults')
  const worksRoot = path.join(home, 'works')
  await mkdir(projectRoot, { recursive: true })
  await mkdir(worksRoot, { recursive: true })
  const shas: Record<string, string> = {}

  const newV = await seedVault(projectRoot, worksRoot, 'st-new')
  shas['st-new'] = newV.sha

  const behind = await seedVault(projectRoot, worksRoot, 'st-behind')
  git(localRoot, 'clone', '--quiet', behind.bare, path.join(localRoot, 'st-behind'))
  shas['st-behind'] = await advance(behind.work, behind.bare, 'remote-advance')

  const tip = await seedVault(projectRoot, worksRoot, 'st-tip')
  git(localRoot, 'clone', '--quiet', tip.bare, path.join(localRoot, 'st-tip'))
  shas['st-tip'] = tip.sha

  const dirty = await seedVault(projectRoot, worksRoot, 'st-dirty')
  git(localRoot, 'clone', '--quiet', dirty.bare, path.join(localRoot, 'st-dirty'))
  await advance(dirty.work, dirty.bare, 'remote-advance')
  await writeFile(path.join(localRoot, 'st-dirty', 'f0.md'), '# 本地未提交修改\n')

  const wasSynced = await seedVault(projectRoot, worksRoot, 'st-was-synced')
  git(localRoot, 'clone', '--quiet', wasSynced.bare, path.join(localRoot, 'st-was-synced'))
  shas['st-was-synced'] = await advance(wasSynced.work, wasSynced.bare, 'remote-advance')

  const vaults: MockVault[] = ['st-new', 'st-behind', 'st-tip', 'st-dirty', 'st-was-synced'].map((slug) => ({
    slug,
    name: slug,
    role: 'reader',
    default_branch: 'main',
    main_admin_only: false,
  }))
  const server = await startMockServer(projectRoot, { username: FAKE_USERNAME, token: FAKE_TOKEN, apiOutcome: 'ok', gitBasicAccepted: true, vaults })
  const env = {
    ...gitEnv(home),
    NOTEGIT_SERVER: server.baseUrl,
    NOTEGIT_TOKEN: FAKE_TOKEN,
    NOTEGIT_LOCAL_ROOT: localRoot,
  }
  const login = await run(['login', server.baseUrl, '--username', FAKE_USERNAME], { ...gitEnv(home), NOTEGIT_TOKEN: FAKE_TOKEN })
  assert.equal(login.status, 0, `login 应成功，stderr：${login.stderr}`)
  return {
    home,
    localRoot,
    serverUrl: server.baseUrl,
    server,
    shas,
    env,
    dispose: async () => {
      await server.close()
      await rm(home, { recursive: true, force: true })
      await rm(localRoot, { recursive: true, force: true })
    },
  }
}

const ALL_SLUGS = ['st-new', 'st-behind', 'st-tip', 'st-dirty', 'st-was-synced']

// ── 1) 状态落盘：与 T3 报告同源同值；标记=第二真相同事务写 ────────────────────

test('状态落盘：sync 写出状态文件，success last_sync 与报告/标记同源同值，跳过库不刷新时间', async () => {
  const w = await buildWorld()
  try {
    const r = await run(['sync', '--json'], w.env)
    assert.equal(r.status, 0, `应零失败，stderr：${r.stderr}`)
    // 工具内部目录（.notegit，已随本轮 sync 建立）不得触发孤儿提示——即使
    // localRoot 位于 git 仓库内（revParse 会向上假性解析；点前缀守卫的场景）
    assert.ok(!r.stderr.includes('不对应当前任何可见库'), `.notegit 不应被当作孤儿副本提示：${r.stderr}`)
    const doc = parseJson(r)
    const vaults = bySlug(doc)

    // 状态文件存在且逐库条目准确
    assert.ok(await exists(stateFilePath(w.localRoot)), 'sync 后应写出 <root>/.notegit/sync-state.json')
    const state: SyncStateDoc = readSyncState(w.localRoot)
    assert.equal(state.version, 1)
    assert.deepEqual(
      Object.keys(state.vaults).sort(),
      [...ALL_SLUGS].sort(),
      '五库逐库建条目',
    )

    for (const slug of ['st-new', 'st-behind', 'st-tip', 'st-was-synced']) {
      const entry = state.vaults[slug]!
      const reported = vaults.get(slug)!
      assert.equal(reported.status, 'success')
      // 同源同值核心断言：报告 last_sync == 状态条目 last_sync == .git 标记
      assert.ok(typeof reported.last_sync === 'string', `${slug} 报告项应带 last_sync`)
      assert.equal(entry.last_sync, reported.last_sync, `${slug} 状态条目与报告同源同值`)
      const marker = await readMarker(path.join(w.localRoot, slug))
      assert.equal(marker, reported.last_sync, `${slug} .git 标记同一事务同值`)
      assert.equal(entry.revoked, false, `${slug} 撤权位缺省 false`)
      assert.equal(entry.head, rev(path.join(w.localRoot, slug), 'HEAD'), `${slug} 状态 head == 实际 HEAD`)
      assert.match(String(entry.last_sync), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, 'ISO 形态')
    }

    // 跳过库：条目在、head=本地、last_sync=null（从未经 notegit 同步）、不写标记
    const dirtyEntry = state.vaults['st-dirty']!
    assert.equal(dirtyEntry.head, rev(path.join(w.localRoot, 'st-dirty'), 'HEAD'))
    assert.equal(dirtyEntry.last_sync, null, '从未经 notegit 同步 → last_sync null')
    assert.equal(await readMarker(path.join(w.localRoot, 'st-dirty')), null, '跳过库不写时间标记')
    const dirtyReport = vaults.get('st-dirty')!
    assert.equal(dirtyReport.status, 'skipped')
    assert.equal(dirtyReport.last_sync, null, '跳过项报告 last_sync null（同源）')
  } finally {
    await w.dispose()
  }
})

// ── 2) 删除重建：整个 .notegit 删除 → 完全重建、副本无损、跳过判断一致 ─────────

test('删除重建：删整个 .notegit 后 sync 完全重建状态；副本指纹逐字节无损；跳过判断与重建前一致；last_sync 以标记为重建来源', async () => {
  const w = await buildWorld()
  try {
    // 第一跑：全库落定状态 + st-was-synced 被成功同步
    const r1 = await run(['sync', '--json'], w.env)
    assert.equal(r1.status, 0, `首跑应零失败，stderr：${r1.stderr}`)
    const doc1 = parseJson(r1)
    const v1 = bySlug(doc1)
    const wasSyncedTs = v1.get('st-was-synced')!.last_sync as string

    // 首跑跳过判断（重建前基准）
    const skipBefore: Record<string, string> = {}
    for (const [slug, vault] of v1) {
      if (vault.status === 'skipped') skipBefore[slug] = vault.reason_code
    }
    assert.equal(skipBefore['st-dirty'], 'dirty')

    // st-was-synced 变脏（它已有标记+状态——重建时标记应为 last_sync 来源）
    await writeFile(path.join(w.localRoot, 'st-was-synced', 'f0.md'), '# 同步后又改脏\n')

    // 全部本地副本指纹（重建前）
    const before: Record<string, string> = {}
    for (const slug of ALL_SLUGS) before[slug] = await captureWorktreeFingerprint(path.join(w.localRoot, slug))

    // 删除整个 .notegit（状态+锁一起——完全冷缓存）
    await rm(path.join(w.localRoot, '.notegit'), { recursive: true, force: true })

    // 第二跑：重建
    const r2 = await run(['sync', '--json'], w.env)
    assert.equal(r2.status, 0, `重建跑应零失败，stderr：${r2.stderr}`)
    const doc2 = parseJson(r2)
    const v2 = bySlug(doc2)

    // 重建后跳过判断与重建前一致（同世界两跑对比）
    const skipAfter: Record<string, string> = {}
    for (const [slug, vault] of v2) {
      if (vault.status === 'skipped') skipAfter[slug] = vault.reason_code
    }
    assert.deepEqual(skipAfter, { ...skipBefore, 'st-was-synced': 'dirty' }, '跳过判断应一致（st-dirty 同前；st-was-synced 本轮新跳过——世界已改）')
    assert.equal(v2.get('st-new')!.reason_code, 'up_to_date', '已克隆库重建后判已最新（不重复克隆）')
    assert.equal(v2.get('st-behind')!.reason_code, 'up_to_date', '已快进库重建后判已最新')

    // 工作副本无损：五库指纹逐字节不变
    for (const slug of ALL_SLUGS) {
      const after = await captureWorktreeFingerprint(path.join(w.localRoot, slug))
      assert.equal(after, before[slug], `${slug} 重建同步后指纹须逐字节不变；首差：${firstFingerprintMismatch(before[slug], after) ?? '（无）'}`)
    }

    // 状态完全重建：五库条目齐全；st-was-synced 的 last_sync 以标记为来源 == 首跑时间
    const state2 = readSyncState(w.localRoot)
    assert.deepEqual(Object.keys(state2.vaults).sort(), [...ALL_SLUGS].sort(), '重建后五库条目齐全')
    const rebuilt = state2.vaults['st-was-synced']!
    assert.equal(rebuilt.last_sync, wasSyncedTs, '重建条目 last_sync 以 .git 标记为来源（回到首跑值）')
    assert.equal(rebuilt.head, rev(path.join(w.localRoot, 'st-was-synced'), 'HEAD'), '重建条目 head = 当前本地 HEAD')
    assert.equal(state2.vaults['st-dirty']!.last_sync, null, '从未同步库重建后仍 null')

    // 报告同源：文本通道也携带重建来源时间（标记回退可观察）
    const r3 = await run(['sync'], w.env)
    assert.match(r3.stderr, new RegExp(`st-was-synced：跳过——.*；离线副本 [0-9a-f]{7}，上次同步 ${wasSyncedTs.replace(/[.]/g, '\\.')}`), '文本跳过行携带标记回退的 last_sync')
  } finally {
    await w.dispose()
  }
})

// ── 3) 并发：两个真实 sync 进程同时跑同一根目录，不交叉修改 ─────────────────────

test('双进程并发：同一库动作对 = {克隆,已最新}/{快进,已最新}（互斥串行化），零失败，终态一致，锁文件全释放', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'ngt-syncstate-conc-home-'))
  const localRoot = await mkdtemp(path.join(tmpdir(), 'ngt-syncstate-conc-local-'))
  const projectRoot = path.join(home, 'vaults')
  const worksRoot = path.join(home, 'works')
  await mkdir(projectRoot, { recursive: true })
  await mkdir(worksRoot, { recursive: true })
  let server: MockServer | undefined // try 内赋值、finally 关闭（块作用域）
  try {
    // 两活性库（并发克隆/快进的见证）+ 一跳过库
    const newV = await seedVault(projectRoot, worksRoot, 'c-clone')
    const behind = await seedVault(projectRoot, worksRoot, 'c-ff')
    git(localRoot, 'clone', '--quiet', behind.bare, path.join(localRoot, 'c-ff'))
    const ffTip = await advance(behind.work, behind.bare, 'remote-advance')
    const dirty = await seedVault(projectRoot, worksRoot, 'c-skip')
    git(localRoot, 'clone', '--quiet', dirty.bare, path.join(localRoot, 'c-skip'))
    await advance(dirty.work, dirty.bare, 'remote-advance')
    await writeFile(path.join(localRoot, 'c-skip', 'f0.md'), '# 本地未提交修改\n')

    const vaults: MockVault[] = ['c-clone', 'c-ff', 'c-skip'].map((slug) => ({
      slug,
      name: slug,
      role: 'reader',
      default_branch: 'main',
      main_admin_only: false,
    }))
    server = await startMockServer(projectRoot, { username: FAKE_USERNAME, token: FAKE_TOKEN, apiOutcome: 'ok', gitBasicAccepted: true, vaults })
    const env = { ...gitEnv(home), NOTEGIT_SERVER: server.baseUrl, NOTEGIT_TOKEN: FAKE_TOKEN, NOTEGIT_LOCAL_ROOT: localRoot }
    const login = await run(['login', server.baseUrl, '--username', FAKE_USERNAME], { ...gitEnv(home), NOTEGIT_TOKEN: FAKE_TOKEN })
    assert.equal(login.status, 0, `login 应成功，stderr：${login.stderr}`)

    // 两进程真实同时起跑
    const [a, b] = await runConcurrent(['sync', '--json'], env)
    for (const [name, r] of [['A', a], ['B', b]] as const) {
      assert.equal(r.status, 0, `进程 ${name} 应零失败退出；stdout：${r.stdout.slice(0, 500)}；stderr：${r.stderr.slice(0, 500)}`)
    }
    const docA = parseJson(a)
    const docB = parseJson(b)
    for (const [name, doc] of [['A', docA], ['B', docB]] as const) {
      assert.equal(doc.summary.failed, 0, `进程 ${name} 逐项零失败`)
      assert.equal(doc.summary.total, 3, `进程 ${name} 三库逐项上报`)
    }

    // 互斥串行化证据：同一库在两报告中的动作对恰为「一变一不变」
    const actionOf = (doc: JsonDoc, slug: string): string => bySlug(doc).get(slug)!.reason_code
    const pair = (slug: string): string => [actionOf(docA, slug), actionOf(docB, slug)].sort().join('+')
    assert.equal(pair('c-clone'), 'cloned+up_to_date', 'c-clone 两进程动作对 = 克隆+已最新（第二个进程看到第一个的成果——未重复克隆）')
    assert.equal(pair('c-ff'), 'fast_forwarded+up_to_date', 'c-ff 两进程动作对 = 快进+已最新（未重复快进/交叉修改）')
    assert.equal(pair('c-skip'), 'dirty+dirty', '跳过库两进程一致判 dirty（跳过判断不受并发影响）')

    // 终态与状态文件一致
    assert.equal(rev(path.join(localRoot, 'c-clone'), 'HEAD'), newV.sha, 'c-clone 最终 HEAD = 远端 tip')
    assert.equal(rev(path.join(localRoot, 'c-ff'), 'HEAD'), ffTip, 'c-ff 最终 HEAD = 远端 tip')
    const state = readSyncState(localRoot)
    assert.deepEqual(Object.keys(state.vaults).sort(), ['c-clone', 'c-ff', 'c-skip'], '状态文件三库齐全（跨进程写不丢）')
    assert.equal(state.vaults['c-clone']!.head, newV.sha)
    assert.equal(state.vaults['c-ff']!.head, ffTip)

    // 副本干净（并发未留下半成品状态）
    for (const slug of ['c-clone', 'c-ff']) {
      const out = execFileSync('git', ['status', '--porcelain'], { cwd: path.join(localRoot, slug), env: GIT, encoding: 'utf8' })
      assert.equal(out.trim(), '', `${slug} 并发后工作区应干净`)
    }

    // 锁卫生：两个进程结束后锁文件全部释放
    const locksDir = path.join(localRoot, '.notegit', 'locks')
    const leftover = await readdir(locksDir).catch(() => [] as string[])
    assert.deepEqual(leftover, [], `锁文件应全部释放（残留：${leftover.join(',')}）`)
    assert.equal(await exists(path.join(localRoot, '.notegit', 'sync-state.json.lock')), false, '状态锁也应释放')
  } finally {
    await server?.close()
    await rm(home, { recursive: true, force: true })
    await rm(localRoot, { recursive: true, force: true })
  }
})
