import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, rm, mkdir, writeFile, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { startMockServer, type MockServer, type MockVault } from '../test-support/mock-server.ts'

// S7-T3 黑盒层：多库逐项结果与输出契约（架构 §7.3「多库逐库报告成功、跳过、失败，
// 不能把部分成功报告成全部成功」；breakdown §2.6 S7-T3 行）。混合状态多库场景
// （部分成功 + 部分跳过 + 部分失败）下断言：--json schema（vaults[]/summary 计数/
// generatedAt）与逐项准确性、文本人读输出（逐库行 + 汇总）、退出码非零当且仅当
// 有失败（跳过不判失败）。六态策略行为自身仍由 sync.test.ts 固化（本文件不重复）。
//
// 注：git 世界搭建助手与 sync.test.ts 同构（刻意不抽公共件——与并行 S7-T2 的
// 文件不相交约定；两文件各自演化，合并后如需再收敛）。
const BIN = new URL('../dist/bin/notegit.js', import.meta.url).pathname
const FAKE_TOKEN = 'ngt_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE'
const FAKE_USERNAME = 'sync-report-user'

interface Run {
  status: number | null
  stdout: string
  stderr: string
}

// 异步 spawn（同 sync.test.ts 约定）：父进程事件循环需持续应答子进程的 fetch/clone。
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

