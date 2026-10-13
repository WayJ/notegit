import type { DatabaseSync } from 'node:sqlite';
import type { MaintenanceGate } from '../../maintenance/gate.ts';
import { publishWebSubmit, type CommitIdentity, type PublishResult } from '../../publish/index.ts';
import { execGit } from '../../publish/git-exec.ts';
import { vaultRepoPath } from '../../vaults/repo-path.ts';

/**
 * S5-T2 还原提交面（breakdown §2.4 S5-T2 行「还原走发布组件」；架构 §6/§2
 * 「通过新增提交还原历史内容，保持可追溯」「网页不能通过直接 update-ref 绕过
 * 接收规则」）：把「目标提交处某路径的内容」以单条 upsert 走 S3-T7
 * publishWebSubmit 完整检查链（候选→审计→授权→分支规则→校验→base-commit→
 * 执行点→update-ref→settle）——
 *
 * - **base commit = 请求时默认分支 tip**（S4-T7 冲突保护机制复用：预期旧
 *   commit CAS 比对不符或原子更新竞态 → 拒绝不覆盖；与 upload/rename 同形，
 *   组件层 base-commit/update-ref 阶段覆盖见 publish-pipeline 测试）。
 * - **以新提交还原**：候选提交以 tip 为父，历史提交/对象原样保留（不删历史
 *   ——旧版本仍在历史页/版本预览可查）；还原被删除路径 = 该提交树中的内容
 *   以 upsert 重建。
 * - 校验单一来源（sprint D7）：还原内容照走组件 validation 阶段（.md 套
 *   frontmatter 规则），本面不设第二套校验。
 */

export interface RestoreSubmitInput {
  readonly db: DatabaseSync;
  readonly dataDir: string;
  readonly subject: { readonly employeeId: number; readonly carrierRef: string };
  readonly vault: { readonly slug: string; readonly id: number; readonly defaultBranch: string };
  readonly identity: CommitIdentity;
  /** 目标版本提交全 OID（readEntryAtCommit 已解析） */
  readonly restoreOid: string;
  readonly path: string;
  /** 该提交处该路径的 blob 字节（逐字节恢复，不转码） */
  readonly content: Buffer;
  /** 该提交处该条目的 tree mode（ls-tree 原样——常规文件两形态） */
  readonly mode: string;
  readonly maintenanceGate?: MaintenanceGate;
}

/** 默认分支 HEAD（CAS 旧值；空库=null 分支创建语义——同 upload/rename 形态） */
async function headCommit(repoPath: string, branch: string): Promise<string | null> {
  try {
    const out = await execGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repoPath });
    const oid = out.trim();
    return oid === '' ? null : oid;
  } catch {
    return null; // 未知 ref（空库）
  }
}

/** 还原 = 单条 upsert 新提交（内容=目标版本字节；父=当前 tip） */
export async function restoreFileAtCommit(input: RestoreSubmitInput): Promise<PublishResult> {
  const repoPath = vaultRepoPath(input.dataDir, input.vault.id);
  const baseCommit = await headCommit(repoPath, input.vault.defaultBranch);
  return publishWebSubmit({
    db: input.db,
    dataDir: input.dataDir,
    subject: input.subject,
    vaultSlug: input.vault.slug,
    branch: input.vault.defaultBranch,
    baseCommit,
    changes: [{ kind: 'upsert', path: input.path, mode: input.mode, content: input.content }],
    message: `Web 还原：${input.path}（回到 ${input.restoreOid.slice(0, 10)}）`,
    identity: input.identity,
    ...(input.maintenanceGate !== undefined ? { maintenanceGate: input.maintenanceGate } : {}),
  });
}
