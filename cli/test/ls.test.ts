import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import http from 'node:http'

// S6-T3 黑盒层：测试目标 = dist 产物（与 cli.test.ts 同约定）。
// 覆盖：--json schema 固化、两员工集合与 Web 库列表一致（对照 server/test/
// vaults-matrix.test.ts world() 数据面：alice=admin(alpha)；bob=reader(alpha)+
// admin(beta)）、退出码 0/1/2 契约、本地状态端到端（真实 git + insteadOf 把
// <server>/git/ 前缀重定向到本地 bare 仓库——fetch/merge-base 全真实）。
const BIN = new URL('../dist/bin/notegit.js', import.meta.url).pathname

interface VaultDef {
  readonly slug: string
  readonly name: string
  readonly default_branch: string
  readonly main_admin_only: boolean
}

// 数据面对照 server vaults-matrix world()：两员工、两不同成员集库；carol=无库员工
const VAULTS: readonly VaultDef[] = [
  { slug: 'alpha', name: 'Alpha', default_branch: 'main', main_admin_only: false },
  { slug: 'beta', name: 'Beta', default_branch: 'main', main_admin_only: false },
]
const BY_SLUG = new Map(VAULTS.map((v) => [v.slug, v]))
const MEMBERSHIPS: Record<string, Record<string, string>> = {
  alice: { alpha: 'admin' },
  bob: { alpha: 'reader', beta: 'admin' },
  carol: {},
}
const TOKENS: Record<string, string> = {
  alice: `ngt_${'a'.repeat(43)}`,
  bob: `ngt_${'b'.repeat(43)}`,
  carol: `ngt_${'c'.repeat(43)}`,
}
const SIDS: Record<string, string> = { alice: 'sid-alice', bob: 'sid-bob', carol: 'sid-carol' }

let apiServer: http.Server
let serverUrl = ''
let apiMode: 'ok' | 'internal' = 'ok'

/** 认证载体解析：Bearer token（CLI/API 面）或 ngt_sid Cookie（Web 面）→ 员工名。 */
function identify(headers: http.IncomingHttpHeaders): string | undefined {
  const auth = headers['authorization']
  if (typeof auth === 'string') {
    const m = /^Bearer\s+(.+)$/.exec(auth)
    if (m !== null) {
      const who = Object.keys(TOKENS).find((k) => TOKENS[k] === m[1])
      if (who !== undefined) return who
    }
  }
  const cookie = headers['cookie']
  if (typeof cookie === 'string') {
    const m = /(?:^|;\s*)ngt_sid=([^;]+)/.exec(cookie)
    if (m !== null) {
      const who = Object.keys(SIDS).find((k) => SIDS[k] === m[1])
      if (who !== undefined) return who
    }
  }
  return undefined
}

function vaultsOf(who: string): Array<VaultDef & { role: string }> {
  const member = MEMBERSHIPS[who]!
  return VAULTS.filter((v) => member[v.slug] !== undefined)
    .map((v) => ({ ...v, role: member[v.slug]! }))
}

before(async () => {
  apiServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://notegit.invalid')
    if (url.pathname === '/api/v1/vaults' && req.method === 'GET') {
      if (apiMode === 'internal') {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { code: 'E-RUN-001', message: '内部错误' } }))
        return
      }
      const who = identify(req.headers)
      if (who === undefined) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { code: 'E-AUTH-001', message: '未认证' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ vaults: vaultsOf(who) }))
      return
    }
    // /git/* 在本测试不可达（insteadOf 重定向到本地 bare 仓库）；防御性 404
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { code: 'E-RES-001', message: '资源不存在或无权访问' } }))
  })
  await new Promise<void>((resolve) => apiServer.listen(0, '127.0.0.1', resolve))
  serverUrl = `http://127.0.0.1:${(apiServer.address() as { port: number }).port}`
})

after(async () => {
  await new Promise<void>((resolve) => apiServer.close(() => resolve()))
})

interface LsRun {
  status: number | null
  stdout: string
  stderr: string
}

