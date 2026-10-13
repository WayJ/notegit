/**
 * notegit lint 命令（S6-T4；breakdown §2.5：--staged 读 index 不读工作目录、--all
 * 全工作树、--json 输出 validation-report 协议、退出码 0/1/2、规则版本提示）。
 *
 * 单一规则源（sprint D5）：校验编排/报告形状/错误码全部来自 notegit-validation
 * （packages/validation 工作区依赖——开发态直取；安装态内嵌打包属 S6-T7）。
 * 本地端报告 scope=pre-commit（validation.md §1 三端一致表）。
 *
 * hook 等价接口预留（S6-T5 消费）：lintOnce 是唯一执行入口，命令面 runLint 与
 * pre-commit hook（T5）经它获得同一报告与退出码——hook 触发 lint 等价于手动
 * `notegit lint --staged`。
 */
import process from 'node:process'
import { validate, rulesVersion, renderMessage, issueOf, type Report, type FileInput } from 'notegit-validation'
import { EXIT_ERROR } from '../exit-codes.ts'
import { credentialSourceFromEnv } from '../ls/credential-source.ts'
import { GitSourceError, readBlob, readIndexSnapshot, realExecGit, type ExecGit } from './git-source.ts'
import { compareRulesVersions, probeServerRulesVersion } from './version-probe.ts'

export { compareRulesVersions } from './version-probe.ts'

export interface LintOptions {
  mode: 'staged' | 'all'
  json: boolean
}

/** 版本提示结局：无提示 / 跳过（reason 供 stderr 说明；silent=未配置凭据等常态静默）/ 附 N-UPGRADE-001 提示。 */
export type LintHint = { kind: 'none' } | { kind: 'skipped'; reason: string; silent: boolean } | { kind: 'notice'; notice: { code: string; message: string } }

export interface LintOutcome {
  report: Report
  exitCode: number
  hint: LintHint
}

/** 可注入依赖（测试与 T5 hook 消费用；缺省 = 真实进程环境）。 */
export interface LintDeps {
  cwd: string
  env: NodeJS.ProcessEnv
  execGit: ExecGit
  fetchImpl: typeof fetch
  stdout: (s: string) => void
  stderr: (s: string) => void
}

export function parseLintArgs(argv: readonly string[]): { ok: true; args: LintOptions } | { ok: false; message: string } {
  let mode: 'staged' | 'all' | undefined
  let json = false
  for (const a of argv) {
    if (a === '--staged' || a === '--all') {
      const m = a === '--staged' ? 'staged' : 'all'
      if (mode !== undefined && mode !== m) return { ok: false, message: `--staged 与 --all 互斥（notegit lint --staged | --all）` }
      mode = m
    } else if (a === '--json') json = true
    else if (a.startsWith('-')) return { ok: false, message: `未知选项：${a}（notegit lint --help 查看用法）` }
    else return { ok: false, message: `不接受位置参数：${a}（notegit lint [--staged | --all] [--json]）` }
  }
  if (mode === undefined) return { ok: false, message: '需要 --staged 或 --all 之一指定校验范围（notegit lint --help 查看用法）' }
  return { ok: true, args: { mode, json } }
}

function errorReport(e: unknown): Report {
  return {
    rulesVersion: rulesVersion(),
    scope: 'pre-commit',
    result: 'error',
    exitCode: 2,
    summary: { filesTotal: 0, filesPassed: 0, filesFailed: 0, errorCount: 1, warningCount: 0 },
    files: [],
    issues: [issueOf('E-RUN-002', { actual: e instanceof Error ? e.message : String(e) })],
  }
}

/**
 * 执行一次 lint（唯一入口；runLint 与 S6-T5 hook 共用）。
 * 组装 index 输入 → validate（scope=pre-commit）→ 版本提示（探测服务端规则版本，
 * 本地旧于服务端时附 N-UPGRADE-001；不改变退出码）。git/内部错误 fail-closed 为
 * E-RUN-002 错误报告（退出码 2）。
 */
