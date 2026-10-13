import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { rulesVersion, renderMessage } from 'notegit-validation'
import { schemaCheck } from '../../packages/validation/test/helpers/schema-check.ts'

// S6-T4 黑盒层：测试目标 = dist 产物（与 cli.test.ts / ls.test.ts 同约定）。
// 覆盖：S1 部分暂存只校验暂存内容（契约 §1 防校验错对象——读 index 不读工作
// 目录）、--all 全跟踪树、--json 报告过 validation-report.schema.json、退出码
// 0/1/2 契约、规则版本提示三态（本地 mock server 驱动）、hook 等价入口（单元层
// 另见 lint-unit.test.ts）。
const BIN = new URL('../dist/bin/notegit.js', import.meta.url).pathname

// 契约单一来源（只读消费）：报告 schema + validation 包自证过的内嵌校验器
const reportSchema = JSON.parse(
  readFileSync(new URL('../../docs/contracts/schemas/validation-report.schema.json', import.meta.url), 'utf8'),
)

const VALID_MD = `---
title: 基线文档
---

正文。
`
const NO_FM_MD = `# 没有 frontmatter 的知识文档\n`

/** 同步 git（测试装配用；-c 身份避免依赖全局配置）。 */
function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', ['-c', 'user.name=notegit-test', '-c', 'user.email=notegit-test@example.invalid', ...args], {
    cwd,
    encoding: 'utf8',
  })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr}`)
}

const repos: string[] = []

/** 新建临时 git 仓库（含初始提交），返回路径；after 统一清理。 */
async function initRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'notegit-lint-'))
  repos.push(dir)
  git(dir, 'init', '-b', 'main')
  await writeFile(path.join(dir, 'README.md'), '# 导航\n')
  git(dir, 'add', 'README.md')
  git(dir, 'commit', '-m', 'c0')
  return dir
}

interface LintRun {
  status: number | null
  stdout: string
  stderr: string
}

// 异步 spawn（非 spawnSync）：版本提示三态用例在测试进程内起假服务器，
// spawnSync 会冻结事件循环导致子进程 fetch 自死锁（S6-T2/T3 同教训）。
async function runLint(
  args: string[],
  opts: { cwd?: string; server?: string; token?: string } = {},
): Promise<LintRun> {
  const env: Record<string, string> = {
    PATH: process.env['PATH']!,
    HOME: path.join(tmpdir(), 'notegit-lint-nohome'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  }
  if (opts.server !== undefined) env['NOTEGIT_SERVER'] = opts.server
  if (opts.token !== undefined) env['NOTEGIT_TOKEN'] = opts.token
  const child = spawn(process.execPath, [BIN, 'lint', ...args], { cwd: opts.cwd, env })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (d: string) => (stdout += d))
  child.stderr.on('data', (d: string) => (stderr += d))
  const [code] = (await once(child, 'close')) as [number | null]
  return { status: code, stdout, stderr }
}

interface ReportDoc {
  rulesVersion: string
  scope: string
  result: string
  exitCode: number
  summary: { filesTotal: number; filesPassed: number; filesFailed: number; errorCount: number; warningCount: number }
  files: Array<{ path: string; status: string; issues: Array<{ code: string; severity: string }> }>
  notices?: Array<{ code: string; message: string }>
  issues?: Array<{ code: string; severity: string }>
}

function parseReport(r: LintRun): ReportDoc {
  try {
    return JSON.parse(r.stdout) as ReportDoc
  } catch {
    assert.fail(`stdout 不是合法 JSON 报告：${r.stdout.slice(0, 400)}\nstderr：${r.stderr.slice(0, 400)}`)
  }
}

// ── S1：部分暂存只校验暂存内容（契约 §1 防校验错对象）──────────────────────

test('S1 部分暂存：只暂存 2/3 文件时，报告仅含暂存文件（未暂存者不入场）', async () => {
  const dir = await initRepo()
  // 三个知识文档：a=暂存+无效（缺 frontmatter）、b=暂存+有效、c=仅工作目录（无效但未暂存）
  await writeFile(path.join(dir, 'a.md'), NO_FM_MD)
  await writeFile(path.join(dir, 'b.md'), VALID_MD)
  await writeFile(path.join(dir, 'c.md'), NO_FM_MD)
  git(dir, 'add', 'a.md', 'b.md')

  const r = await runLint(['--staged', '--json'], { cwd: dir })
  assert.equal(r.status, 1, `暂存内容含错误应退出 1（stderr：${r.stderr.slice(0, 300)}）`)
  const report = parseReport(r)
  assert.deepEqual(
    report.files.map((f) => f.path).sort(),
    ['a.md', 'b.md'],
    '报告文件集 = 恰好两个已暂存文件；未暂存的 c.md 不得入场（防校验错对象）',
  )
  const a = report.files.find((f) => f.path === 'a.md')!
  assert.equal(a.status, 'fail')
  assert.ok(a.issues.some((i) => i.code === 'E-FM-001'), 'a.md 缺 frontmatter 应报 E-FM-001')
  assert.equal(report.files.find((f) => f.path === 'b.md')!.status, 'pass')
  assert.equal(report.result, 'fail')
  assert.equal(report.summary.filesTotal, 2)
})

test('S1 内容来源 = index：暂存合法内容后再改坏工作目录，--staged 仍通过', async () => {
  const dir = await initRepo()
  await writeFile(path.join(dir, 'x.md'), VALID_MD)
  git(dir, 'add', 'x.md')
  // 暂存后把工作目录改坏（缺 frontmatter）：校验对象是 index，不看工作目录
  await writeFile(path.join(dir, 'x.md'), NO_FM_MD)

  const r = await runLint(['--staged', '--json'], { cwd: dir })
  assert.equal(r.status, 0, `index 内容合法应通过（stderr：${r.stderr.slice(0, 300)}）`)
  const report = parseReport(r)
  assert.equal(report.result, 'pass')
  assert.equal(report.files.length, 1)
  assert.equal(report.files[0]!.path, 'x.md')
  assert.equal(report.files[0]!.status, 'pass')
})

test('仅暂存删除：删除不做元数据校验，空报告通过（契约 §2.5）', async () => {
  const dir = await initRepo()
  await writeFile(path.join(dir, 'gone.md'), VALID_MD)
  git(dir, 'add', 'gone.md')
  git(dir, 'commit', '-m', 'c1')
  git(dir, 'rm', '--cached', 'gone.md')

  const r = await runLint(['--staged', '--json'], { cwd: dir })
  assert.equal(r.status, 0)
  const report = parseReport(r)
  assert.deepEqual(report.files, [])
  assert.equal(report.summary.filesTotal, 0)
  assert.equal(report.result, 'pass')
})

test('暂存重命名（拆为旧删+新增）：仅新路径入场，旧路径不校验', async () => {
  const dir = await initRepo()
  await writeFile(path.join(dir, 'old-name.md'), VALID_MD)
  git(dir, 'add', 'old-name.md')
  git(dir, 'commit', '-m', 'c1')
  git(dir, 'mv', 'old-name.md', 'new-name.md')
  await writeFile(path.join(dir, 'new-name.md'), NO_FM_MD) // 重命名后内容破坏 → 目标路径须有合法 frontmatter
  git(dir, 'add', 'new-name.md')

  const r = await runLint(['--staged', '--json'], { cwd: dir })
  assert.equal(r.status, 1)
  const report = parseReport(r)
  assert.deepEqual(report.files.map((f) => f.path), ['new-name.md'], '重命名按目标路径重新判定；旧路径删除不校验')
  assert.ok(report.files[0]!.issues.some((i) => i.code === 'E-FM-001'))
})

// ── --all：全工作树 = index 全部已跟踪条目（「将提交的完整树」语义）──────────

test('--all：校验全部已跟踪条目（含未变更文件）；未暂存的工作目录破坏不反映（内容取 index）', async () => {
  const dir = await initRepo()
  await writeFile(path.join(dir, 'committed-good.md'), VALID_MD)
  git(dir, 'add', 'committed-good.md')
  git(dir, 'commit', '-m', 'c1')
  // staged-bad：暂存坏内容；worktree-only 破坏的 committed-good2 不反映
  await writeFile(path.join(dir, 'staged-bad.md'), NO_FM_MD)
  git(dir, 'add', 'staged-bad.md')
  const committedGood2 = path.join(dir, 'committed-good.md')
  await writeFile(committedGood2, NO_FM_MD) // 工作目录改坏但未暂存 → --all 仍按 index 判定

  const r = await runLint(['--all', '--json'], { cwd: dir })
  assert.equal(r.status, 1)
  const report = parseReport(r)
  assert.deepEqual(
    report.files.map((f) => f.path).sort(),
    ['README.md', 'committed-good.md', 'staged-bad.md'],
    '--all 覆盖 index 全部条目（README 豁免也入报告）',
  )
  assert.equal(report.files.find((f) => f.path === 'committed-good.md')!.status, 'pass', 'index 内容合法，工作目录破坏不影响判定')
  assert.equal(report.files.find((f) => f.path === 'staged-bad.md')!.status, 'fail')
})

test('README 豁免以 exempt: true 入报告（豁免仅限 frontmatter，仍受类型/容量规则）', async () => {
  const dir = await initRepo()
  await writeFile(path.join(dir, 'README.md'), '# 无 frontmatter 的导航\n')
  git(dir, 'add', 'README.md')

  const r = await runLint(['--staged', '--json'], { cwd: dir })
  assert.equal(r.status, 0)
  const report = parseReport(r)
  const readme = report.files.find((f) => f.path === 'README.md')!
  assert.equal(readme.status, 'pass')
  assert.equal((readme as { exempt?: boolean }).exempt, true)
  assert.ok(!readme.issues.some((i) => i.code.startsWith('E-FM-')), '豁免不产生 E-FM-*')
})

test('暂存符号链接：按 index mode 判 E-PATH-002（不读 blob）', async () => {
  const dir = await initRepo()
  await writeFile(path.join(dir, 'target.md'), VALID_MD)
  const sl = spawnSync('ln', ['-s', 'target.md', 'link.md'], { cwd: dir })
  assert.equal(sl.status, 0, `ln -s 应成功：${sl.stderr}`)
  git(dir, 'add', 'target.md', 'link.md')

  const r = await runLint(['--staged', '--json'], { cwd: dir })
  assert.equal(r.status, 1)
  const report = parseReport(r)
  const link = report.files.find((f) => f.path === 'link.md')!
  assert.equal(link.status, 'fail')
  assert.ok(link.issues.some((i) => i.code === 'E-PATH-002'), `link.md 应报 E-PATH-002：${JSON.stringify(link.issues)}`)
})

test('非 UTF-8 的 .md：内容解码失败报 E-FM-002（退出 1）', async () => {
  const dir = await initRepo()
  // 0xff 0xfe 开头 + 孤立续字节：必非合法 UTF-8
  await writeFile(path.join(dir, 'binary.md'), Buffer.from([0x2d, 0x2d, 0x2d, 0x0a, 0xff, 0xfe, 0x0a, 0x74, 0x69, 0x74, 0x6c, 0x65, 0x3a, 0x20, 0xe0, 0x0a, 0x2d, 0x2d, 0x2d, 0x0a]))
  git(dir, 'add', 'binary.md')

  const r = await runLint(['--staged', '--json'], { cwd: dir })
  assert.equal(r.status, 1)
  const report = parseReport(r)
  assert.ok(
    report.files[0]!.issues.some((i) => i.code === 'E-FM-002'),
    `非 UTF-8 .md 应报 E-FM-002：${JSON.stringify(report.files[0]!.issues)}`,
  )
})

// ── 报告协议与退出码契约 ──────────────────────────────────────────────────────

test('--json 报告过 validation-report.schema.json（fail 与 pass 两形态）', async () => {
  const failRepo = await initRepo()
  await writeFile(path.join(failRepo, 'bad.md'), NO_FM_MD)
  git(failRepo, 'add', 'bad.md')
  const failRun = await runLint(['--staged', '--json'], { cwd: failRepo })
  const failDoc = JSON.parse(failRun.stdout)
  assert.deepEqual(schemaCheck(reportSchema, failDoc), [], 'fail 报告应过 schema')
  assert.equal(failDoc['exitCode'], failRun.status, 'schema 的 result↔exitCode 映射与实际退出码一致')

  const passRepo = await initRepo()
  await writeFile(path.join(passRepo, 'good.md'), VALID_MD)
  git(passRepo, 'add', 'good.md')
  const passRun = await runLint(['--staged', '--json'], { cwd: passRepo })
  const passDoc = JSON.parse(passRun.stdout)
  assert.deepEqual(schemaCheck(reportSchema, passDoc), [], 'pass 报告应过 schema')
  assert.equal(passRun.status, 0)
  assert.equal(passDoc['scope'], 'pre-commit', '本地端 scope=pre-commit（契约 §1）')
})

test('运行错误（非 git 仓库）：退出码 2，--json 输出 result=error 的 E-RUN-002 报告且过 schema', async () => {
  const notARepo = await mkdtemp(path.join(tmpdir(), 'notegit-notrepo-'))
  repos.push(notARepo)
  const r = await runLint(['--staged', '--json'], { cwd: notARepo })
  assert.equal(r.status, 2)
  const report = parseReport(r)
  assert.equal(report.result, 'error')
  assert.equal(report.exitCode, 2)
  assert.ok(report.issues!.some((i) => i.code === 'E-RUN-002'))
  assert.deepEqual(schemaCheck(reportSchema, JSON.parse(r.stdout)), [], 'error 报告应过 schema')
})

test('用法错误退出码 2：缺模式 / 模式互斥 / 未知旗标 / 位置参数', async () => {
  const dir = await initRepo()
  for (const [args, why] of [
    [['--json'], '缺 --staged/--all'],
    [['--staged', '--all'], '两模式互斥'],
    [['--staged', '--definitely'], '未知旗标'],
    [['--staged', 'extra.txt'], '位置参数'],
  ] as const) {
    const r = await runLint([...args], { cwd: dir })
    assert.equal(r.status, 2, `${why} 应退出 2`)
    assert.match(r.stderr, /lint/, `${why}：stderr 指明 lint`)
  }
})

test('人类可读输出（无 --json）：含问题行与小结，退出码同报告', async () => {
  const dir = await initRepo()
  await writeFile(path.join(dir, 'bad.md'), NO_FM_MD)
  git(dir, 'add', 'bad.md')
  const r = await runLint(['--staged'], { cwd: dir })
  assert.equal(r.status, 1)
  assert.match(r.stdout, /bad\.md/)
  assert.match(r.stdout, /E-FM-001/)
  assert.doesNotMatch(r.stdout, /^\s*\{/m, '非 --json 不输出 JSON')
})

// ── 规则版本提示三态（本地 mock server；端点 = T7 补录 api.md 后的生产形态）──

let probeServer: http.Server
let probeUrl = ''
let probeMode: 'stale' | 'same' | 'missing' = 'same'
const PROBE_TOKEN = `ngt_${'p'.repeat(43)}`

before(async () => {
  probeServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://notegit.invalid')
    if (url.pathname === '/api/v1/rules-version' && req.method === 'GET') {
      if (probeMode === 'missing') {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { code: 'E-RES-001', message: '资源不存在' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ rulesVersion: probeMode === 'stale' ? '99.0.0' : rulesVersion() }))
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => probeServer.listen(0, '127.0.0.1', resolve))
  probeUrl = `http://127.0.0.1:${(probeServer.address() as { port: number }).port}`
})

