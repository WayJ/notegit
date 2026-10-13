import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'

// S6-T7 三端规则版本一致性（breakdown §2.5 S6-T7 行；validation §7.3；sprint 场景 S5）。
// 三端 = CLI 内嵌（dist 产物）== docs/contracts/rules-version.json（唯一机器来源）
// == 服务端 GET /api/v1/rules-version 响应。服务端链在 server/test/rules-version-routes
// 固化（端点响应 vs manifest 文件直读）；本文件固化 CLI 链与构建/打包/安装态断言，
// CI 两链经同一 manifest 文件合成三端一致（transitive，无需跨 workspace 依赖）。

// ── T4 激活：端点常量 == api.md 补录端点（探测路径与契约文档单一事实） ──────────

test('T4 激活：RULES_VERSION_ENDPOINT 与 api.md 补录的端点路径一致', async () => {
  const { RULES_VERSION_ENDPOINT } = await import('../src/lint/version-probe.ts')
  assert.equal(RULES_VERSION_ENDPOINT, '/api/v1/rules-version')
  const apiMd = readFileSync(new URL('../../docs/contracts/api.md', import.meta.url), 'utf8')
  assert.ok(
    apiMd.includes(`GET ${RULES_VERSION_ENDPOINT}`),
    `api.md 应补录端点 GET ${RULES_VERSION_ENDPOINT}（S6-T7 端点表补录）`,
  )
})

// ── 构建断言核心（S6-T7）：assertSameRulesVersion 的漂移判定与提示语义 ─────────
// （单测用合成版本串；对真实 dist/manifest 的应用见下方「三端一致」段。）

test('assertSameRulesVersion：版本相同（含预发布段）→ 通过', async () => {
  const { assertSameRulesVersion } = await import('../test-support/rules-version-consistency.ts')
  assert.doesNotThrow(() => assertSameRulesVersion('1.0.0', '1.0.0'))
  assert.doesNotThrow(() => assertSameRulesVersion('1.0.0-draft.1', '1.0.0-draft.1'))
})

test('assertSameRulesVersion：MAJOR 漂移 → 失败并提示三端同步升级（validation §7.2 情形 C）', async () => {
  const { assertSameRulesVersion } = await import('../test-support/rules-version-consistency.ts')
  assert.throws(
    () => assertSameRulesVersion('1.0.0', '2.0.0'),
    (e: Error) =>
      e.message.includes('MAJOR') &&
      e.message.includes('三端') &&
      e.message.includes('同步') &&
      e.message.includes('1.0.0') &&
      e.message.includes('2.0.0'),
  )
})

test('assertSameRulesVersion：MINOR/PATCH/预发布漂移 → 失败并提示重新构建（非 MAJOR 文案）', async () => {
  const { assertSameRulesVersion } = await import('../test-support/rules-version-consistency.ts')
  for (const [a, b] of [
    ['1.0.0', '1.1.0'],
    ['1.0.0', '1.0.1'],
    ['1.0.0-draft.1', '1.0.0-draft.2'],
    ['1.0.0-draft.1', '1.0.0'],
  ] as const) {
    assert.throws(
      () => assertSameRulesVersion(a, b),
      (e: Error) => e.message.includes('重新构建') && !e.message.includes('MAJOR 漂移'),
      `${a} vs ${b} 应以非 MAJOR 漂移失败`,
    )
  }
})

test('assertSameRulesVersion：任一侧不可按 SemVer 解析 → 失败（fail-closed，不可比不等于一致）', async () => {
  const { assertSameRulesVersion } = await import('../test-support/rules-version-consistency.ts')
  assert.throws(() => assertSameRulesVersion('1.0', '1.0.0'), /无法/)
  assert.throws(() => assertSameRulesVersion('1.0.0', 'v1.0.0'), /无法/)
})

// ── 三端一致链之 CLI 链（构建断言，breakdown §2.5 S6-T7 完成标准；场景 S5）─────
// dist 由 npm test 的 build 步骤新鲜构建；此处读产物，不重新触发 tsc。