export async function lintOnce(opts: LintOptions, deps: Partial<LintDeps> = {}): Promise<LintOutcome> {
  const cwd = deps.cwd ?? process.cwd()
  const d: LintDeps = {
    cwd,
    env: process.env,
    execGit: realExecGit(cwd),
    fetchImpl: fetch,
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
    ...deps,
  }

  let report: Report
  try {
    const snap = await readIndexSnapshot(opts.mode, d.execGit)
    const selected = opts.mode === 'staged' ? snap.entries.filter((e) => snap.stagedPaths!.has(e.path)) : snap.entries
    const files: FileInput[] = []
    for (const e of selected) {
      files.push({ path: e.path, mode: e.mode, content: await readBlob(d.execGit, e) })
    }
    const allPaths = snap.entries.map((e) => e.path)
    report = await validate({ scope: 'pre-commit', files, knownPaths: allPaths, treePaths: allPaths })
  } catch (e) {
    if (e instanceof GitSourceError || e instanceof Error) report = errorReport(e)
    else report = errorReport(String(e))
  }

  // 版本提示（校验未能完成时无意义，跳过）：服务端为权威版本（架构 §5.4）
  let hint: LintHint = { kind: 'none' }
  if (report.result !== 'error') {
    const probe = await probeServerRulesVersion(credentialSourceFromEnv(d.env), d.fetchImpl)
    if (probe.kind === 'version') {
      const cmp = compareRulesVersions(rulesVersion(), probe.version)
      if (cmp === -1) {
        const notice = {
          code: 'N-UPGRADE-001',
          message: renderMessage('N-UPGRADE-001', { actual: rulesVersion(), expected: probe.version }),
        }
        report.notices = [...(report.notices ?? []), notice]
        hint = { kind: 'notice', notice }
      } else if (cmp === null) {
        hint = { kind: 'skipped', reason: '服务端规则版本无法比较', silent: false }
      }
    } else {
      hint = { kind: 'skipped', reason: probe.reason, silent: probe.silent }
    }
  }

  return { report, exitCode: report.exitCode, hint }
}

/** 人类可读输出（--json 之外的形态）。 */
export function renderLintText(out: LintOutcome, opts: LintOptions): string {
  const r = out.report
  const lines: string[] = [`notegit lint --${opts.mode}（scope=${r.scope}，规则版本 ${r.rulesVersion}）`, '']
  if (r.result === 'error') {
    lines.push('校验运行错误：')
    for (const i of r.issues ?? []) lines.push(`  ${i.code} ${i.message}`)
  } else if (r.files.length === 0) {
    lines.push(opts.mode === 'staged' ? '暂存区没有待校验内容。' : '没有已跟踪文件。')
  } else {
    for (const f of r.files) {
      const exempt = f.exempt === true ? '（导航豁免：frontmatter 不校验）' : ''
      lines.push(`${f.path}：${f.status === 'pass' ? '通过' : '未通过'}${exempt}`)
      for (const i of f.issues) {
        const sev = i.severity === 'error' ? '错误' : i.severity === 'warning' ? '警告' : '提示'
        lines.push(`  ${sev} ${i.code} ${i.message}`)
      }
    }
  }
  lines.push('')
  lines.push(
    `小结：${r.summary.filesTotal} 个文件，${r.summary.filesFailed} 个未通过，${r.summary.errorCount} 个错误，${r.summary.warningCount} 个警告`,
  )
  for (const n of r.notices ?? []) lines.push(`提示 ${n.code} ${n.message}`)
  return `${lines.join('\n')}\n`
}

/** 命令面：解析 argv → lintOnce → 输出（--json 报告 / 人类可读）→ 返回进程退出码（0/1/2）。用法错误打 stderr 返回 2（不抛出）。 */
export async function runLint(argv: string[], deps: Partial<LintDeps> = {}): Promise<number> {
  const parsed = parseLintArgs(argv)
  if (!parsed.ok) {
    process.stderr.write(`notegit lint: ${parsed.message}\n`)
    return EXIT_ERROR
  }
  const d: Pick<LintDeps, 'stdout' | 'stderr'> = {
    stdout: deps.stdout ?? ((s) => process.stdout.write(s)),
    stderr: deps.stderr ?? ((s) => process.stderr.write(s)),
  }
  const out = await lintOnce(parsed.args, deps)
  if (out.hint.kind === 'skipped' && !out.hint.silent) {
    d.stderr(`notegit lint: 跳过规则版本提示（${out.hint.reason}）\n`)
  }
  if (parsed.args.json) d.stdout(`${JSON.stringify(out.report, null, 2)}\n`)
  else d.stdout(renderLintText(out, parsed.args))
  return out.exitCode
}
