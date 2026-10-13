import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, rm, mkdir, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { startMockServer, type MockServer, type MockVault } from '../test-support/mock-server.ts'
import { captureWorktreeFingerprint } from '../src/sync/worktree-snapshot.ts'
import { readSyncState } from '../src/sync/state.ts'

// S7-T6 黑盒层：断网与过期版本提示（breakdown §2.6 S7-T6 行；架构 §7.1「失败时
// 明确提示离线副本的 commit 和同步时间，不能声称一定使用最新知识」+ §7.3）。
// 真实 CLI 子进程 + mock Smart HTTP（同 sync-state 世界搭法，刻意不抽公共件——
// 并行任务的文件不相交约定）；断网经 mock-server 的 gitFault 注入面（api 面照常，
// 仅 /git/* 传输失败/挂起/返回 HTTP 错误码）。断言面：
//   1) 断网三态：net_unreachable / timeout / http_error 逐库 reason_code + 可读
//      message（可理解报错）+ 全程不出现「已是最新」（不声称最新——文案断言）；
//   2) 原子性（库粒度语义：已成功库保留其结果、后续库标 failed；不存在库内半更新）：
//      多库中途断网 → 已成功库结果/状态保留、断网库工作副本逐字节不动、
//      新库克隆失败不残留半成品目录、失败库不改写状态缓存；
//   3) 离线副本明示：失败 message 携带「离线副本 <commit>（可能过期），上次同步
//      <时间>」；ls 表格与 --json 含每库 HEAD 与上次同步（消费 T4 状态面），
//      无法对照远端的副本标注「可能过期」。
const BIN = new URL('../dist/bin/notegit.js', import.meta.url).pathname
const FAKE_TOKEN = 'ngt_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE'
const FAKE_USERNAME = 'sync-offline-user'

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

function porcelain(cwd: string): string {
  return execFileSync('git', ['status', '--porcelain'], { cwd, env: GIT, encoding: 'utf8' }).trim()
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

interface JsonVault {
  slug: string
  status: string
  reason_code: string
  message?: string
  head?: string | null
  last_sync?: string | null
}

interface JsonDoc {
  vaults: JsonVault[]
  summary: { total: number; success: number; skipped: number; failed: number }
}

function parseJson(r: Run): JsonDoc {
  return JSON.parse(r.stdout) as JsonDoc
}

function bySlug(doc: JsonDoc): Map<string, JsonVault> {
  return new Map(doc.vaults.map((v) => [v.slug, v]))
}

/** 建世界：home/local/works/vaults + mock server（登录完成）。vaults 顺序即 sync 遍历序。 */
async function buildWorld(vaults: MockVault[]): Promise<{
  home: string
  localRoot: string
  server: MockServer
  env: Record<string, string>
  dispose: () => Promise<void>
}> {
  const home = await mkdtemp(path.join(tmpdir(), 'ngt-syncoff-home-'))
  const localRoot = path.join(home, 'local')
  const projectRoot = path.join(home, 'vaults')
  const worksRoot = path.join(home, 'works')
  await mkdir(localRoot, { recursive: true })
  await mkdir(projectRoot, { recursive: true })
  await mkdir(worksRoot, { recursive: true })
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
    server,
    env,
    dispose: async () => {
      await server.close()
      await rm(home, { recursive: true, force: true })
    },
  }
}

// ── 1) 断网三态（全部库断网：不声称最新的文案断言作用于全程输出） ─────────────

