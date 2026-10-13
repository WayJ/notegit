/**
 * S9-T5 本地 Harness 收口（breakdown §2.8 S9-T5 行；DOD-10「两环境完成读取与修改」）。
 *
 * 对真实服务实例（server/ 现码 startApp）走**员工电脑读写闭环 + 网页双通道**：
 * login → ls → sync（读）→ 本地修改 → lint → commit → push（Git 通道写）
 * → 浏览页核对（Web 看 Git）→ 网页提交（Web 通道写）→ 再 sync 快进（Git 看 Web）
 * → 引用三要素解析。harness-guide.test.ts（S7-T8）守 login→sync→引用的读面；
 * 本文件补齐写面与双通道会合——收口记录见 docs/s9/harness-local-closeout.md，
 * 复跑演练脚本 cli/test-support/harness-closeout-drill.ts（逐步输出即验证记录）。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
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
} from '../test-support/real-instance.ts'

const BIN = new URL('../dist/bin/notegit.js', import.meta.url).pathname

const SLUG = 'v-handbook'
const DOC_PATH = 'docs/getting-started.md'
const DOC_CONTENT = '---\ntitle: 起步\n---\n\n# 起步\n\n第一条知识。\n'
const LOCAL_NEW_PATH = 'notes/local-edit.md'
const LOCAL_NEW_CONTENT = '---\ntitle: 本地修改演练\n---\n\n经本地 Harness Git 通道新增。\n'
const WEB_NEW_PATH = 'notes/from-web.md'
const WEB_NEW_CONTENT = '---\ntitle: 网页通道演练\n---\n\n经网页提交通道发布。\n'

interface Run {
  status: number | null
  stdout: string
  stderr: string
}

/** 异步跑 dist 产物 CLI（对在听实例的调用绝不可 sync spawn——S6 教训）。 */
function runBin(args: string[], opts: { cwd?: string } = {}): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { env, cwd: opts.cwd })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')))
    child.on('error', () => resolve({ status: null, stdout, stderr }))
    child.on('close', (code) => resolve({ status: code, stdout, stderr }))
  })
}

let root: string
let inst: RealInstance
let aliceToken: string
let aliceCookie: string
let seedHead: string
let env: Record<string, string>
let repo: string

/** 员工网页会话（ngt_sid）。 */
async function webSession(username: string, password: string): Promise<string> {
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

before(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'ngt-local-closeout-'))
  inst = await bootRealInstance(path.join(root, 'data'))
  const alice = await createEmployee(inst, 'alice')
  aliceToken = await createCredentialFor(inst, alice.username, alice.password)
  aliceCookie = await webSession(alice.username, alice.password)
  await createVault(inst, SLUG, '员工手册', [{ username: alice.username, role: 'editor' }])
  const seeded = await seedVaultContent(inst.baseUrl, SLUG, aliceToken, [
    { path: 'README.md', content: '# 员工手册\n\n导航：docs/getting-started.md\n' },
    { path: DOC_PATH, content: DOC_CONTENT },
  ])
  seedHead = seeded.head

  env = { ...(process.env as Record<string, string>) }
  env['HOME'] = root
  env['XDG_CONFIG_HOME'] = path.join(root, '.config')
  env['NOTEGIT_CREDENTIALS_FILE'] = path.join(root, 'credentials')
  env['GIT_CONFIG_GLOBAL'] = path.join(root, '.gitconfig')
  env['GIT_CONFIG_SYSTEM'] = '/dev/null'
  env['GIT_TERMINAL_PROMPT'] = '0'
  env['NOTEGIT_SERVER'] = inst.baseUrl
  env['NOTEGIT_TOKEN'] = aliceToken
  env['NOTEGIT_LOCAL_ROOT'] = path.join(root, 'knowbase')
  delete env['GIT_ASKPASS']
  delete env['SSH_ASKPASS']
  repo = path.join(root, 'knowbase', SLUG)
})

after(async () => {
  await inst.close()
  rmSync(root, { recursive: true, force: true })
})

test('本地读面：login 免交互成功，输出不含明文令牌', async () => {
  const r = await runBin(['login', inst.baseUrl, '--username', 'alice'])
  assert.equal(r.status, 0, `login 应退出 0，stderr：${r.stderr}`)
  assert.ok(!r.stdout.includes(aliceToken) && !r.stderr.includes(aliceToken), 'login 输出不得含完整 token')
})

test('本地读面：ls not_cloned → sync 克隆（HEAD=种子）→ ls cloned', async () => {
  const before = await runBin(['ls', '--json'])
  assert.equal(before.status, 0, `ls 应退出 0，stderr：${before.stderr}`)
  const docBefore = JSON.parse(before.stdout) as { vaults: Array<{ slug: string; local: { status: string } }> }
  assert.equal(docBefore.vaults.find((x) => x.slug === SLUG)?.local.status, 'not_cloned')

  const sync = await runBin(['sync'])
  assert.equal(sync.status, 0, `sync 应退出 0，stderr：${sync.stderr}`)
  const rev = await git(repo, 'rev-parse', 'HEAD')
  assert.equal(rev.stdout.trim(), seedHead, '克隆 HEAD 应等于服务端种子提交')

  const after = await runBin(['ls', '--json'])
  const docAfter = JSON.parse(after.stdout) as { vaults: Array<{ slug: string; local: { status: string } }> }
  assert.equal(docAfter.vaults.find((x) => x.slug === SLUG)?.local.status, 'cloned')
});

