/**
 * S9-T5 双 Harness 环境验证收口演练脚本（breakdown §2.8 S9-T5 行；DOD-10）。
 *
 * 演练即测试：本脚本对**真实服务实例**（server/ 现码 startApp）完整走两遍——
 *   L 面（本地 Harness 收口）：员工电脑模拟 login→ls→sync→引用取回→本地修改→
 *     lint→commit→push（Git 通道）→网页浏览核对→网页提交（Web 通道）→再 sync
 *     快进（双通道闭环）→新引用取回；
 *   H 面（托管 Harness 收口）：按 docs/harness/hosted-runbook.md 布局起两员工
 *     （同一 OS 账号最苛刻形态）→各自 login/ls/sync→目录/凭据/状态隔离复查→
 *     共享库经 alice push + bob sync 协作不破坏隔离。
 *
 * 逐步断言，任一步失败即非零退出；输出即验证记录（建议 tee 留档）：
 *   cd cli && npm run build && node test-support/harness-closeout-drill.ts
 *   （仓库根亦可：node cli/test-support/harness-closeout-drill.ts——需先构建 cli/dist）
 * 收口文档：docs/s9/harness-local-closeout.md、docs/s9/harness-hosted-closeout.md；
 * npm test 常驻守卫：cli/test/local-harness-closeout.test.ts、hosted-harness-closeout.test.ts。
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  bootRealInstance,
  createEmployee,
  createCredentialFor,
  createVault,
  seedVaultContent,
  api,
  git,
  type RealInstance,
} from './real-instance.ts'

const BIN = new URL('../dist/bin/notegit.js', import.meta.url).pathname

if (!existsSync(BIN)) {
  console.error(`缺 ${BIN}——先构建：cd cli && npm run build`)
  process.exit(2)
}

// ── 记录与断言仪器 ───────────────────────────────────────────────────────────

const t0 = Date.now()
let passed = 0

function log(line = ''): void {
  const s = ((Date.now() - t0) / 1000).toFixed(1).padStart(5)
  console.log(`[${s}s] ${line}`)
}

/** 子行摘录（S8 演练留档同款「│ 」前缀；先脱敏再入档）。 */
function excerpt(text: string): void {
  for (const l of text.split('\n')) log(`│ ${l}`)
}

/** 令牌脱敏：明文仅保留首 8 + 尾 2 字符（identity §3.1 形态可辨、不可复原）。 */
function mask(token: string): string {
  return `${token.slice(0, 8)}…${token.slice(-2)}`
}

function maskAll(text: string, ...secrets: string[]): string {
  let out = text
  for (const s of secrets) out = out.split(s).join(mask(s))
  return out
}

