import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { startMockServer, type MockServer, type MockVault } from '../test-support/mock-server.ts'

// S7-T5 黑盒层：撤权标记与显式清理（验收场景 S5：404→标记→清理遇改动拒绝）。
// 真实 git + mock Smart HTTP（撤权 = 删掉服务端 bare 仓库 → git 通道 404，identity
// §5.2；列表仍含该库模拟「列表快照后撤权」的竞态窗——列表移除路径另测）。
// 四组断言：① 404→标记+报告（skipped/revoked，副本不动）；② clean 默认只清理已
// 标记库、遇改动/未推送拒绝并给导出指引、--force 强制删除并警示；③ 撤权后恢复
// 权限 → 下次 sync 恢复更新且 revoked 位清除；④ revoked ∈ skipped reason_code
// （--json 契约）。状态文件断言直读 <root>/.notegit/sync-state.json。
const BIN = new URL('../dist/bin/notegit.js', import.meta.url).pathname
const FAKE_TOKEN = 'ngt_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE'
const FAKE_USERNAME = 'sync-revoked-user'

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
  projectRoot: string
  worksRoot: string
  serverUrl: string
  server: MockServer
  shas: Record<string, string>
  env: Record<string, string>
  dispose: () => Promise<void>
}

/**
 * 撤权世界：seed + 直接克隆 r-gone 与 r-ok → login → sync #1（双双 up_to_date，
 * 状态条目落地 revoked:false）。测试随后删 r-gone 的 bare 模拟撤权（git 通道 404）。
 */
