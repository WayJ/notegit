/**
 * S6-T8 主线 e2e（breakdown §2.5 S6-T8 行：安装-登录-lint 修正流程走通；对本地
 * mock/测试实例——test-support/mock-server.ts 真实 git http-backend，S6-T2 同款）。
 *
 * 流程 = README「快速开始」主线的可自动化复刻：
 *   打包安装（单 tarball，validation 内嵌）→ login（凭据 0600 + helper 注册 +
 *   掩码输出）→ git clone（credential helper 免交互、remote URL 无 token）→
 *   lint --staged 报错（E-FM-001，退出码 1）→ 按报告修正 → lint 通过（退出码 0）
 *   → setup 装 hook → 坏提交被 hook 阻断、修正后提交放行。
 * 文档一致性抽检（README ≡ --help、JSON 样例过 schema）另见 docs-consistency.test.ts。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { startMockServer, FAKE_TOKEN, FAKE_USERNAME, type MockServer } from '../test-support/mock-server.ts'
import { schemaCheck } from '../../packages/validation/test/helpers/schema-check.ts'

const CLI_DIR = new URL('..', import.meta.url).pathname
const MASKED = `ngt_${FAKE_TOKEN.slice(4, 6)}…${FAKE_TOKEN.slice(-4)}`

const REPORT_SCHEMA = JSON.parse(
  readFileSync(new URL('../../docs/contracts/schemas/validation-report.schema.json', import.meta.url), 'utf8'),
)

let root: string
let server: MockServer
let env: Record<string, string>
let installedBin: string
let cloneDir: string

interface Run {
  status: number
  stdout: string
  stderr: string
}

/** 异步跑已安装的 notegit（sync spawn 会冻结本进程 mock server——S6-T2/T3 教训）。 */
function runBin(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [installedBin, ...args], { cwd: opts.cwd, env: opts.env ?? env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')))
    child.on('error', () => resolve({ status: 2, stdout, stderr }))
    child.on('close', (code) => resolve({ status: code ?? 2, stdout, stderr }))
    child.stdin.end()
  })
}

/** 异步 git（clone/commit 等会经本进程 mock server 或其派生 hook——sync spawn 冻结
 * 事件循环会让 server 无法应答而自死锁，S6-T2/T3 教训；一律异步）。 */
function git(cwd: string, ...args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      'git',
      ['-c', 'user.name=notegit-test', '-c', 'user.email=notegit-test@example.invalid', ...args],
      { cwd, env },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')))
    child.on('error', () => resolve({ status: 2, stdout, stderr }))
    child.on('close', (code) => resolve({ status: code ?? 2, stdout, stderr }))
    child.stdin.end()
  })
}