// 异步 spawn（非 spawnSync）：本文件在测试进程内起假 API 服务器，spawnSync 会
// 冻结事件循环 → 子进程的 fetch 永远等不到响应（自死锁）。异步 spawn 让父进程
// 持续应答；逐测试 await 收割输出与退出码。
async function runLs(args: string[], opts: { token?: string; server?: string; localRoot?: string; home?: string }): Promise<LsRun> {
  const env: Record<string, string> = {
    PATH: process.env['PATH']!,
    HOME: opts.home ?? path.join(tmpdir(), 'notegit-ls-nohome'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  }
  if (opts.server !== undefined) env['NOTEGIT_SERVER'] = opts.server
  if (opts.token !== undefined) env['NOTEGIT_TOKEN'] = opts.token
  if (opts.localRoot !== undefined) env['NOTEGIT_LOCAL_ROOT'] = opts.localRoot
  const child = spawn(process.execPath, [BIN, 'ls', ...args], { env })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (d: string) => (stdout += d))
  child.stderr.on('data', (d: string) => (stderr += d))
  const [code] = (await once(child, 'close')) as [number | null]
  return { status: code, stdout, stderr }
}

async function runLsJson(who: keyof typeof TOKENS, localRoot?: string, home?: string): Promise<{ r: LsRun; doc: Record<string, unknown> }> {
  const r = await runLs(['--json'], { token: TOKENS[who], server: serverUrl, ...(localRoot !== undefined && { localRoot }), ...(home !== undefined && { home }) })
  let doc: Record<string, unknown> | undefined
  try {
    doc = JSON.parse(r.stdout) as Record<string, unknown>
  } catch {
    // 保持 undefined，断言处给出可读失败
  }
  return { r, doc: doc ?? ({} as Record<string, unknown>) }
}

// Web 库列表数据面：同端点、会话载体（ngt_sid Cookie）——与 CLI 输出对照的一致性基准
async function webVaultList(who: keyof typeof SIDS): Promise<Array<{ slug: string; role: string }>> {
  const res = await fetch(`${serverUrl}/api/v1/vaults`, { headers: { cookie: `ngt_sid=${SIDS[who]}` } })
  assert.equal(res.status, 200, `Web 载体取库列表应 200（${who}）`)
  return ((await res.json()) as { vaults: Array<{ slug: string; role: string }> }).vaults
}

// ── 帮助与用法 ────────────────────────────────────────────────────────────────

test('ls --help：退出码 0，含用法/--json/凭据环境变量说明，不再是占位命令', async () => {
  const r = await runLs(['--help'], { token: TOKENS['alice'], server: serverUrl })
  assert.equal(r.status, 0)
  assert.match(r.stdout, /notegit ls \[--json\]/)
  assert.match(r.stdout, /--json/)
  assert.doesNotMatch(r.stdout, /尚未实现/)
})

test('ls -h 与 ls --help 输出一致', async () => {
  const r1 = await runLs(['-h'], { token: TOKENS['alice'], server: serverUrl })
  const r2 = await runLs(['--help'], { token: TOKENS['alice'], server: serverUrl })
  assert.equal(r1.status, 0)
  assert.equal(r1.stdout, r2.stdout)
})

test('未知旗标：退出码 2（用法错误），stderr 指出选项名', async () => {
  const r = await runLs(['--definitely-not-a-flag'], { token: TOKENS['alice'], server: serverUrl })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /未知选项/)
  assert.match(r.stderr, /--definitely-not-a-flag/)
})

test('多余位置参数：退出码 2（ls 不接受位置参数）', async () => {
  const r = await runLs(['alpha'], { token: TOKENS['alice'], server: serverUrl })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /参数|选项|用法/)
})

// ── JSON schema 固化（结构稳定：deepEqual 锁键集与取值域） ──────────────────