function readManifest(p: string): { rulesVersion: string; status: string } {
  return JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8')) as { rulesVersion: string; status: string }
}

test('CLI 内嵌（文件面）：dist/docs/contracts/rules-version.json 与唯一机器来源逐字一致', async () => {
  const { assertSameRulesVersion } = await import('../test-support/rules-version-consistency.ts')
  const embedded = readManifest('../dist/docs/contracts/rules-version.json')
  const manifest = readManifest('../../docs/contracts/rules-version.json')
  assert.equal(embedded.status, manifest.status, 'status 字段也应一致（端点响应形状的来源）')
  assertSameRulesVersion(embedded.rulesVersion, manifest.rulesVersion)
})

test('CLI 内嵌（运行面）：dist lint 报告的 rulesVersion == manifest——vendored 拷贝真实可跑', async () => {
  // 非 git 目录 → E-RUN-002 错误报告（退出码 2）：报告必带 rulesVersion，取自
  // dist 内嵌 manifest——证明 dist JS → dist/node_modules/notegit-validation（纯 JS
  // vendored）→ dist/docs/contracts 全链接通，不依赖仓库 workspace。
  const { spawn } = await import('node:child_process')
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  const dir = await mkdtemp(path.join(tmpdir(), 'notegit-s6t7-dist-'))
  try {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/bin/notegit.js', import.meta.url)), 'lint', '--all', '--json'], {
      cwd: dir,
      env: { PATH: process.env['PATH']!, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
    })
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d: string) => (out += d))
    let err = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (d: string) => (err += d))
    const [status] = (await once(child, 'close')) as [number | null]
    assert.equal(status, 2, `非 git 仓库应退出 2；stderr：${err.slice(0, 300)}`)
    const report = JSON.parse(out) as { rulesVersion: string; result: string; issues: Array<{ code: string }> }
    assert.equal(report.result, 'error')
    assert.ok(report.issues.some((i) => i.code === 'E-RUN-002'))
    const manifest = readManifest('../../docs/contracts/rules-version.json')
    assert.equal(report.rulesVersion, manifest.rulesVersion, 'dist 运行时应从内嵌 manifest 取版本')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('vendored 自包含：dist/node_modules/notegit-validation 纯 JS、exports 指 .js、运行时双契约文件在场', async () => {
  const { readdirSync, statSync } = await import('node:fs')
  const vendored = new URL('../dist/node_modules/notegit-validation/', import.meta.url)
  const pkg = JSON.parse(readFileSync(new URL('package.json', vendored), 'utf8')) as {
    name: string
    type: string
    exports: Record<string, string>
  }
  assert.equal(pkg.name, 'notegit-validation')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.exports['.'], './src/index.js', 'vendored 包 exports 应指纯 JS 入口')
  // 递归无 .ts（Node ≥22.13 且 node_modules 下拒绝类型剥离——T1 实测缺陷形态）
  const tsFiles: string[] = []
  const walk = (u: URL): void => {
    for (const e of readdirSync(u)) {
      const child = new URL(`${e}${statSync(new URL(e, u)).isDirectory() ? '/' : ''}`, u)
      if (statSync(child).isDirectory()) walk(child)
      else if (e.endsWith('.ts')) tsFiles.push(`${u.href}${e}`)
    }
  }
  walk(vendored)
  assert.deepEqual(tsFiles, [], `vendored 面不得含 .ts（T1：node_modules 下类型剥离被 Node 拒绝）：${tsFiles.join(', ')}`)
  // validation 运行时读取的两个契约文件（contract.ts readContractJson 消费面）
  for (const f of ['rules-version.json', 'validation-defaults.json']) {
    JSON.parse(readFileSync(new URL(`../dist/docs/contracts/${f}`, import.meta.url), 'utf8'))
  }
})