after(async () => {
  await new Promise<void>((resolve) => probeServer.close(() => resolve()))
  await Promise.allSettled(repos.map((d) => rm(d, { recursive: true, force: true })))
})

test('版本提示·旧于服务端：报告 notices 附 N-UPGRADE-001（注册表模板），退出码不受影响', async () => {
  probeMode = 'stale'
  const dir = await initRepo()
  await writeFile(path.join(dir, 'good.md'), VALID_MD)
  git(dir, 'add', 'good.md')
  const r = await runLint(['--staged', '--json'], { cwd: dir, server: probeUrl, token: PROBE_TOKEN })
  assert.equal(r.status, 0, 'info 级提示不改变退出码（N- 码 exit 0）')
  const report = parseReport(r)
  assert.equal(report.notices?.length, 1)
  assert.equal(report.notices![0]!.code, 'N-UPGRADE-001')
  assert.equal(
    report.notices![0]!.message,
    renderMessage('N-UPGRADE-001', { actual: rulesVersion(), expected: '99.0.0' }),
    '提示消息 = 注册表模板单源渲染',
  )
  assert.equal(report.result, 'pass', '版本差异本身不构成拒绝理由')
})

test('版本提示·与服务端同版：无 notices', async () => {
  probeMode = 'same'
  const dir = await initRepo()
  await writeFile(path.join(dir, 'good.md'), VALID_MD)
  git(dir, 'add', 'good.md')
  const r = await runLint(['--staged', '--json'], { cwd: dir, server: probeUrl, token: PROBE_TOKEN })
  assert.equal(r.status, 0)
  assert.equal(parseReport(r).notices, undefined)
})

