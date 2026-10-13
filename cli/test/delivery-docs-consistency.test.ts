/**
 * S9-T6 交付文档一致性抽检（breakdown §2.8 S9-T6 行 / DOD-15「不留无法运行的示例」）。
 *
 * 覆盖面 = S9-T6 三份文档 + 已知限制清单（docs/contracts/ 只读消费）：
 *  - docs/user/（README 索引 + quickstart/contributing/permissions，员工视角）
 *  - docs/admin/README.md（管理员手册：员工/凭据/维护/备份恢复升级/指标）
 *  - docs/harness/agent-guide.md（Agent 使用指南，补充 S7-T8 主指引）
 *  - docs/known-limitations.md（与架构 §12 边界逐条对齐 + 本周期遗留）
 *
 * 抽检形态（cli/README ↔ --help 既有模式的扩展）：
 *  A) notegit 命令抽检——三份文档 sh 围栏里的每条 `notegit …` 命令：子命令 ∈
 *     COMMAND_ORDER、每个 --旗标出现在该命令真实 `--help` 输出中（虚构命令/旗标即红）；
 *  B) 备份/恢复/升级 CLI 抽检——admin 文档的每条 `node src/backup/cli.ts …`：真实
 *     运行无参形态取得 usage（exit 1 + 用法文本），子命令/相位/旗标须在 usage 内；
 *  C) API 路径抽检——文档 curl 示例里的每个 `/api/v1/…` 路径逐字出现在 api.md 契约；
 *  D) 网页路径抽检——quickstart 提到的页面路径在 server/src/web 路由源码中真实存在；
 *  E) 已知限制对齐——架构 §12 边界表逐行（运行时解析 architecture.md）须在
 *     known-limitations.md 中逐条出现，本周期遗留关键词（导航折叠/web 字体/共享缓存/
 *     单实例/Q9）不得静默缺失。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { COMMAND_ORDER } from '../src/commands.ts'

const ROOT = new URL('../..', import.meta.url).pathname
const BIN = new URL('../dist/bin/notegit.js', import.meta.url).pathname

const DOCS = {
  userIndex: 'docs/user/README.md',
  quickstart: 'docs/user/quickstart.md',
  contributing: 'docs/user/contributing.md',
  permissions: 'docs/user/permissions.md',
  admin: 'docs/admin/README.md',
  agentGuide: 'docs/harness/agent-guide.md',
  knownLimitations: 'docs/known-limitations.md',
} as const

function doc(name: string): string {
  const p = ROOT + name
  assert.ok(existsSync(p), `缺交付文档 ${name}（S9-T6）`)
  return readFileSync(p, 'utf8')
}

/** ```sh / ```bash 围栏内容（行尾 `\` 续行合并；输出为逐行数组）。 */
function shLines(text: string): string[] {
  const out: string[] = []
  for (const fence of text.matchAll(/```(?:sh|bash)\n([\s\S]*?)```/g)) {
    const joined = fence[1]!.replace(/\\\n/g, ' ')
    for (let line of joined.split('\n')) {
      line = line.replace(/^\$\s?/, '').trim()
      if (line.length > 0) out.push(line)
    }
  }
  return out
}

// ── A) notegit 命令抽检 ───────────────────────────────────────────────────────

const helpCache = new Map<string, string>()

function helpOf(cmd: string): string {
  const cached = helpCache.get(cmd)
  if (cached !== undefined) return cached
  const r = spawnSync(process.execPath, [BIN, cmd, '--help'], { encoding: 'utf8' })
  assert.equal(r.status, 0, `notegit ${cmd} --help 应退出 0（stderr：${r.stderr}）`)
  helpCache.set(cmd, r.stdout)
  return r.stdout
}

/** 围栏中以（可选 `FOO=bar` 环境前缀后的）notegit 起头的命令行。 */
function notegitCommandLines(text: string): string[] {
  return shLines(text)
    .filter((l) => !l.startsWith('#'))
    .map((l) => /^(?:[A-Z_][A-Z0-9_]*=\S+\s+)*(notegit\s.*)$/.exec(l)?.[1])
    .filter((l): l is string => l !== undefined)
}

const NOTEGIT_DOC_FILES = [DOCS.quickstart, DOCS.contributing, DOCS.agentGuide]

test('命令抽检：三份文档的 notegit 命令——子命令真实存在、旗标全在 --help 内', () => {
  for (const file of NOTEGIT_DOC_FILES) {
    const lines = notegitCommandLines(doc(file))
    assert.ok(lines.length > 0, `${file} 应至少含一条 notegit 命令示例`)
    for (const line of lines) {
      const tokens = line.split(/\s+/)
      const cmd = tokens[1]!
      if (cmd === '--version' || cmd === '--help' || cmd === '-h') continue
      assert.ok(
        (COMMAND_ORDER as readonly string[]).includes(cmd),
        `${file} 出现未实现命令「notegit ${cmd}」：${line}`,
      )
      const help = helpOf(cmd)
      for (const t of tokens.slice(2)) {
        if (t.startsWith('--')) {
          assert.ok(help.includes(t), `${file} 旗标 ${t} 不在「notegit ${cmd} --help」输出中：${line}`)
        }
      }
    }
  }
})

