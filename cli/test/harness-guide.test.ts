/**
 * S7-T8 Harness 指引文档-实现一致性冒烟（breakdown §2.6 S7-T8 行：指引步骤可照做跑通）。
 *
 * 两层防线：
 *  A) 结构面：docs/harness/README.md（主指引）存在且含全部关键锚点——本地/托管两节、
 *     指引用命令原文（login/ls/sync）、环境变量、默认目录、引用格式三要素、托管侧
 *     NOTEGIT_DATA_DIR/bootstrap token 路径、按员工隔离表述与 S7-T7 手册指引、负载数据
 *     指针。锚点改动而文档未跟 → 红。
 *  B) 行为面：按指引步骤对**真实服务实例**（server/ 现码 startApp）完整走一遍——
 *     启动实例 → 管理员 bootstrap → 邀请员工+口令重置 → 员工建访问凭据 → 建库授权 →
 *     种子首批内容（经 pre-receive 真实校验）→ 员工电脑侧 login → ls --json → sync
 *     （完整克隆）→ 再 sync（up_to_date）→ 按引用格式（库/路径/commit）取回内容核对。
 *     指引宣称的每一步真实可跑、宣称的结果真实发生。
 * 指引文本与行为共用本文件中的命令常量（结构面断言原文 = 行为面执行形态）。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  bootRealInstance,
  createEmployee,
  createCredentialFor,
  createVault,
  seedVaultContent,
  type RealInstance,
} from '../test-support/real-instance.ts'

const GUIDE = new URL('../../docs/harness/README.md', import.meta.url).pathname
const BIN = new URL('../dist/bin/notegit.js', import.meta.url).pathname

// 指引中的命令原文（结构面锚点 = 行为面执行形态，两面对照）
const CMD_LOGIN = 'notegit login <服务器地址> --username <员工用户名>'
const CMD_LS = 'notegit ls --json'
const CMD_SYNC = 'notegit sync'

// ── A) 结构面：指引存在且含关键锚点 ─────────────────────────────────────────

test('指引存在：docs/harness/README.md（S7-T8 主指引）', () => {
  assert.ok(existsSync(GUIDE), `缺 ${GUIDE}——S7-T8 交付物（主指引文档）`)
})

test('指引结构：本地/托管两节 + 实例工作流记录与引用格式三要素（库/路径/commit）', () => {
  const doc = readFileSync(GUIDE, 'utf8')
  assert.ok(doc.includes('## 本地 Harness'), '缺「## 本地 Harness」节')
  assert.ok(doc.includes('## 托管 Harness'), '缺「## 托管 Harness」节')
  assert.ok(doc.includes('实例工作流记录'), '缺实例工作流记录节')
  assert.ok(doc.includes('库/路径/commit'), '缺引用格式三要素（库/路径/commit，对齐 S5-T6/架构 §7.1）')
})

test('指引结构：本地节含安装与主线命令原文（login/ls/sync）及环境要求', () => {
  const doc = readFileSync(GUIDE, 'utf8')
  assert.ok(doc.includes('npm install -g notegit-<version>.tgz'), '缺单 tarball 安装命令（与 cli/README 安装节一致）')
  assert.ok(doc.includes(CMD_LOGIN), `缺命令原文：${CMD_LOGIN}`)
  assert.ok(doc.includes(CMD_LS), `缺命令原文：${CMD_LS}`)
  assert.ok(doc.includes(CMD_SYNC), `缺命令原文：${CMD_SYNC}`)
  assert.ok(doc.includes('Node ≥ 22.13'), '缺 Node ≥ 22.13 环境要求（selection §6）')
  for (const v of ['NOTEGIT_SERVER', 'NOTEGIT_TOKEN', 'NOTEGIT_LOCAL_ROOT', 'NOTEGIT_CREDENTIALS_FILE']) {
    assert.ok(doc.includes(v), `缺环境变量 ${v}（与 cli 文档一致）`)
  }
  assert.ok(doc.includes('~/knowbase'), '缺本地根目录默认 ~/knowbase（架构 §7.2）')
})

test('指引结构：托管节含启动/初始化真实参数与按员工隔离表述（§7.2 为准，指向 S7-T7 手册）', () => {
  const doc = readFileSync(GUIDE, 'utf8')
  assert.ok(doc.includes('NOTEGIT_DATA_DIR'), '缺 NOTEGIT_DATA_DIR（server 启动数据目录）')
  assert.ok(doc.includes('/data'), '缺缺省数据目录 /data（server/src/main.ts DEFAULT_DATA_DIR）')
  assert.ok(doc.includes('admin-bootstrap.token'), '缺 bootstrap token 文件路径（config/admin-bootstrap.token）')
  assert.ok(doc.includes('不共享'), '缺「可写工作目录不共享」表述（架构 §7.2）')
  assert.ok(doc.includes('S7-T7'), '缺 S7-T7 托管隔离手册指引（并行任务，详规以其为准）')
})

test('指引结构：负载数据点指针（.agents/notes/2026-10-13-S7-T8-load.md，数据交 S8-T8）', () => {
  const doc = readFileSync(GUIDE, 'utf8')
  assert.ok(doc.includes('.agents/notes/2026-10-13-S7-T8-load.md'), '缺负载数据记录指针')
  assert.ok(doc.includes('S8-T8'), '缺「数据交 S8-T8 收口」说明（selection §7 量化链）')
})

// ── B) 行为面：按指引步骤对真实实例走通 ─────────────────────────────────────

let root: string
let inst: RealInstance
let aliceToken: string
let env: Record<string, string>
let seedHead: string

const SLUG = 'v-handbook'
const DOC_PATH = 'docs/getting-started.md'
const DOC_CONTENT = '---\ntitle: 起步\n---\n\n# 起步\n\n第一条知识。\n'

/** 异步跑 dist 产物 CLI（对在听实例的调用绝不可 sync spawn——S6 教训）。 */
function runBin(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')))
    child.on('error', () => resolve({ status: null, stdout, stderr }))
    child.on('close', (code) => resolve({ status: code, stdout, stderr }))
  })
}