/** 目录是否为 git 仓库（rev-parse --git-dir 成功与否）。 */
function isGitDir(cwd: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd, env: GIT, stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

/** 造 seed 工作库并推 bare（projectRoot/<slug>.git，被 mock server 以 Smart HTTP 服务）。 */
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

interface MixedWorld {
  home: string
  localRoot: string
  serverUrl: string
  server: MockServer
  shas: Record<string, { c1: string; c2?: string; local?: string }>
  env: Record<string, string>
  dispose: () => Promise<void>
}

/**
 * 混合状态世界（六库）：
 *   m-new（无副本→克隆）、m-behind（干净落后→快进）、m-tip（干净已最新）、
 *   m-dirty（脏→跳过）、m-ahead（领先→跳过）、m-broken（非 git 目录→失败）。
 * 期望逐项：success×3 + skipped×2 + failed×1。
 */
async function mixedWorld(): Promise<MixedWorld> {
  const home = await mkdtemp(path.join(tmpdir(), 'ngt-syncrep-home-'))
  const localRoot = await mkdtemp(path.join(tmpdir(), 'ngt-syncrep-local-'))
  const projectRoot = path.join(home, 'vaults')
  const worksRoot = path.join(home, 'works')
  await mkdir(projectRoot, { recursive: true })
  await mkdir(worksRoot, { recursive: true })
  const shas: MixedWorld['shas'] = {}

  const cloneLocal = async (slug: string, bare: string): Promise<void> => {
    git(localRoot, 'clone', '--quiet', bare, path.join(localRoot, slug))
  }

  // m-new：仅远端存在，本地无副本 → success/cloned
  const mNew = await seedVault(projectRoot, worksRoot, 'm-new')
  shas['m-new'] = { c1: mNew.sha }

  // m-behind：本地 c1，远端前进到 c2 → success/fast_forwarded
  const mBehind = await seedVault(projectRoot, worksRoot, 'm-behind')
  await cloneLocal('m-behind', mBehind.bare)
  shas['m-behind'] = { c1: mBehind.sha, c2: await advance(mBehind.work, mBehind.bare, 'remote-advance') }

  // m-tip：本地 c1 == 远端 tip → success/up_to_date
  const mTip = await seedVault(projectRoot, worksRoot, 'm-tip')
  await cloneLocal('m-tip', mTip.bare)
  shas['m-tip'] = { c1: mTip.sha }

  // m-dirty：本地 c1 + 未提交修改，远端前进 → skipped/dirty（字节不动）
  const mDirty = await seedVault(projectRoot, worksRoot, 'm-dirty')
  await cloneLocal('m-dirty', mDirty.bare)
  shas['m-dirty'] = { c1: mDirty.sha, c2: await advance(mDirty.work, mDirty.bare, 'remote-advance') }
  await writeFile(path.join(localRoot, 'm-dirty', 'f0.md'), '# 本地未提交修改（不可被覆盖）\n')

  // m-ahead：本地领先（未推送提交），远端停在 c1 → skipped/ahead
  const mAhead = await seedVault(projectRoot, worksRoot, 'm-ahead')
  await cloneLocal('m-ahead', mAhead.bare)
  shas['m-ahead'] = { c1: mAhead.sha, local: await localCommit(path.join(localRoot, 'm-ahead'), 'local-work') }

  // m-broken：目录存在但不是 git 仓库 → failed/status_error
  await mkdir(path.join(localRoot, 'm-broken'), { recursive: true })
  await writeFile(path.join(localRoot, 'm-broken', 'stray.txt'), 'not a git repo\n')

  const vaults: MockVault[] = ['m-new', 'm-behind', 'm-tip', 'm-dirty', 'm-ahead', 'm-broken'].map((slug) => ({
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

// ── 混合场景（验收场景 S3：部分成功 + 部分跳过 + 部分失败） ────────────────────

test('混合场景 --json：逐项 status/reason_code 准确、summary 计数一致（3+2+1）、退出码 1；stdout 纯 JSON', async () => {
  const w = await mixedWorld()
  try {
    const r = await run(['sync', '--json'], w.env)
    assert.equal(r.status, 1, '有失败库 → 退出码非零（iff 失败方向）')

    // stdout 纯 JSON：前置/后置文本会在此抛出（机器模式不得混入人读行）
    const doc = JSON.parse(r.stdout) as {
      server: string
      local_root: string
      generatedAt: string
      vaults: Array<Record<string, unknown> & { slug: string; status: string; reason_code: string }>
      summary: { total: number; success: number; skipped: number; failed: number }
    }

    // schema 顶层键集与固定取值
    assert.deepEqual(Object.keys(doc).sort(), ['generatedAt', 'local_root', 'server', 'summary', 'vaults'])
    assert.equal(doc.server, w.serverUrl)
    assert.equal(doc.local_root, w.localRoot)
    assert.match(doc.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/, 'generatedAt 应为 ISO 8601（UTC）')
    assert.ok(Number.isFinite(Date.parse(doc.generatedAt)))

    // 逐项准确（按 slug 定位，不耦合列表顺序）
    assert.equal(doc.vaults.length, 6, '六库逐项上报')
    const byslug = new Map(doc.vaults.map((v) => [v.slug, v]))
    const vNew = byslug.get('m-new')!
    assert.deepEqual(Object.keys(vNew).sort(), ['head', 'path', 'reason_code', 'slug', 'status'])
    assert.equal(vNew.status, 'success')
    assert.equal(vNew.reason_code, 'cloned')
    assert.equal(vNew['head'], w.shas['m-new']!.c1)
    assert.equal(vNew.path, path.join(w.localRoot, 'm-new'))

    const vBehind = byslug.get('m-behind')!
    assert.deepEqual(Object.keys(vBehind).sort(), ['from', 'path', 'reason_code', 'slug', 'status', 'to'])
    assert.equal(vBehind.status, 'success')
    assert.equal(vBehind.reason_code, 'fast_forwarded')
    assert.equal(vBehind['from'], w.shas['m-behind']!.c1)
    assert.equal(vBehind['to'], w.shas['m-behind']!.c2)

    const vTip = byslug.get('m-tip')!
    assert.deepEqual(Object.keys(vTip).sort(), ['head', 'path', 'reason_code', 'slug', 'status'])
    assert.equal(vTip.status, 'success')
    assert.equal(vTip.reason_code, 'up_to_date')
    assert.equal(vTip['head'], w.shas['m-tip']!.c1)

    const vDirty = byslug.get('m-dirty')!
    assert.deepEqual(Object.keys(vDirty).sort(), ['head', 'last_sync', 'path', 'reason', 'reason_code', 'slug', 'status'])
    assert.equal(vDirty.status, 'skipped')
    assert.equal(vDirty.reason_code, 'dirty')
    assert.match(String(vDirty['reason']), /未提交修改/)

    const vAhead = byslug.get('m-ahead')!
    assert.deepEqual(Object.keys(vAhead).sort(), ['head', 'last_sync', 'path', 'reason', 'reason_code', 'slug', 'status'])
    assert.equal(vAhead.status, 'skipped')
    assert.equal(vAhead.reason_code, 'ahead')
    assert.match(String(vAhead['reason']), /领先|未推送/)

    const vBroken = byslug.get('m-broken')!
    assert.deepEqual(Object.keys(vBroken).sort(), ['message', 'path', 'reason_code', 'slug', 'status'])
    assert.equal(vBroken.status, 'failed')
    assert.equal(vBroken.reason_code, 'status_error')
    assert.match(String(vBroken['message']), /不是 git 仓库/)

    // 取值域：status 三值枚举
    for (const v of doc.vaults) assert.ok(['success', 'skipped', 'failed'].includes(v.status), `未知 status：${v.status}`)

    // 汇总计数一致（== 逐项复数，不把跳过算失败、不把部分成功报成全部成功）
    assert.deepEqual(doc.summary, { total: 6, success: 3, skipped: 2, failed: 1 })
    assert.equal(doc.summary.total, doc.vaults.length)
    for (const s of ['success', 'skipped', 'failed'] as const) {
      assert.equal(doc.summary[s], doc.vaults.filter((v) => v.status === s).length, `summary.${s} 应与逐项复数一致`)
    }

    // 机器模式纯净性：stdout 无 T1 文本行；token 不出现在任何输出面
    assert.ok(!/：已克隆|：已快进|：已是最新|：跳过|：失败|同步完成/.test(r.stdout), 'stdout 不得混入人读文本行')
    assert.ok(!r.stdout.includes(FAKE_TOKEN) && !r.stderr.includes(FAKE_TOKEN), '凭据不得进入输出')

    // 逐项准确同时对照磁盘事实（报告与真实副本一致）
    assert.equal(rev(path.join(w.localRoot, 'm-new'), 'HEAD'), w.shas['m-new']!.c1, 'm-new 应克隆到 tip')
    assert.equal(rev(path.join(w.localRoot, 'm-behind'), 'HEAD'), w.shas['m-behind']!.c2, 'm-behind 应快进到 c2')
    assert.equal(rev(path.join(w.localRoot, 'm-tip'), 'HEAD'), w.shas['m-tip']!.c1, 'm-tip 应原地不动')
    assert.equal(await readFile(path.join(w.localRoot, 'm-dirty', 'f0.md'), 'utf8'), '# 本地未提交修改（不可被覆盖）\n', 'm-dirty 未提交字节保留')
    assert.equal(rev(path.join(w.localRoot, 'm-ahead'), 'HEAD'), w.shas['m-ahead']!.local, 'm-ahead 领先提交保留')
    assert.equal(isGitDir(path.join(w.localRoot, 'm-broken')), false, 'm-broken 保持非 git 目录')
  } finally {
    await w.dispose()
  }
})

test('混合场景 文本输出：逐库行（成功 stdout / 跳过、失败 stderr）+ 汇总行如实计数；不把部分成功报成全部成功', async () => {
  const w = await mixedWorld()
  try {
    const r = await run(['sync'], w.env)
    assert.equal(r.status, 1, '有失败库 → 退出码非零')
    assert.match(r.stdout, /m-new：已克隆（HEAD [0-9a-f]{7}）→ .*m-new/)
    assert.match(r.stdout, /m-behind：已快进 [0-9a-f]{7} → [0-9a-f]{7}/)
    assert.match(r.stdout, /m-tip：已是最新（[0-9a-f]{7}）/)
    assert.match(r.stdout, /同步完成：共 6 库（成功 3、跳过 2、失败 1）/, '汇总行计数与逐项一致')
    assert.match(r.stderr, /m-dirty：跳过——.*未提交修改/)
    assert.match(r.stderr, /m-ahead：跳过——.*(领先|未推送)/)
    assert.match(r.stderr, /m-broken：失败——.*不是 git 仓库/)
    for (const face of [r.stdout, r.stderr]) {
      assert.ok(!face.includes('全部成功') && !face.includes('全部同步成功'), '不得把部分成功报成全部成功（文案断言）')
    }
  } finally {
    await w.dispose()
  }
})

// ── 退出码 iff 语义的另一方向：无失败（成功 + 跳过）→ 0 ────────────────────────

test('无失败场景：成功 + 跳过（跳过不判失败）→ 文本与 --json 退出码均为 0', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'ngt-syncrep-ok-'))
  const localRoot = path.join(home, 'local')
  const worksRoot = path.join(home, 'works')
  const projectRoot = path.join(home, 'vaults')
  await mkdir(worksRoot, { recursive: true })
  await mkdir(projectRoot, { recursive: true })
  await seedVault(projectRoot, worksRoot, 'v-ok')
  const dirty = await seedVault(projectRoot, worksRoot, 'v-dirty')
  await mkdir(localRoot, { recursive: true })
  git(localRoot, 'clone', '--quiet', dirty.bare, path.join(localRoot, 'v-dirty'))
  await writeFile(path.join(localRoot, 'v-dirty', 'f0.md'), '# 未提交修改\n')
  const vaults: MockVault[] = ['v-ok', 'v-dirty'].map((slug) => ({ slug, name: slug, role: 'reader', default_branch: 'main', main_admin_only: false }))
  const server = await startMockServer(projectRoot, { username: FAKE_USERNAME, token: FAKE_TOKEN, apiOutcome: 'ok', gitBasicAccepted: true, vaults })
  const env = { ...gitEnv(home), NOTEGIT_SERVER: server.baseUrl, NOTEGIT_TOKEN: FAKE_TOKEN, NOTEGIT_LOCAL_ROOT: localRoot }
  const login = await run(['login', server.baseUrl, '--username', FAKE_USERNAME], { ...gitEnv(home), NOTEGIT_TOKEN: FAKE_TOKEN })
  try {
    assert.equal(login.status, 0, `login 应成功，stderr：${login.stderr}`)

    const text = await run(['sync'], env)
    assert.equal(text.status, 0, '跳过不算失败：无失败库 → 退出码 0（iff 语义断言）')
    assert.match(text.stdout, /v-ok：已克隆/)
    assert.match(text.stderr, /v-dirty：跳过/)
    assert.match(text.stdout, /成功 1、跳过 1、失败 0/)

    const json = await run(['sync', '--json'], env)
    assert.equal(json.status, 0, '--json 同一契约：无失败 → 0')
    const doc = JSON.parse(json.stdout) as { summary: { total: number; success: number; skipped: number; failed: number } }
    assert.deepEqual(doc.summary, { total: 2, success: 1, skipped: 1, failed: 0 })
  } finally {
    await server.close()
    await rm(home, { recursive: true, force: true })
  }
})

// ── 边界：空库列表与 --json 不绕过命令级错误 ─────────────────────────────────

test('空库列表：--json vaults 为空数组、汇总全零、退出码 0', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'ngt-syncrep-empty-'))
  const server = await startMockServer(path.join(home, 'vaults'), {
    username: FAKE_USERNAME,
    token: FAKE_TOKEN,
    apiOutcome: 'ok',
    gitBasicAccepted: true,
    vaults: [],
  })
  try {
    const env = { ...gitEnv(home), NOTEGIT_SERVER: server.baseUrl, NOTEGIT_TOKEN: FAKE_TOKEN, NOTEGIT_LOCAL_ROOT: path.join(home, 'local') }
    const r = await run(['sync', '--json'], env)
    assert.equal(r.status, 0)
    const doc = JSON.parse(r.stdout) as { vaults: unknown[]; summary: { total: number; success: number; skipped: number; failed: number } }
    assert.deepEqual(doc.vaults, [])
    assert.deepEqual(doc.summary, { total: 0, success: 0, skipped: 0, failed: 0 })
  } finally {
    await server.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('--json 不绕过命令级错误：用法错误退出 2；未配置凭据退出 1 且 stdout 无 JSON', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'ngt-syncrep-usage-'))
  try {
    const usage = await run(['sync', '--json', '--depth', '0'], gitEnv(home))
    assert.equal(usage.status, 2, '用法错误与 --json 无关，仍退出 2')
    assert.ok(usage.stderr.length > 0)

    const nocred = await run(['sync', '--json'], gitEnv(home))
    assert.equal(nocred.status, 1, '未配置凭据 → 业务性失败退出 1')
    assert.equal(nocred.stdout, '', '命令级失败不产生 JSON 信封（stderr 文本，同 ls 契约）')
    assert.match(nocred.stderr, /未配置/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