test('断网三态：refuse→net_unreachable、hang+超时注入→timeout、http500→http_error；可读报错；无半成品目录；全程不出现「已是最新」', async () => {
  const w = await buildWorld([
    { slug: 'n-refuse', name: 'n-refuse', role: 'reader', default_branch: 'main', main_admin_only: false },
    { slug: 'n-hang', name: 'n-hang', role: 'reader', default_branch: 'main', main_admin_only: false },
    { slug: 'n-http', name: 'n-http', role: 'reader', default_branch: 'main', main_admin_only: false },
  ])
  try {
    const home = w.home
    const works = path.join(home, 'works')
    await seedVault(path.join(home, 'vaults'), works, 'n-refuse')
    await seedVault(path.join(home, 'vaults'), works, 'n-hang')
    await seedVault(path.join(home, 'vaults'), works, 'n-http')
    w.server.state.gitFault = [
      { slug: 'n-refuse', mode: 'refuse' },
      { slug: 'n-hang', mode: 'hang' },
      { slug: 'n-http', mode: 'http', status: 500 },
    ]
    const env = { ...w.env, NOTEGIT_SYNC_TIMEOUT_MS: '2000' }

    const r = await run(['sync', '--json'], env)
    assert.equal(r.status, 1, '有失败库 → 退出码非零')
    const doc = parseJson(r)
    const v = bySlug(doc)

    assert.equal(v.get('n-refuse')!.reason_code, 'net_unreachable', `reason_code=net_unreachable（实际：${v.get('n-refuse')!.reason_code}）`)
    assert.match(v.get('n-refuse')!.message ?? '', /克隆失败：无法连接服务器（/, '无法连接类：message 可读且含类别')

    assert.equal(v.get('n-hang')!.reason_code, 'timeout', `reason_code=timeout（实际：${v.get('n-hang')!.reason_code}）`)
    assert.match(v.get('n-hang')!.message ?? '', /克隆失败：网络操作超时（/, '超时类：message 可读且含类别')

    assert.equal(v.get('n-http')!.reason_code, 'http_error', `reason_code=http_error（实际：${v.get('n-http')!.reason_code}）`)
    assert.match(v.get('n-http')!.message ?? '', /克隆失败：服务器 HTTP 错误 500（/, 'HTTP 错误码类：message 可读且含状态码')

    for (const item of doc.vaults) assert.equal(item.status, 'failed')
    assert.deepEqual(doc.summary, { total: 3, success: 0, skipped: 0, failed: 3 })

    // 原子性（库内）：三个新库克隆失败均不残留半成品目录
    for (const slug of ['n-refuse', 'n-hang', 'n-http']) {
      assert.equal(await exists(path.join(w.localRoot, slug)), false, `${slug} 不得残留半成品克隆目录`)
    }
    // 失败库不写状态缓存（T4：失败不产生缓存事实）
    assert.deepEqual(readSyncState(w.localRoot).vaults, {}, '全失败 → 状态文件无条目')

    // 文本通道 + 不声称最新（文案断言）：离线状态下全程禁「已是最新」措辞
    const rt = await run(['sync'], env)
    assert.equal(rt.status, 1)
    assert.match(rt.stderr, /n-refuse：失败——克隆失败：无法连接服务器（/)
    assert.match(rt.stderr, /n-hang：失败——克隆失败：网络操作超时（/)
    assert.match(rt.stderr, /n-http：失败——克隆失败：服务器 HTTP 错误 500（/)
    assert.match(rt.stdout, /共 3 库（成功 0、跳过 0、失败 3）/)
    for (const text of [rt.stdout, rt.stderr]) {
      assert.ok(!text.includes('已是最新'), `离线输出不得出现「已是最新」：${text}`)
      assert.ok(!text.includes('已克隆') && !text.includes('已快进'), `离线输出不得宣称克隆/快进成功：${text}`)
    }
  } finally {
    await w.dispose()
  }
})

// ── 2) 多库中途断网：库粒度原子性 + 离线副本明示（§7.1） ─────────────────────