async function step(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed += 1
    log(`✓ ${name}`)
  } catch (err) {
    log(`✗ ${name}`)
    log(`│ 失败：${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}

/** 泄漏红线：任何命令输出不得含明文令牌（DOD-09/凭据纪律）。 */
function assertNoSecret(what: string, text: string, ...secrets: string[]): void {
  for (const s of secrets) assert.ok(!text.includes(s), `${what} 输出不得含明文令牌`)
}

interface Run {
  status: number | null
  stdout: string
  stderr: string
}

/** 异步跑 dist 产物 CLI（对在听实例的调用绝不可 sync spawn——S6 教训）。 */
function runBin(
  args: string[],
  env: Record<string, string>,
  opts: { cwd?: string; stdin?: string } = {},
): Promise<Run> {
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
    child.on('error', () => resolve({ status: null, stdout, stderr }))
    child.on('close', (code) => resolve({ status: code, stdout, stderr }))
  })
}

function modeOf(p: string): number {
  return statSync(p).mode & 0o777
}

/** 带会话环境的 git（push/ls-remote 等需认证或需会话配置的调用必须走这里——credential helper 注册在会话 GIT_CONFIG_GLOBAL）。 */
function gitWith(env: Record<string, string>, cwd: string, ...args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn('git', ['-c', 'user.name=notegit-drill', '-c', 'user.email=notegit-drill@example.invalid', ...args], { cwd, env })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => (stdout += d))
    child.stderr.on('data', (d: string) => (stderr += d))
    child.on('error', () => resolve({ status: null, stdout, stderr }))
    child.on('close', (code) => resolve({ status: code, stdout, stderr }))
  })
}

function oct(n: number): string {
  return `0${n.toString(8)}`
}

/** 员工网页会话（ngt_sid；写操作由 api() 附同源 Origin）。 */
async function webSession(inst: RealInstance, username: string, password: string): Promise<string> {
  const res = await fetch(`${inst.baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  assert.equal(res.status, 200, `网页登录 ${username} 应 200`)
  const raw = res.headers.get('set-cookie') ?? ''
  const m = raw.match(/ngt_sid=([^;]+)/)
  assert.ok(m !== null, `登录响应 cookie 非 ngt_sid 形态：${raw}`)
  return `ngt_sid=${m[1]}`
}

// ── 世界：真实实例 + alice（v-handbook 编辑者）+ 种子内容 ─────────────────────

const root = mkdtempSync(path.join(tmpdir(), 'ngt-s9t5-'))
const inst = await bootRealInstance(path.join(root, 'server-data'))

const aliceAcc = await createEmployee(inst, 'alice')
const aliceToken = await createCredentialFor(inst, aliceAcc.username, aliceAcc.password)
const bobAcc = await createEmployee(inst, 'bob')
const bobToken = await createCredentialFor(inst, bobAcc.username, bobAcc.password)
const aliceCookie = await webSession(inst, aliceAcc.username, aliceAcc.password)

const SLUG = 'v-handbook'
const DOC_PATH = 'docs/getting-started.md'
const DOC_CONTENT = '---\ntitle: 起步\n---\n\n# 起步\n\n第一条知识。\n'
await createVault(inst, SLUG, '员工手册', [{ username: aliceAcc.username, role: 'editor' }])
const seeded = await seedVaultContent(inst.baseUrl, SLUG, aliceToken, [
  { path: 'README.md', content: '# 员工手册\n\n导航：docs/getting-started.md\n' },
  { path: DOC_PATH, content: DOC_CONTENT },
])

/** 员工电脑会话环境（指引 docs/harness/README.md 本地节步骤 3–5 的环境面）。 */
const laptop = path.join(root, 'laptop')
const laptopEnv: Record<string, string> = {
  ...(process.env as Record<string, string>),
  HOME: laptop,
  XDG_CONFIG_HOME: path.join(laptop, '.config'),
  GIT_CONFIG_GLOBAL: path.join(laptop, '.gitconfig'),
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  NOTEGIT_CREDENTIALS_FILE: path.join(laptop, 'credentials'),
  NOTEGIT_LOCAL_ROOT: path.join(laptop, 'knowbase'),
  NOTEGIT_SERVER: inst.baseUrl,
  NOTEGIT_TOKEN: aliceToken,
}
delete laptopEnv['GIT_ASKPASS']
delete laptopEnv['SSH_ASKPASS']

const repo = path.join(laptop, 'knowbase', SLUG)

/** 服务端 tip（经 credential helper 免交互认证——不用 URL 凭据；走员工电脑会话环境）。 */
async function remoteTip(env: Record<string, string>, cwd: string): Promise<string> {
  const r = await gitWith(env, cwd, 'ls-remote', 'origin', 'refs/heads/main')
  assert.equal(r.status, 0, `ls-remote 应成功：${r.stderr}`)
  return r.stdout.split('\t')[0]!.trim()
}

log(`S9-T5 双 Harness 收口演练开始（实例 ${inst.baseUrl}；数据目录 ${inst.dataDir}）`)

// ── L 面：本地 Harness 读写闭环（员工电脑模拟） ─────────────────────────────

await step('L1 login：令牌经环境变量，免交互成功，输出无明文令牌', async () => {
  const r = await runBin(['login', inst.baseUrl, '--username', aliceAcc.username], laptopEnv)
  assert.equal(r.status, 0, `login 应退出 0，stderr：${r.stderr}`)
  assertNoSecret('login', r.stdout + r.stderr, aliceToken)
  excerpt(`$ NOTEGIT_TOKEN=${mask(aliceToken)} notegit login ${inst.baseUrl} --username alice`)
  excerpt(r.stdout.trim() || r.stderr.trim())
})

let firstLs = ''
await step('L2 ls --json：列出授权库，本地状态 not_cloned（同步前）', async () => {
  const r = await runBin(['ls', '--json'], laptopEnv)
  assert.equal(r.status, 0, `ls 应退出 0，stderr：${r.stderr}`)
  const doc = JSON.parse(r.stdout) as { vaults: Array<{ slug: string; local: { status: string } }> }
  const v = doc.vaults.find((x) => x.slug === SLUG)
  assert.ok(v !== undefined, `ls 应列出 ${SLUG}：${r.stdout}`)
  assert.equal(v.local.status, 'not_cloned')
  firstLs = r.stdout
  excerpt('$ notegit ls --json')
  excerpt(r.stdout.trim())
})

await step('L3 sync：完整克隆到 <根>/<slug>，HEAD 与服务端种子一致', async () => {
  const r = await runBin(['sync'], laptopEnv)
  assert.equal(r.status, 0, `sync 应退出 0，stderr：${r.stderr}`)
  assertNoSecret('sync', r.stdout + r.stderr, aliceToken)
  const rev = await git(repo, 'rev-parse', 'HEAD')
  assert.equal(rev.stdout.trim(), seeded.head, '克隆 HEAD 应等于服务端种子提交')
  excerpt('$ notegit sync')
  excerpt(r.stdout.trim())
})

await step('L4 ls --json：同步后状态 cloned（幂等复看）', async () => {
  const r = await runBin(['ls', '--json'], laptopEnv)
  assert.equal(r.status, 0, `ls 应退出 0，stderr：${r.stderr}`)
  const doc = JSON.parse(r.stdout) as { vaults: Array<{ slug: string; local: { status: string } }> }
  assert.equal(doc.vaults.find((x) => x.slug === SLUG)?.local.status, 'cloned')
  excerpt('$ notegit ls --json   # local.status: not_cloned → cloned')
  const before = JSON.parse(firstLs) as { vaults: Array<{ slug: string; local: { status: string } }> }
  excerpt(`local.status: ${before.vaults.find((x) => x.slug === SLUG)?.local.status} → ${doc.vaults.find((x) => x.slug === SLUG)?.local.status}`)
})

await step('L5 引用取回：库/路径/commit 三要素解析到种子内容（架构 §7.1）', async () => {
  const show = await git(repo, 'show', `${seeded.head}:${DOC_PATH}`)
  assert.equal(show.status, 0, `git show ${seeded.head}:${DOC_PATH} 应成功`)
  assert.equal(show.stdout, DOC_CONTENT, '引用 commit 处的该路径内容应与种子一致')
  excerpt(`引用：${SLUG} / ${DOC_PATH} @ ${seeded.head.slice(0, 7)}（${seeded.head}）`)
  excerpt(`$ git show ${seeded.head}:${DOC_PATH} → 与种子逐字一致（${show.stdout.length} 字节）`)
})

const LOCAL_EDIT_APPEND = '\n\n## 本地补充（S9-T5 收口演练）\n\n经本地 Harness Git 通道修改。\n'
const LOCAL_NEW_PATH = 'notes/local-edit.md'
const LOCAL_NEW_CONTENT = '---\ntitle: 本地修改演练\n---\n\n经本地 Harness Git 通道新增。\n'

await step('L6 本地修改：改既有文档 + 新增 notes/local-edit.md，lint --staged 通过后提交', async () => {
  appendFileSync(path.join(repo, DOC_PATH), LOCAL_EDIT_APPEND)
  mkdirSync(path.join(repo, 'notes'), { recursive: true })
  writeFileSync(path.join(repo, LOCAL_NEW_PATH), LOCAL_NEW_CONTENT)
  await git(repo, 'add', '.')
  const diff = await git(repo, 'diff', '--cached', '--stat')
  excerpt('$ git add . && git diff --cached --stat')
  excerpt(diff.stdout.trim())
  const lint = await runBin(['lint', '--staged'], laptopEnv, { cwd: repo })
  assert.equal(lint.status, 0, `lint --staged 应通过，输出：${lint.stdout}${lint.stderr}`)
  excerpt(`$ notegit lint --staged   # exit ${lint.status}`)
  excerpt(lint.stdout.trim() || lint.stderr.trim())
  const commit = await git(repo, 'commit', '-m', 'S9-T5 本地修改：改起步文档 + 新增本地演练笔记')
  assert.equal(commit.status, 0, `commit 应成功：${commit.stderr}`)
})

let pushedHead = ''
await step('L7 push：git push origin main 经 credential helper 免交互成功，服务端 tip 前进；令牌不进 URL/输出', async () => {
  const url = await git(repo, 'remote', 'get-url', 'origin')
  assert.equal(url.stdout.trim(), `${inst.baseUrl}/git/${SLUG}.git`, 'remote URL 应为服务地址（无凭据）')
  assertNoSecret('remote URL', url.stdout, aliceToken)
  const r = await gitWith(laptopEnv, repo, 'push', 'origin', 'main')
  assert.equal(r.status, 0, `push 应成功：${r.stderr}`)
  assertNoSecret('push', r.stdout + r.stderr, aliceToken)
  const local = await git(repo, 'rev-parse', 'HEAD')
  pushedHead = local.stdout.trim()
  assert.equal(await remoteTip(laptopEnv, repo), pushedHead, '服务端 tip 应等于本地推送 HEAD')
  excerpt('$ git push origin main')
  excerpt(r.stderr.trim())
  excerpt(`服务端 tip = 本地 HEAD ${pushedHead.slice(0, 7)}（ls-remote 核对一致）`)
})

await step('L8 网页通道核对：浏览页可见 Git 通道发布的新文件（Web 看 Git）', async () => {
  const notes = await fetch(`${inst.baseUrl}/vaults/${SLUG}/browse/notes/`, { headers: { cookie: aliceCookie } })
  assert.equal(notes.status, 200, `浏览 notes/ 应 200，实际 ${notes.status}`)
  const html = await notes.text()
  assert.ok(html.includes('local-edit.md'), '浏览页应列出 Git 通道新增的 local-edit.md')
  excerpt(`$ GET /vaults/${SLUG}/browse/notes/（alice 网页会话）→ 200，页面含 local-edit.md`)
})

const WEB_NEW_PATH = 'notes/from-web.md'
const WEB_NEW_CONTENT = '---\ntitle: 网页通道演练\n---\n\n经网页提交通道发布（S9-T5）。\n'
let webHead = ''

await step('L9 网页通道提交：POST submissions（base_commit=当前 tip）发布新文档', async () => {
  const res = await api(inst.baseUrl, aliceCookie, 'POST', `/api/v1/vaults/${SLUG}/submissions`, {
    base_commit: pushedHead,
    changes: [{ path: WEB_NEW_PATH, content: WEB_NEW_CONTENT }],
    message: 'S9-T5 网页通道提交',
  })
  assert.equal(res.status, 201, `网页提交应 201，实际 ${res.status}：${JSON.stringify(res.body)}`)
  webHead = await remoteTip(laptopEnv, repo)
  assert.notEqual(webHead, pushedHead, '网页提交后服务端 tip 应前进')
  excerpt(`$ POST /api/v1/vaults/${SLUG}/submissions {base_commit: ${pushedHead.slice(0, 7)}, changes: [${WEB_NEW_PATH}]} → 201`)
  excerpt(`服务端 tip ${pushedHead.slice(0, 7)} → ${webHead.slice(0, 7)}`)
})

await step('L10 再 sync：快进到网页提交，本地副本出现网页通道内容（Git 看 Web——双通道闭环）', async () => {
  const r = await runBin(['sync'], laptopEnv)
  assert.equal(r.status, 0, `sync 应退出 0，stderr：${r.stderr}`)
  assert.ok(r.stdout.includes('已快进'), `sync 人读输出应含「已快进」：${r.stdout}`)
  excerpt('$ notegit sync')
  excerpt(r.stdout.trim())
  const local = readFileSync(path.join(repo, WEB_NEW_PATH), 'utf8')
  assert.equal(local, WEB_NEW_CONTENT, '本地副本应与网页通道发布内容逐字一致')
  const rev = await git(repo, 'rev-parse', 'HEAD')
  assert.equal(rev.stdout.trim(), webHead, '本地 HEAD 应等于网页提交 tip')
})

await step('L11 新引用取回：库/路径/commit 指向网页提交可解析（引用随内容演进不失效）', async () => {
  const show = await git(repo, 'show', `${webHead}:${WEB_NEW_PATH}`)
  assert.equal(show.status, 0, `git show ${webHead.slice(0, 7)}:${WEB_NEW_PATH} 应成功`)
  assert.equal(show.stdout, WEB_NEW_CONTENT, '新引用处内容应可解析且一致')
  excerpt(`引用：${SLUG} / ${WEB_NEW_PATH} @ ${webHead.slice(0, 7)}（${webHead}）→ git show 解析一致`)
})

// ── H 面：托管 Harness 按员工隔离复查（hosted-runbook 布局，真实实例） ────────

/** 托管布局（runbook §1）：共享父目录 0755；员工目录（凭据 + 本地根）由 CLI 收紧 0700。 */
const hostedBase = path.join(root, 'hosted')
const employeesDir = path.join(hostedBase, 'employees')
mkdirSync(employeesDir, { recursive: true })
chmodSync(employeesDir, 0o755)
const hostedHome = mkdtempSync(path.join(tmpdir(), 'ngt-s9t5-home-')) // 同一 OS 账号（最苛刻形态）

interface HostedEmployee {
  name: string
  token: string
  dir: string
  root: string
  credFile: string
}

function hostedEmp(name: string, token: string): HostedEmployee {
  const dir = path.join(employeesDir, name)
  return { name, token, dir, root: path.join(dir, 'knowbase'), credFile: path.join(dir, 'credentials') }
}

const hAlice = hostedEmp('alice', aliceToken)
const hBob = hostedEmp('bob', bobToken)

function hostedEnv(emp: HostedEmployee): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    PATH: process.env['PATH']!,
    HOME: hostedHome,
    XDG_CONFIG_HOME: path.join(hostedHome, '.config'),
    GIT_CONFIG_GLOBAL: path.join(hostedHome, '.gitconfig'),
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    NOTEGIT_CREDENTIALS_FILE: emp.credFile,
    NOTEGIT_LOCAL_ROOT: emp.root,
    NOTEGIT_SERVER: inst.baseUrl,
    NOTEGIT_TOKEN: emp.token,
  }
}

