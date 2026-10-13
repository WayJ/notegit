/** 随工具分发的 pre-commit hook 本体（S6-T5；validation §1「库内脚本攻击 hook」行：
 * 只运行本程序——它只做 git plumbing 查询 + packages/validation 校验，绝不执行知识库
 * 内的任何脚本/hook 样本）。由 .git/hooks/pre-commit launcher 以绝对路径调用
 * （launcher 见 install.ts；安装/卸载/兼容链属 S6-T6 的 notegit setup）。
 *
 * 用法：node pre-commit.js [--json]
 * - 缺省：人读报告（git 将 hook 输出回显给提交者），退出码 = 报告退出码（0/1/2）
 * - --json：stdout 输出 validation-report 协议 JSON（与 notegit lint --staged --json
 *   同一报告——等价断言见 test/hooks-lint.test.ts）
 * 退出码语义（validation §6.1）：0=通过（可含 warning）→ 放行 commit；1=校验错误 →
 * 阻断；2=运行错误 → 阻断（fail-closed）。
 */
import process from 'node:process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Report, Issue } from 'notegit-validation'
import { lintStaged } from './staged.ts'

function issueLine(issue: Issue): string {
  const icon = issue.severity === 'error' ? '✗' : '⚠'
  return `  ${icon} [${issue.code}] ${issue.message}`
}

/** 人读报告（§1 失败行为：给出文件、规则与修正提示——消息模板自带定位与修正建议）。 */
export function renderReport(report: Report): string {
  const s = report.summary
  const lines: string[] = []
  if (report.result === 'pass') {
    lines.push(`notegit pre-commit：通过（${s.filesTotal} 个文件，${s.warningCount} 个警告）—— 规则版本 ${report.rulesVersion}`)
  } else if (report.result === 'fail') {
    lines.push(`notegit pre-commit：校验失败（${s.filesFailed}/${s.filesTotal} 个文件未过，${s.errorCount} 个错误、${s.warningCount} 个警告）—— 规则版本 ${report.rulesVersion}`)
  } else {
    lines.push(`notegit pre-commit：运行错误（fail-closed）—— 规则版本 ${report.rulesVersion}`)
  }
  for (const issue of report.issues ?? []) lines.push(issueLine(issue))
  for (const f of report.files) {
    for (const issue of f.issues) lines.push(issueLine(issue))
  }
  for (const notice of report.notices ?? []) lines.push(`  ℹ ${notice.message}`)
  if (report.result === 'fail') lines.push('提交已阻止：修正以上问题后重试（notegit lint --staged 可复现本报告）')
  if (report.result === 'error') lines.push('提交已阻止：校验未能完成（fail-closed）；notegit lint --staged 可复现')
  return `${lines.join('\n')}\n`
}

/** hook 主流程：返回进程退出码（写 stdout 由调用方/入口完成）。 */
export async function runHook(argv: readonly string[], out: { write(s: string): void } = process.stdout): Promise<number> {
  if (argv.length === 0) {
    const { report, exitCode } = await lintStaged()
    out.write(renderReport(report))
    return exitCode
  }
  if (argv.length === 1 && argv[0] === '--json') {
    const { report, exitCode } = await lintStaged()
    out.write(`${JSON.stringify(report)}\n`)
    return exitCode
  }
  process.stderr.write('用法：pre-commit [--json]（由 .git/hooks/pre-commit launcher 调用，不接收其他参数）\n')
  return 2
}

// 直接作为进程入口运行时执行（launcher：exec <node 绝对路径> <本文件绝对路径>）
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runHook(process.argv.slice(2))
}
