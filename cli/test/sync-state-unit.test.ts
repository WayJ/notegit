import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, utimes, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import {
  stateFilePath,
  readSyncState,
  readVaultState,
  writeVaultEntry,
  setRevoked,
  stateEntryOfOutcome,
} from '../src/sync/state.ts'
import { acquireFileLock, withFileLock, repoLockPath, stateLockPath } from '../src/sync/lock.ts'
import { readLastSync } from '../src/sync/last-sync.ts'
import type { SyncFailureCode, SyncOutcome } from '../src/sync/engine.ts'

// S7-T4 单元层：状态文件（仅缓存语义——架构 §7.3「状态 JSON 只是缓存，丢失后可重建」）
// 与并发锁（「每库 Git 操作和全局状态写入分别加锁，避免并发命令交叉修改」）。
// 黑盒层（删状态重建无损 / 双进程真实并发 / 跳过判断一致）见 sync-state.test.ts；
// 锁选型（排他创建+轮询+死进程陈旧抢占）与残余竞态窗口记录于 lock.ts 模块头。

const SHA1 = '1111111111111111111111111111111111111111'
const SHA2 = '2222222222222222222222222222222222222222'
const TS1 = '2026-10-13T08:00:00.000Z'
const TS2 = '2026-10-13T09:00:00.000Z'

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'ngt-syncstate-unit-'))
  try {
    await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ── 状态文件：路径与缓存语义（缺失/损坏 → 空缓存，不抛出） ─────────────────────

test('状态·路径：stateFilePath = <root>/.notegit/sync-state.json', () => {
  assert.equal(stateFilePath(path.join('/root', '')), path.join('/root', '.notegit', 'sync-state.json'))
})

test('状态·缺失即空缓存：无状态文件 → 空文档（version 1、vaults 空），不抛出', async () => {
  await withRoot(async (root) => {
    assert.deepEqual(readSyncState(root), { version: 1, vaults: {} })
    assert.equal(readVaultState(root, 'alpha'), null, '未知 slug → null')
  })
})

test('状态·损坏容忍：坏 JSON / 未知版本 → 空文档（仅缓存，可重建，不抛出）', async () => {
  await withRoot(async (root) => {
    const file = stateFilePath(root)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, '{not json', 'utf8')
    assert.deepEqual(readSyncState(root), { version: 1, vaults: {} }, '坏 JSON 折叠为空缓存')
    await writeFile(file, JSON.stringify({ version: 99, vaults: { alpha: { head: SHA1, last_sync: TS1, revoked: false } } }), 'utf8')
    assert.deepEqual(readSyncState(root), { version: 1, vaults: {} }, '未知版本同样折叠（不误读未来形态）')
  })
})

// ── 状态文件：写读往返与合并（不覆盖他库条目） ────────────────────────────────

test('状态·写读往返：writeVaultEntry 后读回同条目；先后写不同 slug 互不覆盖', async () => {
  await withRoot(async (root) => {
    await writeVaultEntry(root, 'alpha', { head: SHA1, last_sync: TS1, revoked: false })
    await writeVaultEntry(root, 'beta', { head: SHA2, last_sync: TS2, revoked: false })
    assert.deepEqual(readVaultState(root, 'alpha'), { head: SHA1, last_sync: TS1, revoked: false })
    assert.deepEqual(readVaultState(root, 'beta'), { head: SHA2, last_sync: TS2, revoked: false })
    // 同 slug 后写覆盖先写（最新事实胜）
    await writeVaultEntry(root, 'alpha', { head: SHA2, last_sync: TS2, revoked: false })
    assert.deepEqual(readVaultState(root, 'alpha'), { head: SHA2, last_sync: TS2, revoked: false })
    assert.deepEqual(readVaultState(root, 'beta'), { head: SHA2, last_sync: TS2, revoked: false }, 'beta 不受影响')
  })
})

test('状态·撤权标记位：setRevoked 置位/读回；正常写复位为 false（库重新可见即恢复同步资格，T5 消费）', async () => {
  await withRoot(async (root) => {
    await writeVaultEntry(root, 'alpha', { head: SHA1, last_sync: TS1, revoked: false })
    await setRevoked(root, 'alpha', true)
    const marked = readVaultState(root, 'alpha')
    assert.equal(marked?.revoked, true, 'setRevoked(true) 后可读回')
    assert.equal(marked?.head, SHA1, '置位只动 revoked，不丢 head/last_sync')
    // 正常 sync 写入携带 revoked:false —— 权限恢复后条目回到可同步
    await writeVaultEntry(root, 'alpha', { head: SHA1, last_sync: TS2, revoked: false })
    assert.equal(readVaultState(root, 'alpha')?.revoked, false)
  })
})

