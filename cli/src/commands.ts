/**
 * 子命令注册表（S6-T1 骨架）：每命令的帮助文案与交付状态标注。
 * status 同时用于占位执行的 stderr 提示；sync 按 sprint D6 仅占位、真实现属 S7。
 */
export interface CommandSpec {
  name: string
  /** 已实现命令渲染「已实现」状态行；缺省 = 占位（尚未实现）。 */
  implemented?: boolean
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
    implemented: true,
    usage: 'notegit login <server> [--username <用户名>]',
    detail: '交互或参数提供用户名与访问令牌（ngt_，网页端「查看访问凭据」创建）；令牌仅经隐藏输入或环境变量 NOTEGIT_TOKEN 提供，绝不走命令行参数、remote URL、仓库文件或日志；校验通过后存入 0600 凭据文件并注册 Git credential helper。',
    options: [
      '--username <用户名>  参数式提供用户名（缺省交互输入）',
      '令牌来源：环境变量 NOTEGIT_TOKEN 或隐藏交互输入（不接受 --token 参数）',
      '-h, --help  输出本帮助',
    ],
  },
  ls: {
    name: 'ls',
    summary: '列出有权访问的知识库、clone URL 与本地状态',
    status: 'S6-T3 已实现（--json schema 固化于 cli/test/ls.test.ts）',
    usage: 'notegit ls [--json]',
    detail: '实时按当前员工权限列出可见库（GET /api/v1/vaults，Bearer）；本地状态 = 未克隆/已克隆/落后/未知（对照本地根目录 <root>/<slug>）。凭据占位面：NOTEGIT_SERVER 与 NOTEGIT_TOKEN 环境变量（S6-T2 login 交付后接管）；本地根目录默认 ~/knowbase，可用 NOTEGIT_LOCAL_ROOT 覆盖。',
    options: ['--json  输出 JSON（schema 固化）', '-h, --help  输出本帮助'],
    implemented: true,
  },
  setup: {
    name: 'setup',
    summary: '在已克隆库中安装/卸载/管理本地校验 hook 与本地根目录',
    status: 'S6-T6 交付（兼容两模式与卸载还原测试：cli/test/setup-*.test.ts）',
    usage: 'notegit setup [--chain] [--local-root <路径>] [--uninstall]',
    detail: '在当前仓库安装 pre-commit hook（不执行库内脚本）。已有外来 pre-commit 时默认明确报告冲突并拒绝安装（保留现有 hook）；加 --chain 改用兼容链：原 hook 原样保留为 pre-commit.user，提交时先运行原 hook 再追加 notegit 校验。卸载还原 .git/hooks 原状（兼容链卸载把原 hook 还原回 pre-commit），重复安装/卸载幂等。--local-root 把本地根目录持久化到 CLI 配置（notegit ls 按 <根>/<slug> 对照，缺省 ~/knowbase）；同时提示性检查 Git credential helper 注册状态。',
    options: [
      '--chain            已有外来 pre-commit 时采用兼容链（保留原 hook 为 pre-commit.user，先运行原 hook 再追加 notegit 校验）；默认为明确报告冲突拒绝安装',
      '--local-root <路径>  持久化本地根目录到 CLI 配置（~ 按当前 HOME 展开；缺省取环境变量 NOTEGIT_LOCAL_ROOT）',
      '--uninstall        卸载并还原 .git/hooks 原状（幂等；外来 hook 不触碰）',
      '-h, --help         输出本帮助',
    ],
    implemented: true,
  },
  lint: {
    name: 'lint',
    summary: '手动校验知识库内容（与服务端同一规则）',
    status: 'S6-T4 已实现（--json 报告协议固化于 cli/test/lint.test.ts）',
    implemented: true,
    usage: 'notegit lint [--staged | --all] [--json]',
    detail: '消费 packages/validation 同一实现（D5 工作区依赖）。--staged 只读 git index（不读工作目录——部分暂存只校验暂存内容）；--all 校验 index 全部已跟踪条目（将提交的完整树，内容同样取 index）。报告过 validation-report 协议（schemas/validation-report.schema.json）；本地规则旧于服务端时报告附 N-UPGRADE-001 提示（未配置凭据时静默跳过，探测失败时 stderr 一行说明；提示不改变退出码）。',
    options: [
      '--staged  只校验暂存区内容（相对 HEAD 的新增/修改；删除不校验）',
      '--all     校验 index 全部已跟踪条目',
      '--json    输出 validation-report JSON（退出码 0/1/2 同报告 exitCode）',
      '凭据面（仅版本提示用，可选）：环境变量 NOTEGIT_SERVER 与 NOTEGIT_TOKEN',
      '-h, --help  输出本帮助',
    ],
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
