import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { chmodSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// S7-T2 单元层：不覆盖保证（D7 红线）的三个验证辅助 + 引擎跳过上报字段。
// - clobber-scan：静态代码扫描（类似 S2 无缓存断言 no-permission-cache.test.ts——
//   本扫描只看字符串字面量、不看注释：注释里的「不存在 stash/reset/rebase 路径」是
//   文档而非调用；自证用例先证明扫描器对每个禁改令牌都能命中，守卫用例再扫真实源。
// - worktree-snapshot：本地指纹（status/diff 全量 + 索引 + refs + 工作树逐文件
//   sha256）；幂等性证明「前后相等」非侥幸，敏感性证明指纹能察觉任何一类本地改动。
// - last-sync：上次同步时间标记（T4 状态文件未合并前的本地形状；集成点见模块头）。
// 四态前后逐字节快照的黑盒证明见 sync-noclobber.test.ts。
import { scanClobberingGitLiterals } from '../src/sync/clobber-scan.ts'
import { captureWorktreeFingerprint, firstFingerprintMismatch } from '../src/sync/worktree-snapshot.ts'
import { readLastSync, writeLastSync } from '../src/sync/last-sync.ts'
import { applySyncStrategy, type SyncOps } from '../src/sync/engine.ts'

const GIT = { PATH: process.env['PATH']!, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } as const

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, env: GIT, stdio: 'pipe' })
}

const SHA1 = '1111111111111111111111111111111111111111'

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'notegit-noclobber-unit-'))
  try {
    await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/** 造一个有单文件单提交的真实仓库（指纹敏感性测试基线）。 */
async function seedRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  git(dir, 'init', '-b', 'main')
  git(dir, 'config', 'user.name', 't')
  git(dir, 'config', 'user.email', 't@notegit.invalid')
  await writeFile(path.join(dir, 'a.md'), '# a\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-m', 'c0')
}

// ── clobber-scan：静态红线扫描（D7；S2 无缓存断言同型） ──────────────────────

test('D7 扫描·自证：禁改令牌作为独立字面量参数即被标记（stash/reset/rebase/--hard 等）', () => {
  const tokens = ['stash', 'reset', 'rebase', 'checkout', 'clean', 'restore', 'cherry-pick', 'revert', 'filter-branch', '--hard', '--force', '-f', '-D']
  for (const token of tokens) {
    const source = `function bad() {\n  runGit(dir, ['${token}', 'HEAD'])\n}\n`
    const hits = scanClobberingGitLiterals(source)
    assert.ok(
      hits.some((h) => h.token === token),
      `令牌 ${token} 应被标记（命中：${JSON.stringify(hits)}）`,
    )
    assert.equal(hits[0]!.line, 2, '违规行号应指向字面量所在行')
  }
})

test('D7 扫描·自证：模板串中以空格分隔的破坏性命令形态被标记（git reset --hard）', () => {
  const source = 'const cmd = `git reset --hard HEAD`\n'
  const tokens = scanClobberingGitLiterals(source).map((h) => h.token)
  assert.ok(tokens.includes('reset'), '`git reset --hard` 中的 reset 应被标记')
  assert.ok(tokens.includes('--hard'), '`git reset --hard` 中的 --hard 应被标记')
})

test('D7 扫描·自证：状态名 clean 不误报，但 argv 位与 git clean 连写真调用即被标记', () => {
  // 状态机词表（D5：clean 是六态之一）——比较、类型联合、状态名文案都不是调用
  const benign = [
    "if (info.state === 'clean') {",
    "readonly state: Exclude<SyncState, 'new' | 'clean'>",
    "const msg = 'clean 判定缺少 head/remote_tip（内部错误）'",
  ].join('\n')
  assert.deepEqual(scanClobberingGitLiterals(benign), [], '状态名形态不得误报')

  // argv 数组上下文中的 'clean'（字面量前同行有未闭合 '['）= git clean 调用位
  const argv = "const r = runGit(dir, ['clean', '-fd'])\n"
  assert.ok(
    scanClobberingGitLiterals(argv).some((h) => h.token === 'clean'),
    "argv 位的 'clean' 应被标记（git clean -fd 是 D7 级破坏）",
  )

  // 拼接串里的两字连写
  const joined = "const cmd = 'git clean -fd 谨慎'\n"
  assert.ok(
    scanClobberingGitLiterals(joined).some((h) => h.token === 'git clean'),
    "'git clean …' 连写应被标记",
  )
})

