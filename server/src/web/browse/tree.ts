import { execGit } from '../../publish/git-exec.ts';
import { readTreeCached } from '../../readcache/tree-cache.ts';
import { vaultRepoPath } from '../../vaults/repo-path.ts';

/**
 * S4-T1 Git tree 读取面（目录浏览的数据源）：默认分支实时读，只读 plumbing
 * （ls-tree / cat-file），不改引用。S24-T1 起 ls-tree/rev-parse 族经单源跨请求
 * 树缓存（readcache/tree-cache.ts——失效钩子优先+TTL 兜底+fail-closed，E8 D48）
 * 服务，读端点响应形态不变（只变服务方式）；cat-file/blob 正文不在树缓存面。
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
    await readTreeCached(['rev-parse', '--verify', '--quiet', ref], { cwd: repo });
  } catch (err) {
    if (!isGitExitFailure(err)) return { kind: 'unavailable' }; // spawn 失败（目录缺失）
    return { kind: 'no-commits' }; // ref 不存在 = unborn 默认分支（空库）
  }
  const target = dirPath === '' ? ref : `${ref}:${dirPath}`;
  try {
    const out = await readTreeCached(['ls-tree', '-l', '-z', target], { cwd: repo });
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

// ── S11-T3 目录行最后提交元数据（批量派生） ─────────────────────────────────

/** 条目最新触及提交的呈现元数据（作者/时间——G07） */
export interface LastCommitInfo {
  readonly author: string;
  /** 作者时间 ISO 8601（相对时间呈现 + title 绝对时间提示所依） */
  readonly isoTime: string;
}

/** git 执行面注入缝（缺省 execGit；测试以计数包装证明批量派生——恒单次 spawn） */
export type RunGit = typeof execGit;

/**
 * 批量派生「当前目录条目 → 最新触及提交」：单次 `git log -z --name-only
 * --format=…`（记录分隔 %x1e / 字段分隔 %x1f——NUL 由 -z 保留给路径，防转义
 * 与换行歧义）由新到旧扫描全历史路径名单，条目名首见即定——blob=精确路径
 * 触及、tree=子路径前缀触及（`docs/nested-x` 不误配 `docs/nested/`）。逐条
 * spawn 禁止（D4：N+1 子进程风爆）；每请求实时派生、无缓存（log 族不属
 * ls-tree 族——S24 D1 缓存面外，不另受 githttp 闸门约束）。条目集与序不经此
 * 面——仅附加元数据（页面一致性断言仍以 ls-tree 为准）。记录首字段 commit
 * hash 未消费（解析健全性锚）；合并提交默认无路径名单，自然跳过（发布面无
 * 合并提交——语义与「任一父提交触及」近似）。
 */
export async function readLastCommits(
  dataDir: string,
  vaultId: number,
  defaultBranch: string,
  dirPath: string,
  entries: readonly TreeEntry[],
  runGit: RunGit = execGit,
): Promise<Map<string, LastCommitInfo>> {
  const latest = new Map<string, LastCommitInfo>();
  if (entries.length === 0) return latest;
  const out = await runGit(
    ['log', '-z', '--name-only', '--format=\x1e%H\x1f%an\x1f%aI', refOf(defaultBranch)],
    { cwd: vaultRepoPath(dataDir, vaultId) },
  );
  const prefix = dirPath === '' ? '' : `${dirPath}/`;
  for (const record of out.split('\x1e')) {
    const headEnd = record.indexOf('\0'); // 记录头（hash\x1fauthor\x1fiso）止于首个 NUL
    if (headEnd === -1) continue;
    const [hash, author, iso] = record.slice(0, headEnd).split('\x1f');
    if (hash === undefined || hash === '' || author === undefined || iso === undefined) continue;
    // -z 下首个路径前有一换行（名单分隔），其后路径逐个 NUL 终止（路径可含换行）
    for (const p of record.slice(headEnd + 1).replace(/^\n/, '').split('\0')) {
      if (p === '') continue;
      const rel = prefix === '' ? p : p.startsWith(prefix) ? p.slice(prefix.length) : null;
      if (rel === null || rel === '') continue;
      const seg = rel.split('/', 1)[0]; // 当前目录直接子项名
      if (seg !== '' && !latest.has(seg)) latest.set(seg, { author, isoTime: iso });
    }
  }
  return latest;
}

/**
 * 单路径「最后触及提交」元数据（S21-T2/B4 阅读页维护者·更新时间数据源）：
 * `git log -n 1 --format=<oid, author, iso> <ref> -- <path>` 单次 spawn——与
 * readLastCommits 同读取面（默认分支实时读、无缓存），仅收窄为单个树路径。
 * 无提交触及（路径不存在于历史）/ 分支不存在 / 仓库缺失 → null（呈现层如实
 * 省略该徽章，不虚构）。
 */
export async function readLastCommitForPath(
  dataDir: string,
  vaultId: number,
  defaultBranch: string,
  entryPath: string,
  runGit: RunGit = execGit,
): Promise<{ author: string; isoTime: string } | null> {
  let out: string;
  try {
    out = await runGit(
      ['log', '-n', '1', '-z', '--name-only', '--format=\x1e%H\x1f%an\x1f%aI', `refs/heads/${defaultBranch}`, '--', entryPath],
      { cwd: vaultRepoPath(dataDir, vaultId) },
    );
  } catch {
    return null;
  }
  const record = out.indexOf('\x1e');
  if (record === -1) return null;
  const rest = out.slice(record + 1);
  const headEnd = rest.indexOf('\0');
  const head = (headEnd === -1 ? rest : rest.slice(0, headEnd)).split('\x1f');
  const [, author, iso] = head;
  if (author === undefined || author === '' || iso === undefined || iso === '') return null;
  return { author, isoTime: iso };
}

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
