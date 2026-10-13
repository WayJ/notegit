import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// 测试目标 = 分发产物（dist），不是源码 .ts：干净环境 npm install -g 后运行的就是它
// （Node 对 node_modules 下的 .ts 不做类型剥离——ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING）
const BIN = new URL('../dist/bin/notegit.js', import.meta.url).pathname
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }

function runCli(args: string[], opts: { cwd?: string } = {}): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', cwd: opts.cwd })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

test('--version：退出码 0，stdout 为 notegit <版本>，版本与 package.json 单源一致', () => {
  const r = runCli(['--version'])
  assert.equal(r.status, 0)
  assert.equal(r.stdout.trim(), `notegit ${pkg.version}`)
})

test('-v 短旗标与 --version 输出一致', () => {
  const r = runCli(['-v'])
  assert.equal(r.status, 0)
  assert.equal(r.stdout.trim(), `notegit ${pkg.version}`)
})

test('--help：退出码 0，stdout 列出全部五个子命令', () => {
  const r = runCli(['--help'])
  assert.equal(r.status, 0)
  for (const name of ['login', 'ls', 'setup', 'lint', 'sync']) {
    assert.match(r.stdout, new RegExp(`(^|\\s)${name}(\\s|$)`, 'm'), `帮助中应出现命令 ${name}`)
  }
})

test('--help：声明退出码契约 0/1/2 三态语义', () => {
  const r = runCli(['--help'])
  assert.equal(r.status, 0)
  assert.match(r.stdout, /退出码/)
  assert.match(r.stdout, /0[^\n]*成功/)
  assert.match(r.stdout, /1[^\n]*失败/)
  assert.match(r.stdout, /2[^\n]*(用法|运行)错误/)
})

test('-h 与 --help 输出一致（stdout 全同）', () => {
  const r1 = runCli(['-h'])
  const r2 = runCli(['--help'])
  assert.equal(r1.status, 0)
  assert.equal(r1.stdout, r2.stdout)
})

test('无参数：退出码 2（用法错误），stderr 提示未提供命令', () => {
  const r = runCli([])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /未提供命令/)
  assert.match(r.stderr, /--help/)
})

test('未知命令：退出码 2，stderr 指出该命令名', () => {
  const r = runCli(['definitely-not-a-command'])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /未知命令/)
  assert.match(r.stderr, /definitely-not-a-command/)
})

test('未知顶层选项：退出码 2，stderr 提示未知选项', () => {
  const r = runCli(['--definitely-not-a-flag'])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /未知选项/)
})

test('login --help：退出码 0，stdout 含用法与状态标注', () => {
  const r = runCli(['login', '--help'])
  assert.equal(r.status, 0)
  assert.match(r.stdout, /notegit login/)
  assert.match(r.stdout, /尚未实现|S6-T2/)
})

test('ls --help：退出码 0，stdout 含用法与状态标注', () => {
  const r = runCli(['ls', '--help'])
  assert.equal(r.status, 0)
  assert.match(r.stdout, /notegit ls/)
  assert.match(r.stdout, /尚未实现|S6-T3/)
})

test('setup --help：退出码 0，stdout 含用法与状态标注', () => {
  const r = runCli(['setup', '--help'])
  assert.equal(r.status, 0)
  assert.match(r.stdout, /notegit setup/)
  assert.match(r.stdout, /尚未实现|S6-T6/)
})

test('lint --help：退出码 0，stdout 含 --staged/--all/--json 与退出码说明', () => {
  const r = runCli(['lint', '--help'])
  assert.equal(r.status, 0)
  assert.match(r.stdout, /notegit lint/)
  assert.match(r.stdout, /--staged/)
  assert.match(r.stdout, /--all/)
  assert.match(r.stdout, /--json/)
})

test('sync --help：退出码 0，stdout 含用法与 --depth 选项（S7-T1 已实现）', () => {
  // 集成修正：T1 占位断言随 S7-T1 实现作废——改为已实现契约（行为细节见 sync.test.ts）
  const r = runCli(['sync', '--help'])
  assert.equal(r.status, 0)
  assert.match(r.stdout, /notegit sync \[--depth <深度>\]/)
  assert.match(r.stdout, /--depth/)
  assert.doesNotMatch(r.stdout, /尚未实现/)
})

test('ls（已实现，S6-T3 集成修正）：未配置凭据时退出码 1（业务性失败）', () => {
  // 集成修正：T1 占位断言随 T3 实现作废——无凭据走业务失败路径
  const r = runCli(['ls', '--json'])
  assert.equal(r.status, 1)
})

test('setup（S6-T6 已实现）：在非 git 仓库中运行 → 退出码 2，stderr 说明不在工作树内', () => {
  // 不能在 cli/ 内裸跑（本仓库会被装上 hook）：用隔离的临时目录断言运行错误路径
  const notRepo = mkdtempSync(path.join(tmpdir(), 'ngt-cli-setup-'))
  try {
    const r = spawnSync(process.execPath, [BIN, 'setup'], { cwd: notRepo, encoding: 'utf8' })
    assert.equal(r.status, 2)
    assert.match(r.stderr, /工作树/)
  } finally {
    rmSync(notRepo, { recursive: true, force: true })
  }
})

test('lint --staged --json（S6-T4 已实现）：非 git 仓库 → 退出码 2 + E-RUN-002 运行错误报告', () => {
  // T1 占位断言随 T4 实现作废——改为运行错误契约（校验细节见 lint.test.ts）
  const notARepo = mkdtempSync(path.join(tmpdir(), 'notegit-cli-notrepo-'))
  try {
    const r = runCli(['lint', '--staged', '--json'], { cwd: notARepo })
    assert.equal(r.status, 2)
    const doc = JSON.parse(r.stdout) as { result: string; exitCode: number; issues: Array<{ code: string; message: string }> }
    assert.equal(doc.result, 'error')
    assert.equal(doc.exitCode, 2)
    assert.ok(doc.issues.some((i) => i.code === 'E-RUN-002'))
    assert.match(doc.issues.find((i) => i.code === 'E-RUN-002')!.message, /不在 git 仓库/)
  } finally {
    rmSync(notARepo, { recursive: true, force: true })
  }
})

test('sync（S7-T1 已实现）：未配置凭据时退出码 1（业务性失败，同 ls）', () => {
  // 集成修正：T1 占位断言随 S7-T1 实现作废——无凭据走业务失败路径（六态行为见 sync.test.ts）
  const r = runCli(['sync'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /未配置/)
})

test('子命令 -h 短旗标与 --help 等价（以 lint 为例）', () => {
  const r1 = runCli(['lint', '-h'])
  const r2 = runCli(['lint', '--help'])
  assert.equal(r1.status, 0)
  assert.equal(r1.stdout, r2.stdout)
})