await step('H0 世界：两员工三库两成员集（alice 专属 / bob 专属 / 共享 team-docs）就位', async () => {
  await createVault(inst, 'alice-notes', 'Alice 专属', [{ username: hAlice.name, role: 'editor' }])
  await createVault(inst, 'bob-notes', 'Bob 专属', [{ username: hBob.name, role: 'editor' }])
  await createVault(inst, 'team-docs', '团队共享', [
    { username: hAlice.name, role: 'editor' },
    { username: hBob.name, role: 'editor' },
  ])
  await seedVaultContent(inst.baseUrl, 'alice-notes', aliceToken, [{ path: 'README.md', content: '# alice\n' }])
  await seedVaultContent(inst.baseUrl, 'bob-notes', bobToken, [{ path: 'README.md', content: '# bob\n' }])
  await seedVaultContent(inst.baseUrl, 'team-docs', aliceToken, [{ path: 'README.md', content: '# team\n' }])
  excerpt('布局（runbook §1）：employees/ 0755；alice/、bob/ 各含 credentials + knowbase/')
  excerpt('会话环境仅三变量隔离：NOTEGIT_LOCAL_ROOT / NOTEGIT_CREDENTIALS_FILE / NOTEGIT_TOKEN（HOME 与 git 全局配置共享——同一 OS 账号）')
})