before(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'ngt-harness-'))
  // 指引·托管节步骤：启动测试实例（NOTEGIT_DATA_DIR 指向独立数据目录）+ 管理员初始化
  inst = await bootRealInstance(path.join(root, 'data'))
  // 指引·托管节步骤：邀请员工（一次性口令重置令牌 → 员工设口令）
  const alice = await createEmployee(inst, 'alice')
  // 指引·托管节步骤：员工登录网页凭据页创建访问令牌（ngt_，明文仅此一次）
  aliceToken = await createCredentialFor(inst, alice.username, alice.password)
  // 指引·托管节步骤：建库 + 授权（writer）
  await createVault(inst, SLUG, '员工手册', [{ username: alice.username, role: 'editor' }])
  // 指引·托管节步骤：首批内容（README 免 frontmatter；知识文档带 title）经 pre-receive 校验入库
  const seeded = await seedVaultContent(inst.baseUrl, SLUG, aliceToken, [
    { path: 'README.md', content: '# 员工手册\n\n导航：docs/getting-started.md\n' },
    { path: DOC_PATH, content: DOC_CONTENT },
  ])
  seedHead = seeded.head

  // 指引·本地节步骤：员工电脑侧环境（凭据文件/根目录隔离到临时 HOME）
  env = { ...process.env } as Record<string, string>
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
})

after(async () => {
  await inst.close()
  rmSync(root, { recursive: true, force: true })
})

test('本地步骤：login 免交互成功（token 经环境变量），输出掩码不泄漏明文', async () => {
  const r = await runBin(['login', inst.baseUrl, '--username', 'alice'])
  assert.equal(r.status, 0, `login 应退出 0，stderr：${r.stderr}`)
  assert.ok(!r.stdout.includes(aliceToken) && !r.stderr.includes(aliceToken), 'login 输出不得含完整 token')
})

test('本地步骤：ls --json 列出授权库且本地状态 not_cloned（同步前）', async () => {
  const r = await runBin(['ls', '--json'])
  assert.equal(r.status, 0, `ls 应退出 0，stderr：${r.stderr}`)
  const doc = JSON.parse(r.stdout) as { vaults: Array<{ slug: string; local: { status: string } }> }
  const v = doc.vaults.find((x) => x.slug === SLUG)
  assert.ok(v !== undefined, `ls 应列出 ${SLUG}：${r.stdout}`)
  assert.equal(v.local.status, 'not_cloned')
})

test('本地步骤：sync 完整克隆到 <根>/<slug>，HEAD 与服务端种子一致', async () => {
  const r = await runBin(['sync'])
  assert.equal(r.status, 0, `sync 应退出 0，stderr：${r.stderr}`)
  const head = readFileSync(path.join(root, 'knowbase', SLUG, '.git', 'HEAD'), 'utf8').trim()
  void head // 上述读取只证明是 git 仓库；HEAD 一致性用 git rev-parse 核对
  const { git } = await import('../test-support/real-instance.ts')
  const rev = await git(path.join(root, 'knowbase', SLUG), 'rev-parse', 'HEAD')
  assert.equal(rev.status, 0, 'rev-parse 应成功')
  assert.equal(rev.stdout.trim(), seedHead, '克隆 HEAD 应等于服务端种子提交')
})

test('本地步骤：再 sync 报 up_to_date（幂等，无重复克隆）', async () => {
  const r = await runBin(['sync', '--json'])
  assert.equal(r.status, 0, `sync 应退出 0，stderr：${r.stderr}`)
  const doc = JSON.parse(r.stdout) as { vaults: Array<{ slug: string; reason_code: string }> }
  assert.equal(doc.vaults.find((x) => x.slug === SLUG)?.reason_code, 'up_to_date')
})

test('引用格式：库/路径/commit 三要素可取回并核对内容（对齐 S5-T6/架构 §7.1）', async () => {
  // 引用 = 库/路径/commit：v-handbook / docs/getting-started.md / <seedHead>
  const cited = readFileSync(path.join(root, 'knowbase', SLUG, DOC_PATH), 'utf8')
  assert.equal(cited, DOC_CONTENT, '引用指向的工作副本内容应与种子一致')
  const { git } = await import('../test-support/real-instance.ts')
  const show = await git(path.join(root, 'knowbase', SLUG), 'show', `${seedHead}:${DOC_PATH}`)
  assert.equal(show.status, 0, `git show ${seedHead}:${DOC_PATH} 应成功`)
  assert.equal(show.stdout, DOC_CONTENT, '引用 commit 处的该路径内容应可解析（对应 Web 历史）')
})
