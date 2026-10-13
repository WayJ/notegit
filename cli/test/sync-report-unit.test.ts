import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import {
  buildSyncReport,
  exitCodeOf,
  renderReportJson,
  renderReportText,
  summarize,
  vaultResultOf,
  type VaultResult,
} from '../src/sync/report.ts'
import type { SyncOutcome } from '../src/sync/engine.ts'
import { EXIT_FAIL, EXIT_OK } from '../src/exit-codes.ts'

// S7-T3 单元层：逐项结果对象（status success/skipped/failed + reason_code + 细节）、
// 汇总计数、退出码契约（非零当且仅当有失败；跳过不判失败——架构 §7.3 语义断言）、
// --json 文档 schema 固化（deepEqual 锁键集与取值域）与文本人读输出（逐库行 + 汇总，
// 与 T1 最小报告形态逐字兼容）。黑盒混合多库场景（真实 git + mock serve）见
// sync-report.test.ts；六态策略行为自身仍由 sync-unit.test.ts / sync.test.ts 固化。

const SHA1 = '1111111111111111111111111111111111111111'
const SHA2 = '2222222222222222222222222222222222222222'
const DIR = path.join('/root', 'alpha')
/** S7-T4：成功项 last_sync（与状态文件同源同值——runSync 单一 syncedAt 时钟）。 */
const TS = '2026-10-13T08:00:00.000Z'

/** 各变体至少一件的 outcome 夹具（reason/message 为测试自供文本——本层只测映射，不锁引擎文案）。 */
const OUTCOMES: SyncOutcome[] = [
  { action: 'cloned', slug: 'w-new', path: DIR, head: SHA2, last_sync: TS },
  { action: 'fast_forwarded', slug: 'w-behind', path: DIR, from: SHA1, to: SHA2, last_sync: TS },
  { action: 'up_to_date', slug: 'w-tip', path: DIR, head: SHA1, last_sync: TS },
  { action: 'skipped', slug: 'w-dirty', path: DIR, state: 'dirty', reason: '工作区有未提交修改', head: null, last_sync: null },
  { action: 'skipped', slug: 'w-ahead', path: DIR, state: 'ahead', reason: '本地有领先远端的未推送提交', head: null, last_sync: null },
  { action: 'skipped', slug: 'w-diverged', path: DIR, state: 'diverged', reason: '本地与远端分叉', head: null, last_sync: null },
  { action: 'skipped', slug: 'w-other', path: DIR, state: 'other_branch', reason: '当前位于分支 feature', head: null, last_sync: null },
  { action: 'failed', slug: 'w-bad', path: DIR, code: 'status_error', message: '目录存在但不是 git 仓库' },
]

// ── vaultResultOf：outcome → 逐项结果对象（status + reason_code + 细节） ──────

test('映射·成功三动作：cloned/fast_forwarded/up_to_date → status=success，reason_code=动作，last_sync 透传（S7-T4），细节随变体', () => {
  const cloned = vaultResultOf(OUTCOMES[0]!)
  assert.deepEqual(cloned, { slug: 'w-new', status: 'success', reason_code: 'cloned', path: DIR, head: SHA2, last_sync: TS })
  const ff = vaultResultOf(OUTCOMES[1]!)
  assert.deepEqual(ff, { slug: 'w-behind', status: 'success', reason_code: 'fast_forwarded', path: DIR, from: SHA1, to: SHA2, last_sync: TS })
  const tip = vaultResultOf(OUTCOMES[2]!)
  assert.deepEqual(tip, { slug: 'w-tip', status: 'success', reason_code: 'up_to_date', path: DIR, head: SHA1, last_sync: TS })
})

test('映射·跳过四态：reason_code=四态枚举，reason 原样透传，path 可为 null', () => {
  const skipped = OUTCOMES.filter((o): o is Extract<SyncOutcome, { action: 'skipped' }> => o.action === 'skipped')
  assert.equal(skipped.length, 4, '夹具应含全部四类跳过态')
  for (const outcome of skipped) {
    const r = vaultResultOf(outcome)
    assert.equal(r.status, 'skipped')
    assert.equal(r.reason_code, outcome.state)
    assert.equal(r.reason, outcome.reason)
  }
  const noDir = vaultResultOf({ action: 'skipped', slug: 'x', path: null, state: 'dirty', reason: 'r', head: null, last_sync: null })
  assert.equal(noDir.path, null)
})

test('映射·失败：reason_code=引擎原因码（status_error 等），message 原样透传', () => {
  const codes = ['status_error', 'clone_failed', 'head_unreadable', 'fast_forward_failed', 'internal'] as const
  for (const code of codes) {
    const r = vaultResultOf({ action: 'failed', slug: 'w-x', path: DIR, code, message: `m-${code}` })
    assert.deepEqual(r, { slug: 'w-x', status: 'failed', reason_code: code, path: DIR, message: `m-${code}` })
  }
})

// ── summarize：汇总计数与 vaults[] 逐项一致（不把跳过计入失败） ────────────────

