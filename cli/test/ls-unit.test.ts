import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

// S6-T3 单元层：ls 状态机与纯函数的注入式测试（黑盒 dist 测试见 ls.test.ts——
// 两层合起来固化 --json schema 与本地状态契约；breakdown §2.5 S6-T3 行）。
import { cloneUrlOf } from '../src/ls/api.ts'
import { credentialSourceFromEnv } from '../src/ls/credential-source.ts'
import { computeLocalStatus, type GitOps } from '../src/ls/local-status.ts'

// ── cloneUrlOf：clone URL 构造（server 实现 /git/<slug>[.git] Smart HTTP 形态） ──

test('cloneUrlOf：<server>/git/<slug>.git，服务端尾斜杠归一', () => {
  assert.equal(cloneUrlOf('https://notegit.example.com', 'alpha'), 'https://notegit.example.com/git/alpha.git')
  assert.equal(cloneUrlOf('https://notegit.example.com/', 'team-notes'), 'https://notegit.example.com/git/team-notes.git')
  assert.equal(cloneUrlOf('http://127.0.0.1:3000', 'a-b-1'), 'http://127.0.0.1:3000/git/a-b-1.git')
})

// ── credentialSourceFromEnv：占位凭据面（T2 合并后切到 login/credential helper） ──

test('credentialSourceFromEnv：NOTEGIT_SERVER + NOTEGIT_TOKEN 齐备才返回，尾斜杠归一', () => {
  assert.deepEqual(credentialSourceFromEnv({ NOTEGIT_SERVER: 'https://s.example/', NOTEGIT_TOKEN: 'ngt_x' }), {
    server: 'https://s.example',
    token: 'ngt_x',
  })
})

test('credentialSourceFromEnv：缺任一或空白 → undefined（= 未配置）', () => {
  assert.equal(credentialSourceFromEnv({ NOTEGIT_TOKEN: 'ngt_x' }), undefined)
  assert.equal(credentialSourceFromEnv({ NOTEGIT_SERVER: 'https://s.example' }), undefined)
  assert.equal(credentialSourceFromEnv({ NOTEGIT_SERVER: '  ', NOTEGIT_TOKEN: 'ngt_x' }), undefined)
  assert.equal(credentialSourceFromEnv({ NOTEGIT_SERVER: 'https://s.example', NOTEGIT_TOKEN: '' }), undefined)
  assert.equal(credentialSourceFromEnv({}), undefined)
})

// ── computeLocalStatus：本地状态机（注入 GitOps；fs 用真实临时目录） ──

const SHA1 = '1111111111111111111111111111111111111111'
const SHA2 = '2222222222222222222222222222222222222222'