test('--json schema 固化：alice（本地无副本）完整结构 deepEqual 锁定；token 不出现在输出', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'notegit-ls-root-'))
  try {
    const { r, doc } = await runLsJson('alice', root)
    assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    assert.deepEqual(doc, {
      server: serverUrl,
      local_root: path.resolve(root),
      vaults: [
        {
          slug: 'alpha',
          name: 'Alpha',
          role: 'admin',
          default_branch: 'main',
          main_admin_only: false,
          clone_url: `${serverUrl}/git/alpha.git`,
          local: { path: null, status: 'not_cloned', head: null, remote_tip: null, last_sync: null },
        },
      ],
    })
    assert.ok(!r.stdout.includes(TOKENS['alice']) && !r.stderr.includes(TOKENS['alice']), '凭据不得进入 stdout/stderr')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ── 两员工集合与 Web 库列表一致（验收场景 S3；对照 server 授权测试数据面） ──

test('两员工 ls --json 集合与 Web 库列表逐员工一致；无权库不出现', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'notegit-ls-root-'))
  try {
    for (const who of ['alice', 'bob'] as const) {
      const { r, doc } = await runLsJson(who, root)
      assert.equal(r.status, 0, `${who} stderr: ${r.stderr}`)
      const listed = doc['vaults'] as Array<{ slug: string; role: string }>
      const web = await webVaultList(who)
      assert.deepEqual(
        listed.map((v) => [v.slug, v.role]),
        web.map((v) => [v.slug, v.role]),
        `${who}：ls 输出集合/角色应与 Web 库列表一致`,
      )
      for (const v of web) {
        assert.equal(BY_SLUG.get(v.slug) !== undefined, true, `未知库 ${v.slug}`)
      }
    }
    // 数据面锚点（server vaults-matrix world()）：alice=admin(alpha)；bob=reader(alpha)+admin(beta)
    const alice = (await runLsJson('alice', root)).doc['vaults'] as Array<{ slug: string; role: string }>
    const bob = (await runLsJson('bob', root)).doc['vaults'] as Array<{ slug: string; role: string }>
    assert.deepEqual(alice.map((v) => [v.slug, v.role]), [['alpha', 'admin']])
    assert.deepEqual(bob.map((v) => [v.slug, v.role]), [
      ['alpha', 'reader'],
      ['beta', 'admin'],
    ])
    assert.ok(!alice.some((v) => v.slug === 'beta'), '非成员库不得出现在 alice 列表')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('空列表员工（carol）：退出码 0，vaults 为空数组', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'notegit-ls-root-'))
  try {
    const { r, doc } = await runLsJson('carol', root)
    assert.equal(r.status, 0)
    assert.deepEqual(doc['vaults'], [])
    assert.equal(doc['server'], serverUrl)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ── 人类可读输出（无 --json） ────────────────────────────────────────────────

test('无 --json：退出码 0，表格式输出含 slug/状态，stdout 非 JSON 对象', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'notegit-ls-root-'))
  try {
    const r = await runLs([], { token: TOKENS['bob'], server: serverUrl, localRoot: root })
    assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    assert.doesNotMatch(r.stdout.trimStart(), /^\{/, '无 --json 时不应输出 JSON 对象')
    assert.match(r.stdout, /alpha/)
    assert.match(r.stdout, /beta/)
    assert.match(r.stdout, /未克隆/)
    assert.equal(r.stderr, '')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ── 退出码 1：业务性失败 ─────────────────────────────────────────────────────

test('未配置凭据（无 NOTEGIT_SERVER/NOTEGIT_TOKEN）：退出码 1，stderr 提示配置面', async () => {
  const r = await runLs(['--json'], {})
  assert.equal(r.status, 1)
  assert.match(r.stderr, /未配置/)
  assert.match(r.stderr, /NOTEGIT_SERVER|login/)
  assert.ok(!r.stdout.includes('{'), '失败时 stdout 应无 JSON')
})

test('token 无效（401）：退出码 1，stderr 提示认证失败', async () => {
  const r = await runLs(['--json'], { token: `ngt_${'z'.repeat(43)}`, server: serverUrl })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /认证失败|401/)
})

test('服务器不可达（连接拒绝）：退出码 1，stderr 提示无法连接', async () => {
  const r = await runLs(['--json'], { token: TOKENS['alice'], server: 'http://127.0.0.1:1' })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /无法连接/)
})

test('服务器 500：退出码 1，stderr 提示服务器错误', async () => {
  apiMode = 'internal'
  try {
    const r = await runLs(['--json'], { token: TOKENS['alice'], server: serverUrl })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /服务器错误|500/)
  } finally {
    apiMode = 'ok'
  }
})

// ── 本地状态端到端：真实 git（insteadOf 把 <server>/git/ 重定向到本地 bare 仓库） ──

const GIT_ENV = { PATH: process.env['PATH']!, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, env: GIT_ENV, stdio: 'pipe' })
}

function rev(cwd: string, ref: string): string {
  return execFileSync('git', ['rev-parse', ref], { cwd, env: GIT_ENV, encoding: 'utf8' }).trim()
}

