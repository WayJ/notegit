/**
 * notegit ls 命令实现（S6-T3；架构 §8.1）。
 *
 * 流程：凭据面（占位 = 环境变量，T2 接管）→ GET /api/v1/vaults（实时权限）→
 * 逐库本地状态（local-status.ts）→ --json（schema 固化于 test/ls.test.ts）或
 * 表格输出。退出码：0 成功；1 查询失败（未配置/401/网络/5xx/契约形态）；
 * 2 用法错误（main.ts 统一处理的运行错误同）。
 */
import process from 'node:process'
import { credentialSourceFromEnv } from './credential-source.ts'
import { cloneUrlOf, fetchVaults, type VaultSummary } from './api.ts'
import { computeLocalStatus, localRootOf, realGitOps, type LocalInfo } from './local-status.ts'
import { EXIT_ERROR, EXIT_FAIL, EXIT_OK } from '../exit-codes.ts'

interface LsArgs {
  json: boolean
}

function parseArgs(argv: string[]): { ok: true; args: LsArgs } | { ok: false; message: string } {
  let json = false
  for (const a of argv) {
    if (a === '--json') json = true
    else if (a.startsWith('-')) return { ok: false, message: `未知选项：${a}（notegit ls --help 查看用法）` }
    else return { ok: false, message: `不接受位置参数：${a}（notegit ls [--json]）` }
  }
  return { ok: true, args: { json } }
}

interface VaultEntry extends VaultSummary {
  readonly clone_url: string
  readonly local: LocalInfo
}

/** 执行 ls；返回进程退出码。用法错误打 stderr 并返回 2（不抛出）。 */
export async function runLs(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const parsed = parseArgs(argv)
  if (!parsed.ok) {
    process.stderr.write(`notegit ls: ${parsed.message}\n`)
    return EXIT_ERROR
  }
  const cred = credentialSourceFromEnv(env)
  if (cred === undefined) {
    process.stderr.write(
      'notegit ls: 未配置服务器或凭据（设置 NOTEGIT_SERVER 与 NOTEGIT_TOKEN；S6-T2 login 交付后将接管凭据获取）\n',
    )
    return EXIT_FAIL
  }
  const result = await fetchVaults(cred)
  if (!result.ok) {
    process.stderr.write(`notegit ls: ${result.message}\n`)
    return EXIT_FAIL
  }
  const root = localRootOf(env)
  const ops = realGitOps()
  const entries: VaultEntry[] = []
  for (const v of result.vaults) {
    const cloneUrl = cloneUrlOf(cred.server, v.slug)
    entries.push({ ...v, clone_url: cloneUrl, local: await computeLocalStatus({ root, slug: v.slug, defaultBranch: v.default_branch, cloneUrl, ops }) })
  }
  if (parsed.args.json) {
    process.stdout.write(`${JSON.stringify({ server: cred.server, local_root: root, vaults: entries }, null, 2)}\n`)
    return EXIT_OK
  }
  printTable(cred.server, root, entries)
  return EXIT_OK
}

const STATUS_LABEL: Record<LocalInfo['status'], string> = {
  not_cloned: '未克隆',
  cloned: '已克隆',
  behind: '落后',
  unknown: '未知',
}

function printTable(server: string, root: string, entries: VaultEntry[]): void {
  const lines = [`服务器 ${server}；本地根目录 ${root}`, '']
  if (entries.length === 0) {
    lines.push('无可见库。')
  } else {
    const slugW = Math.max(4, ...entries.map((e) => e.slug.length))
    const nameW = Math.max(4, ...entries.map((e) => e.name.length))
    lines.push(`${'库'.padEnd(slugW)}  状态    角色      默认分支  名称`)
    for (const e of entries) {
      lines.push(
        `${e.slug.padEnd(slugW)}  ${STATUS_LABEL[e.local.status].padEnd(4)}  ${e.role.padEnd(6)}  ${e.default_branch.padEnd(6)}  ${e.name.padEnd(nameW)}`,
      )
    }
  }
  process.stdout.write(`${lines.join('\n')}\n`)
}