before(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'ngt-docs-flow-'))

  // 1) 本地测试实例：真实 git http-backend + /api/v1/credentials（mock-server，S6-T2 同款）
  const projectRoot = path.join(root, 'vaults')
  const bare = path.join(projectRoot, 'engineering-notes.git')
  execFileSync('git', ['init', '--bare', '-b', 'main', bare])
  {
    const seed = path.join(root, 'seed')
    execFileSync('git', ['init', '-b', 'main', seed])
    execFileSync('git', ['-C', seed, 'config', 'user.email', 'seed@notegit-test'])
    execFileSync('git', ['-C', seed, 'config', 'user.name', 'seed'])
    writeFileSync(path.join(seed, 'README.md'), '# 导航\n')
    execFileSync('git', ['-C', seed, 'add', '.'])
    execFileSync('git', ['-C', seed, 'commit', '-m', 'seed'])
    execFileSync('git', ['-C', seed, 'push', bare, 'main'])
  }
  server = await startMockServer(projectRoot, {
    username: FAKE_USERNAME,
    token: FAKE_TOKEN,
    apiOutcome: 'ok',
    gitBasicAccepted: true,
  })

  // 2) 环境隔离（HOME/git 全局/凭据文件全部落在 root）
  env = { ...process.env } as Record<string, string>
  env['HOME'] = root
  env['XDG_CONFIG_HOME'] = path.join(root, '.config')
  env['NOTEGIT_CREDENTIALS_FILE'] = path.join(root, 'credentials')
  env['GIT_CONFIG_GLOBAL'] = path.join(root, '.gitconfig')
  env['GIT_CONFIG_NOSYSTEM'] = '1'
  env['GIT_CONFIG_SYSTEM'] = '/dev/null'
  env['GIT_TERMINAL_PROMPT'] = '0'
  env['NOTEGIT_TOKEN'] = FAKE_TOKEN
  delete env['GIT_ASKPASS']
  delete env['SSH_ASKPASS']

  // 3) 安装：真实 pack（--ignore-scripts：dist 已由 npm test build 步骤新鲜构建，
  //    避免 prepack 重建与并行 dist 产物测试竞争——S6-T7 同教训）→ 干净 --prefix 安装
  const packDest = path.join(root, 'pack')
  mkdirSync(packDest)
  const npmEnv: Record<string, string> = { PATH: process.env['PATH']!, HOME: process.env['HOME']!, TMPDIR: tmpdir() }
  const pack = spawnSync('npm', ['pack', '--ignore-scripts', '--pack-destination', packDest], {
    cwd: CLI_DIR,
    encoding: 'utf8',
    env: npmEnv,
  })
  assert.equal(pack.status, 0, `npm pack 应成功，stderr：${pack.stderr.slice(0, 600)}`)
  const tgz = readdirSync(packDest).find((f) => f.endsWith('.tgz'))
  assert.ok(tgz !== undefined, 'pack 产物 tarball 应存在')
  const installDir = path.join(root, 'install')
  const install = spawnSync('npm', ['install', '--prefix', installDir, path.join(packDest, tgz)], {
    encoding: 'utf8',
    env: npmEnv,
    maxBuffer: 16 * 1024 * 1024,
  })
  assert.equal(install.status, 0, `干净安装应成功（单 tarball 自包含），stderr：${install.stderr.slice(0, 800)}`)
  installedBin = path.join(installDir, 'node_modules', 'notegit', 'dist', 'bin', 'notegit.js')
  assert.ok(existsSync(installedBin), `安装产物应含 bin：${installedBin}`)
})

after(async () => {
  await server.close()
  rmSync(root, { recursive: true, force: true })
})

test('安装：单 tarball 安装后 notegit 可执行，--version 与 --help 真实可用', async () => {
  const v = await runBin(['--version'])
  assert.equal(v.status, 0)
  assert.equal(v.stdout.trim(), 'notegit 0.0.0', `--version 应输出版本，实际：${v.stdout}`)
  const h = await runBin(['--help'])
  assert.equal(h.status, 0)
  for (const name of ['login', 'ls', 'lint', 'setup', 'sync']) {
    assert.ok(h.stdout.includes(name), `--help 应列出 ${name}`)
  }
  assert.ok(h.stdout.includes('S7'), 'sync 占位应标注 S7（文档主线与实现一致的安装态验证）')
})

test('登录：login 成功——掩码输出、凭据 0600、helper 注册；全文无明文 token', async () => {
  const r = await runBin(['login', server.baseUrl, '--username', FAKE_USERNAME])
  assert.equal(r.status, 0, `login 应成功，stderr：${r.stderr}`)
  assert.ok(r.stdout.includes(MASKED), `stdout 应含掩码 ${MASKED}，实际：${r.stdout}`)
  assert.ok(!r.stdout.includes(FAKE_TOKEN) && !r.stderr.includes(FAKE_TOKEN), '输出不得含明文 token')
  const credFile = path.join(root, 'credentials')
  assert.ok(existsSync(credFile), '凭据文件应存在')
  assert.equal(statSync(credFile).mode & 0o777, 0o600, '凭据文件权限应为 0600')
  const helperKey = `credential.http://127.0.0.1:${server.port}.helper`
  const readBack = spawnSync('git', ['config', '--global', '--get-all', helperKey], { encoding: 'utf8', env })
  assert.equal(readBack.status, 0, `helper 应按 host 注册（${helperKey}），stderr：${readBack.stderr}`)
  assert.ok(readBack.stdout.includes('credential'), `helper 值应为本 CLI credential 子命令，stdout：${readBack.stdout}`)
  const gitconfig = readFileSync(path.join(root, '.gitconfig'), 'utf8')
  assert.ok(!gitconfig.includes(FAKE_TOKEN), '.gitconfig 不得含明文 token')
})