// ── 状态文件：outcome → 条目推导（failed 不写，skipped 保留旧 last_sync） ───────

test('推导·stateEntryOfOutcome：成功三动作 = 新 head + 本次时间；跳过 = 本地 head + 旧时间；失败 = null（不写）', () => {
  const cloned: SyncOutcome = { action: 'cloned', slug: 'a', path: '/r/a', head: SHA2, last_sync: TS1 }
  assert.deepEqual(stateEntryOfOutcome(cloned, TS2), { head: SHA2, last_sync: TS2, revoked: false })
  const ff: SyncOutcome = { action: 'fast_forwarded', slug: 'a', path: '/r/a', from: SHA1, to: SHA2, last_sync: TS1 }
  assert.deepEqual(stateEntryOfOutcome(ff, TS2), { head: SHA2, last_sync: TS2, revoked: false })
  const utd: SyncOutcome = { action: 'up_to_date', slug: 'a', path: '/r/a', head: SHA1, last_sync: TS1 }
  assert.deepEqual(stateEntryOfOutcome(utd, TS2), { head: SHA1, last_sync: TS2, revoked: false })
  const skipped: SyncOutcome = { action: 'skipped', slug: 'a', path: '/r/a', state: 'dirty', reason: 'r', head: SHA1, last_sync: TS1 }
  assert.deepEqual(stateEntryOfOutcome(skipped, TS2), { head: SHA1, last_sync: TS1, revoked: false }, '跳过：head=当前本地，last_sync=上次（不刷新为本次）')
  const failed: SyncOutcome = { action: 'failed', slug: 'a', path: '/r/a', code: 'clone_failed', message: 'm' }
  assert.equal(stateEntryOfOutcome(failed, TS2), null, '失败不写状态（保留旧条目）')
})

// ── 并发：同进程内不丢更新 + 原子写（读者永不见半截 JSON） ────────────────────

test('状态·并发合流：两异步循环各写不同 slug（交替读改写），最终两 slug 均在（不丢更新）', async () => {
  await withRoot(async (root) => {
    await writeVaultEntry(root, 'seed', { head: SHA1, last_sync: TS1, revoked: false }) // 先建立文件
    await Promise.all([
      (async () => {
        for (let i = 0; i < 30; i++) await writeVaultEntry(root, 'alpha', { head: SHA1, last_sync: TS1, revoked: false })
      })(),
      (async () => {
        for (let i = 0; i < 30; i++) await writeVaultEntry(root, 'beta', { head: SHA2, last_sync: TS2, revoked: false })
      })(),
    ])
    assert.ok(readVaultState(root, 'alpha') !== null, 'alpha 条目不得被 beta 的写覆盖丢失')
    assert.ok(readVaultState(root, 'beta') !== null, 'beta 条目不得被 alpha 的写覆盖丢失')
    assert.ok(readVaultState(root, 'seed') !== null, '既有 seed 条目也不得丢')
  })
})

test('状态·写原子性：并发写期间读者循环始终解析成功且形状合法（tmp+rename，永无半截 JSON）', async () => {
  await withRoot(async (root) => {
    await writeVaultEntry(root, 'seed', { head: SHA1, last_sync: TS1, revoked: false })
    const file = stateFilePath(root)
    let reads = 0
    const reader = (async () => {
      const deadline = Date.now() + 400
      while (Date.now() < deadline) {
        const raw = JSON.parse(await readFile(file, 'utf8')) as { version: number; vaults: Record<string, unknown> }
        assert.equal(raw.version, 1)
        assert.ok(typeof raw.vaults === 'object' && raw.vaults !== null)
        reads++
      }
    })()
    const writer = (async () => {
      for (let i = 0; i < 200; i++) {
        await writeVaultEntry(root, `v${i % 3}`, { head: SHA2, last_sync: TS2, revoked: false })
      }
    })()
    await Promise.all([reader, writer])
    assert.ok(reads > 5, `读者应完成多次读取（实际 ${reads} 次）`)
  })
})

// ── 锁：互斥、分库独立、超时、释放、陈旧抢占 ──────────────────────────────────

