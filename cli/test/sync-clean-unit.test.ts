import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { inspectCleanSafety, type CleanInspectOps } from '../src/sync/clean.ts'

// S7-T5 单元层：sync clean 的安全检查矩阵（架构 §7.3「显式清理遇到本地改动或未推送
// 提交时拒绝并提示导出」）。检查是纯本地 git 探测（不联网），此处以注入假件穷举
// 拒绝原因与安全放行；命令编排（锁/删除/状态条目/输出/退出码）的黑盒证明见
// sync-revoked.test.ts（真实 git 副本 + dist 产物）。

const DIR = path.join('/root', 'alpha')

/** 可编排探测假件：字段缺省 = 对应 git 探测失败（undefined → indeterminate）。 */
function fakeInspect(script: { head?: string; status?: string; stash?: boolean; unpushed?: number }): CleanInspectOps {
  return {
    revParseHead: async () => script.head,
    statusPorcelain: async () => script.status,
    stashExists: async () => script.stash,
    unpushedCount: async () => script.unpushed,
  }
}

/** 全安全基线（干净、已全部推送、无暂存栈）。 */
const SAFE = { head: 'a'.repeat(40), status: '', stash: false, unpushed: 0 } as const

// ── 安全放行 ──────────────────────────────────────────────────────────────────

test('检查·安全放行：干净 + 零未推送 + 无暂存栈 → null（可删——内容可由远端重建）', async () => {
  assert.equal(await inspectCleanSafety(fakeInspect(SAFE), DIR), null)
})

test('检查·状态输出仅空白 → 同样安全（porcelain 空串/换行不构成改动）', async () => {
  assert.equal(await inspectCleanSafety(fakeInspect({ ...SAFE, status: '\n  \n' }), DIR), null)
})

// ── 拒绝矩阵（默认模式逐因拒绝；--force 语义在 e2e 与命令层证明） ────────────────

test('检查·非 git 仓库（HEAD 不可读）→ not_a_repo（内容不可判定，保守拒绝）', async () => {
  const r = await inspectCleanSafety(fakeInspect({ ...SAFE, head: undefined }), DIR)
  assert.equal(r?.refusal, 'not_a_repo')
  assert.match(r?.detail ?? '', /不是 git 仓库|不可读/)
})

test('检查·未提交修改（含未跟踪）→ local_changes（dirty 是最直接的未导出数据）', async () => {
  const r = await inspectCleanSafety(fakeInspect({ ...SAFE, status: ' M f0.md\n?? new.md\n' }), DIR)
  assert.equal(r?.refusal, 'local_changes')
  assert.match(r?.detail ?? '', /未提交修改/)
})

test('检查·暂存栈有条目 → stash_entries（stash 也是未导出的工作现场）', async () => {
  const r = await inspectCleanSafety(fakeInspect({ ...SAFE, stash: true }), DIR)
  assert.equal(r?.refusal, 'stash_entries')
  assert.match(r?.detail ?? '', /暂存栈/)
})

test('检查·未推送提交 → unpushed_commits（detail 携带计数）', async () => {
  const r = await inspectCleanSafety(fakeInspect({ ...SAFE, unpushed: 3 }), DIR)
  assert.equal(r?.refusal, 'unpushed_commits')
  assert.match(r?.detail ?? '', /3/)
  assert.match(r?.detail ?? '', /未推送/)
})

test('检查·探测失败（status/unpushed 返回 undefined）→ indeterminate（fail-safe 拒绝）', async () => {
  const a = await inspectCleanSafety(fakeInspect({ ...SAFE, status: undefined }), DIR)
  assert.equal(a?.refusal, 'indeterminate')
  const b = await inspectCleanSafety(fakeInspect({ ...SAFE, unpushed: undefined }), DIR)
  assert.equal(b?.refusal, 'indeterminate')
})

test('检查·优先序：非仓库先于其余（HEAD 不可读时不再判定改动）', async () => {
  const r = await inspectCleanSafety(fakeInspect({ head: undefined, status: ' M f\n', stash: true, unpushed: 9 }), DIR)
  assert.equal(r?.refusal, 'not_a_repo', '先判 git-ness，一处拒绝即止')
})

test('检查·优先序：未提交修改先于未推送（两者并存时报 local_changes）', async () => {
  const r = await inspectCleanSafety(fakeInspect({ ...SAFE, status: ' M f\n', unpushed: 2 }), DIR)
  assert.equal(r?.refusal, 'local_changes')
})