test('克隆：credential helper 免交互 clone 成功；remote URL 不含 token', async () => {
  cloneDir = path.join(root, 'knowbase', 'engineering-notes')
  mkdirSync(path.dirname(cloneDir), { recursive: true })
  const r = await git(root, 'clone', `${server.baseUrl}/engineering-notes.git`, cloneDir)
  assert.equal(r.status, 0, `clone 应免交互成功（helper 供凭据），stderr：${r.stderr}`)
  assert.ok(existsSync(path.join(cloneDir, 'README.md')), 'clone 内容应落地')
  const config = readFileSync(path.join(cloneDir, '.git', 'config'), 'utf8')
  assert.ok(config.includes(`${server.baseUrl}/engineering-notes.git`))
  assert.ok(!config.includes(FAKE_TOKEN), '.git/config 不得含明文 token')
})

test('lint：坏文档报 E-FM-001 退出码 1（--json 报告过 schema）→ 按报告修正 → 退出码 0', async () => {
  // 报错侧（README「校验循环」同一步骤）
  writeFileSync(path.join(cloneDir, 'bad.md'), '# 没有 frontmatter 的知识文档\n')
  assert.equal((await git(cloneDir, 'add', 'bad.md')).status, 0)
  const bad = await runBin(['lint', '--staged'], { cwd: cloneDir })
  assert.equal(bad.status, 1, `校验错误应退出 1，stderr：${bad.stderr}`)
  assert.ok(bad.stdout.includes('E-FM-001'), `报告应含 E-FM-001，实际：${bad.stdout}`)
  const badJson = await runBin(['lint', '--staged', '--json'], { cwd: cloneDir })
  assert.equal(badJson.status, 1)
  const report = JSON.parse(badJson.stdout) as Record<string, unknown>
  assert.deepEqual(schemaCheck(REPORT_SCHEMA, report), [], '安装态 --json 报告应过契约 schema')
  assert.equal(report['result'], 'fail')
  assert.equal(report['exitCode'], 1)

  // 修正侧：按报告补 frontmatter 后复跑
  writeFileSync(path.join(cloneDir, 'bad.md'), '---\ntitle: 修复后的文档\n---\n\n正文。\n')
  assert.equal((await git(cloneDir, 'add', 'bad.md')).status, 0)
  const good = await runBin(['lint', '--staged'], { cwd: cloneDir })
  assert.equal(good.status, 0, `修正后应退出 0，stdout：${good.stdout}`)
  assert.ok(good.stdout.includes('通过'))
})

test('setup + hook：安装 hook；坏提交被阻断（fail-closed）；修正后提交放行', async () => {
  const setup = await runBin(['setup'], { cwd: cloneDir })
  assert.equal(setup.status, 0, `setup 应成功，stderr：${setup.stderr}`)
  assert.ok(setup.stdout.includes('已安装 notegit pre-commit hook'), `stdout：${setup.stdout}`)
  assert.ok(existsSync(path.join(cloneDir, '.git', 'hooks', 'pre-commit')), 'hook 应已安装')

  // 坏提交：hook 阻断并回显报告（README：提交已阻止提示）
  writeFileSync(path.join(cloneDir, 'worse.md'), '# 又一个没有 frontmatter 的文档\n')
  assert.equal((await git(cloneDir, 'add', 'worse.md')).status, 0)
  const blocked = await git(cloneDir, 'commit', '-m', 'bad commit')
  assert.notEqual(blocked.status, 0, '坏提交应被 hook 阻断')
  assert.ok(
    `${blocked.stdout}${blocked.stderr}`.includes('E-FM-001'),
    `阻断输出应含 E-FM-001，实际：${blocked.stdout}${blocked.stderr}`,
  )

  // 修正：移出坏文件后，合法内容提交放行
  assert.equal((await git(cloneDir, 'reset', '-q', 'HEAD', '--', 'worse.md')).status, 0)
  rmSync(path.join(cloneDir, 'worse.md'))
  const ok = await git(cloneDir, 'commit', '-m', 'docs: 修复 frontmatter')
  assert.equal(ok.status, 0, `合法提交应放行，stderr：${ok.stderr}`)
  const head = await git(cloneDir, 'log', '-1', '--format=%s')
  assert.equal(head.stdout.trim(), 'docs: 修复 frontmatter')
})
