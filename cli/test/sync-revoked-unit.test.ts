import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { computeSyncStatus, type SyncGitOps } from '../src/ls/local-status.ts'
import { applySyncStrategy, type SyncOps } from '../src/sync/engine.ts'
import { readSyncState, readVaultState, removeVaultEntry, stateEntryOfOutcome, writeVaultEntry } from '../src/sync/state.ts'
import type { SyncOutcome } from '../src/sync/engine.ts'

// S7-T5 单元层：撤权标记的三个纯推导面——
//   1) 判定面：fetch 收 404（not_found）→ sync 状态 'revoked'（identity §5.2：
//      撤权库 Git 通道一律 404；架构 §7.3「失去权限时标记该库不可继续同步」）；
//   2) 策略面：revoked → skipped（reason 提示撤权与清理入口），零变更操作（D7）；
//   3) 状态面：skipped/revoked outcome → 状态条目 revoked=true（clean 命令的消费
//      依据）；removeVaultEntry（清理成功后移除条目）。
// 黑盒层（真实 404 服务端 → 标记 → 清理拒绝/恢复）见 sync-revoked.test.ts；
// 报告契约（reason_code=revoked）见 sync-report-unit.test.ts。

const SHA1 = '1111111111111111111111111111111111111111'
const SHA2 = '2222222222222222222222222222222222222222'
const TS1 = '2026-10-13T08:00:00.000Z'
const TS2 = '2026-10-13T09:00:00.000Z'
const SYNCED_AT = '2026-10-13T10:00:00.000Z'

/** 可编排判定假件：fetchTip 支持三种结局（成功/404/不可用）；记录调用序。 */
function fakeGit(script: {
  repo?: string
  branch?: string | null
  dirty?: boolean
  tip?: string
  notFound?: boolean
  unavailable?: boolean
}): SyncGitOps & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    revParse: async (_cwd, ref) => (ref === 'HEAD' ? script.repo : undefined),
    currentBranch: async () => script.branch,
    isDirty: async () => script.dirty,
    remoteTip: async () => script.tip,
    fetchTip: async (_cwd, _url, branch) => {
      calls.push(`fetchTip:${branch}`)
      if (script.notFound === true) return { found: false, reason: 'not_found' }
      if (script.unavailable === true) return { found: false, reason: 'unavailable' }
      return { found: true, sha: script.tip ?? SHA2 }
    },
    isAncestor: async () => undefined,
  }
}

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'ngt-syncrev-unit-'))
  try {
    await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const ARGS = { slug: 'alpha', defaultBranch: 'main', cloneUrl: 'https://s/git/alpha.git' } as const

// ── 判定面：fetch 404 → revoked（不再折叠为 error） ───────────────────────────

test('判定·fetch 收 404（not_found）→ state=revoked，携带本地 head/分支，不再发祖先判定', async () => {
  await withRoot(async (root) => {
    await mkdir(path.join(root, 'alpha'))
    const git = fakeGit({ repo: SHA1, branch: 'main', dirty: false, notFound: true })
    const info = await computeSyncStatus({ root, ...ARGS, ops: git })
    assert.deepEqual(info, { state: 'revoked', path: path.join(root, 'alpha'), branch: 'main', head: SHA1, remote_tip: null, message: null })
    assert.deepEqual(git.calls, ['fetchTip:main'], '404 判定后不再继续判定（无 isAncestor 调用）')
  })
})

test('判定·fetch 失败但非 404（unavailable）→ 仍为 error（网络/认证问题不误标撤权）', async () => {
  await withRoot(async (root) => {
    await mkdir(path.join(root, 'alpha'))
    const git = fakeGit({ repo: SHA1, branch: 'main', dirty: false, unavailable: true })
    const info = await computeSyncStatus({ root, ...ARGS, ops: git })
    assert.equal(info.state, 'error', '非 404 的 fetch 失败保持 error（fail-safe：不误标）')
    assert.match(info.message ?? '', /fetch|远端/)
    assert.equal(info.head, SHA1)
  })
})

test('判定·本地即可判的跳过态不发起 fetch（脏工作区遇撤权不明知——判定序不变，404 只在 fetch 处发现）', async () => {
  await withRoot(async (root) => {
    await mkdir(path.join(root, 'alpha'))
    const git = fakeGit({ repo: SHA1, branch: 'main', dirty: true, notFound: true })
    const info = await computeSyncStatus({ root, ...ARGS, ops: git })
    assert.equal(info.state, 'dirty', '脏工作区先行跳过（不联网），撤权检测不前置')
    assert.deepEqual(git.calls, [], '不应发起 fetch')
  })
})

// ── 策略面：revoked → skipped（D7：零变更操作） ───────────────────────────────

function noOps(): SyncOps & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    clone: async () => {
      calls.push('clone')
      throw new Error('不应克隆')
    },
    fastForward: async () => {
      calls.push('ff')
      throw new Error('不应快进')
    },
    revHead: async () => {
      calls.push('revHead')
      return undefined
    },
  }
}