let aliceCredBefore = ''
await step('H1 两员工各自 login：凭据落各自私有文件 0600，员工目录收紧 0700', async () => {
  const a = await runBin(['login', inst.baseUrl, '--username', hAlice.name], hostedEnv(hAlice))
  assert.equal(a.status, 0, `alice login 应成功，stderr：${a.stderr}`)
  aliceCredBefore = readFileSync(hAlice.credFile, 'utf8')
  const b = await runBin(['login', inst.baseUrl, '--username', hBob.name], hostedEnv(hBob))
  assert.equal(b.status, 0, `bob login 应成功，stderr：${b.stderr}`)
  excerpt(`$ notegit login … --username alice → credentials 0600 @ ${hAlice.credFile.replace(root, '<演练根>')}`)
  excerpt(`$ notegit login … --username bob   → credentials 0600 @ ${hBob.credFile.replace(root, '<演练根>')}`)
})

await step('H2 可见库各归各：alice 3 库 / bob 2 库，互不见对方专属库（真实 API 授权面）', async () => {
  const a = await runBin(['ls', '--json'], hostedEnv(hAlice))
  assert.equal(a.status, 0, `alice ls 应退出 0，stderr：${a.stderr}`)
  const b = await runBin(['ls', '--json'], hostedEnv(hBob))
  assert.equal(b.status, 0, `bob ls 应退出 0，stderr：${b.stderr}`)
  const slugsA = (JSON.parse(a.stdout) as { vaults: Array<{ slug: string }> }).vaults.map((x) => x.slug).sort()
  const slugsB = (JSON.parse(b.stdout) as { vaults: Array<{ slug: string }> }).vaults.map((x) => x.slug).sort()
  assert.deepEqual(slugsA, ['alice-notes', 'team-docs', 'v-handbook'], `alice 可见库应恰为 3：${slugsA}`)
  assert.deepEqual(slugsB, ['bob-notes', 'team-docs'], `bob 可见库应恰为 2：${slugsB}`)
  assertNoSecret('ls', a.stdout + b.stdout, aliceToken, bobToken)
  excerpt(`$ notegit ls（alice 会话）→ ${slugsA.join('、')}`)
  excerpt(`$ notegit ls（bob 会话）→ ${slugsB.join('、')}`)
})