test('命令抽检：quickstart 的环境变量面与 cli/README 契约一致', () => {
  const qs = doc(DOCS.quickstart)
  for (const v of ['NOTEGIT_TOKEN', 'NOTEGIT_SERVER', 'NOTEGIT_LOCAL_ROOT', 'NOTEGIT_CREDENTIALS_FILE']) {
    assert.ok(qs.includes(v), `quickstart 缺环境变量 ${v}（与 cli/README 环境变量表一致）`)
  }
  assert.ok(qs.includes('~/knowbase'), 'quickstart 缺本地根目录默认 ~/knowbase')
})

// ── B) 备份/恢复/升级 CLI 抽检（admin 文档） ──────────────────────────────────

const BACKUP_CMDS = ['backup', 'verify', 'restore', 'finalize', 'upgrade'] as const
const UPGRADE_PHASES = ['pre-backup', 'gate', 'post'] as const

test('命令抽检：backup CLI 真实可运行（无参 exit 1 + 完整用法，五个子命令三相位）', () => {
  const r = spawnSync(process.execPath, [ROOT + 'server/src/backup/cli.ts'], { encoding: 'utf8' })
  assert.equal(r.status, 1, '无参运行应 exit 1（用法错误，不静默）')
  assert.ok(r.stderr.includes('用法：'), '用法文本应在 stderr')
  for (const c of BACKUP_CMDS) assert.ok(r.stderr.includes(c), `用法缺子命令 ${c}`)
  for (const p of UPGRADE_PHASES) assert.ok(r.stderr.includes(p), `用法缺 upgrade 相位 ${p}`)
})

test('命令抽检：admin 文档的 backup/upgrade 命令行——子命令/相位/旗标全在用法内', () => {
  const usageText = spawnSync(process.execPath, [ROOT + 'server/src/backup/cli.ts'], { encoding: 'utf8' }).stderr
  const allowedFlags = new Set([...usageText.matchAll(/--[a-z-]+/g)].map((m) => m[0]!))
  const lines = shLines(doc(DOCS.admin)).filter(
    (l) => /node\s+(\S*\/)?src\/backup\/cli\.ts/.test(l) && !l.startsWith('#'),
  )
  assert.ok(lines.length > 0, 'admin 文档应含 node src/backup/cli.ts 命令示例')
  for (const line of lines) {
    const tokens = line.split(/\s+/)
    const i = tokens.findIndex((t) => /(^|\/)src\/backup\/cli\.ts$/.test(t))
    const sub = tokens[i + 1]!
    assert.ok(
      (BACKUP_CMDS as readonly string[]).includes(sub),
      `admin 文档 backup CLI 子命令「${sub}」不存在：${line}`,
    )
    let rest = tokens.slice(i + 2)
    if (sub === 'upgrade') {
      const phase = rest[0]!
      assert.ok(
        (UPGRADE_PHASES as readonly string[]).includes(phase),
        `admin 文档 upgrade 相位「${phase}」不存在：${line}`,
      )
      rest = rest.slice(1)
    }
    for (const t of rest) {
      if (t.startsWith('--')) {
        assert.ok(allowedFlags.has(t), `admin 文档旗标 ${t} 不在 backup CLI 用法内：${line}`)
      }
    }
  }
})

// ── C) API 路径抽检（文档 curl 示例 ↔ api.md 契约） ───────────────────────────

const API_MD = readFileSync(ROOT + 'docs/contracts/api.md', 'utf8')

function apiPathsOf(text: string): string[] {
  return [...text.matchAll(/\/api\/v1\/[A-Za-z0-9{}._/-]+/g)].map((m) => m[0]!)
}

test('路径抽检：user/admin 文档 curl 示例的 /api/v1 路径逐字存在于 api.md 契约', () => {
  const files = [DOCS.quickstart, DOCS.permissions, DOCS.admin]
  let checked = 0
  for (const file of files) {
    for (const p of apiPathsOf(doc(file))) {
      // api.md 对「同前缀 + 末段 {id}」的续写用缩写形态（如 …/credentials/{id}），
      // 此时接受逐段前缀命中；其余路径必须逐字出现（防虚构端点）。
      const ok = API_MD.includes(p) || (p.endsWith('/{id}') && API_MD.includes(p.replace(/\/[^/]+$/, '')))
      assert.ok(ok, `${file} 的 API 路径「${p}」不在 docs/contracts/api.md（占位符用 {slug}/{username}/{id} 形态）`)
      checked++
    }
  }
  assert.ok(checked > 0, 'user/admin 文档应至少各含一个 API 端点示例')
})

// ── D) 网页路径抽检（quickstart ↔ server/src/web 路由源码） ───────────────────

const WEB_SRC = [
  'server/src/web/shell.ts',
  'server/src/web/browse/routes.ts',
  'server/src/web/search/routes.ts',
  'server/src/web/history/routes.ts',
]
  .map((f) => readFileSync(ROOT + f, 'utf8'))
  .join('\n')