test('锁·互斥：同一锁文件两并发临界区不重叠（最大并发=1）；串行序 enter 后必 exit', async () => {
  await withRoot(async (root) => {
    const lock = path.join(root, 'a.lock')
    let active = 0
    let maxActive = 0
    const events: string[] = []
    await Promise.all(
      [1, 2, 3].map((i) =>
        withFileLock(lock, async () => {
          events.push(`enter${i}`)
          active++
          maxActive = Math.max(maxActive, active)
          await sleep(25)
          active--
          events.push(`exit${i}`)
        }),
      ),
    )
    assert.equal(maxActive, 1, '临界区不得重叠')
    for (let i = 0; i < events.length; i += 2) {
      assert.match(events[i]!, /^enter/, '事件序列应 enter/exit 交替')
      assert.match(events[i + 1]!, /^exit/, '事件序列应 enter/exit 交替')
    }
  })
})

test('锁·分库独立：持有 alpha 库锁不阻塞 beta 库锁（分别加锁——架构 §7.3「每库 Git 操作」粒度）', async () => {
  await withRoot(async (root) => {
    const hold = await acquireFileLock(repoLockPath(root, 'alpha'))
    try {
      const t0 = Date.now()
      await withFileLock(repoLockPath(root, 'beta'), async () => undefined, { timeoutMs: 5000 })
      assert.ok(Date.now() - t0 < 1000, 'beta 应立即可得（不串行在 alpha 之后）')
    } finally {
      await hold.release()
    }
  })
})

test('锁·全局状态锁路径独立于库锁：stateLockPath 与 repoLockPath 是不同文件', async () => {
  await withRoot(async (root) => {
    assert.notEqual(stateLockPath(root), repoLockPath(root, 'alpha'))
    assert.equal(stateLockPath(root), `${stateFilePath(root)}.lock`)
    assert.equal(repoLockPath(root, 'alpha'), path.join(root, '.notegit', 'locks', 'alpha.lock'))
  })
})

test('锁·超时：他人持锁不释放 → acquireFileLock 在 timeoutMs 后抛错（含锁路径）', async () => {
  await withRoot(async (root) => {
    const lockPath = path.join(root, 'busy.lock')
    const holder = await acquireFileLock(lockPath)
    try {
      await assert.rejects(acquireFileLock(lockPath, { timeoutMs: 150, retryMs: 20 }), (err: unknown) => {
        assert.ok(err instanceof Error)
        assert.match(err.message, /busy\.lock/)
        assert.match(err.message, /超时/)
        return true
      })
    } finally {
      await holder.release()
    }
  })
})

test('锁·释放与再获得：release 后同一锁文件可立即再次获得', async () => {
  await withRoot(async (root) => {
    const lockPath = path.join(root, 'r.lock')
    const first = await acquireFileLock(lockPath)
    await first.release()
    const second = await acquireFileLock(lockPath)
    await second.release() // 不抛即通过
  })
})

test('锁·陈旧抢占：持有者 pid 已死且锁龄超 staleMs → 后来者抢占成功（崩溃自愈）', async () => {
  await withRoot(async (root) => {
    const lockPath = path.join(root, 'stale.lock')
    await mkdir(path.dirname(lockPath), { recursive: true })
    // 伪造已崩溃进程留下的锁：内容带死 pid；mtime 回拨 1 小时
    const deadPid = 999999999
    await writeFile(lockPath, `${JSON.stringify({ pid: deadPid, token: 'stale-token', acquiredAt: new Date(Date.now() - 3600_000).toISOString() })}\n`)
    const hourAgo = new Date(Date.now() - 3600_000)
    await utimes(lockPath, hourAgo, hourAgo)
    const t0 = Date.now()
    const lock = await acquireFileLock(lockPath, { timeoutMs: 5000, retryMs: 20, staleMs: 60_000 })
    try {
      assert.ok(Date.now() - t0 < 3000, '死锁应被抢占而非等到超时')
    } finally {
      await lock.release()
    }
  })
})

