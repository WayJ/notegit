import { execGit } from '../../publish/git-exec.ts';
import { vaultRepoPath } from '../../vaults/repo-path.ts';

/**
 * S4-T1 Git tree 读取面（目录浏览的数据源）：默认分支实时读（每请求 spawn，
 * 无任何缓存——D-IC-05 精神），只读 plumbing（ls-tree / cat-file），不改引用。
 * 消费既有导出面：execGit（S3-T7 发布组件同语义——退出码 0→stdout、超时
 * SIGKILL、异步强制）与 vaultRepoPath（S3-T1 路径映射）。
 *
 * 与 api.md §6 tree/blob 端点的关系：本面只服务服务端渲染的页面族；API 端点
 * （CLI/API 消费者）仍按契约由后续任务实现——同一判定语义（默认分支、路径
 * 不存在即缺），不互替代。
 */

export interface TreeEntry {
  readonly name: string;
  readonly type: 'tree' | 'blob' | 'commit';
  readonly oid: string;
  /** blob 字节数（ls-tree -l）；tree/commit 无 */
  readonly size: number | undefined;
}

export type DirRead =
  | { kind: 'ok'; entries: TreeEntry[] }
  /** 默认分支尚无提交（新库空初始化——init bare 后 unborn） */
  | { kind: 'no-commits' }
  /** 路径不存在或非目录（含非法路径形态——与不存在同响应，不泄露树内容） */
  | { kind: 'not-found' }
  /** 仓库目录缺失/读取失败（存储不一致——页面空态呈现，不冒充 404） */
  | { kind: 'unavailable' };

/** -z 输出：`<mode> SP <type> SP <oid>[ SP <size>] TAB <name>`，NUL 分隔、名字不转义 */
const LS_TREE_LINE = /^(\d{6}) (tree|blob|commit) ([0-9a-f]{40,64})(?:\s+(\d+|-))?\t([\s\S]*)$/;

function parseLsTree(out: string): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const rec of out.split('\0')) {
    if (rec === '') continue;
    const m = LS_TREE_LINE.exec(rec);
    if (m === null) continue; // 未知形态跳过（不虚构条目）
    entries.push({
      type: m[2] as TreeEntry['type'],
      oid: m[3],
      size: m[4] !== undefined && m[4] !== '-' ? Number(m[4]) : undefined,
      name: m[5],
    });
  }
  return entries;
}

/** 页面树路径合法性：非空段、无 ./..、无反斜杠/控制字符，段长与总长受限 */
export function treePathOk(p: string): boolean {
  if (p.length === 0) return true;
  if (p.length > 1024 || p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg.length === 0 || seg === '.' || seg === '..' || seg.length > 255) return false;
    if (/[\x00-\x1f\x7f]/.test(seg)) return false;
  }
  return true;
}

function refOf(defaultBranch: string): string {
  return `refs/heads/${defaultBranch}`;
}

/** git 已运行但退出非零（语义失败：ref/路径不存在）；spawn 层失败（仓库目录缺失等 ENOENT）为 false */
function isGitExitFailure(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('git ');
}

/**
 * 读取默认分支某目录的直接子项（一层，与 `git ls-tree <rev>[:<path>]` 同集）。
 * 顺序保持 Git tree 原序（树内字节序——目录按带 `/` 排序），页面渲染与
 * `git ls-tree` 输出一致（完成标准断言所依）。
 */
export async function readDirTree(
  dataDir: string,
  vaultId: number,
  defaultBranch: string,
  dirPath: string,
): Promise<DirRead> {
  if (!treePathOk(dirPath)) return { kind: 'not-found' };
  const repo = vaultRepoPath(dataDir, vaultId);
  const ref = refOf(defaultBranch);
  try {
    await execGit(['rev-parse', '--verify', '--quiet', ref], { cwd: repo });
  } catch (err) {
    if (!isGitExitFailure(err)) return { kind: 'unavailable' }; // spawn 失败（目录缺失）
    return { kind: 'no-commits' }; // ref 不存在 = unborn 默认分支（空库）
  }
  const target = dirPath === '' ? ref : `${ref}:${dirPath}`;
  try {
    const out = await execGit(['ls-tree', '-l', '-z', target], { cwd: repo });
    return { kind: 'ok', entries: parseLsTree(out) };
  } catch (err) {
    if (!isGitExitFailure(err)) return { kind: 'unavailable' };
    return { kind: 'not-found' }; // 路径不存在或解析到 blob（非目录）
  }
}

/** README.md（名称大小写不敏感，架构 §5.2）条目定位——目录导航渲染用 */
export function findReadmeEntry(entries: readonly TreeEntry[]): TreeEntry | undefined {
  return entries.find((e) => e.type === 'blob' && e.name.toLowerCase() === 'readme.md');
}

/** 读取 blob 文本（cat-file by oid——不再次解析路径；上限由调用方按 entry.size 判） */
export async function readBlobText(dataDir: string, vaultId: number, oid: string): Promise<string> {
  return execGit(['cat-file', 'blob', oid], { cwd: vaultRepoPath(dataDir, vaultId) });
}

/** README 渲染上限：超限不渲染正文、页面如实标注（防超大文件拖垮页面） */
export const README_RENDER_MAX_BYTES = 1024 * 1024;

/** 以「父目录列表 + 文件名」解析单个条目（view 占位定位用；空路径不是条目） */
export async function readEntryAt(
  dataDir: string,
  vaultId: number,
  defaultBranch: string,
  entryPath: string,
): Promise<{ kind: 'ok'; entry: TreeEntry } | { kind: 'missing' } | Exclude<DirRead, { kind: 'ok' }>> {
  const slash = entryPath.lastIndexOf('/');
  const dirPath = slash === -1 ? '' : entryPath.slice(0, slash);
  const name = entryPath.slice(slash + 1);
  const read = await readDirTree(dataDir, vaultId, defaultBranch, dirPath);
  if (read.kind !== 'ok') return read;
  const entry = read.entries.find((e) => e.name === name);
  return entry === undefined ? { kind: 'missing' } : { kind: 'ok', entry };
}
