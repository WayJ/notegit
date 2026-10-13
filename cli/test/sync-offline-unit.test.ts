import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { once } from 'node:events'

// S7-T6 单元层：断网三态（无法连接/超时/HTTP 错误码 → net_unreachable/timeout/
// http_error）经引擎 outcome 的 reason_code 与可读 message 断言（分类表用真实
// git stderr 形态作夹具，从 applySyncStrategy 公共缝驱动——分类函数本身是内部
// 实现细节）；失败库存在可读本地 HEAD 时 message 携带「离线副本 …（可能过期），
// 上次同步 …」明示（架构 §7.1）；克隆失败清理半成品目录（库内原子性）；
// NOTEGIT_SYNC_TIMEOUT_MS 超时注入缝。黑盒断网 e2e 见 sync-offline.test.ts。
import { applySyncStrategy, realSyncOps, type SyncOps } from '../src/sync/engine.ts'
import type { SyncInfo } from '../src/ls/local-status.ts'
import { lastSyncMarkerPath } from '../src/sync/last-sync.ts'

const SHA1 = '1111111111111111111111111111111111111111'
const SHA2 = '2222222222222222222222222222222222222222'
const TS = '2026-10-13T08:00:00.000Z'

/** 可编排变更 ops：clone/fastForward 按脚本抛错，revHead 可脚本化（清理守卫用）。 */
function fakeSyncOps(script: { cloneErr?: Error; ffErr?: Error; head?: string; cloneSideEffect?: (dir: string) => Promise<void> }): SyncOps {
  return {
    clone: async (_url, dir) => {
      if (script.cloneSideEffect !== undefined) await script.cloneSideEffect(dir)
      if (script.cloneErr !== undefined) throw script.cloneErr
    },
    fastForward: async () => {
      if (script.ffErr !== undefined) throw script.ffErr
    },
    revHead: async () => script.head,
  }
}

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'notegit-sync-offline-unit-'))
  try {
    await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const NEW_INFO: SyncInfo = { state: 'new', path: null, branch: null, head: null, remote_tip: null, message: null }

function cleanInfo(dir: string): SyncInfo {
  return { state: 'clean', path: dir, branch: 'main', head: SHA1, remote_tip: SHA2, message: null }
}

// ── 断网三态分类（真实 git stderr 形态 → failed reason_code + 可读 message） ──

interface ClassCase {
  readonly name: string
  readonly stderr: string
  readonly code: 'net_unreachable' | 'timeout' | 'http_error'
  readonly messageRe: RegExp
}

const CLONE_CLASS_CASES: readonly ClassCase[] = [
  {
    name: '连接被拒（Failed to connect / Connection refused）→ net_unreachable',
    stderr: "fatal: unable to access 'http://127.0.0.1:9/git/alpha.git/': Failed to connect to 127.0.0.1 port 9: Connection refused",
    code: 'net_unreachable',
    messageRe: /克隆失败：无法连接服务器（.*Connection refused）/,
  },
  {
    name: '域名不可解析（Could not resolve host）→ net_unreachable',
    stderr: "fatal: unable to access 'http://no.such.host.invalid/git/alpha.git/': Could not resolve host: no.such.host.invalid",
    code: 'net_unreachable',
    messageRe: /克隆失败：无法连接服务器（.*Could not resolve host/,
  },
  {
    name: '连接被重置（recv failure: Connection reset by peer）→ net_unreachable',
    stderr: "fatal: unable to access 'http://127.0.0.1:1/git/alpha.git/': recv failure: Connection reset by peer",
    code: 'net_unreachable',
    messageRe: /克隆失败：无法连接服务器（.*recv failure/,
  },
  {
    name: 'HTTP 500（The requested URL returned error: 500）→ http_error',
    stderr: "fatal: unable to access 'http://127.0.0.1:1/git/alpha.git/': The requested URL returned error: 500",
    code: 'http_error',
    messageRe: /克隆失败：服务器 HTTP 错误 500（.*returned error: 500）/,
  },
  {
    name: 'HTTP 404（撤权形态，S7-T5 将消费）→ http_error',
    stderr: "fatal: unable to access 'http://127.0.0.1:1/git/alpha.git/': The requested URL returned error: 404",
    code: 'http_error',
    messageRe: /克隆失败：服务器 HTTP 错误 404（.*returned error: 404）/,
  },
  {
    name: '连接超时（Connection timed out）→ timeout',
    stderr: "fatal: unable to access 'http://10.255.255.1/git/alpha.git/': Failed to connect to 10.255.255.1 port 80: Connection timed out",
    code: 'timeout',
    messageRe: /克隆失败：网络操作超时（.*timed out）/,
  },
  {
    name: 'CLI 侧超时终止（NOTEGIT_SYNC_TIMEOUT_MS 注入形态）→ timeout',
    stderr: '网络操作超时（git clone 超过 1500 ms 上限）',
    code: 'timeout',
    messageRe: /克隆失败：网络操作超时（git clone 超过 1500 ms 上限）/,
  },
]

for (const c of CLONE_CLASS_CASES) {
  test(`断网分类·克隆路径：${c.name}`, async () => {
    await withRoot(async (root) => {
      const out = await applySyncStrategy({
        root,
        slug: 'alpha',
        cloneUrl: 'http://127.0.0.1:1/git/alpha.git',
        defaultBranch: 'main',
        info: NEW_INFO,
        ops: fakeSyncOps({ cloneErr: new Error(c.stderr) }),
        syncedAt: TS,
      })
      assert.equal(out.action, 'failed')
      assert.equal(out.code, c.code, `reason_code 应为 ${c.code}，message：${'message' in out ? out.message : ''}`)
      assert.ok('message' in out && c.messageRe.test(out.message), `message 应可读且含类别信息：${'message' in out ? out.message : ''}`)
      // 新库无离线副本可指——失败 message 不得携带离线副本提示
      assert.ok(!('message' in out && out.message.includes('可能过期')), '新库失败不得声称「可能过期」的离线副本（无副本）')
    })
  })
}

test('断网分类·非网络失败不误判：destination path already exists → clone_failed（透传首行）', async () => {
  await withRoot(async (root) => {
    const out = await applySyncStrategy({
      root,
      slug: 'alpha',
      cloneUrl: 'http://127.0.0.1:1/git/alpha.git',
      defaultBranch: 'main',
      info: NEW_INFO,
      ops: fakeSyncOps({ cloneErr: new Error("fatal: destination path 'alpha' already exists and is not an empty directory.") }),
      syncedAt: TS,
    })
    assert.equal(out.action, 'failed')
    assert.equal(out.code, 'clone_failed', '非网络失败保持既有原因码')
    assert.ok('message' in out && out.message.includes('already exists'), 'message 透传 git 首行')
  })
})

// ── 离线副本明示（架构 §7.1）：有可读本地 HEAD 的失败携带 commit + 上次同步 ──

test('快进失败（HTTP 503）：message 携带离线副本 commit（可能过期）与 .git 标记的上次同步时间', async () => {
  await withRoot(async (root) => {
    const dir = path.join(root, 'alpha')
    await mkdir(path.join(dir, '.git'), { recursive: true })
    await writeFile(lastSyncMarkerPath(dir), `${TS}\n`, 'utf8')
    const out = await applySyncStrategy({
      root,
      slug: 'alpha',
      cloneUrl: 'http://127.0.0.1:1/git/alpha.git',
      defaultBranch: 'main',
      info: cleanInfo(dir),
      ops: fakeSyncOps({ ffErr: new Error("fatal: unable to access 'http://s/git/alpha.git/': The requested URL returned error: 503") }),
      syncedAt: TS,
    })
    assert.equal(out.action, 'failed')
    assert.equal(out.code, 'http_error')
    assert.ok('message' in out)
    assert.match(out.message, /快进失败：服务器 HTTP 错误 503（/)
    assert.match(out.message, new RegExp(`离线副本 ${SHA1.slice(0, 7)}（可能过期），上次同步 ${TS.replace(/[.]/g, '\\.')}`), '失败须明示离线副本 commit 与同步时间（§7.1）')
  })
})

test('快进失败（无法连接）：从未经 notegit 同步 → 上次同步「未知（该副本未经 notegit 同步）」', async () => {
  await withRoot(async (root) => {
    const dir = path.join(root, 'alpha')
    await mkdir(path.join(dir, '.git'), { recursive: true })
    const out = await applySyncStrategy({
      root,
      slug: 'alpha',
      cloneUrl: 'http://127.0.0.1:1/git/alpha.git',
      defaultBranch: 'main',
      info: cleanInfo(dir),
      ops: fakeSyncOps({ ffErr: new Error("fatal: unable to access 'http://s/git/alpha.git/': Failed to connect to 127.0.0.1 port 9: Connection refused") }),
      syncedAt: TS,
    })
    assert.equal(out.action, 'failed')
    assert.equal(out.code, 'net_unreachable')
    assert.ok('message' in out)
    assert.match(out.message, /离线副本 1111111（可能过期），上次同步 未知（该副本未经 notegit 同步）/)
  })
})

test('判定面失败（获取远端失败）且本地 HEAD 可读：status_error message 追加离线副本明示', async () => {
  await withRoot(async (root) => {
    const dir = path.join(root, 'alpha')
    await mkdir(path.join(dir, '.git'), { recursive: true })
    await writeFile(lastSyncMarkerPath(dir), `${TS}\n`, 'utf8')
    const out = await applySyncStrategy({
      root,
      slug: 'alpha',
      cloneUrl: 'http://127.0.0.1:1/git/alpha.git',
      defaultBranch: 'main',
      info: { state: 'error', path: dir, branch: 'main', head: SHA1, remote_tip: null, message: '获取远端失败（网络或权限）：http://127.0.0.1:1/git/alpha.git' },
      ops: fakeSyncOps({}),
      syncedAt: TS,
    })
    assert.equal(out.action, 'failed')
    assert.equal(out.code, 'status_error', '判定面失败码不变（分类属变更面）；断网语义由 message 明示')
    assert.ok('message' in out)
    assert.match(out.message, /获取远端失败（网络或权限）/)
    assert.match(out.message, new RegExp(`离线副本 ${SHA1.slice(0, 7)}（可能过期），上次同步 ${TS.replace(/[.]/g, '\\.')}`))
  })
})

test('判定面失败但本地 HEAD 不可读（如非 git 目录）：message 保持原样，不携带离线副本提示', async () => {
  await withRoot(async (root) => {
    const dir = path.join(root, 'alpha')
    await mkdir(dir, { recursive: true })
    const out = await applySyncStrategy({
      root,
      slug: 'alpha',
      cloneUrl: 'http://127.0.0.1:1/git/alpha.git',
      defaultBranch: 'main',
      info: { state: 'error', path: dir, branch: null, head: null, remote_tip: null, message: `目录存在但不是 git 仓库（或 HEAD 不可读）：${dir}` },
      ops: fakeSyncOps({}),
      syncedAt: TS,
    })
    assert.equal(out.action, 'failed')
    assert.equal(out.code, 'status_error')
    assert.ok('message' in out)
    assert.equal(out.message, `目录存在但不是 git 仓库（或 HEAD 不可读）：${dir}`, '无离线副本可指——message 与 T3 契约逐字一致')
  })
})

// ── 库内原子性：克隆失败的半成品目录必须清掉（无库内半更新） ─────────────────

test('克隆超时留半成品目录（HEAD 不可解析）→ 清理移除，不留库内半更新', async () => {
  await withRoot(async (root) => {
    const out = await applySyncStrategy({
      root,
      slug: 'alpha',
      cloneUrl: 'http://127.0.0.1:1/git/alpha.git',
      defaultBranch: 'main',
      info: NEW_INFO,
      ops: fakeSyncOps({
        cloneSideEffect: async (dir) => {
          await mkdir(path.join(dir, '.git'), { recursive: true }) // 模拟被 SIGTERM 杀死的中途克隆
          await writeFile(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8')
        },
        cloneErr: new Error('网络操作超时（git clone 超过 1500 ms 上限）'),
        head: undefined, // 半成品：HEAD^{commit} 不可解析
      }),
      syncedAt: TS,
    })
    assert.equal(out.action, 'failed')
    assert.equal(out.code, 'timeout')
    assert.equal(existsSync(path.join(root, 'alpha')), false, '克隆失败的半成品目录应被清理（库内原子性）')
  })
})

test('克隆失败但目录已像完整副本（HEAD 可解析）→ 不动目录（D7：不删用户数据）', async () => {
  await withRoot(async (root) => {
    const out = await applySyncStrategy({
      root,
      slug: 'alpha',
      cloneUrl: 'http://127.0.0.1:1/git/alpha.git',
      defaultBranch: 'main',
      info: NEW_INFO,
      ops: fakeSyncOps({
        cloneSideEffect: async (dir) => {
          await mkdir(path.join(dir, '.git'), { recursive: true })
        },
        cloneErr: new Error('网络操作超时（git clone 超过 1500 ms 上限）'),
        head: SHA1, // 看起来是完整副本（HEAD 可解析）——守卫应拒绝清理
      }),
      syncedAt: TS,
    })
    assert.equal(out.action, 'failed')
    assert.equal(existsSync(path.join(root, 'alpha')), true, 'HEAD 可解析的目录不是半成品——不得删除')
  })
})

// ── NOTEGIT_SYNC_TIMEOUT_MS：真实 git 的超时注入缝（hang 服务 + 短超时） ─────

test('NOTEGIT_SYNC_TIMEOUT_MS：挂起不响应的服务 + 2s 超时 → realSyncOps.clone 以「超时」抛出', async () => {
  const hang = http.createServer(() => {
    /* 接受连接，永不响应（timeout 注入面） */
  })
  await new Promise<void>((resolve) => hang.listen(0, '127.0.0.1', resolve))
  const port = (hang.address() as { port: number }).port
  const dir = path.join(await mkdtemp(path.join(tmpdir(), 'notegit-sync-offline-tmo-')), 'alpha')
  const prev = process.env['NOTEGIT_SYNC_TIMEOUT_MS']
  process.env['NOTEGIT_SYNC_TIMEOUT_MS'] = '2000'
  try {
    await assert.rejects(
      realSyncOps().clone(`http://127.0.0.1:${port}/git/alpha.git`, dir),
      /超时|timed out/,
      '超时终止应抛出含「超时」的错误（供分类为 timeout）',
    )
  } finally {
    if (prev === undefined) delete process.env['NOTEGIT_SYNC_TIMEOUT_MS']
    else process.env['NOTEGIT_SYNC_TIMEOUT_MS'] = prev
    // hang 模式下存在「已收到请求但永不响应」的连接：close() 会等它到 requestTimeout，
    // 必须先断开全部连接，否则测试收尾挂起。
    hang.closeAllConnections()
    hang.close()
    await once(hang, 'close')
    await rm(path.dirname(dir), { recursive: true, force: true })
  }
})
