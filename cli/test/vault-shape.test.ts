import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'

// 服务端响应形态收窄的单元 + 行为层测试（CLI 消费服务端响应的唯一收窄点）。
//
// 背景：GET /api/v1/vaults 的 slug/default_branch 此前零校验，直接进入本地路径
// 拼接与 git 实参（git clone <url> <dir> / git fetch <url> <branch>）→ 恶意或被
// 攻陷的服务端可把攻击者控制的文件树写到同步根之外（登录持久化 RCE）。
// 本文件钉死：形态判定函数口径 + 摄入面 fail-closed + 消费面纵深防御。
import { isSafeBranchName, isSafeVaultSlug, safeVaultDir } from '../src/vault-shape.ts'
import { fetchVaults } from '../src/ls/api.ts'
import { applySyncStrategy, type SyncOps } from '../src/sync/engine.ts'

// ── isSafeVaultSlug：库标识形态（单个路径段；服务端 api.md §5 的 slug 契约） ──

test('isSafeVaultSlug：接受服务端合法形态（单段字母数字连字符，含前导连字符）', () => {
  assert.equal(isSafeVaultSlug('alpha'), true)
  assert.equal(isSafeVaultSlug('a-b-1'), true)
  assert.equal(isSafeVaultSlug('-lead'), true, '前导连字符是服务端合法形态，不得误拒')
  assert.equal(isSafeVaultSlug('ALPHA'), true)
})

test('isSafeVaultSlug：拒绝路径穿越与任何非单段形态', () => {
  for (const bad of [
    '../../Library/LaunchAgents',
    '..',
    '.',
    'a/b',
    'a\\b',
    'a.b',
    'a b',
    '',
    'a\u0000b',
    'a\nb',
    'a;b',
    'a$b',
    'a~b',
    'a:b',
    'a*b',
    'a?b',
    'a[b',
    'a%2e%2e',
  ]) {
    assert.equal(isSafeVaultSlug(bad), false, `应拒绝：${JSON.stringify(bad)}`)
  }
})

test('isSafeVaultSlug：长度上限 64（超长拒绝、64 接受）', () => {
  assert.equal(isSafeVaultSlug('a'.repeat(64)), true)
  assert.equal(isSafeVaultSlug('a'.repeat(65)), false)
})

// ── isSafeBranchName：默认分支形态（git 实参注入面） ──────────────────────────

test('isSafeBranchName：接受 git 可接受的常规分支名', () => {
  assert.equal(isSafeBranchName('main'), true)
  assert.equal(isSafeBranchName('master'), true)
  assert.equal(isSafeBranchName('release/1.0'), true)
  assert.equal(isSafeBranchName('feature_x.1'), true)
})

test('isSafeBranchName：拒绝以 - 开头（git 实参注入）、含 .. / 空格 / refspec 记号 / 空串 / 控制字符', () => {
  for (const bad of [
    '-c core.sshCommand=x',
    '--upload-pack=evil',
    'a..b',
    '..',
    'a b',
    'a:b',
    'a~b',
    'a^b',
    'a?b',
    'a*b',
    'a[b',
    'a\\b',
    '',
    'a\nb',
    'a\u0000b',
  ]) {
    assert.equal(isSafeBranchName(bad), false, `应拒绝：${JSON.stringify(bad)}`)
  }
})

// ── safeVaultDir：库目录不得越出同步根（纵深防御第二道） ──────────────────────

test('safeVaultDir：合法 slug → 根下的目录路径', () => {
  assert.equal(safeVaultDir('/tmp/root', 'alpha'), path.resolve('/tmp/root/alpha'))
})

test('safeVaultDir：越界路径 → null（路径穿越、等于根本身）', () => {
  assert.equal(safeVaultDir('/tmp/root', '../../evil'), null)
  assert.equal(safeVaultDir('/tmp/root', '..'), null)
  assert.equal(safeVaultDir('/tmp/root', '.'), null)
  assert.equal(safeVaultDir('/tmp/root', ''), null)
})

// ── 摄入面：GET /api/v1/vaults 的形态收窄（fail-closed：一条不合法 → 整份拒绝） ──

let apiServer: http.Server
let serverUrl = ''
/** 当前服务器将返回的 vaults 载荷（逐测试改写）。 */
let vaultsPayload: unknown[] = []