test('D7 扫描·自证：报告文案中的「stash/reset/rebase」斜杠连写不误报', () => {
  // engine 现行跳过原因即此形态——文案告知用户「不会」做这些事，不是调用。
  const source = `const reason = '工作区有未提交修改（含未跟踪文件）；保留本地改动，不自动 stash/reset/rebase'\n`
  assert.deepEqual(scanClobberingGitLiterals(source), [], '文案不得被误报为调用')
})

test('D7 扫描·自证：允许的只读/快进调用形态不标记', () => {
  const benign = [
    "const a = ['clone', '--quiet', url, dir]",
    "const b = ['fetch', '--quiet', url, branch]",
    "const c = ['merge', '--ff-only', 'FETCH_HEAD']",
    "const d = ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']",
    "const e = ['status', '--porcelain']",
    "const f = ['symbolic-ref', '--quiet', '--short', 'HEAD']",
    "const g = ['merge-base', '--is-ancestor', a, b]",
  ].join('\n')
  assert.deepEqual(scanClobberingGitLiterals(benign), [], '白名单调用形态不得被标记')
})

test('D7 扫描·守卫：sync 代码路径（cli/src/sync/*.ts + ls/local-status.ts）零违规', () => {
  const syncDir = fileURLToPath(new URL('../src/sync', import.meta.url))
  // clobber-scan.ts 是扫描器自身的禁改令牌字典（纯函数、无 git 调用面）——
  // 字典字面量即红线清单本身，扫描它等于让清单不自证；git 调用面是其余模块。
  const files = [
    ...readdirSync(syncDir)
      .filter((f) => f.endsWith('.ts') && f !== 'clobber-scan.ts')
      .map((f) => path.join(syncDir, f)),
    fileURLToPath(new URL('../src/ls/local-status.ts', import.meta.url)),
  ]
  assert.ok(files.length >= 5, `扫描范围应至少含 5 个源文件（实际 ${files.length}）`)
  for (const file of files) {
    const hits = scanClobberingGitLiterals(readFileSync(file, 'utf8'))
    assert.deepEqual(
      hits.map((h) => `${path.basename(file)}:${h.line}`),
      [],
      `${path.basename(file)} 存在禁改 git 调用字面量（D7 红线）：${JSON.stringify(hits)}`,
    )
  }
})

test('D7 扫描·守卫：engine 中 merge 调用必须与 --ff-only 同行成对（不与非快进 merge 共存）', () => {
  const engine = readFileSync(fileURLToPath(new URL('../src/sync/engine.ts', import.meta.url)), 'utf8')
  const mergeLines = engine.split('\n').map((line, i) => ({ line, no: i + 1 })).filter((l) => /'merge'/.test(l.line))
  assert.ok(mergeLines.length >= 1, 'engine 应至少有一处 merge 调用（快进路径）')
  for (const l of mergeLines) {
    assert.match(l.line, /'--ff-only'/, `engine.ts:${l.no} 的 merge 必须成对携带 --ff-only`)
  }
})

// ── worktree-snapshot：指纹的幂等性与敏感性（快照证明的可信度前提） ────────────

async function seedFingerprintRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'notegit-fp-'))
  await seedRepo(dir)
  return dir
}

