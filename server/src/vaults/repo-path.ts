import path from 'node:path';

/**
 * 仓库路径映射（架构 §3.2/§9；storage-model §1 ID 策略）：库的稳定内部 ID →
 * `<dataDir>/git/<vault-id>.git`。路径只由数据库稳定 ID 映射，**不拼接任何
 * 用户输入**（slug 可改名、可含注入形态，一律不进路径）。
 *
 * 消费者：S3-T1（建库即 `git init --bare` 于本路径）与 Git HTTP 接入层；
 * dataDir 由启动流程解析（默认 /data，NOTEGIT_DATA_DIR 可覆盖，backup §2）。
 */
export function vaultRepoPath(dataDir: string, vaultId: number): string {
  // 注入防线：id 只接受正的安全整数（INTEGER PRIMARY KEY rowid 域），
  // 其余（0/负数/小数/NaN/超大数/字符串）一律拒绝，绝不进路径拼接。
  if (!Number.isSafeInteger(vaultId) || vaultId <= 0) {
    throw new RangeError(`vault id must be a positive safe integer, got: ${String(vaultId)}`);
  }
  return path.join(dataDir, 'git', `${vaultId}.git`);
}

/**
 * 反向解析（S3-T1）：`<id>.git` 目录名 → vault id，其余名字一律 undefined。
 * 磁盘命名约定（正向 vaultRepoPath / 反向本函数）唯一来源在本文件——
 * gitrepo 生命周期与一致性核对经此消费，不在别处再写 `.git` 形态。
 */
export function parseVaultRepoDirName(name: string): number | undefined {
  const m = /^(\d+)\.git$/.exec(name);
  if (!m) return undefined;
  const id = Number(m[1]);
  // 与 vaultRepoPath 同一合法域：0/前导零变形/超 MAX_SAFE_INTEGER 不认
  if (!Number.isSafeInteger(id) || id <= 0 || m[1].startsWith('0')) return undefined;
  return id;
}
