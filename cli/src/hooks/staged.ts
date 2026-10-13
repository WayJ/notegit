/** 暂存区校验核心（S6-T5 临时载体——S6-T4 并行未合并，本接口即 notes 接口约定的先实现，
 * 记录于 .agents/notes/2026-10-13-S6-T5-hooks.md；T4 合并时 lint 命令应消费同一实现或
 * 保持等价，等价断言见 test/hooks-lint.test.ts）。
 *
 * validation.md §1 pre-commit 行：校验对象 = 暂存区将提交的文件内容（读 index，不读
 * 工作目录——部分暂存不得校验错对象）；失败行为 = 退出非零阻断。内容规则判定全部在
 * packages/validation（sprint D5 单一来源），本模块只负责「哪些内容将随本次提交进入
 * 历史」：
 * - 变更集 = index 相对 HEAD（无 HEAD 的根提交 = 全部 index 条目）的新增/修改；
 *   mode 变化同样视为修改。删除条目不进变更（validation.md §2.5 删除不做元数据校验）。
 * - 内容与 mode 一律取自 index（ls-files --stage + cat-file blob）——工作目录随后
 *   如何改动不影响判定（将提交的是 index 内容）。
 * - treePaths = index 全路径（候选提交全 tree，E-PATH-004 基线——与 pre-receive 的
 *   CommitDelta.treePaths 同语义）；knownPaths 同源（库内链接存在性按提交后状态判定）。
 * - 危险 mode（symlink 120000 / gitlink 160000）不读 blob，交由 E-PATH-002/003 整条拒绝
 *   （与 server/src/githttp/validation-input.ts 同规则）。
 * - unmerged 条目（stage≠0）在 git 侧提交前即被拒（本 hook 不会遇到；重复路径按
 *   后写覆盖，语义上该提交不可能成立）。
 */
import { validate, rulesVersion, issueOf, summarize, VALID_FILE_MODES } from 'notegit-validation'
import type { FileInput, Report } from 'notegit-validation'
import { runGitText, runGitBuffer } from './git.ts'

/** index 扫描结果（validate() 的 pre-commit 输入面）。 */
export interface StagedScan {
  /** 相对 HEAD（或根提交全集）的暂存新增/修改条目，内容取自 index blob */
  files: FileInput[]
  /** 候选提交（index）全 tree 路径 —— E-PATH-004 基线 */
  treePaths: string[]
  /** 同候选全 tree 路径 —— 库内链接存在性基线（提交后状态） */
  knownPaths: string[]
}

/** lint --staged 单次结果：报告（validation-report 协议）+ 进程退出码（0/1/2）。 */
export interface LintStagedResult {
  report: Report
  exitCode: 0 | 1 | 2
}

interface IndexEntry {
  mode: string
  oid: string
  stage: string
  path: string
}

interface HeadEntry {
  mode: string
  oid: string
}

/** `git ls-files --stage -z` 输出解析：`<mode> SP <oid> SP <stage>\t<path>` NUL 分隔记录。 */
function parseLsFiles(out: string): IndexEntry[] {
  const entries: IndexEntry[] = []
  for (const record of out.split('\0')) {
    if (record === '') continue
    const tab = record.indexOf('\t')
    if (tab === -1) throw new Error(`ls-files 记录缺少路径分隔：${record.slice(0, 80)}`)
    const meta = record.slice(0, tab).split(' ')
    if (meta.length !== 3) throw new Error(`ls-files 记录元数据畸形：${record.slice(0, 80)}`)
    entries.push({ mode: meta[0]!, oid: meta[1]!, stage: meta[2]!, path: record.slice(tab + 1) })
  }
  return entries
}

/** `git ls-tree -r -z` 输出解析：`<mode> SP <type> SP <oid>\t<path>` NUL 分隔记录。 */
function parseLsTree(out: string): Map<string, HeadEntry> {
  const byPath = new Map<string, HeadEntry>()
  for (const record of out.split('\0')) {
    if (record === '') continue
    const tab = record.indexOf('\t')
    if (tab === -1) throw new Error(`ls-tree 记录缺少路径分隔：${record.slice(0, 80)}`)
    const meta = record.slice(0, tab).split(' ')
    if (meta.length !== 3) throw new Error(`ls-tree 记录元数据畸形：${record.slice(0, 80)}`)
    byPath.set(record.slice(tab + 1), { mode: meta[0]!, oid: meta[2]! })
  }
  return byPath
}

/** 扫描暂存区（cwd 可为仓库内任意目录——先解析 toplevel，git 运行 hook 时 cwd=仓库根）。 */
export async function scanStaged(cwd: string = process.cwd()): Promise<StagedScan> {
  const top = (await runGitText(['rev-parse', '--show-toplevel'], { cwd })).trim()
  if (top === '') throw new Error('不在 git 工作树内（rev-parse --show-toplevel 为空）')

  const index = parseLsFiles(await runGitText(['ls-files', '--stage', '-z'], { cwd: top }))
  const treePaths = index.map((e) => e.path)

  // HEAD 存量条目（根提交无 HEAD → 空基线，全部 index 条目均为新增）。
  // verify --quiet 在未出生分支上退出码 1 且无输出——按「无 HEAD」处理。
  let head = new Map<string, HeadEntry>()
  const headOid = await runGitText(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: top })
    .then((out) => out.trim())
    .catch(() => '')
  if (headOid !== '') {
    head = parseLsTree(await runGitText(['ls-tree', '-r', '-z', headOid], { cwd: top }))
  }

  const files: FileInput[] = []
  for (const entry of index) {
    const known = head.get(entry.path)
    if (known !== undefined && known.mode === entry.mode && known.oid === entry.oid) continue // 与 HEAD 一致：非本次变更
    // 危险 mode 不读 blob（gitlink 对象可能不存在；symlink 内容交 E-PATH-002 拒绝）
    const content = VALID_FILE_MODES.has(entry.mode)
      ? new Uint8Array(await runGitBuffer(['cat-file', 'blob', entry.oid], { cwd: top }))
      : new Uint8Array(0)
    files.push({ path: entry.path, mode: entry.mode, content })
  }
  return { files, treePaths, knownPaths: treePaths }
}

/** lint --staged 等价入口：扫描 + 校验，永不抛出（扫描失败 → E-RUN-002 error 报告，退出码 2）。 */
export async function lintStaged(cwd: string = process.cwd()): Promise<LintStagedResult> {
  try {
    const scan = await scanStaged(cwd)
    const report = await validate({
      scope: 'pre-commit',
      files: scan.files,
      treePaths: scan.treePaths,
      knownPaths: scan.knownPaths,
    })
    return { report, exitCode: report.exitCode }
  } catch (e) {
    // 与 validate() 内部 errorReport 同构（E-RUN-002 → 退出码 2，fail-closed）
    const issues = [issueOf('E-RUN-002', { actual: e instanceof Error ? e.message : String(e) })]
    const report: Report = {
      rulesVersion: rulesVersion(),
      scope: 'pre-commit',
      result: 'error',
      exitCode: 2,
      summary: summarize([], issues),
      files: [],
      issues,
    }
    return { report, exitCode: 2 }
  }
}
