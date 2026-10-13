/**
 * S6-T8 文档一致性抽检（breakdown §2.5 S6-T8 行：文档命令与 --help 一致）。
 *
 * 测试目标：cli/README.md 的每命令章节必须与真实 dist 产物的 `notegit <cmd> --help`
 * 关键行逐字一致（用法行/摘要/选项行/退出码行）——--help（commands.ts）变更而文档
 * 未跟时此处变红。结构化样例（--json）逐块过 validation-report 契约 schema，保证
 * 「文档=实现现状」：样例是 schema 合法的真实报告形态，示例错误码（E-FM-001）与
 * README 给出的复现步骤一一对应（人工复现全流程 e2e 另见 docs-flow-e2e.test.ts）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { COMMAND_ORDER } from '../src/commands.ts'
import { schemaCheck } from '../../packages/validation/test/helpers/schema-check.ts'

// 黑盒取 --help（与 cli.test.ts 同约定：目标 = dist 产物；npm test 先 build 再跑测试）
const BIN = new URL('../dist/bin/notegit.js', import.meta.url).pathname

const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8')

// 契约单一来源（只读消费，lint.test.ts 同款）
const REPORT_SCHEMA = JSON.parse(
  readFileSync(new URL('../../docs/contracts/schemas/validation-report.schema.json', import.meta.url), 'utf8'),
)

interface HelpFacts {
  usage: string
  summary: string
  options: string[]
  exitLine: string
}

function helpFacts(name: string): HelpFacts {
  const r = spawnSync(process.execPath, [BIN, name, '--help'], { encoding: 'utf8' })
  assert.equal(r.status, 0, `notegit ${name} --help 应退出 0（stderr：${r.stderr}）`)
  const lines = r.stdout.split('\n')
  const dash = lines[0]!.indexOf(' — ')
  assert.ok(dash > 0, `${name} --help 首行应为「<usage> — <summary>」形态`)
  const usage = lines[0]!.slice(0, dash)
  const summary = lines[0]!.slice(dash + 3)
  const optIdx = lines.indexOf('选项：')
  assert.ok(optIdx !== -1, `${name} --help 应含「选项：」块`)
  const options: string[] = []
  for (let i = optIdx + 1; i < lines.length && lines[i] !== ''; i++) options.push(lines[i]!.trim())
  assert.ok(options.length > 0, `${name} --help 选项块不应为空`)
  const exitLine = lines.find((l) => l.startsWith('退出码：'))
  assert.ok(exitLine !== undefined, `${name} --help 应含退出码行`)
  return { usage, summary, options, exitLine }
}

/** README 命令章节行（`### notegit <name>` 起到下一个 `## `/`### ` 标题前）。 */
function sectionLines(name: string): string[] {
  const lines = README.split('\n')
  const i = lines.indexOf(`### notegit ${name}`)
  assert.ok(i !== -1, `README 缺少「### notegit ${name}」章节`)
  let j = i + 1
  while (j < lines.length && !/^(## |### )/.test(lines[j]!)) j++
  return lines.slice(i, j)
}

function sectionOf(name: string): string {
  return sectionLines(name).join('\n')
}

/** 章节内 ```json 围栏块解析（文档样例必须全部是合法 JSON）。 */
function jsonBlocksOf(section: string): unknown[] {
  return [...section.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1] as string))
}

// ── 逐命令：README 章节 ≡ --help 关键行 ──────────────────────────────────────

for (const name of COMMAND_ORDER) {
  test(`文档一致性：notegit ${name} 章节含 --help 关键行（用法/摘要/选项/退出码）`, () => {
    const facts = helpFacts(name)
    const section = sectionOf(name)
    assert.ok(section.includes(facts.usage), `章节缺用法行：${facts.usage}`)
    assert.ok(section.includes(facts.summary), `章节缺摘要：${facts.summary}`)
    for (const o of facts.options) {
      assert.ok(section.includes(o), `章节缺选项行：${o}`)
    }
    assert.ok(section.includes(facts.exitLine), `章节缺退出码行：${facts.exitLine}`)
  })
}