test('中途断网（库粒度原子性）：已成功库保留结果，断网库标 failed 且副本逐字节不动；失败 message 明示离线副本 commit/上次同步；新库无半成品；状态缓存不被失败改写', async () => {
  const w = await buildWorld([
    { slug: 'ok-v', name: 'ok-v', role: 'reader', default_branch: 'main', main_admin_only: false },
    { slug: 'old-v', name: 'old-v', role: 'reader', default_branch: 'main', main_admin_only: false },
  ])
  try {
    const home = w.home
    const works = path.join(home, 'works')
    const projectRoot = path.join(home, 'vaults')
    await seedVault(projectRoot, works, 'ok-v')
    const old = await seedVault(projectRoot, works, 'old-v')
    git(w.localRoot, 'clone', '--quiet', old.bare, path.join(w.localRoot, 'old-v'))
    const oldTip = await advance(old.work, old.bare, 'remote-advance')

    // 首轮（健康）：ok-v 克隆、old-v 快进——建立 T4 状态面（last_sync/HEAD）
    const r1 = await run(['sync', '--json'], w.env)
    assert.equal(r1.status, 0, `首轮应零失败，stderr：${r1.stderr}`)
    const v1 = bySlug(parseJson(r1))
    const oldTs = v1.get('old-v')!.last_sync as string
    assert.equal(v1.get('old-v')!.reason_code, 'fast_forwarded')
    assert.equal(rev(path.join(w.localRoot, 'old-v'), 'HEAD'), oldTip)

    // 中途断网：old-v（已有副本，判定面 fetch 失败）与 down-v（新库，克隆失败）传输注入 refuse
    w.server.state.vaults = [
      ...w.server.state.vaults!,
      { slug: 'down-v', name: 'down-v', role: 'reader', default_branch: 'main', main_admin_only: false },
    ]
    await seedVault(projectRoot, works, 'down-v')
    w.server.state.gitFault = [
      { slug: 'old-v', mode: 'refuse' },
      { slug: 'down-v', mode: 'refuse' },
    ]

    const before = await captureWorktreeFingerprint(path.join(w.localRoot, 'old-v'))

    const r2 = await run(['sync', '--json'], w.env)
    assert.equal(r2.status, 1, '有失败库 → 退出码非零')
    const v2 = bySlug(parseJson(r2))

    // 已成功库保留其结果：ok-v 在线核验后报 up_to_date（合法——其 fetch 成功）
    assert.equal(v2.get('ok-v')!.status, 'success')
    assert.equal(v2.get('ok-v')!.reason_code, 'up_to_date')

    // 断网的已有副本库：failed（判定面 fetch 失败）+ 离线副本明示（§7.1）
    const oldItem = v2.get('old-v')!
    assert.equal(oldItem.status, 'failed')
    assert.equal(oldItem.reason_code, 'status_error', '判定面失败码；断网语义经 message 明示')
    assert.match(oldItem.message ?? '', /获取远端失败（网络或权限）/)
    assert.match(oldItem.message ?? '', new RegExp(`离线副本 ${oldTip.slice(0, 7)}（可能过期），上次同步 ${oldTs.replace(/[.]/g, '\\.')}`), '失败须明示离线副本 commit 与上次同步时间')
    // 失败项键集与 T3 契约一致（离线信息随 message 携带，不扩键集）
    assert.deepEqual(Object.keys(oldItem).sort(), ['message', 'path', 'reason_code', 'slug', 'status'])

    // 断网的新库：failed net_unreachable + 无半成品目录
    const downItem = v2.get('down-v')!
    assert.equal(downItem.status, 'failed')
    assert.equal(downItem.reason_code, 'net_unreachable')
    assert.match(downItem.message ?? '', /克隆失败：无法连接服务器（/)
    assert.equal(await exists(path.join(w.localRoot, 'down-v')), false, '克隆失败不得残留半成品目录（无库内半更新）')

    assert.deepEqual(parseJson(r2).summary, { total: 3, success: 1, skipped: 0, failed: 2 })

    // 原子性（已有副本库内）：断网库工作副本逐字节不动、HEAD 不动、工作区干净
    assert.equal(rev(path.join(w.localRoot, 'old-v'), 'HEAD'), oldTip, '断网副本 HEAD 不得移动')
    assert.equal(porcelain(path.join(w.localRoot, 'old-v')), '', '断网副本工作区应保持干净')
    const after = await captureWorktreeFingerprint(path.join(w.localRoot, 'old-v'))
    assert.equal(after, before, '断网副本指纹须逐字节不变')

    // 状态缓存不被失败改写：old-v 条目保留首轮 head/last_sync；down-v 无条目
    const state = readSyncState(w.localRoot)
    assert.equal(state.vaults['old-v']!.head, oldTip)
    assert.equal(state.vaults['old-v']!.last_sync, oldTs)
    assert.equal(state.vaults['down-v'], undefined, '失败库不产生缓存事实')

    // 文本通道：失败行携带离线副本明示
    const r2t = await run(['sync'], w.env)
    assert.equal(r2t.status, 1)
    assert.match(r2t.stderr, new RegExp(`old-v：失败——获取远端失败.*离线副本 ${oldTip.slice(0, 7)}（可能过期），上次同步`))
    assert.match(r2t.stderr, /down-v：失败——克隆失败：无法连接服务器（/)
  } finally {
    await w.dispose()
  }
})

// ── 3) 服务器整体不可达（API 面）：可理解报错 + 离线提示，不产出逐库「最新」面 ──

