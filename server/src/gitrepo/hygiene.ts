import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { runGit } from '../githttp/git-spawn.ts';

/**
 * 库目录残留清理（S3-T8；T6/T7 honest-gaps 的运维级最小实现）：
 *
 * 三类残留与来源：
 * 1. `notegit-push-*.bytes` 计数文件——chunked 推送计量的落盘通道（T6），正常
 *    时序由 HTTP 层在子进程退出时删除；进程硬崩残留（惰性垃圾，不阻塞路径）。
 * 2. `objects/incoming-*` 隔离目录——receive-pack 在途隔离区，拒绝/中断后 git
 *    不自动清（T6 notes：惰性垃圾，S8 备份/维护流程可扫——本模块即该扫的实现）。
 * 3. 无引用松对象——拒绝发布的 web 候选提交经 -w 落库后被拒成为松对象
 *    （T7 notes：git prune 域）；计入 measureVaultBytes（E-LIMIT-005 口径），
 *    清理即回收容量。
 *
 * 锚点裁决：**启动时（listen 之前）**由 startApp 调用——单进程假设（架构 §9、
 * backup §3）下启动无在途写，三类残留皆上次进程生命周期所留，可安全清。
 * 安全边界：只删 notegit-push-*.bytes / incoming-* / `git prune`（无引用松对象）；
 * 可达对象、refs、pack、配置一概不动（prune 不重排 pack——避免每次启动 repack
 * 大库；有松对象才执行，纯 pack 库零开销跳过）。
 */

export interface VaultHygieneResult {
  /** 清扫的库目录数（<dataDir>/git/ 下全部目录） */
  readonly vaultDirs: number;
  /** 删除的 notegit-push-*.bytes 计数文件数 */
  readonly bytesFiles: number;
  /** 删除的 objects/incoming-* 隔离目录数 */
  readonly quarantineDirs: number;
  /** 执行了 git prune 的库数（仅有松对象的库） */
  readonly prunedRepos: number;
}

/** 库目录下是否有松对象（objects/xx/yy 文件形态；纯 pack 库返回 false——零开销跳过 prune） */
async function hasLooseObjects(repoPath: string): Promise<boolean> {
  const objectsDir = path.join(repoPath, 'objects');
  let entries;
  try {
    entries = await readdir(objectsDir, { withFileTypes: true });
  } catch {
    return false; // 无 objects 目录（畸形库）——跳过 prune
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[0-9a-f]{2}$/.test(entry.name)) continue;
    try {
      const shard = await readdir(path.join(objectsDir, entry.name));
      if (shard.length > 0) return true;
    } catch {
      // 读失败交给 prune 自身判定
    }
  }
  return false;
}

/** 启动清扫（listen 前调用）：计数文件 + 隔离目录 + 有松对象库的 git prune。
 *  单库失败不阻断启动（残留属惰性垃圾——清理是回收，不是正确性前提）。 */
export async function sweepVaultResidue(dataDir: string): Promise<VaultHygieneResult> {
  const gitRoot = path.join(dataDir, 'git');
  let vaultDirs = 0;
  let bytesFiles = 0;
  let quarantineDirs = 0;
  let prunedRepos = 0;

  let repos: import('node:fs').Dirent[];
  try {
    repos = await readdir(gitRoot, { withFileTypes: true });
  } catch {
    return { vaultDirs: 0, bytesFiles: 0, quarantineDirs: 0, prunedRepos: 0 }; // 无 git 目录（未初始化形态）
  }

  for (const entry of repos) {
    if (!entry.isDirectory()) continue;
    const repoPath = path.join(gitRoot, entry.name);
    try {
      if (!(await stat(repoPath)).isDirectory()) continue;
    } catch {
      continue;
    }
    vaultDirs += 1;

    // ① notegit-push-*.bytes（仅库根目录一层——计数文件只在根）
    try {
      for (const file of await readdir(repoPath)) {
        if (file.startsWith('notegit-push-') && file.endsWith('.bytes')) {
          await rm(path.join(repoPath, file), { force: true });
          bytesFiles += 1;
        }
      }
    } catch (err) {
      warn(entry.name, '计数文件清扫失败', err);
    }

    // ② objects/incoming-* 隔离目录（receive-pack 在途区；启动时无在途）
    try {
      const objectsDir = path.join(repoPath, 'objects');
      for (const dir of await readdir(objectsDir, { withFileTypes: true }).catch(() => [])) {
        if (dir.isDirectory() && dir.name.startsWith('incoming-')) {
          await rm(path.join(objectsDir, dir.name), { recursive: true, force: true });
          quarantineDirs += 1;
        }
      }
    } catch (err) {
      warn(entry.name, '隔离目录清扫失败', err);
    }

    // ③ 无引用松对象（git prune：只删不可达，不重排 pack；有松对象才执行）
    try {
      if (await hasLooseObjects(repoPath)) {
        await runGit(['prune'], { cwd: repoPath });
        prunedRepos += 1;
      }
    } catch (err) {
      warn(entry.name, '松对象 prune 失败', err);
    }
  }
  return { vaultDirs, bytesFiles, quarantineDirs, prunedRepos };
}

function warn(repo: string, what: string, err: unknown): void {
  console.warn(`[notegit hygiene] ${repo}：${what}（跳过，下次启动重试）：${err instanceof Error ? err.message : String(err)}`);
}