test('文档一致性：README 命令章节集合 == CLI 命令集（不虚构命令、不漏命令）', () => {
  const headings = [...README.matchAll(/^### notegit (\S+)$/gm)].map((m) => m[1] as string)
  assert.deepEqual([...headings].sort(), [...COMMAND_ORDER].sort())
})

test('文档一致性：命令一览表覆盖全部命令，作用列 == --help 命令列表摘要', () => {
  const top = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' })
  assert.equal(top.status, 0, `notegit --help 应退出 0（stderr：${top.stderr}）`)
  for (const name of COMMAND_ORDER) {
    assert.ok(README.includes(`| \`notegit ${name}\``), `命令一览表缺 notegit ${name} 行`)
    const line = top.stdout.split('\n').find((l) => l.startsWith(`  ${name} `))
    assert.ok(line !== undefined, `notegit --help 命令列表缺 ${name}`)
    const summary = line.slice(`  ${name} `.length).trim()
    assert.ok(README.includes(summary), `README 缺 --help 摘要：${summary}`)
  }
})

test('文档一致性：已实现命令章节不出现「尚未实现」（sync 随 S7-T1 转正）', () => {
  for (const name of COMMAND_ORDER) {
    const section = sectionOf(name)
    assert.ok(!section.includes('尚未实现'), `${name} 已实现，章节不应出现「尚未实现」`)
  }
})

test('文档一致性：安装节为单 tarball 自包含（S6-T7），无旧双 tarball 指引', () => {
  assert.ok(README.includes('npm install -g notegit-<version>.tgz'), '安装节应给单 tarball 安装命令')
  assert.ok(!README.includes('notegit-validation-<version>.tgz'), '不应残留双 tarball 安装指引（validation 已内嵌）')
})

test('文档一致性：安装节含版本验证命令', () => {
  assert.ok(README.includes(`notegit --version`), '安装节应含版本验证命令')
})

test('文档一致性：退出码三态与环境要求在文档', () => {
  assert.ok(README.includes('| 0 |') && README.includes('| 1 |') && README.includes('| 2 |'), '退出码表应含 0/1/2 三态')
  assert.ok(README.includes('fail-closed'), '应说明运行错误 fail-closed 语义')
  assert.ok(README.includes('Node ≥ 22.13'), '环境要求 Node ≥ 22.13')
  for (const v of ['NOTEGIT_TOKEN', 'NOTEGIT_SERVER', 'NOTEGIT_LOCAL_ROOT', 'NOTEGIT_CREDENTIALS_FILE']) {
    assert.ok(README.includes(v), `环境变量文档缺 ${v}`)
  }
})

// ── 结构化样例：--json 块逐个过契约 schema，示例错误码与复现步骤对应 ─────────

test('文档一致性：lint 章节 --json 样例过 validation-report schema（E-FM-001 ↔ 退出码 1 可复现）', () => {
  const section = sectionOf('lint')
  const blocks = jsonBlocksOf(section)
  assert.equal(blocks.length, 2, 'lint 章节应恰有两个完整 JSON 报告样例（校验错误 + 运行错误）')
  for (const b of blocks) {
    const errs = schemaCheck(REPORT_SCHEMA, b)
    assert.deepEqual(errs, [], `报告样例应过 schema：${JSON.stringify(errs)}`)
  }
  const fail = blocks[0] as { result: string; exitCode: number; files: Array<{ status: string; issues: Array<{ code: string }> }> }
  assert.equal(fail['result'], 'fail')
  assert.equal(fail['exitCode'], 1)
  assert.equal(fail.files[0]?.issues[0]?.code, 'E-FM-001', '首个样例错误码应与「校验循环」步骤复现的 E-FM-001 一致')
  const runErr = blocks[1] as { result: string; exitCode: number; issues: Array<{ code: string }> }
  assert.equal(runErr['result'], 'error')
  assert.equal(runErr['exitCode'], 2)
  assert.equal(runErr.issues[0]?.code, 'E-RUN-002')
})

test('文档一致性：ls 章节 --json 样例形态与四值 local.status 枚举一致', () => {
  const blocks = jsonBlocksOf(sectionOf('ls'))
  assert.equal(blocks.length, 1, 'ls 章节应恰有一个 JSON 样例')
  const doc = blocks[0] as {
    server: string
    local_root: string
    vaults: Array<{ slug: string; clone_url: string; local: { status: string } }>
  }
  assert.equal(typeof doc['server'], 'string')
  assert.equal(typeof doc['local_root'], 'string')
  assert.ok(Array.isArray(doc.vaults) && doc.vaults.length > 0)
  for (const v of doc.vaults) {
    assert.ok(['not_cloned', 'cloned', 'behind', 'unknown'].includes(v.local.status), `local.status 应为四值枚举：${v.local.status}`)
    assert.ok(v.clone_url.includes('/git/'), `clone_url 应为 /git/<slug>.git 形态：${v.clone_url}`)
  }
})
