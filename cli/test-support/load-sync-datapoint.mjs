/**
 * S7-T8 并发 sync 负载数据点（selection §7：服务端每请求 git 子进程并发的首个量化场景；
 * breakdown §2.6 S7-T8：2–4 个并发 sync（多库世界）对真实测试服务实例）。
 *
 * 形态：server/ 现码以 startApp 在本进程内启动（真实 Fastify + git http-backend CGI，
 * 不打桩）；世界 = M 个库 × 若干文档；每并发度 c ∈ {1,2,3,4} 独立员工（独立 HOME /
 * 凭据 / 本地根目录）同时 `notegit sync`（完整克隆——首同步是每请求子进程链最重的
 * 形态）。测量面（全部外部观察，不改 server/ 代码）：
 *   - 服务端耗时：HTTP 请求级 duration（挂在本进程 http server 的 request/finish
 *     事件上计时，按 api / git 分类聚合）+ 服务进程 CPU 时间（process.cpuUsage）；
 *   - RSS：服务进程 RSS（process.memoryUsage().rss）峰值；
 *   - 子进程数：ps 采样进程树（本进程 → git http-backend → upload-pack…），
 *     记录 git 子进程峰值个数与峰值 RSS 合计。
 * 输出：JSON（stdout）——人工整理进 .agents/notes/2026-10-13-S7-T8-load.md。
 *
 * 运行（仓库根目录）：node cli/test-support/load-sync-datapoint.mjs [--vaults 4] [--files 20]
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { bootRealInstance, createEmployee, createCredentialFor, createVault, seedVaultContent } from './real-instance.ts'

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : [])).filter((p) => p.length === 2),
)
const VAULTS = Number(args['vaults'] ?? 4)
const FILES_PER_VAULT = Number(args['files'] ?? 50)
const CONCURRENCIES = [1, 2, 3, 4]
const BIN = new URL('../dist/bin/notegit.js', import.meta.url).pathname

const root = mkdtempSync(path.join(tmpdir(), 'ngt-load-'))
const samples = [] // {t, rss, gitChildren, gitRssSum, chainDetail}
const requestTimes = [] // {phase, kind, path, ms}
let sampling = false

async function psTree() {
  return new Promise((resolve) => {
    const p = spawn('ps', ['-eo', 'pid=,ppid=,rss=,comm='], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.on('close', () => resolve(out))
    p.on('error', () => resolve(''))
  })
}

/** 从 ps 输出取本进程下两层内的 git 子进程（http-backend → upload-pack/pack-objects…）。 */
function gitDescendants(psOut) {
  const rows = psOut
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => {
      const m = l.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)
      return m ? { pid: Number(m[1]), ppid: Number(m[2]), rss: Number(m[3]), comm: m[4] } : null
    })
    .filter((r) => r !== null)
  const me = process.pid
  const children = rows.filter((r) => r.ppid === me && /git/.test(r.comm))
  const grand = rows.filter((r) => children.some((c) => c.pid === r.ppid) && /git/.test(r.comm))
  const all = [...children, ...grand]
  return {
    count: all.length,
    rssSum: all.reduce((s, r) => s + r.rss, 0),
    detail: all.map((r) => `${r.comm.split('/').pop()}=${r.rss}KB`).sort().join(','),
  }
}

const sampler = setInterval(async () => {
  if (!sampling) return
  const [psOut, mem] = await Promise.all([psTree(), Promise.resolve(null)])
  const g = gitDescendants(psOut)
  if (g.count > 0 && process.env['LOAD_DEBUG']) process.stderr.write(`[dbg] ${JSON.stringify(g)}\n`)
  samples.push({ t: Date.now(), rss: process.memoryUsage().rss, ...g })
}, 50)

function hookRequestTiming(server, phase) {
  server.on('request', (req, res) => {
    const start = process.hrtime.bigint()
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6
      const p = req.url ?? '/'
      requestTimes.push({ phase, kind: p.includes('/git/') ? 'git' : 'api', path: p.split('?')[0], ms })
    })
  })
}

function runSync(env, rootDir) {
  return new Promise((resolve) => {
    const start = Date.now()
    const child = spawn(process.execPath, [BIN, 'sync'], { env, cwd: rootDir })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', (code) => resolve({ code, ms: Date.now() - start, stdout, stderr }))
  })
}

function employeeEnv(idx, server, token) {
  const home = path.join(root, `emp${idx}`)
  const env = { ...process.env }
  env['HOME'] = home
  env['XDG_CONFIG_HOME'] = path.join(home, '.config')
  env['NOTEGIT_CREDENTIALS_FILE'] = path.join(home, 'credentials')
  env['GIT_CONFIG_GLOBAL'] = path.join(home, '.gitconfig')
  env['GIT_CONFIG_SYSTEM'] = '/dev/null'
  env['GIT_TERMINAL_PROMPT'] = '0'
  env['NOTEGIT_SERVER'] = server
  env['NOTEGIT_TOKEN'] = token
  env['NOTEGIT_LOCAL_ROOT'] = path.join(home, 'knowbase')
  delete env['GIT_ASKPASS']
  delete env['SSH_ASKPASS']
  return env
}

function quantile(xs, q) {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]
}

const summary = { vaults: [], concurrency: [], env: { node: process.version, pid: process.pid } }

