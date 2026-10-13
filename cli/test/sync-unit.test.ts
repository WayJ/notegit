import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

// S7-T1 单元层：sync 六态判定（D5：ls 四态的展开——判定逻辑复用 local-status 并
// 扩展，不另立状态机）与 §7.3 策略表应用。黑盒 e2e（真实 git + mock git serve）
// 见 sync.test.ts；ls 四态自身契约仍由 ls-unit.test.ts 固化（本文件不重复）。
import { computeLocalStatus, computeSyncStatus, type SyncGitOps } from '../src/ls/local-status.ts'
import { applySyncStrategy, type SyncOps } from '../src/sync/engine.ts'

const SHA1 = '1111111111111111111111111111111111111111'
const SHA2 = '2222222222222222222222222222222222222222'

/** 可编排的 SyncGitOps 假件：记录调用，按脚本应答（undefined = 对应 git 调用失败）。 */
function fakeGit(script: {
  repo?: string // revParse HEAD（undefined = 非 git 仓库 / HEAD 不可读）
  branch?: string | null // currentBranch（null = 分离头指针）
  dirty?: boolean
  head?: string // revParse refs/heads/<默认分支>
  tip?: string // remoteTip（fetch 后 FETCH_HEAD）
  headAncestor?: boolean // isAncestor(head, tip)
  tipAncestor?: boolean // isAncestor(tip, head)
}): SyncGitOps & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    revParse: async (_cwd, ref) => {
      calls.push(`revParse:${ref}`)
      return ref === 'HEAD' ? script.repo : script.head
    },
    currentBranch: async (_cwd) => {
      calls.push('currentBranch')
      return script.branch
    },
    isDirty: async (_cwd) => {
      calls.push('isDirty')
      return script.dirty
    },
    remoteTip: async (_cwd, _url, branch) => {
      calls.push(`remoteTip:${branch}`)
      return script.tip
    },
    isAncestor: async (_cwd, a, b) => {
      calls.push(`isAncestor:${a.slice(0, 4)}->${b.slice(0, 4)}`)
      if (a === SHA1 && b === SHA2) return script.headAncestor
      if (a === SHA2 && b === SHA1) return script.tipAncestor
      return undefined
    },
  }
}

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'notegit-sync-unit-'))
  try {
    await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const ARGS = { slug: 'alpha', defaultBranch: 'main', cloneUrl: 'https://s/git/alpha.git' } as const

// ── computeSyncStatus：六态判定（架构 §7.3 唯一语义源；D5 展开） ──────────────

test('computeSyncStatus：根目录下无副本 → new，且不发起任何 git 调用', async () => {
  await withRoot(async (root) => {
    const git = fakeGit({ repo: SHA1, head: SHA1, tip: SHA1 })
    const info = await computeSyncStatus({ root, ...ARGS, ops: git })
    assert.deepEqual(info, { state: 'new', path: null, branch: null, head: null, remote_tip: null, message: null })
    assert.deepEqual(git.calls, [])
  })
})

test('computeSyncStatus：目录存在但不是 git 仓库（revParse HEAD 失败）→ error，不再继续判定', async () => {
  await withRoot(async (root) => {
    await mkdir(path.join(root, 'alpha'))
    const git = fakeGit({ repo: undefined, branch: 'main' })
    const info = await computeSyncStatus({ root, ...ARGS, ops: git })
    assert.equal(info.state, 'error')
    assert.equal(info.path, path.join(root, 'alpha'))
    assert.match(info.message ?? '', /不是 git 仓库/)
    assert.ok(!git.calls.includes('currentBranch'), '非仓库应就地终止，不再查分支')
  })
})

test('computeSyncStatus：分离头指针（currentBranch=null）→ other_branch，不取远端', async () => {
  await withRoot(async (root) => {
    await mkdir(path.join(root, 'alpha'))
    const git = fakeGit({ repo: SHA1, branch: null, head: SHA1, tip: SHA1 })
    const info = await computeSyncStatus({ root, ...ARGS, ops: git })
    assert.deepEqual(info, { state: 'other_branch', path: path.join(root, 'alpha'), branch: null, head: SHA1, remote_tip: null, message: null })
    assert.ok(!git.calls.some((c) => c.startsWith('remoteTip')), '本地即可判跳过，不应发起网络')
  })
})

test('computeSyncStatus：当前分支 ≠ 默认分支 → other_branch（携带分支名），不取远端', async () => {
  await withRoot(async (root) => {
    await mkdir(path.join(root, 'alpha'))
    const git = fakeGit({ repo: SHA1, branch: 'feature', head: SHA1, tip: SHA2 })
    const info = await computeSyncStatus({ root, ...ARGS, ops: git })
    assert.deepEqual(info, { state: 'other_branch', path: path.join(root, 'alpha'), branch: 'feature', head: SHA1, remote_tip: null, message: null })
    assert.ok(!git.calls.some((c) => c.startsWith('remoteTip')), '他分支跳过无需 fetch')
  })
})

test('computeSyncStatus：工作区有未提交修改（含未跟踪）→ dirty，不取远端', async () => {
  await withRoot(async (root) => {
    await mkdir(path.join(root, 'alpha'))
    const git = fakeGit({ repo: SHA1, branch: 'main', dirty: true, head: SHA1, tip: SHA2 })
    const info = await computeSyncStatus({ root, ...ARGS, ops: git })
    assert.deepEqual(info, { state: 'dirty', path: path.join(root, 'alpha'), branch: 'main', head: SHA1, remote_tip: null, message: null })
    assert.ok(!git.calls.some((c) => c.startsWith('remoteTip')), '脏工作区跳过无需 fetch')
  })
})

test('computeSyncStatus：位于默认分支且干净，但 fetch 失败 → error（head 保留）', async () => {
  await withRoot(async (root) => {
    await mkdir(path.join(root, 'alpha'))
    const git = fakeGit({ repo: SHA1, branch: 'main', dirty: false, head: SHA1, tip: undefined })
    const info = await computeSyncStatus({ root, ...ARGS, ops: git })
    assert.equal(info.state, 'error')
    assert.equal(info.head, SHA1)
    assert.match(info.message ?? '', /fetch|远端/)
  })
})

test('computeSyncStatus：head == 远端 tip → clean（已是最新）', async () => {
  await withRoot(async (root) => {
    await mkdir(path.join(root, 'alpha'))
    const git = fakeGit({ repo: SHA1, branch: 'main', dirty: false, head: SHA1, tip: SHA1 })
    const info = await computeSyncStatus({ root, ...ARGS, ops: git })
    assert.deepEqual(info, { state: 'clean', path: path.join(root, 'alpha'), branch: 'main', head: SHA1, remote_tip: SHA1, message: null })
  })
})

test('computeSyncStatus：head 是 tip 祖先 → clean（可快进），head/tip 均上报', async () => {
  await withRoot(async (root) => {
    await mkdir(path.join(root, 'alpha'))
    const git = fakeGit({ repo: SHA1, branch: 'main', dirty: false, head: SHA1, tip: SHA2, headAncestor: true })
    const info = await computeSyncStatus({ root, ...ARGS, ops: git })
    assert.deepEqual(info, { state: 'clean', path: path.join(root, 'alpha'), branch: 'main', head: SHA1, remote_tip: SHA2, message: null })
    assert.ok(git.calls.includes(`isAncestor:${SHA1.slice(0, 4)}->${SHA2.slice(0, 4)}`), '先判 (head, tip)')
  })
})

test('computeSyncStatus：tip 是 head 祖先（本地领先）→ ahead', async () => {
  await withRoot(async (root) => {
    await mkdir(path.join(root, 'alpha'))
    const git = fakeGit({ repo: SHA1, branch: 'main', dirty: false, head: SHA1, tip: SHA2, headAncestor: false, tipAncestor: true })
    const info = await computeSyncStatus({ root, ...ARGS, ops: git })
    assert.deepEqual(info, { state: 'ahead', path: path.join(root, 'alpha'), branch: 'main', head: SHA1, remote_tip: SHA2, message: null })
  })
})

test('computeSyncStatus：互不为祖先 → diverged', async () => {
  await withRoot(async (root) => {
    await mkdir(path.join(root, 'alpha'))
    const git = fakeGit({ repo: SHA1, branch: 'main', dirty: false, head: SHA1, tip: SHA2, headAncestor: false, tipAncestor: false })
    const info = await computeSyncStatus({ root, ...ARGS, ops: git })
    assert.deepEqual(info, { state: 'diverged', path: path.join(root, 'alpha'), branch: 'main', head: SHA1, remote_tip: SHA2, message: null })
  })
})

test('computeSyncStatus：祖先判定不可用（isAncestor=undefined）→ error', async () => {
  await withRoot(async (root) => {
    await mkdir(path.join(root, 'alpha'))
    const git = fakeGit({ repo: SHA1, branch: 'main', dirty: false, head: SHA1, tip: SHA2, headAncestor: undefined })
    const info = await computeSyncStatus({ root, ...ARGS, ops: git })
    assert.equal(info.state, 'error')
    assert.equal(info.head, SHA1)
  })
})

// ── D5 映射：同一脚本下 ls 四态 ↔ sync 六态的展开关系 ─────────────────────────

test('D5 展开：not_cloned→new；cloned/behind→clean；unknown→ahead/diverged（同一脚本两侧对照）', async () => {
  await withRoot(async (root) => {
    const cases: Array<{ script: Parameters<typeof fakeGit>[0]; ls: string; sync: string }> = [
      { script: {}, ls: 'not_cloned', sync: 'new' },
      { script: { repo: SHA1, branch: 'main', dirty: false, head: SHA1, tip: SHA1 }, ls: 'cloned', sync: 'clean' },
      { script: { repo: SHA1, branch: 'main', dirty: false, head: SHA1, tip: SHA2, headAncestor: true }, ls: 'behind', sync: 'clean' },
      { script: { repo: SHA1, branch: 'main', dirty: true, head: SHA1, tip: SHA1 }, ls: 'cloned', sync: 'dirty' },
      { script: { repo: SHA1, branch: 'main', dirty: false, head: SHA1, tip: SHA2, headAncestor: false, tipAncestor: true }, ls: 'unknown', sync: 'ahead' },
      { script: { repo: SHA1, branch: 'main', dirty: false, head: SHA1, tip: SHA2, headAncestor: false, tipAncestor: false }, ls: 'unknown', sync: 'diverged' },
    ]
    for (const [i, { script, ls, sync }] of cases.entries()) {
      const slug = `alpha-${i}-${sync}`
      if (ls !== 'not_cloned') await mkdir(path.join(root, slug))
      const lsOps = fakeGit(script)
      const syncOps = fakeGit(script)
      const lsInfo = await computeLocalStatus({ root, slug, defaultBranch: 'main', cloneUrl: 'https://s/git/x.git', ops: lsOps })
      const syncInfo = await computeSyncStatus({ root, slug, defaultBranch: 'main', cloneUrl: 'https://s/git/x.git', ops: syncOps })
      assert.equal(lsInfo.status, ls, `ls 四态应为 ${ls}`)
      assert.equal(syncInfo.state, sync, `sync 六态应为 ${sync}（ls=${ls} 的展开）`)
    }
  })
})

// ── applySyncStrategy：§7.3 策略表应用（注入 SyncOps 假件） ────────────────────

/** 可编排的 SyncOps 假件：记录调用；failClone/failFf 控制失败注入。 */
function fakeSyncOps(opts: { head?: string; failClone?: boolean; failFf?: boolean } = {}): SyncOps & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    clone: async (url, dir, depth) => {
      calls.push(`clone:${url}|${dir}|${depth ?? 'full'}`)
      if (opts.failClone === true) throw new Error('克隆失败（模拟）')
    },
    fastForward: async (dir, url, branch) => {
      calls.push(`ff:${dir}|${url}|${branch}`)
      if (opts.failFf === true) throw new Error('快进失败（模拟）')
    },
    revHead: async (dir) => {
      calls.push(`revHead:${dir}`)
      return opts.head
    },
  }
}