let syncA = ''
let syncB = ''
await step('H3 各自 sync：各自根下恰克隆各自可见库（目录互不交叉）', async () => {
  const a = await runBin(['sync'], hostedEnv(hAlice))
  assert.equal(a.status, 0, `alice sync 应成功，stderr：${a.stderr}`)
  syncA = a.stdout
  const b = await runBin(['sync'], hostedEnv(hBob))
  assert.equal(b.status, 0, `bob sync 应成功，stderr：${b.stderr}`)
  syncB = b.stdout
  assert.deepEqual(readdirSync(hAlice.root).sort(), ['.notegit', 'alice-notes', 'team-docs', 'v-handbook'], 'alice 根下应恰为 alice 可见库')
  assert.deepEqual(readdirSync(hBob.root).sort(), ['.notegit', 'bob-notes', 'team-docs'], 'bob 根下应恰为 bob 可见库')
  assert.ok(!syncA.includes('bob-notes'), 'alice 同步输出不得出现 bob 的库')
  assert.ok(!syncB.includes('alice-notes'), 'bob 同步输出不得出现 alice 的库')
  excerpt('$ notegit sync（alice 会话）')
  excerpt(syncA.trim())
  excerpt('$ notegit sync（bob 会话）')
  excerpt(syncB.trim())
})

