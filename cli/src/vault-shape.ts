/**
 * 服务端响应形态收窄（CLI 消费服务端响应的唯一收窄点）。
 *
 * 背景与理由：CLI 的 ls/sync 从 GET /api/v1/vaults 读取库列表，响应中的 slug 与
 * default_branch 此前零校验，直接进入本地路径拼接与 git 实参（git clone <url>
 * <dir> / git fetch <url> <branch>）。恶意或被攻陷的服务端（或用户被诱导登录到
 * 恶意实例）可用 `../../Library/LaunchAgents` 一类 slug 把攻击者完全控制的文件树
 * 写到同步根之外（macOS LaunchAgents / Linux systemd user 单元 → 登录持久化 RCE），
 * 也可用 `-c core.sshCommand=…` 一类分支名做 git 实参注入。
 *
 * 三道防线（纵深）：
 *   1. 摄入面（ls/api.ts isVaultItem）：slug/默认分支形态收窄——一条不合法即整份
 *      列表按契约形态错误拒绝（fail-closed，不静默丢条目）。
 *   2. 消费面（各消费点）：路径一律经 safeVaultDir 拼装——越出同步根即拒绝操作。
 *   3. 删除面（sync/clean.ts）：与摄入面同一口径（isSafeVaultSlug）——不再存在
 *      「删除面防了、摄入面没防」的不对称。
 *
 * 本模块只做形态判定与路径拼装，不做 I/O、不抛异常（判定面一律返回布尔/null）。
 */
import path from 'node:path'

/**
 * 库标识形态：单个路径段（不含 `/` `\` `.` 与控制字符），长度 1–64 —— 服务端
 * api.md §5 的 slug 契约（服务端 SLUG_PATTERN = /^[a-z0-9-]{1,64}$/）。
 *
 * 口径取服务端形态的放宽版（允许大写）：CLI 消费的是服务端下发的 slug，判定
 * 目的是「不得越出同步根、不得引入路径分隔符」，而非复刻服务端大小写政策；
 * 放宽面仍是无路径语义的纯字母数字连字符串。
 */
export function isSafeVaultSlug(slug: string): boolean {
  return /^[A-Za-z0-9-]{1,64}$/.test(slug)
}

/**
 * 分支名形态：git 可接受的 ref 子集——不得以 `-` 开头（git 实参注入面）、不含
 * `..`、不含 refspec/通配/控制字符。
 */
export function isSafeBranchName(name: string): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name)) return false
  return !name.includes('..')
}

/**
 * 库目录：slug → 本地目录，越出同步根即返回 null（纵深防御——形态校验之外的
 * 第二道：即便字符集判定将来被放宽，路径也不得逃出 root）。
 */
export function safeVaultDir(root: string, slug: string): string | null {
  const resolvedRoot = path.resolve(root)
  const dir = path.resolve(resolvedRoot, slug)
  if (dir === resolvedRoot) return null // 目录等于根本身（slug 为空/`.`/`..` 形态）
  if (!dir.startsWith(resolvedRoot + path.sep)) return null // 越出同步根
  return dir
}
