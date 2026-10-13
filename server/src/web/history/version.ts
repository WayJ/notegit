import { spawn } from 'node:child_process';
import { extractFrontmatter } from 'notegit-validation';
import { execGit } from '../../publish/git-exec.ts';
import { vaultRepoPath } from '../../vaults/repo-path.ts';
import { treePathOk, type TreeEntry } from '../browse/tree.ts';

/**
 * S5-T2 历史版本读取面（版本预览与还原的数据源）：任意提交的树条目/blob
 * 读取——与 S5-T1 log.ts 同规（每请求 spawn、无缓存；只读 plumbing；语义
 * 失败与 spawn 失败分类返回）。复用 browse/tree.ts 的条目形态与路径判定
 * （treePathOk/TreeEntry），寻址面=commit OID（hex 缩写/全 SHA——与 diff 页
 * 同判），不收 rev 形态。
 */

/** 提交 OID 寻址形状（hex 缩写/全 SHA；与 log.ts diff 寻址同判——寻址面收 OID） */
const OID_SHAPE = /^[0-9a-f]{4,64}$/;

/** `ls-tree -l -z` 行形态（与 browse/tree.ts 同式——条目形态两处同构） */
const LS_TREE_LINE = /^(\d{6}) (tree|blob|commit) ([0-9a-f]{40,64})(?:\s+(\d+|-))?\t([\s\S]*)$/;

/** git 已运行但退出非零（语义失败）；spawn 层失败（目录缺失等）为 false */
function isGitExitFailure(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('git ');
}

export type EntryAtRead =
  | { kind: 'ok'; commitOid: string; entry: TreeEntry; mode: string }
  /** 提交在库内、路径未在提交树中出现（含当时尚不存在/已删除的路径） */
  | { kind: 'missing' }
  /** OID 形态非法/未知/非提交对象，或路径形态非法 */
  | { kind: 'not-found' }
  /** 仓库目录缺失/读取失败（存储不一致——页面空态呈现，不冒充 404） */
  | { kind: 'unavailable' };

/**
 * 读取「指定提交处某树路径」的条目（版本预览与还原的目标定位）。与
 * browse/tree.ts readEntryAt 同构（父目录 ls-tree + 按名定位），仅寻址由
 * 默认分支 ref 换为任意 commit OID——该提交树中不存在即 missing（还原「回到
 * 该版本时此文件尚不存在」= 不可还原目标，页面按 404 处理，不虚构内容）。
 */
export async function readEntryAtCommit(
  dataDir: string,
  vaultId: number,
  commitOid: string,
  entryPath: string,
): Promise<EntryAtRead> {
  if (entryPath === '' || !OID_SHAPE.test(commitOid) || !treePathOk(entryPath)) return { kind: 'not-found' };
  const repo = vaultRepoPath(dataDir, vaultId);
  let full: string;
  try {
    full = (await execGit(['rev-parse', '--verify', `${commitOid}^{commit}`], { cwd: repo })).trim();
  } catch (err) {
    if (!isGitExitFailure(err)) return { kind: 'unavailable' };
    return { kind: 'not-found' }; // 未知缩写/非提交对象（blob 等）
  }
  const slash = entryPath.lastIndexOf('/');
  const dirPath = slash === -1 ? '' : entryPath.slice(0, slash);
  const name = entryPath.slice(slash + 1);
  let out: string;
  try {
    out = await execGit(['ls-tree', '-l', '-z', dirPath === '' ? full : `${full}:${dirPath}`], { cwd: repo });
  } catch (err) {
    if (!isGitExitFailure(err)) return { kind: 'unavailable' };
    return { kind: 'not-found' }; // 父目录在该提交树中不存在（含解析到 blob）
  }
  const hit = parseLsTreeWithMode(out).find((e) => e.name === name);
  return hit === undefined
    ? { kind: 'missing' }
    : { kind: 'ok', commitOid: full, entry: hit, mode: hit.mode };
}

/** ls-tree 行（含 mode——还原 upsert 携带该提交处的原 tree mode） */
interface TreeLineEntry extends TreeEntry {
  readonly mode: string;
}

function parseLsTreeWithMode(out: string): TreeLineEntry[] {
  const entries: TreeLineEntry[] = [];
  for (const rec of out.split('\0')) {
    if (rec === '') continue;
    const m = LS_TREE_LINE.exec(rec);
    if (m === null) continue; // 未知形态跳过（不虚构条目）
    entries.push({
      type: m[2] as TreeEntry['type'],
      oid: m[3],
      size: m[4] !== undefined && m[4] !== '-' ? Number(m[4]) : undefined,
      name: m[5],
      mode: m[1],
    });
  }
  return entries;
}

/** 读取 blob 原始字节（二进制安全——还原内容逐字节保留，附件同样可还原）。
 *  execGit 面向文本（stdout→utf8 破坏二进制），与 rename/routes.ts 同形自带
 *  buffer 版（超时 SIGKILL/退出码语义同源）：git 退出非零 → null。 */
export function readBlobBytes(repoPath: string, oid: string): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['cat-file', 'blob', oid], { cwd: repoPath });
    const stdout: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stdout.on('data', (c: Buffer) => stdout.push(c));
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code === 0 ? Buffer.concat(stdout) : null);
    });
  });
}

/** frontmatter 剥离（与 view/routes.ts 同判：闭合块之后为正文；未闭合按
 *  lenient 跳过首行——预览不校验，规则判定在发布组件） */
export function bodyAfterFrontmatter(text: string): string {
  const fm = extractFrontmatter(text);
  const lines = (text.startsWith('﻿') ? text.slice(1) : text).split('\n');
  if (fm.kind === 'block' && fm.closeLine !== undefined) return lines.slice(fm.closeLine).join('\n');
  if (fm.kind === 'unterminated') return lines.slice(1).join('\n');
  return text;
}
