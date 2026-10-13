import { execGit } from '../../publish/git-exec.ts';
import { vaultRepoPath } from '../../vaults/repo-path.ts';
import { treePathOk } from '../browse/tree.ts';

/**
 * S5-T1 Git 历史读取面（历史页与 diff 页的数据源）：默认分支实时读（每请求
 * spawn，无任何缓存——D-IC-05 精神；sprint S5 D5「历史读取直接走 Git，无独立
 * 历史存储」），只读 plumbing（log / diff / rev-parse），不改引用。与 S4-T1
 * browse/tree.ts 同构：消费 execGit（S3-T7 发布组件同语义）与 vaultRepoPath
 * （S3-T1 路径映射），语义失败（ref/OID 不存在）与 spawn 失败（仓库目录缺失）
 * 分类返回，页面层据此区分 404 与空态。
 */

/** 历史页每页条数（分页窗口——测试对照所依常量） */
export const HISTORY_PAGE_SIZE = 20;

/** 历史行（主体=认证员工视角；author 字段按 DOD-03 仅作 Git 元数据展示） */
export interface CommitEntry {
  /** 提交全 OID（diff 链接寻址用） */
  readonly oid: string;
  /** 短 OID（git %h——页面呈现与 git log 对照所依） */
  readonly shortOid: string;
  /** 提交作者名（Git 元数据——推送方可填写，非审计主体） */
  readonly authorName: string;
  /** 提交作者邮箱（Git 元数据） */
  readonly authorEmail: string;
  /** 作者日期 %aI（ISO 8601） */
  readonly authorDate: string;
  /** 提交主题（subject——首行；内嵌分隔符并回） */
  readonly subject: string;
}

export type LogRead =
  | { kind: 'ok'; commits: readonly CommitEntry[]; hasMore: boolean }
  /** 默认分支尚无提交（新库空初始化） */
  | { kind: 'no-commits' }
  /** 路径形态非法（与不存在同响应——不泄露树内容） */
  | { kind: 'not-found' }
  /** 仓库目录缺失/读取失败（存储不一致——页面空态呈现，不冒充 404） */
  | { kind: 'unavailable' };

export type DiffRead =
  | { kind: 'ok'; commitOid: string; diff: string }
  /** OID 形态非法/未知/非提交对象，或路径形态非法 */
  | { kind: 'not-found' }
  | { kind: 'unavailable' };

/** log 机器格式：\x1f 分隔字段、-z 记录间 NUL（名字/主题不转义、无换行歧义） */
const LOG_FORMAT = '%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s';

/** git 已运行但退出非零（语义失败）；spawn 层失败（目录缺失等）为 false */
function isGitExitFailure(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('git ');
}

/**
 * 读取默认分支提交历史（库级 filePath=''；路径级传树路径），与
 * `git log [--skip N -n M] refs/heads/<branch> [-- <path>]` 同集同序（一致性
 * 断言所依）。分页：多取 1 条探测 hasMore，返回恒为单页窗口。
 */
export async function readCommitLog(
  dataDir: string,
  vaultId: number,
  defaultBranch: string,
  filePath: string,
  page: number,
): Promise<LogRead> {
  if (filePath !== '' && !treePathOk(filePath)) return { kind: 'not-found' };
  const repo = vaultRepoPath(dataDir, vaultId);
  const ref = `refs/heads/${defaultBranch}`;
  try {
    await execGit(['rev-parse', '--verify', '--quiet', ref], { cwd: repo });
  } catch (err) {
    if (!isGitExitFailure(err)) return { kind: 'unavailable' };
    return { kind: 'no-commits' }; // ref 不存在 = unborn 默认分支（空库）
  }
  const args = [
    'log', '-z', `--format=${LOG_FORMAT}`,
    '-n', String(HISTORY_PAGE_SIZE + 1),
    '--skip', String((page - 1) * HISTORY_PAGE_SIZE),
    ref,
  ];
  if (filePath !== '') args.push('--', filePath);
  let out: string;
  try {
    out = await execGit(args, { cwd: repo });
  } catch {
    return { kind: 'unavailable' }; // ref 已核验后 log 仍失败（竞态删除/坏对象等）——读取失败空态
  }
  const commits: CommitEntry[] = [];
  for (const rec of out.split('\0')) {
    if (rec === '') continue;
    const f = rec.split('\x1f');
    if (f.length < 6) continue; // 未知形态跳过（不虚构条目）
    commits.push({
      oid: f[0],
      shortOid: f[1],
      authorName: f[2],
      authorEmail: f[3],
      authorDate: f[4],
      subject: f.slice(5).join('\x1f'), // 主题内嵌分隔符时并回（字段序保障）
    });
  }
  const hasMore = commits.length > HISTORY_PAGE_SIZE;
  return { kind: 'ok', commits: hasMore ? commits.slice(0, HISTORY_PAGE_SIZE) : commits, hasMore };
}

/** 页面寻址 OID 形态：hex 缩写或全 SHA（rev 形如 HEAD/~ 不收——寻址面收 OID） */
const OID_SHAPE = /^[0-9a-f]{4,64}$/;

/**
 * 读取单提交↔其父提交的逐文件 diff（`git diff --no-color <父> <目标> -- <路径>`，
 * 一致性断言所依）。根提交无父：以空树为基线（等价 `git diff <空树> <根提交>`，
 * 呈现为整文件新增）；合并提交取第一父（^1——与「父提交↔目标」的常规读法一致）。
 * 目标提交未触及该路径时 git diff 输出为空串——页面据此如实标注空 diff。
 */
export async function readCommitDiff(
  dataDir: string,
  vaultId: number,
  commitOid: string,
  filePath: string,
): Promise<DiffRead> {
  if (filePath === '' || !OID_SHAPE.test(commitOid) || !treePathOk(filePath)) return { kind: 'not-found' };
  const repo = vaultRepoPath(dataDir, vaultId);
  let full: string;
  try {
    full = (await execGit(['rev-parse', '--verify', `${commitOid}^{commit}`], { cwd: repo })).trim();
  } catch (err) {
    if (!isGitExitFailure(err)) return { kind: 'unavailable' };
    return { kind: 'not-found' }; // 未知缩写/非提交对象（blob 等）
  }
  let base: string;
  try {
    base = (await execGit(['rev-parse', '--verify', `${full}^`], { cwd: repo })).trim();
  } catch (err) {
    if (!isGitExitFailure(err)) return { kind: 'unavailable' };
    // 根提交：父解析失败——空树基线（hash-object 空输入，不硬编码哈希算法）
    try {
      base = (await execGit(['hash-object', '-t', 'tree', '--stdin'], { cwd: repo, stdin: Buffer.alloc(0) })).trim();
    } catch {
      return { kind: 'unavailable' };
    }
  }
  let diff: string;
  try {
    diff = await execGit(['diff', '--no-color', base, full, '--', filePath], { cwd: repo });
  } catch (err) {
    if (!isGitExitFailure(err)) return { kind: 'unavailable' };
    return { kind: 'not-found' };
  }
  return { kind: 'ok', commitOid: full, diff };
}
