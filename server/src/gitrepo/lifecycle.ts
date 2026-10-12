import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { vaultRepoPath, parseVaultRepoDirName } from '../vaults/repo-path.ts';

/**
 * bare 仓库生命周期（S3-T1；架构 §3.2/§9；backup-recovery §5 不变量 3）。
 *
 * 建库 = `git init --bare --initial-branch=main` 于 vaultRepoPath 映射路径
 * （`<dataDir>/git/<vault-id>.git`）——路径只由 DB 稳定 ID 映射，**不拼接任何
 * 用户输入**（slug 可改名、可含注入形态，一律不进路径；架构 §3.2）。新库空
 * 初始化：不预置任何提交/分支，HEAD 对称引用指向 main，首次 push 出生分支。
 *
 * 子进程一律异步 spawn（N4 教训：execFileSync 对自家服务自死锁；静态规则
 * no-sync-spawn.test.ts 与代码审查双重拦截）。
 */

/** 异步执行 git，退出码 0 → resolve(stdout)，否则 reject（含 stderr 摘要） */
function runGit(args: readonly string[], options: { cwd?: string; timeoutMs?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: options.cwd });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, options.timeoutMs ?? 30_000);
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString('utf8'));
        return;
      }
      const tail = Buffer.concat(stderr).toString('utf8').trim().split('\n').slice(-3).join(' | ');
      reject(new Error(`git ${args[0]} failed (code=${code}${signal ? ` signal=${signal}` : ''}): ${tail}`));
    });
  });
}

/**
 * 建库：`git init --bare` 于映射路径，HEAD 指向 main，空初始化。
 * 路径经 vaultRepoPath 校验（正的安全整数），注入形态在任何文件系统操作
 * 之前被拒。git/ 目录按需创建（dataDir 布局，backup-recovery §2）。
 */
export async function initBareVaultRepo(dataDir: string, vaultId: number): Promise<void> {
  const repo = vaultRepoPath(dataDir, vaultId); // 注入防线先行：非法 id 在 mkdir 前抛出
  await mkdir(path.dirname(repo), { recursive: true });
  await runGit(['init', '--bare', '--initial-branch=main', repo]);
}

/**
 * 删除库目录（目录与映射行同灭的文件侧；行侧由 VaultService.deleteVault
 * 同事务处理）。目录不存在时幂等成功（force 语义）。
 */
export async function removeVaultRepo(dataDir: string, vaultId: number): Promise<void> {
  const repo = vaultRepoPath(dataDir, vaultId); // 同一注入防线
  await rm(repo, { recursive: true, force: true });
}

// ── 一致性核对与孤儿处置（backup-recovery §5 不变量 3：无孤儿仓库、无孤儿配置行）──

/** 双向核对结果：目录侧孤儿（无 DB 行的仓库目录）与行侧缺失（无目录的 DB 行） */
export interface VaultStoreReport {
  /** git/ 下存在但 DB 无对应 vaults 行的仓库目录（孤儿仓库） */
  readonly orphanRepoIds: number[];
  /** DB 有 vaults 行但 git/ 下无目录（缺失；只报告，不自动重建） */
  readonly missingRepoIds: number[];
}

/** 列出 git/ 下 `<id>.git` 形态的仓库目录 id；目录不存在或名字不符的一律忽略 */
export function listVaultRepoIds(dataDir: string): number[] {
  let entries;
  try {
    entries = readdirSync(path.join(dataDir, 'git'), { withFileTypes: true });
  } catch {
    return []; // git/ 不存在 = 空集（空实例/尚未建库）
  }
  return entries
    .map((e) => (e.isDirectory() ? parseVaultRepoDirName(e.name) : undefined))
    .filter((id): id is number => id !== undefined)
    .sort((a, b) => a - b);
}

/** 双向核对（§5 不变量 3 的检查方向；备份前/恢复后核对用） */
export function verifyVaultStoreConsistency(dataDir: string, vaultIdsInDb: readonly number[]): VaultStoreReport {
  const dirIds = listVaultRepoIds(dataDir);
  const dbIds = new Set(vaultIdsInDb);
  return {
    orphanRepoIds: dirIds.filter((id) => !dbIds.has(id)),
    missingRepoIds: vaultIdsInDb.filter((id) => !dirIds.includes(id)),
  };
}

/**
 * 补偿处置（删除/归档与 DB 映射一致性的兜底）：目录侧孤儿清除（无行引用，
 * 清除安全）；行侧缺失只报告——自动 init 空库会静默掩埋内容丢失，须人工裁决。
 */
export async function reconcileOrphanRepos(
  dataDir: string,
  vaultIdsInDb: readonly number[],
): Promise<{ removedOrphanRepoIds: number[]; missingRepoIds: number[] }> {
  const report = verifyVaultStoreConsistency(dataDir, vaultIdsInDb);
  for (const id of report.orphanRepoIds) {
    await removeVaultRepo(dataDir, id);
  }
  return { removedOrphanRepoIds: report.orphanRepoIds, missingRepoIds: report.missingRepoIds };
}

// ── 服务装配缝（S3-T1 建库/删库挂接）────────────────────────────────────────

/** 库服务消费的仓库生命周期操作（可注入；测试可替换或省略） */
export interface VaultRepoOps {
  /** 建库：于映射路径 init bare（HEAD→main、空初始化） */
  initBare(vaultId: number): Promise<void>;
  /** 删除库目录（幂等） */
  remove(vaultId: number): Promise<void>;
}

/** 以 dataDir 构造真实实现（git init --bare / fs.rm），供 app 装配传入 */
export function createVaultRepoOps(dataDir: string): VaultRepoOps {
  return {
    initBare: (vaultId) => initBareVaultRepo(dataDir, vaultId),
    remove: (vaultId) => removeVaultRepo(dataDir, vaultId),
  };
}