test('版本提示·端点缺失（404）：跳过提示（stderr 一行），报告无 notices，校验照常', async () => {
  probeMode = 'missing'
  const dir = await initRepo()
  await writeFile(path.join(dir, 'bad.md'), NO_FM_MD)
  git(dir, 'add', 'bad.md')
  const r = await runLint(['--staged', '--json'], { cwd: dir, server: probeUrl, token: PROBE_TOKEN })
  assert.equal(r.status, 1, '提示跳过不影响校验判定')
  const report = parseReport(r)
  assert.equal(report.notices, undefined)
  assert.match(r.stderr, /跳过规则版本提示/, 'stderr 说明跳过')
  assert.equal(report.result, 'fail')
})

test('版本提示·服务端不可达：跳过提示不失败（本地校验离线可用）', async () => {
  const dir = await initRepo()
  await writeFile(path.join(dir, 'good.md'), VALID_MD)
  git(dir, 'add', 'good.md')
  const r = await runLint(['--staged', '--json'], { cwd: dir, server: 'http://127.0.0.1:1', token: PROBE_TOKEN })
  assert.equal(r.status, 0)
  assert.equal(parseReport(r).notices, undefined)
  assert.match(r.stderr, /跳过规则版本提示/)
})

test('版本提示·未配置凭据：静默跳过（本地命令不强制服务端）', async () => {
  const dir = await initRepo()
  await writeFile(path.join(dir, 'good.md'), VALID_MD)
  git(dir, 'add', 'good.md')
  const r = await runLint(['--staged', '--json'], { cwd: dir })
  assert.equal(r.status, 0)
  assert.equal(parseReport(r).notices, undefined)
  assert.equal(r.stderr, '', '未配置凭据不输出跳过提示（非错误状态）')
})

test('版本提示·校验失败场景：notices 与 fail 判定共存，退出码仍 1', async () => {
  probeMode = 'stale'
  const dir = await initRepo()
  await writeFile(path.join(dir, 'bad.md'), NO_FM_MD)
  git(dir, 'add', 'bad.md')
  const r = await runLint(['--staged', '--json'], { cwd: dir, server: probeUrl, token: PROBE_TOKEN })
  assert.equal(r.status, 1)
  const report = parseReport(r)
  assert.equal(report.result, 'fail')
  assert.equal(report.notices?.[0]?.code, 'N-UPGRADE-001', '失败报告同样携带版本提示')
})

test('版本提示·人类可读输出：提示行出现在 stdout 小结之后', async () => {
  probeMode = 'stale'
  const dir = await initRepo()
  await writeFile(path.join(dir, 'good.md'), VALID_MD)
  git(dir, 'add', 'good.md')
  const r = await runLint(['--staged'], { cwd: dir, server: probeUrl, token: PROBE_TOKEN })
  assert.equal(r.status, 0)
  assert.match(r.stdout, /N-UPGRADE-001/)
  assert.match(r.stdout, /notegit setup 更新/)
})


