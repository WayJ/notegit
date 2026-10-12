import type { CommitDelta, FileInput } from 'notegit-validation'
import { VALID_FILE_MODES } from 'notegit-validation'
import { runGit, runGitBuffer } from './git-spawn.ts'

/**
 * 校验器输入组装（S3-T4；T3 移交清单 §9.3 第 1 项的落地）：git 遍历（rev-list/
 * diff-tree/ls-tree，全部异步 spawn——N4 自死锁教训）→ packages/validation 的
 * CommitDelta 组装。规则判定全部在共享校验器内完成（sprint D7 单一来源），本
 * 模块只负责「哪些内容是本次推送新引入的」：
 *
 * - 新提交范围：根推送（old 为零）用 `--not --all` 锚定服务端已有历史（pre-receive
 *   先于 ref 更新执行，--all 即推送前状态）；否则 `^old`。
 * - 逐提交展开：普通提交 vs 父提交的新增/修改（diff-tree A/M/T）；根提交全检
 *   （--root vs 空 tree）；合并提交按父展开取**交集**——两父皆无的内容才是本
 *   合并新引入（等于某一父版本的文件在其引入提交处已/将被校验，不因合并重判；
 *   架构 §5.4「合并提交按父比较」的防夹带语义）。
 * - FileInput.mode 取自 ls-tree（tree 条目真实 mode——E-PATH-002/003 判定依据）；
 *   非常规文件 mode（symlink/gitlink）不读 blob（gitlink 对象可能不存在）。
 * - treePaths 附带本提交全 tree 路径（E-PATH-004 全 tree 基线输入）。
 * - 删除条目不进 changes（validation.md §2.5）。
 *
 * -z 输出解析：路径不经 C 引号包裹，制表符/引号等字符原样可达校验器。
 */

export interface GitTraversal {
  /** 文本输出 git 查询（rev-list/ls-tree/diff-tree；-z 输出按 utf8 解码） */
  run(args: readonly string[]): Promise<string>
  /** blob 原始字节（二进制附件精确校验） */
  readBlob(oid: string): Promise<Buffer>
}

/** hook 进程用遍历器：cwd 为仓库目录（receive-pack 置 GIT_DIR='.' 与 cwd=库目录；
 * 测试可传工作树目录——git 隐式发现 .git）。 */
export function hookGitTraversal(cwd: string): GitTraversal {
  return {
    run: (args) => runGit(args, { cwd }),
    readBlob: (oid) => runGitBuffer(['cat-file', 'blob', oid], { cwd }),
  }
}

const ZERO_RE = /^0+$/

interface TreeLine {
  mode: string
  type: string
  oid: string
  path: string
}

/** `ls-tree -r -z` 输出解析：`<mode> SP <type> SP <oid>\t<path>` NUL 分隔记录 */
function parseLsTree(out: string): TreeLine[] {
  const entries: TreeLine[] = []
  for (const record of out.split('\0')) {
    if (record === '') continue
    const tab = record.indexOf('\t')
    if (tab === -1) throw new Error(`ls-tree 记录缺少路径分隔：${record.slice(0, 80)}`)
    const meta = record.slice(0, tab).split(' ')
    if (meta.length !== 3) throw new Error(`ls-tree 记录元数据畸形：${record.slice(0, 80)}`)
    entries.push({ mode: meta[0]!, type: meta[1]!, oid: meta[2]!, path: record.slice(tab + 1) })
  }
  return entries
}

/** `diff-tree -r -z --name-status` 输出解析：`S\0<path>[\0<orig>]\0` 记录（R/C
 *  带原路径第二字段——本模块不启用重命名检测，出现时按新路径计为变更）。返回
 *  新增/修改（A/M/T/R/C）路径集合，删除（D）不进。 */
function parseChangedPaths(out: string): Set<string> {
  const toks = out.split('\0')
  const changed = new Set<string>()
  let i = 0
  while (i < toks.length) {
    const status = toks[i]
    if (status === '') {
      i++
      continue
    }
    const path = toks[i + 1]
    if (path === undefined) throw new Error(`diff-tree 记录缺少路径：${status}`)
    if (/^[RC]/.test(status)) {
      i += 3 // status + 新路径 + 原路径
    } else {
      i += 2
    }
    if (status !== 'D') changed.add(path)
  }
  return changed
}

/** 一个提交相对其父提交集合的变更路径：根提交=全 tree；普通=vs 父；合并=按父交集 */
async function changedPathsOf(t: GitTraversal, oid: string, parents: string[]): Promise<Set<string>> {
  if (parents.length === 0) {
    const out = await t.run(['diff-tree', '-r', '-z', '--no-commit-id', '--name-status', '--root', oid])
    return parseChangedPaths(out)
  }
  let intersection: Set<string> | null = null
  for (const parent of parents) {
    const out = await t.run(['diff-tree', '-r', '-z', '--no-commit-id', '--name-status', parent, oid])
    const per = parseChangedPaths(out)
    if (intersection === null) {
      intersection = per
      continue
    }
    for (const p of intersection) {
      if (!per.has(p)) intersection.delete(p)
    }
  }
  return intersection ?? new Set()
}

/** 一个 ref 命令范围内全部新提交的 CommitDelta 组装（消费方负责跳过删除/违规命令）。 */
export async function collectRefDeltas(
  t: GitTraversal,
  ref: string,
  oldOid: string,
  newOid: string,
): Promise<CommitDelta[]> {
  void ref // ref 归属由上层 RefInput 装配；本函数只遍历提交
  const revArgs = ZERO_RE.test(oldOid)
    ? ['rev-list', '--parents', newOid, '--not', '--all']
    : ['rev-list', '--parents', newOid, `^${oldOid}`]
  const lines = (await t.run(revArgs)).trim().split('\n').filter(Boolean)

  const deltas: CommitDelta[] = []
  for (const line of lines) {
    const [oid, ...parents] = line.split(' ')
    const tree = parseLsTree(await t.run(['ls-tree', '-r', '-z', oid!]))
    const byPath = new Map(tree.map((e) => [e.path, e]))
    const changed = await changedPathsOf(t, oid!, parents)

    const changes: FileInput[] = []
    for (const p of changed) {
      const entry = byPath.get(p)
      if (entry === undefined) {
        throw new Error(`提交 ${oid} 的变更路径 ${p} 不在其 tree 中（遍历不一致，fail-closed）`)
      }
      // 非常规 mode（symlink/gitlink）整条由 E-PATH-002/003 拒绝，不读 blob（gitlink 对象可缺失）
      const content = VALID_FILE_MODES.has(entry.mode) ? await t.readBlob(entry.oid) : new Uint8Array(0)
      changes.push({ path: p, mode: entry.mode, content })
    }
    deltas.push({
      commit: oid!,
      parent: parents[0] ?? null,
      changes,
      treePaths: tree.map((e) => e.path),
    })
  }
  return deltas
}

/** 给定提交的全 tree 路径（pre-receive 链接存在性判定的库内基线，knownPaths 输入）。 */
export async function knownPathsOfTip(t: GitTraversal, oid: string): Promise<string[]> {
  return parseLsTree(await t.run(['ls-tree', '-r', '-z', oid])).map((e) => e.path)
}