await step('H4 隔离复查·权限位：员工目录/本地根 0700、凭据文件 0600、共享父目录 0755（runbook §1 逐行）', async () => {
  assert.equal(modeOf(employeesDir), 0o755, '共享父目录应保持 0755（仅遍历）')
  for (const emp of [hAlice, hBob]) {
    assert.equal(modeOf(emp.dir), 0o700, `${emp.name} 员工目录应 0700，实际 ${oct(modeOf(emp.dir))}`)
    assert.equal(modeOf(emp.root), 0o700, `${emp.name} 本地根应 0700，实际 ${oct(modeOf(emp.root))}`)
    assert.equal(modeOf(emp.credFile), 0o600, `${emp.name} 凭据文件应 0600，实际 ${oct(modeOf(emp.credFile))}`)
  }
  excerpt(`employees/ ${oct(modeOf(employeesDir))}；alice{ dir ${oct(modeOf(hAlice.dir))}, root ${oct(modeOf(hAlice.root))}, cred ${oct(modeOf(hAlice.credFile))} }；bob{ dir ${oct(modeOf(hBob.dir))}, root ${oct(modeOf(hBob.root))}, cred ${oct(modeOf(hBob.credFile))} }`)
})

await step('H5 隔离复查·凭据内容：各文件互只含各自令牌；一方 login 未改写另一方文件', async () => {
  const a = readFileSync(hAlice.credFile, 'utf8')
  const b = readFileSync(hBob.credFile, 'utf8')
  assert.ok(a.includes(aliceToken) && !a.includes(bobToken), 'alice 凭据文件不得含 bob 令牌')
  assert.ok(b.includes(bobToken) && !b.includes(aliceToken), 'bob 凭据文件不得含 alice 令牌')
  assert.equal(a, aliceCredBefore, 'bob login 不得改写 alice 凭据文件')
  excerpt(`alice credentials：仅含 alice 令牌（${mask(aliceToken)}）`)
  excerpt(`bob credentials：仅含 bob 令牌（${mask(bobToken)}）`)
})