// ── 打包产物面：三端一致断言的对象随包分发（T5 移交：dist/src/hooks 断言） ──────

function npmPackDryRun(): Array<{ path: string }> {
  const r = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  assert.equal(r.status, 0, `npm pack --dry-run 应成功，stderr：${r.stderr.slice(0, 500)}`)
  return (JSON.parse(r.stdout) as Array<{ files: Array<{ path: string }> }>)[0]!.files
}

test('pack 清单含三端一致产物面：vendored validation、内嵌 contracts、dist/src/hooks（T5 移交断言）', () => {
  const paths = npmPackDryRun().map((f) => f.path)
  const must = [
    'dist/node_modules/notegit-validation/package.json',
    'dist/node_modules/notegit-validation/src/index.js',
    'dist/docs/contracts/rules-version.json',
    'dist/docs/contracts/validation-defaults.json',
    'dist/src/hooks/pre-commit.js',
    'dist/src/hooks/install.js',
    'dist/src/hooks/staged.js',
    'dist/src/hooks/git.js',
  ]
  for (const p of must) assert.ok(paths.includes(p), `打包清单缺三端一致产物面条目：${p}`)
})

// ── 安装态独立冒烟（T1 分发形态落地=validation 内嵌 CLI dist，master 裁定） ──────
// 干净 --prefix 安装（模拟用户 npm install，不碰全局），从安装产物运行 lint 与
// hook：不依赖仓库 workspace（notegit-validation 不从 registry 解析——内嵌 dist）。