test('路径抽检：quickstart 提到的网页路径在 server/src/web 路由源码中真实注册', () => {
  for (const p of ["'/login'", "'/vaults'", "'/search'", "'/cite'", "'/credentials'"]) {
    assert.ok(WEB_SRC.includes(p), `网页路径 ${p} 未在 server/src/web 路由源码中发现`)
  }
  const qs = doc(DOCS.quickstart)
  for (const p of ['/login', '/vaults', '/search', '/credentials']) {
    assert.ok(qs.includes(p), `quickstart 缺页面路径 ${p}`)
  }
})

// ── 结构锚点：三份文档各自的任务定义要素 ─────────────────────────────────────

test('结构：quickstart 覆盖员工主线（登录→浏览→编辑→上传→历史→搜索）', () => {
  const qs = doc(DOCS.quickstart)
  for (const k of ['登录', '浏览', '编辑', '上传', '历史', '搜索']) {
    assert.ok(qs.includes(k), `quickstart 缺主线环节「${k}」`)
  }
  assert.ok(qs.includes('password-reset'), 'quickstart 缺首次设口令步骤（邀请一次性令牌消费端点）')
})

test('结构：contributing 覆盖双通道/冲突/校验错误修正', () => {
  const c = doc(DOCS.contributing)
  assert.ok(c.includes('网页') && c.includes('Git'), 'contributing 应覆盖网页与 Git 双通道')
  assert.ok(c.includes('冲突'), 'contributing 缺冲突处理')
  assert.ok(c.includes('409'), 'contributing 缺并发冲突 409 语义（不静默覆盖）')
  assert.ok(c.includes('E-FM-001'), 'contributing 缺校验错误修正示例（E-FM-001）')
})

test('结构：permissions 覆盖角色/撤权边界/凭据状态', () => {
  const p = doc(DOCS.permissions)
  for (const k of ['reader', 'editor', 'admin', '实例管理员']) {
    assert.ok(p.includes(k), `permissions 缺角色「${k}」`)
  }
  assert.ok(p.includes('撤权') || p.includes('移除'), 'permissions 缺撤权边界')
  assert.ok(p.includes('404'), 'permissions 缺无权库 404 同体语义')
  assert.ok(p.includes('E-AUTH'), 'permissions 缺凭据四状态（E-AUTH-001..004）')
  assert.ok(p.includes('90 天'), 'permissions 缺凭据有效期上限 90 天（api.md §4）')
})

test('结构：agent-guide 覆盖凭据→login→ls→sync→引用三要素', () => {
  const g = doc(DOCS.agentGuide)
  assert.ok(g.includes('ngt_'), 'agent-guide 缺凭据创建（ngt_ 令牌）')
  assert.ok(g.includes('notegit login') && g.includes('notegit ls') && g.includes('notegit sync'), 'agent-guide 缺主线命令')
  assert.ok(g.includes('库/路径/commit'), 'agent-guide 缺引用格式三要素（库/路径/commit）')
  assert.ok(g.includes('/credentials'), 'agent-guide 缺凭据页路径（/credentials）')
})

test('结构：user README 索引链接四篇与已知限制', () => {
  const idx = doc(DOCS.userIndex)
  for (const f of ['quickstart.md', 'contributing.md', 'permissions.md', 'history-boundary.md']) {
    assert.ok(idx.includes(f), `user README 索引缺 ${f}`)
  }
  assert.ok(idx.includes('known-limitations.md'), 'user README 索引缺已知限制链接')
})

// ── E) 已知限制对齐（架构 §12 逐条 + 本周期遗留） ────────────────────────────

test('对齐：架构 §12 每条边界逐条出现在 known-limitations.md', () => {
  const arch = readFileSync(ROOT + 'architecture.md', 'utf8')
  const sec12 = arch.slice(arch.indexOf('## 12. 风险与边界'), arch.indexOf('## 13.'))
  assert.ok(sec12.length > 0, 'architecture.md §12 解析失败')
  const boundaries = [...sec12.matchAll(/^\| ([^|]+) \|/gm)]
    .map((m) => m[1]!.trim())
    .filter((h) => h !== '边界')
  assert.ok(boundaries.length >= 8, `§12 边界行解析异常：${boundaries.length} 行`)
  const kl = doc(DOCS.knownLimitations)
  for (const b of boundaries) {
    assert.ok(kl.includes(b), `known-limitations 缺架构 §12 边界「${b}」`)
  }
})

test('对齐：本周期遗留五项（导航折叠/web 字体/共享缓存/单实例/Q9）不静默缺失', () => {
  const kl = doc(DOCS.knownLimitations)
  assert.ok(kl.includes('768'), '缺 <768px 导航折叠后置')
  assert.ok(kl.includes('自托管'), '缺 web font 未自托管')
  assert.ok(kl.includes('对象缓存'), '缺共享只读对象缓存后续')
  assert.ok(kl.includes('单实例'), '缺单实例假设')
  assert.ok(kl.includes('Q9'), '缺 Q9 未定')
})