const INFO_BASE = { path: path.join('/root', 'alpha'), branch: 'main', message: null } as const
/** S7-T4：成功 outcome 携带的 last_sync（注入固定时钟，runSync 与状态文件同源同值）。 */
const SYNCED_AT = '2026-10-13T08:00:00.000Z'

async function apply(info: Record<string, unknown>, ops: SyncOps, depth?: number): Promise<ReturnType<typeof applySyncStrategy>> {
  return applySyncStrategy({ root: '/root', slug: 'alpha', cloneUrl: 'https://s/git/alpha.git', defaultBranch: 'main', info: info as never, depth, ops, syncedAt: SYNCED_AT })
}

test('策略表·new：完整克隆（无 depth），成功后上报 head 与 last_sync', async () => {
  const ops = fakeSyncOps({ head: SHA2 })
  const out = await apply({ state: 'new', ...INFO_BASE, head: null, remote_tip: null }, ops)
  assert.deepEqual(out, { action: 'cloned', slug: 'alpha', path: path.join('/root', 'alpha'), head: SHA2, last_sync: SYNCED_AT })
  assert.deepEqual(ops.calls, [`clone:https://s/git/alpha.git|${path.join('/root', 'alpha')}|full`, `revHead:${path.join('/root', 'alpha')}`])
})