/** 可编排的 GitOps 假件：记录调用，按脚本应答（undefined = 对应 git 调用失败）。 */
function fakeGit(script: { head?: string; tip?: string; ancestor?: boolean }): GitOps & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    revParse: async (_cwd, ref) => {
      calls.push(`revParse:${ref}`)
      return script.head
    },
    remoteTip: async (_cwd, _url, branch) => {
      calls.push(`remoteTip:${branch}`)
      return script.tip
    },
    isAncestor: async (_cwd, a, b) => {
      calls.push(`isAncestor:${a.slice(0, 4)}->${b.slice(0, 4)}`)
      return script.ancestor
    },
  }
}

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'notegit-ls-unit-'))
  try {
    await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('computeLocalStatus：根目录下无副本 → not_cloned，且不发起任何 git 调用', async () => {
  await withRoot(async (root) => {
    const git = fakeGit({ head: SHA1, tip: SHA1 })
    const info = await computeLocalStatus({ root, slug: 'alpha', defaultBranch: 'main', cloneUrl: 'https://s/git/alpha.git', ops: git })
    assert.deepEqual(info, { path: null, status: 'not_cloned', head: null, remote_tip: null })
    assert.deepEqual(git.calls, [])
  })
})

test('computeLocalStatus：目录在但 rev-parse 拿不到默认分支 → unknown（head/tip 均 null），不再取远端', async () => {
  await withRoot(async (root) => {
    await mkdir(path.join(root, 'alpha')) // 存在但不是 git 仓库
    const git = fakeGit({ head: undefined, tip: SHA1 })
    const info = await computeLocalStatus({ root, slug: 'alpha', defaultBranch: 'main', cloneUrl: 'https://s/git/alpha.git', ops: git })
    assert.deepEqual(info, { path: path.join(root, 'alpha'), status: 'unknown', head: null, remote_tip: null })
    assert.ok(!git.calls.some((c) => c.startsWith('remoteTip')), 'head 未知时不应取远端 tip')
  })
})

test('computeLocalStatus：head 已知但远端 tip 获取失败（网络/401）→ unknown，head 保留', async () => {
  await withRoot(async (root) => {
    await mkdir(path.join(root, 'alpha'))
    const git = fakeGit({ head: SHA1, tip: undefined })
    const info = await computeLocalStatus({ root, slug: 'alpha', defaultBranch: 'main', cloneUrl: 'https://s/git/alpha.git', ops: git })
    assert.deepEqual(info, { path: path.join(root, 'alpha'), status: 'unknown', head: SHA1, remote_tip: null })
  })
})

test('computeLocalStatus：head == 远端 tip → cloned（head/tip 均上报）', async () => {
  await withRoot(async (root) => {
    await mkdir(path.join(root, 'alpha'))
    const git = fakeGit({ head: SHA1, tip: SHA1 })
    const info = await computeLocalStatus({ root, slug: 'alpha', defaultBranch: 'main', cloneUrl: 'https://s/git/alpha.git', ops: git })
    assert.deepEqual(info, { path: path.join(root, 'alpha'), status: 'cloned', head: SHA1, remote_tip: SHA1 })
    assert.ok(!git.calls.some((c) => c.startsWith('isAncestor')), '相等时无需祖先判定')
  })
})

test('computeLocalStatus：head 是远端 tip 的祖先 → behind', async () => {
  await withRoot(async (root) => {
    await mkdir(path.join(root, 'alpha'))
    const git = fakeGit({ head: SHA1, tip: SHA2, ancestor: true })
    const info = await computeLocalStatus({ root, slug: 'alpha', defaultBranch: 'main', cloneUrl: 'https://s/git/alpha.git', ops: git })
    assert.deepEqual(info, { path: path.join(root, 'alpha'), status: 'behind', head: SHA1, remote_tip: SHA2 })
    assert.ok(git.calls.includes(`isAncestor:${SHA1.slice(0, 4)}->${SHA2.slice(0, 4)}`), '祖先判定入参 = (head, tip)')
  })
})

test('computeLocalStatus：head 领先/分叉于 tip（isAncestor=false）→ unknown（精确状态机属 S7 sync）', async () => {
  await withRoot(async (root) => {
    await mkdir(path.join(root, 'alpha'))
    const git = fakeGit({ head: SHA1, tip: SHA2, ancestor: false })
    const info = await computeLocalStatus({ root, slug: 'alpha', defaultBranch: 'main', cloneUrl: 'https://s/git/alpha.git', ops: git })
    assert.deepEqual(info, { path: path.join(root, 'alpha'), status: 'unknown', head: SHA1, remote_tip: SHA2 })
  })
})

test('computeLocalStatus：祖先判定不可用（isAncestor=undefined）且 head != tip → unknown', async () => {
  await withRoot(async (root) => {
    await mkdir(path.join(root, 'alpha'))
    const git = fakeGit({ head: SHA1, tip: SHA2, ancestor: undefined })
    const info = await computeLocalStatus({ root, slug: 'alpha', defaultBranch: 'main', cloneUrl: 'https://s/git/alpha.git', ops: git })
    assert.deepEqual(info, { path: path.join(root, 'alpha'), status: 'unknown', head: SHA1, remote_tip: SHA2 })
  })
})