test('安装态独立 lint 冒烟：干净 --prefix 安装后 lint 与 hook 可独立运行（不依赖 workspace）', async () => {
  const { spawn, spawnSync } = await import('node:child_process')
  const { mkdtemp, mkdir, rm, writeFile, readdir } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  const cliDir = fileURLToPath(new URL('..', import.meta.url))
  const npmEnv = { PATH: process.env['PATH']!, HOME: process.env['HOME']!, TMPDIR: tmpdir() }

  const work = await mkdtemp(path.join(tmpdir(), 'notegit-s6t7-install-'))
  try {
    // 1) 真实 pack（--ignore-scripts：dist 已由 npm test 的 build 步骤新鲜构建，跳过
    //    prepack 重建——避免与并行 dist 产物测试（ls/lint e2e 直跑 dist/bin）竞争
    //    重写 dist 造成的偶发假故障；prepack 构建路径由 pack.test.ts 覆盖）
    const packDest = path.join(work, 'pack')
    await mkdir(packDest)
    const pack = spawnSync('npm', ['pack', '--ignore-scripts', '--pack-destination', packDest], { cwd: cliDir, encoding: 'utf8', env: npmEnv })
    assert.equal(pack.status, 0, `npm pack 应成功，stderr：${pack.stderr.slice(0, 600)}`)
    const tgz = (await readdir(packDest)).find((f) => f.endsWith('.tgz'))
    assert.ok(tgz !== undefined, 'pack 产物 tarball 应存在')

    // 2) 干净安装（独立 node_modules 树；yaml 经 registry/缓存，notegit-validation 只能来自内嵌 dist）
    const installDir = path.join(work, 'install')
    const install = spawnSync('npm', ['install', '--prefix', installDir, path.join(packDest, tgz)], { encoding: 'utf8', env: npmEnv, maxBuffer: 16 * 1024 * 1024 })
    assert.equal(install.status, 0, `干净安装应成功（notegit-validation 不得依赖 registry 解析），stderr：${install.stderr.slice(0, 800)}`)

    const installedBin = path.join(installDir, 'node_modules', 'notegit', 'dist', 'bin', 'notegit.js')
    const installedHook = path.join(installDir, 'node_modules', 'notegit', 'dist', 'src', 'hooks', 'pre-commit.js')

    // 3) 草稿仓库：README + 暂存 good.md（合法）+ bad.md（缺 frontmatter）
    const repo = path.join(work, 'repo')
    await mkdir(repo)
    const git = (...args: string[]) => {
      const r = spawnSync('git', ['-c', 'user.name=notegit-test', '-c', 'user.email=notegit-test@example.invalid', ...args], { cwd: repo, encoding: 'utf8' })
      if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr}`)
    }
    git('init', '-b', 'main')
    await writeFile(path.join(repo, 'README.md'), '# 导航\n')
    git('add', 'README.md')
    git('commit', '-m', 'c0')
    await writeFile(path.join(repo, 'good.md'), '---\ntitle: 安装态合法文档\n---\n\n正文。\n')
    await writeFile(path.join(repo, 'bad.md'), '# 没有 frontmatter\n')
    git('add', 'good.md', 'bad.md')

    const run = async (entry: string, args: string[]) => {
      const child = spawn(process.execPath, [entry, ...args], {
        cwd: repo,
        env: { PATH: process.env['PATH']!, HOME: path.join(work, 'fake-home'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
      })
      let out = ''
      let err = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (d: string) => (out += d))
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (d: string) => (err += d))
      const [status] = (await once(child, 'close')) as [number | null]
      return { status, out, err }
    }

    // lint --staged：bad.md 触 E-FM-001 → 退出 1；报告版本 == manifest（内嵌单一来源）
    const lintRun = await run(installedBin, ['lint', '--staged', '--json'])
    assert.equal(lintRun.status, 1, `安装态 lint 应退出 1；stderr：${lintRun.err.slice(0, 400)}`)
    const lintReport = JSON.parse(lintRun.out) as {
      rulesVersion: string
      files: Array<{ path: string; status: string; issues: Array<{ code: string }> }>
    }
    const manifest = readManifest('../../docs/contracts/rules-version.json')
    assert.equal(lintReport.rulesVersion, manifest.rulesVersion, '安装态报告版本应来自内嵌 manifest')
    const bad = lintReport.files.find((f) => f.path === 'bad.md')
    assert.ok(bad !== undefined && bad.status === 'fail' && bad.issues.some((i) => i.code === 'E-FM-001'), 'bad.md 应触发 E-FM-001')

    // hook ≡ lint（安装态）：pre-commit.js --json 与 bin lint 同一报告（T5 等价在安装产物上成立）
    const hookRun = await run(installedHook, ['--json'])
    assert.equal(hookRun.status, 1, `安装态 hook 应退出 1；stderr：${hookRun.err.slice(0, 400)}`)
    assert.deepEqual(JSON.parse(hookRun.out), JSON.parse(lintRun.out), 'hook 与 lint --staged --json 应产出同一报告')

    // 入口自检回归（S6-T7 安装态冒烟实测缺陷）：经符号链接路径调用 hook 本体时，
    // 入口比较若不解引用 argv[1] 会静默退出 0（放行提交——fail-open）。自建 symlink
    // 入口跨平台复现该形态（不依赖 /tmp 本身是否为链接）。
    const { symlink } = await import('node:fs/promises')
    const linkedHook = path.join(work, 'linked-pre-commit.js')
    await symlink(installedHook, linkedHook)
    const symRun = await run(linkedHook, ['--json'])
    assert.equal(symRun.status, 1, `经符号链接入口调用 hook 应照常运行并退出 1（fail-open 回归）；stdout：${symRun.out.slice(0, 200)}`)
    assert.deepEqual(JSON.parse(symRun.out), JSON.parse(lintRun.out), '符号链接入口与直连入口应产出同一报告')

    // 干净面：提交合法内容后 --all 通过（退出 0）
    git('rm', '--cached', 'bad.md')
    await rm(path.join(repo, 'bad.md'))
    git('commit', '-m', 'c1')
    const cleanRun = await run(installedBin, ['lint', '--all', '--json'])
    assert.equal(cleanRun.status, 0, `安装态 lint --all 全绿应退出 0；stdout：${cleanRun.out.slice(0, 400)}`)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})