test('指纹·幂等：同一状态连续两次采集逐字节相同（前后相等断言的非侥幸前提）', async () => {
  const dir = await seedFingerprintRepo()
  try {
    const a = await captureWorktreeFingerprint(dir)
    const b = await captureWorktreeFingerprint(dir)
    assert.equal(a, b)
    assert.equal(firstFingerprintMismatch(a, b), undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('指纹·敏感：已跟踪文件改动 1 字节即变', async () => {
  const dir = await seedFingerprintRepo()
  try {
    const before = await captureWorktreeFingerprint(dir)
    await writeFile(path.join(dir, 'a.md'), '# a\nX')
    const after = await captureWorktreeFingerprint(dir)
    assert.notEqual(before, after)
    assert.ok(firstFingerprintMismatch(before, after) !== undefined, '应能定位首差行')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('指纹·敏感：新增未跟踪文件（含嵌套目录）即变——git diff 不覆盖的盲区由工作树行走覆盖', async () => {
  const dir = await seedFingerprintRepo()
  try {
    const before = await captureWorktreeFingerprint(dir)
    await mkdir(path.join(dir, 'notes', 'deep'), { recursive: true })
    await writeFile(path.join(dir, 'notes', 'deep', 'u.md'), '# untracked\n')
    const after = await captureWorktreeFingerprint(dir)
    assert.notEqual(before, after, '未跟踪文件必须进入指纹（D7 保护对象）')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('指纹·敏感：暂存区变更即变（git add 后 --cached 面）', async () => {
  const dir = await seedFingerprintRepo()
  try {
    await writeFile(path.join(dir, 'a.md'), '# staged\n')
    const before = await captureWorktreeFingerprint(dir)
    git(dir, 'add', 'a.md')
    const after = await captureWorktreeFingerprint(dir)
    assert.notEqual(before, after, '暂存动作本身必须改变指纹（index 字节）')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('指纹·敏感：新提交（HEAD 移动）即变', async () => {
  const dir = await seedFingerprintRepo()
  try {
    const before = await captureWorktreeFingerprint(dir)
    await writeFile(path.join(dir, 'b.md'), '# b\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-m', 'c1')
    const after = await captureWorktreeFingerprint(dir)
    assert.notEqual(before, after)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('指纹·敏感：切换分支即变', async () => {
  const dir = await seedFingerprintRepo()
  try {
    const before = await captureWorktreeFingerprint(dir)
    git(dir, 'checkout', '--quiet', '-b', 'feature')
    const after = await captureWorktreeFingerprint(dir)
    assert.notEqual(before, after)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('指纹·敏感：删除已跟踪文件（未暂存删除）即变', async () => {
  const dir = await seedFingerprintRepo()
  try {
    const before = await captureWorktreeFingerprint(dir)
    rmSync(path.join(dir, 'a.md'))
    const after = await captureWorktreeFingerprint(dir)
    assert.notEqual(before, after)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('指纹·敏感：可执行位变更即变', async () => {
  const dir = await seedFingerprintRepo()
  try {
    const before = await captureWorktreeFingerprint(dir)
    chmodSync(path.join(dir, 'a.md'), 0o755)
    git(dir, 'add', 'a.md') // 记入 index 的 mode 位
    const after = await captureWorktreeFingerprint(dir)
    assert.notEqual(before, after)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('firstFingerprintMismatch：不同指纹返回首差行（带节名，可定位）', () => {
  const a = '== status ==\nfoo\n== diff ==\nbar\n'
  const b = '== status ==\nfoo\n== diff ==\nBAZ\n'
  const mismatch = firstFingerprintMismatch(a, b)
  assert.ok(mismatch !== undefined)
  assert.match(mismatch, /diff|BAZ|bar/)
  assert.equal(firstFingerprintMismatch(a, a), undefined)
})

// ── last-sync：上次同步时间标记（T4 状态文件的本地形状） ──────────────────────

test('last-sync·往返：写入后读回同一 ISO 时间串', async () => {
  await withRoot(async (root) => {
    const dir = path.join(root, 'alpha')
    await mkdir(path.join(dir, '.git'), { recursive: true })
    const when = new Date('2026-10-13T01:02:03.456Z')
    await writeLastSync(dir, when)
    assert.equal(readLastSync(dir), '2026-10-13T01:02:03.456Z')
  })
})

test('last-sync·缺省与坏内容：无标记 → null；非 ISO 内容 → null（读侧容忍）', async () => {
  await withRoot(async (root) => {
    const dir = path.join(root, 'alpha')
    await mkdir(path.join(dir, '.git'), { recursive: true })
    assert.equal(readLastSync(dir), null, '无标记应为 null')
    await writeFile(path.join(dir, '.git', 'notegit-last-sync'), 'garbage')
    assert.equal(readLastSync(dir), null, '坏内容应折叠为 null 而非抛出')
  })
})

test('last-sync·覆盖与健壮：后写覆盖先写；非 git 目录写入不抛（静默跳过）', async () => {
  await withRoot(async (root) => {
    const dir = path.join(root, 'alpha')
    await mkdir(path.join(dir, '.git'), { recursive: true })
    await writeLastSync(dir, new Date('2026-10-13T00:00:00Z'))
    await writeLastSync(dir, new Date('2026-10-13T12:00:00Z'))
    assert.equal(readLastSync(dir), '2026-10-13T12:00:00.000Z', '后写覆盖先写')

    const plain = path.join(root, 'plain')
    await mkdir(plain)
    await writeLastSync(plain, new Date('2026-10-13T00:00:00Z')) // 无 .git——不抛
    assert.equal(readLastSync(plain), null)
  })
})

// ── 引擎跳过上报：被跳过库携带原因 + 离线副本 commit + 上次同步时间 ─────────────

function noOpSyncOps(): SyncOps {
  return {
    clone: async () => {},
    fastForward: async () => {},
    revHead: async () => SHA1,
  }
}

test('引擎·跳过上报：dirty 跳过携带离线副本 head 与上次同步时间（读标记），且零变更操作', async () => {
  await withRoot(async (root) => {
    const dir = path.join(root, 'alpha')
    await mkdir(path.join(dir, '.git'), { recursive: true })
    await writeLastSync(dir, new Date('2026-10-13T08:00:00Z'))
    const out = await applySyncStrategy({
      root,
      slug: 'alpha',
      cloneUrl: 'https://s/git/alpha.git',
      defaultBranch: 'main',
      info: { state: 'dirty', path: dir, branch: 'main', head: SHA1, remote_tip: null, message: null },
      ops: noOpSyncOps(),
    })
    assert.equal(out.action, 'skipped')
    if (out.action === 'skipped') {
      assert.equal(out.head, SHA1, '离线副本 commit = 本地 head')
      assert.equal(out.last_sync, '2026-10-13T08:00:00.000Z')
      assert.match(out.reason, /未提交修改/)
    }
  })
})

test('引擎·跳过上报：无标记 → last_sync 为 null（head 仍携带；从未经 notegit 同步的副本）', async () => {
  await withRoot(async (root) => {
    const dir = path.join(root, 'alpha')
    await mkdir(path.join(dir, '.git'), { recursive: true })
    const out = await applySyncStrategy({
      root,
      slug: 'alpha',
      cloneUrl: 'https://s/git/alpha.git',
      defaultBranch: 'main',
      info: { state: 'ahead', path: dir, branch: 'main', head: SHA1, remote_tip: '2222222222222222222222222222222222222222', message: null },
      ops: noOpSyncOps(),
    })
    assert.equal(out.action, 'skipped')
    if (out.action === 'skipped') {
      assert.equal(out.head, SHA1)
      assert.equal(out.last_sync, null, '从未同步过的副本 last_sync 为 null')
    }
  })
})
