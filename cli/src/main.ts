/** 参数分发与帮助渲染（S6-T1 骨架）：--version/--help 真实输出，子命令占位执行。 */
import process from 'node:process'
import { COMMANDS, COMMAND_ORDER, type CommandSpec } from './commands.ts'
import { VERSION } from './version.ts'
import { EXIT_ERROR, EXIT_OK } from './exit-codes.ts'
import { runLs } from './ls/index.ts'
import { runLogin } from './login.ts'
import { runLint } from './lint/index.ts'
import { runCredentialHelper } from './credentials.ts'
import { runSetup } from './setup/index.ts'

function topHelp(): string {
  const lines = [
    'notegit — Notegit 员工端 CLI',
    '',
    '用法：',
    '  notegit <命令> [选项]',
    '',
    '命令：',
    ...COMMAND_ORDER.map((name) => `  ${COMMANDS[name].name.padEnd(6)} ${COMMANDS[name].summary}`),
    '',
    '选项：',
    '  -v, --version  输出版本',
    '  -h, --help     输出本帮助（notegit <命令> --help 查看子命令用法）',
    '',
    '退出码：',
    '  0  成功',
    '  1  命令失败（校验错误、查询失败等业务性失败）',
    '  2  用法错误或运行错误',
    '',
    '环境：Node ≥ 22.13（macOS / Linux；D10 selection §6）',
  ]
  return `${lines.join('\n')}\n`
}

function commandHelp(cmd: CommandSpec): string {
  const lines = [
    `${cmd.usage} — ${cmd.summary}`,
    '',
    '说明：',
    `  ${cmd.detail}`,
    `  状态：${cmd.implemented === true ? `已实现（${cmd.status}）` : `尚未实现（${cmd.status}）`}`,
    '',
    '选项：',
    ...cmd.options.map((o) => `  ${o}`),
    '',
    `退出码：0 成功；1 命令失败；2 用法/运行错误${cmd.implemented === true ? '' : '（占位命令一律退出码 2）'}`,
  ]
  return `${lines.join('\n')}\n`
}

/** 解析 argv 并执行；返回进程退出码（0/1/2，见 exit-codes.ts）。异步命令（login/ls）经 await。 */
export async function run(argv: string[]): Promise<number> {
  const [first, ...rest] = argv
  if (first === undefined) {
    process.stderr.write('notegit: 未提供命令。运行 notegit --help 查看用法。\n')
    return EXIT_ERROR
  }
  if (first === '--version' || first === '-v') {
    process.stdout.write(`notegit ${VERSION}\n`)
    return EXIT_OK
  }
  if (first === '--help' || first === '-h') {
    process.stdout.write(topHelp())
    return EXIT_OK
  }
  if (first.startsWith('-')) {
    process.stderr.write(`notegit: 未知选项：${first}（notegit --help 查看用法）\n`)
    return EXIT_ERROR
  }
  if (first === 'credential') {
    // 内部命令：git credential-helper 协议后端（不进帮助；由 login 注册的配置调用）
    const verb = rest[0]
    if (verb !== 'get' && verb !== 'store' && verb !== 'erase') {
      process.stderr.write('notegit credential: 需要动词 get|store|erase（git credential-helper 协议；内部命令）\n')
      return EXIT_ERROR
    }
    return await runCredentialHelper(verb)
  }
  const cmd = COMMANDS[first]
  if (cmd === undefined) {
    process.stderr.write(`notegit: 未知命令：${first}（notegit --help 查看可用命令）\n`)
    return EXIT_ERROR
  }
  if (rest.includes('--help') || rest.includes('-h')) {
    process.stdout.write(commandHelp(cmd))
    return EXIT_OK
  }
  if (cmd.name === 'ls') return runLs(rest) // S6-T3
  if (cmd.name === 'login') return await runLogin(rest) // S6-T2
<<<<<<< HEAD
  if (cmd.name === 'lint') return await runLint(rest) // S6-T4
=======
  if (cmd.name === 'setup') return await runSetup(rest) // S6-T6
>>>>>>> 644ddaf
  process.stderr.write(`notegit ${cmd.name}: 尚未实现（${cmd.status}）\n`)
  return EXIT_ERROR
}