test('本地读面：引用三要素（库/路径/commit）解析到种子内容', async () => {
  const show = await git(repo, 'show', `${seedHead}:${DOC_PATH}`)
  assert.equal(show.status, 0, `git show ${seedHead}:${DOC_PATH} 应成功`)
  assert.equal(show.stdout, DOC_CONTENT, '引用 commit 处的该路径内容应与种子一致')
});

test('Git 通道写回：本地修改→lint --staged→commit→push 成功，服务端 tip=本地 HEAD，令牌不进 URL/输出', async () => {
  appendFileSync(path.join(repo, DOC_PATH), '\n\n## 本地补充（S9-T5 收口测试）\n')
  mkdirSync(path.join(repo, 'notes'), { recursive: true })
  writeFileSync(path.join(repo, LOCAL_NEW_PATH), LOCAL_NEW_CONTENT)
  await git(repo, 'add', '.')
  const lint = await runBin(['lint', '--staged'], { cwd: repo })
  assert.equal(lint.status, 0, `lint --staged 应通过：${lint.stdout}${lint.stderr}`)
  const commit = await git(repo, 'commit', '-m', 'S9-T5 本地修改（Git 通道）')
  assert.equal(commit.status, 0, `commit 应成功：${commit.stderr}`)

  const url = await git(repo, 'remote', 'get-url', 'origin')
  assert.ok(!url.stdout.includes(aliceToken), 'remote URL 不得含令牌')
  const push = await new Promise<Run>((resolve) => {
    const child = spawn('git', ['push', 'origin', 'main'], { cwd: repo, env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')))
    child.on('close', (code) => resolve({ status: code, stdout, stderr }))
  })
  assert.equal(push.status, 0, `push 应成功：${push.stderr}`)
  assert.ok(!push.stdout.includes(aliceToken) && !push.stderr.includes(aliceToken), 'push 输出不得含明文令牌')

  const head = (await git(repo, 'rev-parse', 'HEAD')).stdout.trim()
  const lsRemote = await new Promise<Run>((resolve) => {
    const child = spawn('git', ['ls-remote', 'origin', 'refs/heads/main'], { cwd: repo, env })
    let stdout = ''
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')))
    child.stderr.on('data', () => {})
    child.on('close', (code) => resolve({ status: code, stdout, stderr: '' }))
  })
  assert.equal(lsRemote.status, 0, 'ls-remote 应成功')
  assert.equal(lsRemote.stdout.split('\t')[0]!.trim(), head, '服务端 tip 应等于本地推送 HEAD')
});

test('Web 看 Git：浏览页列出 Git 通道发布的新文件', async () => {
  const page = await fetch(`${inst.baseUrl}/vaults/${SLUG}/browse/notes/`, { headers: { cookie: aliceCookie } })
  assert.equal(page.status, 200, `浏览 notes/ 应 200，实际 ${page.status}`)
  const html = await page.text()
  assert.ok(html.includes('local-edit.md'), '浏览页应列出 Git 通道新增的 local-edit.md')
});

test('Web 通道写回→双通道会合：网页提交 201，本地再 sync 快进且内容逐字一致，新引用可解析', async () => {
  const tipBefore = (await git(repo, 'rev-parse', 'HEAD')).stdout.trim()
  const res = await api(inst.baseUrl, aliceCookie, 'POST', `/api/v1/vaults/${SLUG}/submissions`, {
    base_commit: tipBefore,
    changes: [{ path: WEB_NEW_PATH, content: WEB_NEW_CONTENT }],
    message: 'S9-T5 网页通道提交',
  })
  assert.equal(res.status, 201, `网页提交应 201，实际 ${res.status}：${JSON.stringify(res.body)}`)

  const sync = await runBin(['sync'])
  assert.equal(sync.status, 0, `sync 应退出 0，stderr：${sync.stderr}`)
  assert.ok(sync.stdout.includes('已快进'), `sync 输出应含「已快进」：${sync.stdout}`)
  assert.equal(readFileSync(path.join(repo, WEB_NEW_PATH), 'utf8'), WEB_NEW_CONTENT, '本地副本应与网页通道发布内容逐字一致')

  const webHead = (await git(repo, 'rev-parse', 'HEAD')).stdout.trim()
  const show = await git(repo, 'show', `${webHead}:${WEB_NEW_PATH}`)
  assert.equal(show.status, 0, `git show ${webHead}:${WEB_NEW_PATH} 应成功`)
  assert.equal(show.stdout, WEB_NEW_CONTENT, '引用新 commit 处内容应可解析且一致')
});