test('策略·revoked → skipped：reason 提示撤权（404）与显式清理入口，携带离线 head/last_sync，零变更操作', async () => {
  await withRoot(async (root) => {
    const ops = noOps()
    const out = await applySyncStrategy({
      root,
      slug: 'alpha',
      cloneUrl: ARGS.cloneUrl,
      defaultBranch: 'main',
      info: { state: 'revoked', path: path.join(root, 'alpha'), branch: 'main', head: SHA1, remote_tip: null, message: null },
      ops,
      syncedAt: SYNCED_AT,
    })
    assert.equal(out.action, 'skipped')
    assert.equal(out.state, 'revoked')
    assert.match(out.reason, /404|撤权/)
    assert.match(out.reason, /sync clean/, '原因应指向显式清理入口')
    assert.equal(out.head, SHA1, '离线副本 head 携带')
    assert.equal(out.last_sync, null, '无状态条目时 last_sync=null')
    assert.deepEqual(ops.calls, [], 'revoked 不得触发任何变更操作（D7：不自动删）')
  })
})

// ── 状态面：outcome → 条目的 revoked 位生命周期 ───────────────────────────────

test('状态·stateEntryOfOutcome：skipped/revoked → 条目 revoked=true（head/last_sync 保留）；其余跳过态复位 false', () => {
  const revoked: SyncOutcome = { action: 'skipped', slug: 'a', path: '/r/a', state: 'revoked', reason: 'r', head: SHA1, last_sync: TS1 }
  assert.deepEqual(stateEntryOfOutcome(revoked, TS2), { head: SHA1, last_sync: TS1, revoked: true }, '撤权跳过：置位且不刷新 last_sync')
  const dirty: SyncOutcome = { action: 'skipped', slug: 'a', path: '/r/a', state: 'dirty', reason: 'r', head: SHA1, last_sync: TS1 }
  assert.deepEqual(stateEntryOfOutcome(dirty, TS2), { head: SHA1, last_sync: TS1, revoked: false }, '可见库的普通跳过复位（重新可见即恢复资格）')
  const ok: SyncOutcome = { action: 'up_to_date', slug: 'a', path: '/r/a', head: SHA1, last_sync: TS1 }
  assert.deepEqual(stateEntryOfOutcome(ok, TS2), { head: SHA1, last_sync: TS2, revoked: false }, '成功同步复位（恢复权限场景的清位面）')
})

test('状态·removeVaultEntry：清理成功后移除目标条目、保留他库；未知 slug 幂等不抛', async () => {
  await withRoot(async (root) => {
    await writeVaultEntry(root, 'alpha', { head: SHA1, last_sync: TS1, revoked: true })
    await writeVaultEntry(root, 'beta', { head: SHA2, last_sync: TS2, revoked: false })
    await removeVaultEntry(root, 'alpha')
    assert.equal(readVaultState(root, 'alpha'), null, 'alpha 条目应被移除')
    assert.deepEqual(readVaultState(root, 'beta'), { head: SHA2, last_sync: TS2, revoked: false }, 'beta 不受影响')
    await removeVaultEntry(root, 'alpha') // 再移除不抛
    assert.deepEqual(readSyncState(root).vaults, { beta: { head: SHA2, last_sync: TS2, revoked: false } })
  })
})