await step('H6 隔离复查·helper 串读面：同一 OS 账号下 credential get 按会话环境各取各自令牌', async () => {
  const host = new URL(inst.baseUrl).host
  const query = `protocol=http\nhost=${host}\n\n`
  const ga = await runBin(['credential', 'get'], hostedEnv(hAlice), { stdin: query })
  assert.equal(ga.status, 0, `helper get（alice 环境）应成功，stderr：${ga.stderr}`)
  assert.ok(ga.stdout.includes(aliceToken) && !ga.stdout.includes(bobToken), 'alice 会话应取到 alice 令牌且不含 bob 令牌')
  const gb = await runBin(['credential', 'get'], hostedEnv(hBob), { stdin: query })
  assert.equal(gb.status, 0, `helper get（bob 环境）应成功，stderr：${gb.stderr}`)
  assert.ok(gb.stdout.includes(bobToken) && !gb.stdout.includes(aliceToken), 'bob 会话应取到 bob 令牌且不含 alice 令牌')
  excerpt(`$ notegit credential get（alice 会话）→ password=${mask(aliceToken)}`)
  excerpt(`$ notegit credential get（bob 会话）→ password=${mask(bobToken)}`)
})

await step('H7 隔离复查·状态面：sync-state.json 各随各根，条目恰为各自可见库', async () => {
  const stateA = JSON.parse(readFileSync(path.join(hAlice.root, '.notegit', 'sync-state.json'), 'utf8')) as { vaults: Record<string, unknown> }
  const stateB = JSON.parse(readFileSync(path.join(hBob.root, '.notegit', 'sync-state.json'), 'utf8')) as { vaults: Record<string, unknown> }
  assert.deepEqual(Object.keys(stateA.vaults).sort(), ['alice-notes', 'team-docs', 'v-handbook'], 'alice 状态文件应恰含 alice 可见库')
  assert.deepEqual(Object.keys(stateB.vaults).sort(), ['bob-notes', 'team-docs'], 'bob 状态文件应恰含 bob 可见库')
  excerpt(`alice .notegit/sync-state.json：${Object.keys(stateA.vaults).sort().join('、')}`)
  excerpt(`bob   .notegit/sync-state.json：${Object.keys(stateB.vaults).sort().join('、')}`)
})