test('汇总：混合八项 → {total 8, success 3, skipped 4, failed 1}；各计数 == 逐项复数', () => {
  const results = OUTCOMES.map(vaultResultOf)
  const summary = summarize(results)
  assert.deepEqual(summary, { total: 8, success: 3, skipped: 4, failed: 1 })
  assert.equal(summary.total, results.length)
  for (const s of ['success', 'skipped', 'failed'] as const) {
    assert.equal(summary[s], results.filter((r) => r.status === s).length)
  }
})

test('汇总：空库列表 → 全零计数', () => {
  assert.deepEqual(summarize([]), { total: 0, success: 0, skipped: 0, failed: 0 })
})

// ── exitCodeOf：退出码契约——非零当且仅当有失败（跳过不判失败） ────────────────

test('退出码·iff 语义：有失败 → 1；无失败（含全部为跳过）→ 0', () => {
  assert.equal(exitCodeOf({ total: 3, success: 1, skipped: 1, failed: 1 }), EXIT_FAIL, '有失败必须非零')
  assert.equal(exitCodeOf({ total: 2, success: 0, skipped: 2, failed: 0 }), EXIT_OK, '跳过不判失败（§7.3 语义断言）')
  assert.equal(exitCodeOf({ total: 2, success: 2, skipped: 0, failed: 0 }), EXIT_OK, '全成功为零')
  assert.equal(exitCodeOf({ total: 0, success: 0, skipped: 0, failed: 0 }), EXIT_OK, '空列表为零')
})

// ── buildSyncReport / renderReportJson：--json 文档 schema 固化 ────────────────

test('--json schema 固化：注入时钟下整文档 deepEqual 锁定（server/local_root/generatedAt/vaults[]/summary）', () => {
  const doc = buildSyncReport({
    server: 'https://s.example',
    local_root: '/root',
    outcomes: [OUTCOMES[0]!, OUTCOMES[7]!],
    now: () => new Date('2026-10-13T08:00:00.000Z'),
  })
  assert.deepEqual(doc, {
    server: 'https://s.example',
    local_root: '/root',
    generatedAt: '2026-10-13T08:00:00.000Z',
    vaults: [
      { slug: 'w-new', status: 'success', reason_code: 'cloned', path: DIR, head: SHA2, last_sync: TS },
      { slug: 'w-bad', status: 'failed', reason_code: 'status_error', path: DIR, message: '目录存在但不是 git 仓库' },
    ],
    summary: { total: 2, success: 1, skipped: 0, failed: 1 },
  })
})

test('--json 序列化：renderReportJson 可被 JSON.parse 原样读回，末尾恰一个换行', () => {
  const doc = buildSyncReport({ server: 'https://s.example', local_root: '/root', outcomes: OUTCOMES, now: () => new Date(0) })
  const text = renderReportJson(doc)
  assert.ok(text.endsWith('\n') && !text.endsWith('\n\n'), '末尾恰一个换行')
  assert.deepEqual(JSON.parse(text), doc)
})

// ── renderReportText：文本人读输出（逐库行 + 汇总；T1 形态逐字兼容） ──────────

test('文本输出：成功行与汇总行走 stdout 侧，跳过/失败行走 stderr 侧，格式与 T1 一致', () => {
  const results: VaultResult[] = OUTCOMES.map(vaultResultOf)
  const summary = summarize(results)
  const text = renderReportText(results, summary)
  assert.deepEqual(text.out, [
    `w-new：已克隆（HEAD ${SHA2.slice(0, 7)}）→ ${DIR}`,
    `w-behind：已快进 ${SHA1.slice(0, 7)} → ${SHA2.slice(0, 7)}`,
    `w-tip：已是最新（${SHA1.slice(0, 7)}）`,
    '同步完成：共 8 库（成功 3、跳过 4、失败 1）',
  ])
  assert.deepEqual(text.err, [
    'w-dirty：跳过——工作区有未提交修改；离线副本 ?，上次同步 未知（该副本未经 notegit 同步）',
    'w-ahead：跳过——本地有领先远端的未推送提交；离线副本 ?，上次同步 未知（该副本未经 notegit 同步）',
    'w-diverged：跳过——本地与远端分叉；离线副本 ?，上次同步 未知（该副本未经 notegit 同步）',
    'w-other：跳过——当前位于分支 feature；离线副本 ?，上次同步 未知（该副本未经 notegit 同步）',
    'w-bad：失败——目录存在但不是 git 仓库',
  ])
})

test('文本输出·不把部分成功报成全部成功：有失败时汇总行如实携带失败计数', () => {
  const results = [vaultResultOf(OUTCOMES[0]!), vaultResultOf(OUTCOMES[7]!)]
  const text = renderReportText(results, summarize(results))
  assert.deepEqual(text.out, [`w-new：已克隆（HEAD ${SHA2.slice(0, 7)}）→ ${DIR}`, '同步完成：共 2 库（成功 1、跳过 0、失败 1）'])
  for (const line of [...text.out, ...text.err]) {
    assert.ok(!line.includes('全部成功') && !line.includes('全部同步成功'), `不得宣称全部成功：${line}`)
  }
})