before(async () => {
  apiServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ vaults: vaultsPayload }))
  })
  await new Promise<void>((resolve) => apiServer.listen(0, '127.0.0.1', resolve))
  serverUrl = `http://127.0.0.1:${(apiServer.address() as { port: number }).port}`
})

after(async () => {
  await new Promise<void>((resolve) => apiServer.close(() => resolve()))
})

function item(slug: string, defaultBranch = 'main'): Record<string, unknown> {
  return { slug, name: '库', role: 'admin', default_branch: defaultBranch, main_admin_only: false }
}

test('摄入面：恶意 slug（路径穿越）→ 整份响应按契约形态错误拒绝（不静默丢条目）', async () => {
  vaultsPayload = [item('../../Library/LaunchAgents')]
  const res = await fetchVaults({ server: serverUrl, token: 'ngt_x' })
  assert.equal(res.ok, false)
  assert.equal(res.ok === false && res.kind, 'shape')
  assert.match(res.ok === false ? res.message : '', /slug|库标识/)
})

test('摄入面：恶意 default_branch（git 实参注入形态）→ 契约形态错误拒绝', async () => {
  vaultsPayload = [item('alpha', '-c core.sshCommand=evil')]
  const res = await fetchVaults({ server: serverUrl, token: 'ngt_x' })
  assert.equal(res.ok, false)
  assert.equal(res.ok === false && res.kind, 'shape')
  assert.match(res.ok === false ? res.message : '', /分支/)
})

test('摄入面：混入一条非法条目 → 整份列表拒绝（fail-closed）', async () => {
  vaultsPayload = [item('alpha'), item('beta/../../evil')]
  const res = await fetchVaults({ server: serverUrl, token: 'ngt_x' })
  assert.equal(res.ok, false)
  assert.equal(res.ok === false && res.kind, 'shape')
})

test('摄入面：合法列表 → 正常放行（收窄不得误伤正常库）', async () => {
  vaultsPayload = [item('alpha'), item('beta', 'release/1.0')]
  const res = await fetchVaults({ server: serverUrl, token: 'ngt_x' })
  assert.equal(res.ok, true)
  assert.equal(res.ok === true && res.vaults.length, 2)
})

// ── 消费面：纵深防御（恶意 slug 不得触发 clone 到越界路径） ──────────────────

const SHA1 = '1111111111111111111111111111111111111111'

/** 记录调用的 SyncOps 假件。 */
function fakeOps(calls: string[]): SyncOps {
  return {
    clone: async (_url, dir) => {
      calls.push(`clone:${dir}`)
    },
    fastForward: async (dir) => {
      calls.push(`fastForward:${dir}`)
    },
    revHead: async () => SHA1,
  }
}

test('消费面：恶意 slug + new 态 → 不调用 clone（不得写到同步根之外），outcome 为 failed', async () => {
  const calls: string[] = []
  const out = await applySyncStrategy({
    root: '/tmp/root',
    slug: '../../evil',
    cloneUrl: 'https://s/git/x.git',
    defaultBranch: 'main',
    info: { state: 'new', path: null, branch: null, head: null, remote_tip: null, message: null },
    ops: fakeOps(calls),
  })
  assert.deepEqual(calls, [], '恶意 slug 不得触发任何 git 变更操作')
  assert.equal(out.action, 'failed')
  assert.equal(out.action === 'failed' ? out.path : 'x', null)
  assert.equal(out.action === 'failed' ? out.code : 'x', 'status_error')
  assert.match(out.action === 'failed' ? out.message : '', /形态不合法/)
})

test('消费面：合法 slug + new 态 → 正常克隆到根下目录（纵深防御不得误伤正常路径）', async () => {
  const calls: string[] = []
  const out = await applySyncStrategy({
    root: '/tmp/root',
    slug: 'alpha',
    cloneUrl: 'https://s/git/alpha.git',
    defaultBranch: 'main',
    info: { state: 'new', path: null, branch: null, head: null, remote_tip: null, message: null },
    ops: fakeOps(calls),
  })
  assert.deepEqual(calls, [`clone:${path.resolve('/tmp/root/alpha')}`])
  assert.equal(out.action, 'cloned')
})