const TEAM_POST = 'notes/alice-post.md'
await step('H8 共享库协作：alice 经自己会话 push team-docs，bob sync 快进到同一提交；bob 根仍无 alice 专属库', async () => {
  const teamRepo = path.join(hAlice.root, 'team-docs')
  mkdirSync(path.join(teamRepo, 'notes'), { recursive: true })
  writeFileSync(path.join(teamRepo, TEAM_POST), '---\ntitle: Alice 的共享帖\n---\n\n经 alice 托管会话发布。\n')
  const add = await git(teamRepo, 'add', '.')
  assert.equal(add.status, 0, 'git add 应成功')
  const commit = await git(teamRepo, '-c', 'user.name=alice', '-c', 'user.email=alice@notegit.invalid', 'commit', '-m', 'S9-T5 alice 共享库提交')
  assert.equal(commit.status, 0, `commit 应成功：${commit.stderr}`)
  const p = await gitWith(hostedEnv(hAlice), teamRepo, 'push', 'origin', 'main')
  assert.equal(p.status, 0, `alice push team-docs 应成功：${p.stderr}`)
  assertNoSecret('push', p.stdout + p.stderr, aliceToken)
  const aliceHead = (await git(teamRepo, 'rev-parse', 'HEAD')).stdout.trim()

  const b = await runBin(['sync'], hostedEnv(hBob))
  assert.equal(b.status, 0, `bob sync 应成功，stderr：${b.stderr}`)
  const bobTeamHead = (await git(path.join(hBob.root, 'team-docs'), 'rev-parse', 'HEAD')).stdout.trim()
  assert.equal(bobTeamHead, aliceHead, 'bob 的 team-docs 应快进到 alice 推送的同一提交')
  assert.ok(readFileSync(path.join(hBob.root, 'team-docs', TEAM_POST), 'utf8').includes('alice 托管会话'), 'bob 副本应含 alice 发布的内容')
  assert.ok(!readdirSync(hBob.root).includes('alice-notes'), 'bob 根仍不得出现 alice 专属库')
  excerpt(`$ git push origin main（alice 会话，team-docs）→ ${p.stderr.trim().split('\n').pop() ?? ''}`)
  excerpt(`$ notegit sync（bob 会话）→ team-docs 已快进 ${aliceHead.slice(0, 7)}；bob-notes 不受影响`)
  excerpt(`bob 根内容：${readdirSync(hBob.root).sort().join('、')}（仍无 alice-notes）`)
})

// ── 收尾 ─────────────────────────────────────────────────────────────────────

await inst.close()
rmSync(root, { recursive: true, force: true })
rmSync(hostedHome, { recursive: true, force: true })
log(`S9-T5 双 Harness 收口演练完成：${passed} 步全绿（L 面 11 步读写闭环 + H 面 9 步隔离复查）`)
