/**
 * git index 读取面（S6-T4；validation.md §1「本地 pre-commit：读 index，不读工作目录」）。
 *
 * 全部内容经 git 底层命令取自 index 对象（ls-files -s + cat-file blob），不 stat、
 * 不读工作目录文件——部分暂存场景由此构造「将提交的内容」（S1 防校验错对象）。
 * --all 与 --staged 同源：候选提交全树 = index 全部 stage-0 条目。
 */
import { spawn } from 'node:child_process'

/** index 条目：path（仓库根相对路径）+ mode（八进制字符串）+ blob（对象 SHA）。 */
export interface IndexEntry {
  readonly path: string
  readonly mode: string
  readonly blob: string
}

/** 一次 lint 所需的 index 快照。 */
export interface IndexSnapshot {
  /** 仓库根（rev-parse --show-toplevel） */
  readonly root: string
  /** index 全部 stage-0 条目（= 候选提交全树；E-PATH-004 基线与链接存在性判定共用） */
  readonly entries: readonly IndexEntry[]
  /** 相对 HEAD 的暂存变更路径（A/M/T；D 不校验——契约 §2.5 删除不做元数据校验）。undefined = --all 不需要 */
  readonly stagedPaths: ReadonlySet<string> | undefined
}

/** 可注入的 git 执行面（返回 stdout 原始字节；非零退出抛 GitSourceError）。 */
export type ExecGit = (args: readonly string[]) => Promise<Buffer>

/** git 调用失败（非零退出/无法启动）——lint 转译为 E-RUN-002 报告（退出码 2）。 */
export class GitSourceError extends Error {}

export function realExecGit(cwd: string): ExecGit {
  return (args) =>
    new Promise<Buffer>((resolve, reject) => {
      const child = spawn('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
      const out: Buffer[] = []
      let err = ''
      child.stdout.on('data', (d: Buffer) => out.push(d))
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (d: string) => {
        err += d
      })
      child.on('error', (e) => reject(new GitSourceError(`无法启动 git：${e.message}`)))
      child.on('close', (code) => {
        if (code === 0) {
          resolve(Buffer.concat(out))
          return
        }
        if (/not a git repository/i.test(err)) {
          reject(new GitSourceError('当前目录不在 git 仓库中（lint 需在知识库内运行）'))
          return
        }
        reject(new GitSourceError(`git ${args[0]} 失败（退出码 ${code}）：${err.trim().slice(0, 500)}`))
      })
    })
}

const decoder = new TextDecoder('utf-8') // 非致命：非法字节替换字符，由路径/编码规则判定，不做前置拒绝

function splitNul(buf: Buffer): Buffer[] {
  const parts: Buffer[] = []
  let start = 0
  for (let i = 0; i <= buf.length; i++) {
    if (i === buf.length || buf[i] === 0) {
      if (i > start) parts.push(buf.subarray(start, i))
      start = i + 1
    }
  }
  return parts
}

/** ls-files -s -z 记录：`<mode> <sha> <stage>\t<path>`（NUL 分隔）。冲突中间 stage 抛错（fail-closed）。 */
function parseLsFiles(out: Buffer): IndexEntry[] {
  const entries: IndexEntry[] = []
  const unmerged: string[] = []
  for (const record of splitNul(out)) {
    const tab = record.indexOf(0x09)
    if (tab < 0) throw new GitSourceError(`ls-files 记录缺少路径分隔符：${decoder.decode(record.subarray(0, 40))}`)
    const [mode = '', blob = '', stage = ''] = decoder.decode(record.subarray(0, tab)).split(' ')
    const entryPath = decoder.decode(record.subarray(tab + 1))
    if (stage === '0') entries.push({ path: entryPath, mode, blob })
    else unmerged.push(entryPath)
  }
  if (unmerged.length > 0) {
    throw new GitSourceError(`存在未解决的合并冲突条目（先 git add 解决再校验）：${unmerged.slice(0, 5).join('、')}${unmerged.length > 5 ? ' 等' : ''}`)
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) // 报告文件序确定化
  return entries
}

/** diff --cached --no-renames --name-status -z 记录：`<status>\0<path>\0`；取 A/M/T。 */
function parseStagedChanges(out: Buffer): Set<string> {
  const paths = new Set<string>()
  const parts = splitNul(out)
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = decoder.decode(parts[i]!)
    const p = decoder.decode(parts[i + 1]!)
    if (status === 'U') throw new GitSourceError(`存在未解决的合并冲突条目（先 git add 解决再校验）：${p}`)
    if (status === 'A' || status === 'M' || status === 'T') paths.add(p)
    // D（删除）不校验：契约 §2.5 删除不做元数据校验
  }
  return paths
}

/**
 * 读取 index 快照。--staged 额外取相对 HEAD 的变更集（unborn HEAD 时 git 语义
 * 自然给出全 A——新库根提交查全部，与 pre-receive 同构）；--all 跳过 diff。
 */
export async function readIndexSnapshot(mode: 'staged' | 'all', execGit: ExecGit): Promise<IndexSnapshot> {
  const root = decoder.decode(await execGit(['rev-parse', '--show-toplevel'])).trim()
  const entries = parseLsFiles(await execGit(['ls-files', '-s', '-z']))
  const stagedPaths = mode === 'staged' ? parseStagedChanges(await execGit(['diff', '--cached', '--no-renames', '--name-status', '-z'])) : undefined
  return { root, entries, stagedPaths }
}

/** 常规文件 mode（其余 mode——符号链接/gitlink/非法——由 E-PATH-002/003/005 在内容判定链首拦截，且 gitlink 无本地对象）。 */
const READABLE_MODES = new Set(['100644', '100755'])
const EMPTY = new Uint8Array(0)

/** 从对象库读 index 条目内容（blob 字节）。 */
export async function readBlob(execGit: ExecGit, entry: IndexEntry): Promise<Uint8Array> {
  if (!READABLE_MODES.has(entry.mode)) return EMPTY
  return await execGit(['cat-file', 'blob', entry.blob])
}