test('策略表·new + --depth：浅克隆作为显式选项传递', async () => {
  const ops = fakeSyncOps({ head: SHA2 })
  const out = await apply({ state: 'new', ...INFO_BASE, head: null, remote_tip: null }, ops, 1)
  assert.equal(out.action, 'cloned')
  assert.ok(ops.calls[0]!.endsWith('|1'), 'clone 应收到 depth=1')
})

test('策略表·clean 且 head==tip：已是最新，不发起任何变更操作', async () => {
  const ops = fakeSyncOps({ head: SHA1 })
  const out = await apply({ state: 'clean', ...INFO_BASE, head: SHA1, remote_tip: SHA1 }, ops)
  assert.deepEqual(out, { action: 'up_to_date', slug: 'alpha', path: INFO_BASE.path, head: SHA1, last_sync: SYNCED_AT })
  assert.deepEqual(ops.calls, [], '已是最新不应触发 clone/ff')
})

test('策略表·clean 且落后：fetch 后快进（--ff-only 语义），from→to 如实上报', async () => {
  const ops = fakeSyncOps({ head: SHA2 })
  const out = await apply({ state: 'clean', ...INFO_BASE, head: SHA1, remote_tip: SHA2 }, ops)
  assert.deepEqual(out, { action: 'fast_forwarded', slug: 'alpha', path: INFO_BASE.path, from: SHA1, to: SHA2, last_sync: SYNCED_AT })
  assert.deepEqual(ops.calls, [`ff:${INFO_BASE.path}|https://s/git/alpha.git|main`, `revHead:${INFO_BASE.path}`])
})