try {
  // ── 世界：实例 + 员工 + M 库种子内容 ─────────────────────────────────────
  const inst = await bootRealInstance(path.join(root, 'data'))
  hookRequestTiming(inst.app.app.server, 'world')
  const employees = []
  const maxC = Math.max(...CONCURRENCIES)
  for (let i = 1; i <= maxC; i++) {
    const username = `load${i}`
    const emp = await createEmployee(inst, username)
    employees.push({ username, token: await createCredentialFor(inst, emp.username, emp.password) })
  }
  let seedBytes = 0
  let seedFiles = 0
  for (let v = 1; v <= VAULTS; v++) {
    const slug = `v-load${String(v).padStart(2, '0')}`
    await createVault(
      inst,
      slug,
      `负载库 ${v}`,
      employees.map((e) => ({ username: e.username, role: 'editor' })),
    )
    const files = [{ path: 'README.md', content: `# 负载库 ${v}\n\n导航目录。\n\n` }]
    for (let f = 1; f <= FILES_PER_VAULT; f++) {
      files.push({
        path: `docs/topic-${String(f).padStart(3, '0')}.md`,
        content: `---\ntitle: 主题 ${f}\n---\n\n# 主题 ${f}\n\n${'知识内容段落。'.repeat(400)}（库 ${v} 文件 ${f}）\n`,
      })
    }
    const seeded = await seedVaultContent(inst.baseUrl, slug, employees[0].token, files)
    seedFiles += files.length
    seedBytes += files.reduce((s, f) => s + Buffer.byteLength(f.content), 0)
    summary.vaults.push({ slug, head: seeded.head, files: files.length })
  }

  // 员工各先 login（注册 credential helper；串行，不入测量窗）
  for (let i = 0; i < maxC; i++) {
    const env = employeeEnv(i + 1, inst.baseUrl, employees[i].token)
    const login = await new Promise((resolve) => {
      const c = spawn(process.execPath, [BIN, 'login', inst.baseUrl, '--username', employees[i].username], { env })
      c.on('close', resolve)
    })
    if (login !== 0) throw new Error(`员工 load${i + 1} login 失败（${login}）`)
    employees[i].env = env
  }

  // ── 测量：每个并发度独立员工全量克隆（互不共享本地根目录） ────────────────
  const rssBase = process.memoryUsage().rss
  const cpuBase = process.cpuUsage()
  for (const c of CONCURRENCIES) {
    await new Promise((r) => setTimeout(r, 400)) // 冷却：上一轮子进程退净、GC 喘息
    const idx = Array.from({ length: c }, (_, k) => k) // 员工 1..c（各并发度用相同前缀员工，根目录独立且首轮即全克隆）
    const phaseSamples0 = samples.length
    const req0 = requestTimes.length
    const cpu0 = process.cpuUsage()
    sampling = true
    const t0 = Date.now()
    // 每相独立本地根目录：该相内每个员工都是首轮完整克隆（不沿用上一相的副本）
    const results = await Promise.all(idx.map((i) => runSync({ ...employees[i].env, NOTEGIT_LOCAL_ROOT: path.join(employees[i].env['NOTEGIT_LOCAL_ROOT'], `c${c}`) }, root)))
    const wall = Date.now() - t0
    sampling = false
    const phase = {
      concurrency: c,
      wall_ms: wall,
      server_cpu_ms: (() => { const u = process.cpuUsage(cpu0); return Math.round((u.user + u.system) / 1000) })(),
      sync_results: results.map((r) => ({
        exit: r.code,
        ms: r.ms,
        ok: r.code === 0 && r.stdout.includes(`成功 ${VAULTS}`) ? true : r.stdout.slice(0, 200),
      })),
      server_rss_peak_kb: Math.max(...samples.slice(phaseSamples0).map((s) => s.rss)) / 1024,
      git_children_peak: Math.max(...samples.slice(phaseSamples0).map((s) => s.count), 0),
      git_children_rss_peak_kb: Math.max(...samples.slice(phaseSamples0).map((s) => s.rssSum), 0),
      git_children_peak_detail: (() => { const w = samples.slice(phaseSamples0); return w.length ? w.reduce((a, b) => (b.rssSum > a.rssSum ? b : a)).detail : '' })(),
      requests: (() => {
        const rs = requestTimes.slice(req0)
        const git = rs.filter((r) => r.kind === 'git').map((r) => r.ms)
        const api = rs.filter((r) => r.kind === 'api').map((r) => r.ms)
        return {
          git_n: git.length,
          git_mean_ms: git.length ? Math.round(git.reduce((a, b) => a + b, 0) / git.length) : null,
          git_p95_ms: quantile(git, 0.95) === null ? null : Math.round(quantile(git, 0.95)),
          git_max_ms: git.length ? Math.round(Math.max(...git)) : null,
          api_n: api.length,
          api_mean_ms: api.length ? Math.round(api.reduce((a, b) => a + b, 0) / api.length) : null,
          git_by_path: rs.filter((r) => r.kind === 'git').reduce((acc, r) => { const k = r.path.endsWith('/info/refs') ? 'info/refs' : (r.path.includes('?service=git-upload-pack') || r.path.includes('/git-upload-pack') ? 'upload-pack' : 'other'); acc[k] = (acc[k] ?? 0) + 1; return acc }, {}),
        }
      })(),
    }
    summary.concurrency.push(phase)
    process.stderr.write(`[load] c=${c} wall=${wall}ms peakChildren=${phase.git_children_peak} peakGitRss=${Math.round(phase.git_children_rss_peak_kb)}KB\n`)
  }
  const cpu = process.cpuUsage(cpuBase)
  summary.server_totals = {
    rss_base_kb: rssBase / 1024,
    rss_final_kb: process.memoryUsage().rss / 1024,
    cpu_user_ms: Math.round(cpu.user / 1000),
    cpu_system_ms: Math.round(cpu.system / 1000),
  }
  summary.world = { vaults: VAULTS, files: seedFiles, content_bytes: seedBytes, employees: maxC }
  summary.sampler = { interval_ms: 100, n: samples.length }
  console.log(JSON.stringify(summary, null, 2))
  await inst.close()
} finally {
  clearInterval(sampler)
  rmSync(root, { recursive: true, force: true })
}
