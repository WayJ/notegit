import type { DatabaseSync } from 'node:sqlite';
import { readTreeCached } from '../../readcache/tree-cache.ts';
import { vaultRepoPath } from '../../vaults/repo-path.ts';
import type { RunGit } from '../browse/tree.ts';
import type { RecentDocumentRow } from './query.ts';
import type { RecentDocDisplay } from '../pages.ts';

/**
 * 工作台「跨库最近文档」显示层（S21-T2/B7；审计 C1 实证：已删除文档按历史发布
 * 事件渲染为首页现存文档）。本模块**只做呈现前整理**，不改任何数据语义：
 *
 * - **按路径去重**：查询面行序=审计时间新→旧（D25），同库同路径首见即最新——
 *   保留最新事件行，其余丢弃；窗口内出现次数记入 `publishCount`（>1 时呈现层
 *   「N 次发布」微标注）。
 * - **与各库 HEAD 树求交**：逐库读默认分支 HEAD 的递归路径清单
 *   （`git ls-tree -r -z`——与派生索引同快照语义、不读 blob），不在当前树中的
 *   路径（已被删除）不再呈现。S24-T1 起本读取经单源跨请求树缓存
 *   （readcache/tree-cache.ts，D1——原 S21 的 per-request Map 由共享缓存层取代：
 *   同库重复行/重复请求均命中同一层，失效一处处处生效）。
 *
 * `recentDocuments`（query.ts，D25/D30）零改动：排序键、成员过滤、事件扫描
 * 上限、降级语义全部保持——本模块是其输出的纯函数式后处理（D45：显示层求交，
 * 数据面语义不变）。git 失败（仓库缺失/分支不存在）时该库行如实清空——与
 * recentDocuments 自身的「读取失败即跳过」同降级方向，不虚构。
 */

/** 显示层执行面参数（git 读取所需；测试以 runGit 注入） */
export interface PresentRecentOptions {
  /** 仓库根目录（→ vaultRepoPath 映射库 ID 到磁盘路径） */
  readonly dataDir: string;
  /** git 执行面注入缝（缺省经单源树缓存 readTreeCached——S24 D1；注入时逐调用直通不缓存） */
  readonly runGit?: RunGit;
}

/**
 * 读默认分支 HEAD 的递归路径集（仅路径名，不读 blob）。
 * 失败（分支不存在/仓库缺失）返回 null——调用方按「该库无现存文档」处理。
 */
async function headPaths(
  runGit: RunGit,
  dataDir: string,
  vaultId: number,
  defaultBranch: string,
): Promise<Set<string> | null> {
  let out: string;
  try {
    out = await runGit(['ls-tree', '-r', '-z', '--full-tree', `refs/heads/${defaultBranch}`], {
      cwd: vaultRepoPath(dataDir, vaultId),
    });
  } catch {
    return null;
  }
  const paths = new Set<string>();
  for (const rec of out.split('\0')) {
    if (rec === '') continue;
    const tab = rec.indexOf('\t');
    if (tab > 0) paths.add(rec.slice(tab + 1));
  }
  return paths;
}

/**
 * 呈现前整理（纯显示层）：去重（保留最新＋次数）→ 与各库 HEAD 树求交（已删
 * 路径出局）。库的 id/default_branch 按行内 slug 实时查 vaults 表（行源自
 * 该 JOIN，行在即行集在；只读）。
 */
export async function presentRecentDocuments(
  db: DatabaseSync,
  rows: readonly RecentDocumentRow[],
  opts: PresentRecentOptions,
): Promise<RecentDocDisplay[]> {
  if (rows.length === 0) return [];

  // ① 去重：行序=新→旧，首见即最新；窗口内同键计数随行带出
  const seen = new Map<string, RecentDocDisplay>();
  for (const r of rows) {
    const key = `${r.vaultSlug}\u0000${r.path}`;
    const prev = seen.get(key);
    if (prev === undefined) {
      seen.set(key, { ...r, publishCount: 1 });
    } else {
      seen.set(key, { ...prev, publishCount: (prev.publishCount ?? 1) + 1 });
    }
  }

  // ② HEAD 树求交：逐库取现存路径集，路径不在集中即出局。同库重复行/重复请求
  // 经单源树缓存命中（S24 D1——缺省执行面 readTreeCached，跨请求去重 spawn）；
  // 注入 runGit 的测试形态逐调用直通
  const runGit = opts.runGit ?? readTreeCached;
  const vaultStmt = db.prepare('SELECT id, default_branch FROM vaults WHERE slug = ?');
  const out: RecentDocDisplay[] = [];
  for (const d of seen.values()) {
    const v = vaultStmt.get(d.vaultSlug) as { id: number; default_branch: string } | undefined;
    const tree = v === undefined ? null : await headPaths(runGit, opts.dataDir, v.id, v.default_branch);
    if (tree !== null && tree.has(d.path)) out.push(d);
  }
  return out;
}