test('策略表·四类跳过态：dirty/ahead/diverged/other_branch 均不动本地（零 SyncOps 调用），逐态给原因', async () => {
  const skipCases: Array<{ info: Record<string, unknown>; reason: RegExp }> = [
    { info: { state: 'dirty', ...INFO_BASE, head: SHA1, remote_tip: null }, reason: /未提交修改/ },
    { info: { state: 'ahead', ...INFO_BASE, head: SHA1, remote_tip: SHA2 }, reason: /领先|未推送/ },
    { info: { state: 'diverged', ...INFO_BASE, head: SHA1, remote_tip: SHA2 }, reason: /分叉/ },
    { info: { state: 'other_branch', ...INFO_BASE, branch: 'feature', head: SHA1, remote_tip: null }, reason: /feature.*默认分支|默认分支.*feature/ },
  ]
  for (const { info, reason } of skipCases) {
    const ops = fakeSyncOps()
    const out = await apply(info, ops)
    assert.equal(out.action, 'skipped', `${String(info['state'])} 应跳过`)
    assert.equal(out.state, info['state'])
    assert.match(out.reason, reason)
    assert.deepEqual(ops.calls, [], `${String(info['state'])} 不得触发任何变更操作（D7）`)
  }
})

test('策略表·他分支·分离头指针：跳过原因不引用分支名', async () => {
  const ops = fakeSyncOps()
  const out = await apply({ state: 'other_branch', ...INFO_BASE, branch: null, head: SHA1, remote_tip: null }, ops)
  assert.equal(out.action, 'skipped')
  assert.match(out.reason, /分离头指针|非.*分支/)
  assert.ok(!out.reason.includes('null'))
})

test('策略表·error 判定：直接失败并携带判定消息与原因码（S7-T3）；本地 HEAD 可读时 message 附离线副本明示（S7-T6），不发起变更操作', async () => {
  const ops = fakeSyncOps()
  const out = await apply({ state: 'error', ...INFO_BASE, head: SHA1, remote_tip: null, message: '不是 git 仓库' }, ops)
  assert.deepEqual(out, {
    action: 'failed',
    slug: 'alpha',
    path: INFO_BASE.path,
    code: 'status_error',
    message: '不是 git 仓库；离线副本 1111111（可能过期），上次同步 未知（该副本未经 notegit 同步）',
  })
  assert.deepEqual(ops.calls, [])
})

test('策略表·克隆失败：折叠为 failed（消息含 git 输出首行）', async () => {
  const ops = fakeSyncOps({ failClone: true })
  const out = await apply({ state: 'new', ...INFO_BASE, head: null, remote_tip: null }, ops)
  assert.equal(out.action, 'failed')
  assert.match(out.message ?? '', /克隆失败/)
})

test('策略表·快进失败：折叠为 failed（不重试、不改判）', async () => {
  const ops = fakeSyncOps({ failFf: true })
  const out = await apply({ state: 'clean', ...INFO_BASE, head: SHA1, remote_tip: SHA2 }, ops)
  assert.equal(out.action, 'failed')
  assert.match(out.message ?? '', /快进失败/)
})