test('锁·活持有者不抢占：pid 存活（自己）时即使锁龄旧也只等待不抢占', async () => {
  await withRoot(async (root) => {
    const lockPath = path.join(root, 'alive.lock')
    await mkdir(path.dirname(lockPath), { recursive: true })
    // 自己的 pid 存活；mtime 回拨 —— 不得被抢占，只能等
    await writeFile(lockPath, `${JSON.stringify({ pid: process.pid, token: 'live-token', acquiredAt: new Date(Date.now() - 3600_000).toISOString() })}\n`)
    const hourAgo = new Date(Date.now() - 3600_000)
    await utimes(lockPath, hourAgo, hourAgo)
    await assert.rejects(acquireFileLock(lockPath, { timeoutMs: 200, retryMs: 20, staleMs: 1000 }), /超时/)
  })
})

// ── last-sync 读取面切换（T2→T4 集成，见 last-sync.ts 头）：状态文件优先，标记回退 ──

test('last-sync·状态优先：状态条目存在 → 返回其 last_sync（标记更新也不得胜出）', async () => {
  await withRoot(async (root) => {
    const dir = path.join(root, 'alpha')
    await mkdir(path.join(dir, '.git'), { recursive: true })
    await writeVaultEntry(root, 'alpha', { head: SHA1, last_sync: TS1, revoked: false })
    await writeFile(path.join(dir, '.git', 'notegit-last-sync'), `${TS2}\n`) // 标记值更新——单一真相在状态文件
    assert.equal(readLastSync(root, dir), TS1)
  })
})

test('last-sync·标记回退：状态无此条目/无状态文件 → 回退 .git 标记（重建来源）；两处皆无或 dir=null → null', async () => {
  await withRoot(async (root) => {
    const dir = path.join(root, 'beta')
    await mkdir(path.join(dir, '.git'), { recursive: true })
    await writeFile(path.join(dir, '.git', 'notegit-last-sync'), `${TS2}\n`)
    assert.equal(readLastSync(root, dir), TS2, '状态无条目 → 标记回退')
    const bare = path.join(root, 'gamma')
    await mkdir(path.join(bare, '.git'), { recursive: true })
    assert.equal(readLastSync(root, bare), null, '两处皆无 → null')
    assert.equal(readLastSync(root, null), null, '无副本（dir=null）→ null')
  })
})

// ── 失败码域：lock_failed 加入 SyncFailureCode（runSync 锁获取失败面；报告 reason_code 透传） ──

test('失败码域：SyncFailureCode = 九值（含 T4 lock_failed + T6 断网三态）；Record 穷尽断言防域漂移', () => {
  const all: Record<SyncFailureCode, true> = {
    status_error: true,
    clone_failed: true,
    head_unreadable: true,
    fast_forward_failed: true,
    internal: true,
    lock_failed: true,
    net_unreachable: true,
    timeout: true,
    http_error: true,
  }
  assert.deepEqual(Object.keys(all).sort(), [
    'clone_failed',
    'fast_forward_failed',
    'head_unreadable',
    'http_error',
    'internal',
    'lock_failed',
    'net_unreachable',
    'status_error',
    'timeout',
  ])
})

// ── 跨进程：两个真实子进程并发写不同 slug，全局状态锁保证不丢更新 ────────────────

const STATE_WRITE_CHILD = new URL('../test-support/state-write-child.ts', import.meta.url).pathname

/** 运行子进程写手（真实进程；返回 {status, stderr}）。 */
function runChild(root: string, slug: string, iterations: number): Promise<{ status: number | null; stderr: string }> {
  const child = spawn(process.execPath, [STATE_WRITE_CHILD, root, slug, String(iterations)], { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (d: string) => (stderr += d))
  return new Promise((resolve) => child.on('close', (code) => resolve({ status: code, stderr })))
}

test('状态·跨进程不丢更新：两真实子进程并发写不同 slug，最终两-entry 均在且文件合法', async () => {
  await withRoot(async (root) => {
    await writeVaultEntry(root, 'seed', { head: SHA1, last_sync: TS1, revoked: false })
    const runs = await Promise.all([runChild(root, 'cp-alpha', 50), runChild(root, 'cp-beta', 50)])
    for (const r of runs) assert.equal(r.status, 0, `子进程应成功退出：${r.stderr}`)
    assert.deepEqual(readVaultState(root, 'cp-alpha'), { head: SHA2, last_sync: TS2, revoked: false }, 'cp-alpha 条目不得丢')
    assert.deepEqual(readVaultState(root, 'cp-beta'), { head: SHA2, last_sync: TS2, revoked: false }, 'cp-beta 条目不得丢')
    assert.ok(readVaultState(root, 'seed') !== null, 'seed 条目不得丢')
  })
})