/** 造一个非 bare 仓库并提交 n 次，返回提交 sha 列表（默认分支 main）。 */
async function seedWork(dir: string, n: number): Promise<string[]> {
  await mkdir(dir, { recursive: true })
  git(dir, 'init', '-b', 'main')
  git(dir, 'config', 'user.name', 't')
  git(dir, 'config', 'user.email', 't@notegit.invalid')
  const shas: string[] = []
  for (let i = 0; i < n; i++) {
    await writeFile(path.join(dir, `f${i}.md`), `# note ${i}\n`)
    git(dir, 'add', '.')
    git(dir, 'commit', '-m', `c${i}`)
    shas.push(rev(dir, 'HEAD'))
  }
  return shas
}

function writeInsteadOf(home: string, remotesDir: string): void {
  writeFileSync(
    path.join(home, '.gitconfig'),
    [`[url "${remotesDir}/"]`, `\tinsteadOf = ${serverUrl}/git/`, ''].join('\n'),
  )
}

test('本地状态 e2e：cloned → behind（远端前进）→ unknown（本地分叉/远端不可达）+ not_cloned', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'notegit-ls-home-'))
  const root = await mkdtemp(path.join(tmpdir(), 'notegit-ls-root-'))
  const remotes = await mkdtemp(path.join(tmpdir(), 'notegit-ls-remotes-'))
  const alphaWork = path.join(remotes, 'alpha-work')
  try {
    const [c1] = await seedWork(alphaWork, 1)
    git(remotes, 'clone', '--bare', alphaWork, 'alpha.git')
    git(remotes, 'clone', '--bare', alphaWork, 'beta.git')
    git(root, 'clone', path.join(remotes, 'alpha.git'), 'alpha') // 本地副本 = 远端 tip
    writeInsteadOf(home, remotes)

    const vault = async (who: 'bob', slug: string): Promise<Record<string, unknown>> => {
      const { r, doc } = await await runLsJson(who, root, home)
      assert.equal(r.status, 0, `stderr: ${r.stderr}`)
      return ((doc['vaults'] as Array<Record<string, unknown>>).find((v) => v['slug'] === slug)!['local'] as Record<string, unknown>)
    }

    // phase 1：alpha=cloned（head==tip）、beta=not_cloned
    assert.deepEqual(await vault('bob', 'alpha'), { path: path.join(root, 'alpha'), status: 'cloned', head: c1, remote_tip: c1, last_sync: null })
    assert.deepEqual(await vault('bob', 'beta'), { path: null, status: 'not_cloned', head: null, remote_tip: null, last_sync: null })

    // phase 2：远端前进一步 → behind
    await writeFile(path.join(alphaWork, 'f9.md'), '# advance\n')
    git(alphaWork, 'add', '.')
    git(alphaWork, 'commit', '-m', 'advance')
    const c2 = rev(alphaWork, 'HEAD')
    git(alphaWork, 'push', path.join(remotes, 'alpha.git'), 'main')
    assert.deepEqual(await vault('bob', 'alpha'), { path: path.join(root, 'alpha'), status: 'behind', head: c1, remote_tip: c2, last_sync: null })

    // phase 3：本地另起提交（与远端分叉，head != tip 且非其祖先）→ unknown
    const alphaLocal = path.join(root, 'alpha')
    git(alphaLocal, 'config', 'user.name', 't')
    git(alphaLocal, 'config', 'user.email', 't@notegit.invalid')
    await writeFile(path.join(alphaLocal, 'local.md'), '# local\n')
    git(alphaLocal, 'add', '.')
    git(alphaLocal, 'commit', '-m', 'local')
    const cLocal = rev(alphaLocal, 'HEAD')
    assert.deepEqual(await vault('bob', 'alpha'), { path: alphaLocal, status: 'unknown', head: cLocal, remote_tip: c2, last_sync: null })

    // phase 4：远端目录消失（fetch 失败）→ unknown，head 保留、remote_tip null
    await rm(path.join(remotes, 'alpha.git'), { recursive: true, force: true })
    assert.deepEqual(await vault('bob', 'alpha'), { path: alphaLocal, status: 'unknown', head: cLocal, remote_tip: null, last_sync: null })
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
    await rm(remotes, { recursive: true, force: true })
  }
})