async function revokedWorld(): Promise<World> {
  const home = await mkdtemp(path.join(tmpdir(), 'ngt-syncrev-home-'))
  const localRoot = await mkdtemp(path.join(tmpdir(), 'ngt-syncrev-local-'))
  const projectRoot = path.join(home, 'vaults')
  const worksRoot = path.join(home, 'works')
  await mkdir(projectRoot, { recursive: true })
  await mkdir(worksRoot, { recursive: true })
  const shas: Record<string, string> = {}
  for (const slug of ['r-gone', 'r-ok']) {
    const v = await seedVault(projectRoot, worksRoot, slug)
    shas[slug] = v.sha
    git(localRoot, 'clone', '--quiet', v.bare, path.join(localRoot, slug))
  }
  const vaults: MockVault[] = ['r-gone', 'r-ok'].map((slug) => ({
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
  const first = await run(['sync'], env)
  assert.equal(first.status, 0, `sync #1 应全成功，stderr：${first.stderr}`)
  return {
    home,
    localRoot,
    projectRoot,
    worksRoot,
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

/** 撤权动作：删除服务端 bare（git 通道从此 404；列表仍含该库 = 模拟列表快照后撤权）。 */
async function revoke(w: World, slug: string): Promise<void> {
  await rm(path.join(w.projectRoot, `${slug}.git`), { recursive: true, force: true })
}

interface StateDoc {
  vaults: Record<string, { head: string | null; last_sync: string | null; revoked: boolean }>
}

async function readState(w: World): Promise<StateDoc> {
  return JSON.parse(await readFile(path.join(w.localRoot, '.notegit', 'sync-state.json'), 'utf8')) as StateDoc
}

// ── ① 撤权检测：fetch 收 404 → 标记 + 报告（skipped/revoked），副本不动 ────────

test('撤权标记：fetch 404 → --json 报 skipped/revoked（exit 0），状态位置位，副本逐字节不动', async () => {
  const w = await revokedWorld()
  try {
    await revoke(w, 'r-gone')
    const r = await run(['sync', '--json'], w.env)
    assert.equal(r.status, 0, '跳过不判失败（撤权是预期后果，不是错误）')
    const doc = JSON.parse(r.stdout) as {
      vaults: Array<Record<string, unknown> & { slug: string; status: string; reason_code: string }>
      summary: { total: number; success: number; skipped: number; failed: number }
    }
    const gone = doc.vaults.find((v) => v.slug === 'r-gone')!
    assert.equal(gone.status, 'skipped')
    assert.equal(gone.reason_code, 'revoked', '④ revoked ∈ skipped reason_code（契约域扩展）')
    assert.match(String(gone['reason']), /404|撤权/)
    assert.equal(gone['head'], w.shas['r-gone'], '离线副本 head 如实上报')
    assert.match(String(gone['last_sync']), /^\d{4}-\d{2}-\d{2}T/, '上次同步时间携带（sync #1 建立）')
    assert.equal(doc.summary.failed, 0, '不得把撤权跳过报成失败')
    const ok = doc.vaults.find((v) => v.slug === 'r-ok')!
    assert.equal(ok.status, 'success', '其他库不受影响（identity §5.2）')

    const state = await readState(w)
    assert.equal(state.vaults['r-gone']?.revoked, true, '状态文件 revoked 位置位（clean 命令的消费依据）')
    assert.equal(state.vaults['r-ok']?.revoked, false, '未撤权库不置位')

    assert.equal(rev(path.join(w.localRoot, 'r-gone'), 'HEAD'), w.shas['r-gone'], '副本 HEAD 不动')
    assert.equal(await readFile(path.join(w.localRoot, 'r-gone', 'f0.md'), 'utf8'), `# r-gone note\n`, '副本字节不动（不自动删）')
  } finally {
    await w.dispose()
  }
})

test('撤权标记：文本通道 stderr 报「跳过——撤权」行，汇总如实计数（成功 1、跳过 1、失败 0）', async () => {
  const w = await revokedWorld()
  try {
    await revoke(w, 'r-gone')
    const r = await run(['sync'], w.env)
    assert.equal(r.status, 0)
    assert.match(r.stderr, /r-gone：跳过——.*(404|撤权)/)
    assert.match(r.stdout, /r-ok：已是最新/)
    assert.match(r.stdout, /成功 1、跳过 1、失败 0/)
  } finally {
    await w.dispose()
  }
})

// ── 标记库不参与后续自动更新：列表移除后不再上报（标记留存 + 孤儿提示） ─────────

test('撤权后列表移除：sync 不再上报该库（不参与自动更新），标记留存，孤儿目录提示权限有变', async () => {
  const w = await revokedWorld()
  try {
    await revoke(w, 'r-gone')
    await run(['sync'], w.env) // 置位 revoked
    w.server.state.vaults = w.server.state.vaults!.filter((v) => v.slug !== 'r-gone') // identity §5.2：列表实时反映权限
    const r = await run(['sync', '--json'], w.env)
    assert.equal(r.status, 0)
    const doc = JSON.parse(r.stdout) as { vaults: Array<{ slug: string }> }
    assert.ok(!doc.vaults.some((v) => v.slug === 'r-gone'), '撤权库不再出现在报告（不参与自动更新）')
    const state = await readState(w)
    assert.equal(state.vaults['r-gone']?.revoked, true, '标记留存（clean 仍可消费）')
    assert.match(r.stderr, /不对应当前任何可见库/, '孤儿目录提示（slug 可能已改名或权限有变）')
    assert.match(r.stderr, /r-gone/, '提示指向被撤权副本目录')
  } finally {
    await w.dispose()
  }
})

// ── ② sync clean：默认只清理已标记库；遇改动/未推送拒绝并给导出指引；--force 强制 ──

test('clean 默认：干净且已全部推送的标记库被清理（目录删除、条目移除）；未标记库不动', async () => {
  const w = await revokedWorld()
  try {
    await revoke(w, 'r-gone')
    await run(['sync'], w.env) // 置位
    const r = await run(['sync', 'clean'], w.env)
    assert.equal(r.status, 0, '安全清理应成功')
    assert.match(r.stdout, /r-gone：已清理/, '清理行（stdout）')
    assert.equal(existsSync(path.join(w.localRoot, 'r-gone')), false, '本地副本已删除')
    const state = await readState(w)
    assert.equal(state.vaults['r-gone'], undefined, '状态条目随清理移除')
    assert.equal(state.vaults['r-ok']?.revoked, false, '未标记库条目保留')
    assert.equal(existsSync(path.join(w.localRoot, 'r-ok')), true, '未标记库目录不动')

    const again = await run(['sync', 'clean'], w.env)
    assert.equal(again.status, 0, '无标记库时退出 0')
    assert.match(again.stdout, /没有已标记撤权的库/, '空目标提示')
  } finally {
    await w.dispose()
  }
})

test('clean 拒绝·脏工作区：拒绝删除 + 导出指引（bundle/复制），副本与标记保留，退出码 1', async () => {
  const w = await revokedWorld()
  try {
    await revoke(w, 'r-gone')
    await run(['sync'], w.env) // 置位
    await writeFile(path.join(w.localRoot, 'r-gone', 'f0.md'), '# 本地未提交修改（不可被清理丢弃）\n')
    const r = await run(['sync', 'clean'], w.env)
    assert.equal(r.status, 1, '存在拒绝 → 非零（目标未达成）')
    assert.match(r.stderr, /r-gone：拒绝清理——.*未提交修改/)
    assert.match(r.stderr, /bundle create/, '导出指引给出 git bundle 命令')
    assert.match(r.stderr, /复制/, '导出指引给出整目录复制备选')
    assert.equal(existsSync(path.join(w.localRoot, 'r-gone')), true, '副本保留（不自动删——D7 同源红线）')
    assert.equal(await readFile(path.join(w.localRoot, 'r-gone', 'f0.md'), 'utf8'), '# 本地未提交修改（不可被清理丢弃）\n', '改动字节保留')
    const state = await readState(w)
    assert.equal(state.vaults['r-gone']?.revoked, true, '标记保留（问题未解决前不摘牌）')
  } finally {
    await w.dispose()
  }
})

test('clean 拒绝·未推送提交 → 拒绝；--force 强制删除并警示（选型落地），退出码 0', async () => {
  const w = await revokedWorld()
  try {
    await revoke(w, 'r-gone')
    await run(['sync'], w.env) // 置位
    const local = await localCommit(path.join(w.localRoot, 'r-gone'), 'local-work')
    const refuse = await run(['sync', 'clean'], w.env)
    assert.equal(refuse.status, 1)
    assert.match(refuse.stderr, /r-gone：拒绝清理——.*(未推送|领先)/)
    assert.equal(rev(path.join(w.localRoot, 'r-gone'), 'HEAD'), local, '领先提交保留')

    const force = await run(['sync', 'clean', '--force'], w.env)
    assert.equal(force.status, 0, '强制清理达成目标 → 0')
    assert.match(force.stderr, /r-gone：强制清理——/, '强制删除的警示行（stderr）')
    assert.match(force.stderr, /未推送|领先/, '警示说明丢弃了什么')
    assert.equal(existsSync(path.join(w.localRoot, 'r-gone')), false, '--force 下副本被删除')
    const state = await readState(w)
    assert.equal(state.vaults['r-gone'], undefined, '条目随之移除')
  } finally {
    await w.dispose()
  }
})

test('clean 用法：未知选项与位置参数 → 退出码 2（不产生清理动作）', async () => {
  const w = await revokedWorld()
  try {
    const bad = await run(['sync', 'clean', '--bogus'], w.env)
    assert.equal(bad.status, 2)
    assert.ok(bad.stderr.length > 0)
    const pos = await run(['sync', 'clean', 'r-gone'], w.env)
    assert.equal(pos.status, 2, '不接受位置参数（清理范围只认状态标记，不手点库）')
    assert.equal(existsSync(path.join(w.localRoot, 'r-gone')), true, '用法错误不得动任何目录')
  } finally {
    await w.dispose()
  }
})

// ── ③ 撤权后恢复权限（管理员重新授权）：下次 sync 恢复更新，revoked 位清除 ──────

test('恢复权限：远端重新可访问 → sync 恢复正常更新（success），revoked 位清除', async () => {
  const w = await revokedWorld()
  try {
    await revoke(w, 'r-gone')
    const marked = await run(['sync', '--json'], w.env)
    assert.equal(marked.status, 0)
    assert.equal((await readState(w)).vaults['r-gone']?.revoked, true, '前置：已置位')

    // 管理员重新授权：服务端库重新可见（bare 重建，同一历史）
    git(w.worksRoot, 'clone', '--quiet', '--bare', path.join(w.worksRoot, 'r-gone'), path.join(w.projectRoot, 'r-gone.git'))
    const r = await run(['sync', '--json'], w.env)
    assert.equal(r.status, 0)
    const doc = JSON.parse(r.stdout) as { vaults: Array<{ slug: string; status: string; reason_code: string }> }
    const gone = doc.vaults.find((v) => v.slug === 'r-gone')!
    assert.equal(gone.status, 'success', '恢复后正常同步')
    assert.equal(gone.reason_code, 'up_to_date', '同一历史 → 已是最新')
    assert.equal((await readState(w)).vaults['r-gone']?.revoked, false, 'revoked 位清除（重新可见即恢复资格）')
  } finally {
    await w.dispose()
  }
})