test('服务器不可达（API 断网）：退出码 1，stderr 提示无法连接 + 本地副本可能过期（指向 ls），stdout 无逐库输出', async () => {
  const w = await buildWorld([{ slug: 'v-x', name: 'v-x', role: 'reader', default_branch: 'main', main_admin_only: false }])
  try {
    const r = await run(['sync'], { ...w.env, NOTEGIT_SERVER: 'http://127.0.0.1:1' })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /无法连接服务器/)
    assert.match(r.stderr, /可能过期/, '断网提示须含「可能过期」语义（§7.1 不声称一定使用最新知识）')
    assert.match(r.stderr, /notegit ls/, '应指向 ls 查看离线副本 HEAD 与上次同步')
    assert.ok(!r.stderr.includes('已是最新') && !r.stdout.includes('已是最新'), '断网输出不得出现「已是最新」')
    assert.equal(r.stdout, '', '命令级失败不产出逐库成功/最新面')
  } finally {
    await w.dispose()
  }
})

// ── 4) ls 呈现：每库 HEAD 与上次同步（消费 T4 状态面）+ 无法对照远端标注「可能过期」 ──

test('ls 离线明示：表格与 --json 含每库 HEAD/上次同步；无法对照远端的副本标注「可能过期」；未知来源为 null/从未', async () => {
  const w = await buildWorld([
    { slug: 'ok-v', name: 'ok-v', role: 'reader', default_branch: 'main', main_admin_only: false },
    { slug: 'old-v', name: 'old-v', role: 'reader', default_branch: 'main', main_admin_only: false },
  ])
  try {
    const home = w.home
    const works = path.join(home, 'works')
    const projectRoot = path.join(home, 'vaults')
    await seedVault(projectRoot, works, 'ok-v')
    const old = await seedVault(projectRoot, works, 'old-v')
    git(w.localRoot, 'clone', '--quiet', old.bare, path.join(w.localRoot, 'old-v'))
    const oldTip = await advance(old.work, old.bare, 'remote-advance')

    // 建立状态面（首轮健康同步）后断网 old-v
    const r1 = await run(['sync', '--json'], w.env)
    assert.equal(r1.status, 0, `首轮应零失败，stderr：${r1.stderr}`)
    const oldTs = (bySlug(parseJson(r1)).get('old-v')!.last_sync) as string
    w.server.state.gitFault = [{ slug: 'old-v', mode: 'refuse' }]

    // --json：local 含 last_sync（消费 T4 状态面），与状态文件同源同值
    const rj = await run(['ls', '--json'], w.env)
    assert.equal(rj.status, 0, `ls 应成功，stderr：${rj.stderr}`)
    const doc = JSON.parse(rj.stdout) as { vaults: Array<{ slug: string; local: Record<string, unknown> }> }
    const localOf = (slug: string): Record<string, unknown> => doc.vaults.find((v) => v.slug === slug)!.local
    for (const slug of ['ok-v', 'old-v']) {
      assert.deepEqual(Object.keys(localOf(slug)).sort(), ['head', 'last_sync', 'path', 'remote_tip', 'status'], 'local 键集固化（+last_sync）')
    }
    const state = readSyncState(w.localRoot)
    assert.equal(localOf('ok-v')['last_sync'], state.vaults['ok-v']!.last_sync, 'ok-v last_sync 与状态文件同源同值')
    assert.equal(localOf('old-v')['last_sync'], oldTs, 'old-v last_sync = 首轮同步时间（状态面）')
    assert.equal(localOf('old-v')['status'], 'unknown', '远端不可达 → unknown（head 保留）')
    assert.equal(localOf('old-v')['remote_tip'], null)
    assert.equal(localOf('old-v')['head'], oldTip)

    // 表格：HEAD/上次同步列 + 「可能过期」标注（无法对照远端）
    const rt = await run(['ls'], w.env)
    assert.equal(rt.status, 0, `ls 表格应成功，stderr：${rt.stderr}`)
    assert.match(rt.stdout, /HEAD/)
    assert.match(rt.stdout, /上次同步/)
    assert.match(rt.stdout, /可能过期/, '离线副本须标注「可能过期」')
    assert.match(rt.stdout, new RegExp(oldTip.slice(0, 7)), '表格含离线副本 HEAD 短 sha')
    assert.match(rt.stdout, new RegExp(oldTs.replace('T', ' ').slice(0, 16).replace(/[.]/g, '\\.')), '表格含上次同步时间')
  } finally {
    await w.dispose()
  }
})
