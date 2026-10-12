/**
 * 子命令注册表（S6-T1 骨架）：每命令的帮助文案与交付状态标注。
 * status 同时用于占位执行的 stderr 提示；sync 按 sprint D6 仅占位、真实现属 S7。
 */
export interface CommandSpec {
  name: string
  summary: string
  status: string
  usage: string
  detail: string
  options: string[]
}

export const COMMANDS: Record<string, CommandSpec> = {
  login: {
    name: 'login',
    summary: '登录并配置员工凭据（安全存储 / Git credential helper）',
    status: 'S6-T2 交付',
    usage: 'notegit login [<server>]',
    detail: '获取、配置员工凭据并交给操作系统安全存储或 Git credential helper；凭据不写入 remote URL、仓库文件或日志。',
    options: ['-h, --help  输出本帮助'],
  },
  ls: {
    name: 'ls',
    summary: '列出有权访问的知识库、clone URL 与本地状态',
    status: 'S6-T3 交付',
    usage: 'notegit ls [--json]',
    detail: '实时按当前员工权限列出可见库；--json 输出结构稳定（schema 固化于 CLI 测试），本地状态标注已克隆/落后/未知。',
    options: ['--json  输出 JSON（schema 固化）', '-h, --help  输出本帮助'],
  },
  setup: {
    name: 'setup',
    summary: '在已克隆库中安装/管理本地校验 hook',
    status: 'S6-T6 交付',
    usage: 'notegit setup [--uninstall]',
    detail: '安装 pre-commit hook（不执行库内脚本，保留现有 hook 兼容或明确报告冲突）；卸载可还原 .git/hooks 原状；重复安装幂等。',
    options: ['--uninstall  卸载并还原 hook', '-h, --help  输出本帮助'],
  },
  lint: {
    name: 'lint',
    summary: '手动校验知识库内容（与服务端同一规则）',
    status: 'S6-T4 交付',
    usage: 'notegit lint [--staged | --all] [--json]',
    detail: '消费 packages/validation 同一实现（D5 工作区依赖）。--staged 只读暂存区（不读工作目录）；报告过 validation-report 协议；规则版本旧于服务端时提示 N-UPGRADE-001。',
    options: ['--staged  只校验暂存区内容', '--all     校验全部已跟踪文档', '--json    输出 validation-report JSON', '-h, --help  输出本帮助'],
  },
  sync: {
    name: 'sync',
    summary: '发现并安全同步知识库到本地（S7 实现，本 sprint 仅骨架）',
    status: 'S7 实现（本 sprint 仅骨架——sprint/S6 决策 D6）',
    usage: 'notegit sync',
    detail: '按安全策略克隆/快进更新可见库，遇脏工作区、未推送提交、分叉等保留改动并逐库报告。注意：sync 真实现属 S7，本 sprint 不提供。',
    options: ['-h, --help  输出本帮助'],
  },
}

export const COMMAND_ORDER = ['login', 'ls', 'sync', 'setup', 'lint'] as const
