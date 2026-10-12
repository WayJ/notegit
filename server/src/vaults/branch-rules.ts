/**
 * 默认分支写入规则数据模型（架构 §4.3；S2-T6 只落数据面，执行随 S3-T5
 * pre-receive / 发布组件接入）。
 *
 * - 固定维度（服务端固定执行，普通 Git 提交不能修改）：默认分支仅快进、
 *   禁 force push、禁删除默认分支；
 * - 可配置维度：`main_admin_only`（默认分支仅库管理员写，默认关）——
 *   即 vaults 表行（PATCH /vaults/{slug} 可改）；
 * - 非默认分支规则（编辑者可创建/快进/删除）与「无 tag 写入」由执行层
 *   （S3-T5）按本模型推导，不在此重复建模。
 */
export interface BranchWriteRules {
  /** 库的默认分支名（vaults.default_branch，初始 main） */
  readonly defaultBranch: string;
  /** 默认分支仅快进（固定 true，架构 §4.3 第一版） */
  readonly fastForwardOnly: true;
  /** 默认分支禁 force push（固定 true） */
  readonly denyForcePush: true;
  /** 默认分支禁删除（固定 true） */
  readonly denyDeleteDefault: true;
  /** main 仅库管理员写（可配置：vaults.main_admin_only，默认关） */
  readonly mainAdminOnly: boolean;
}

/** vaults 表行的规则承载列（其余列与本模型无关） */
export interface VaultBranchColumns {
  readonly default_branch: string;
  readonly main_admin_only: number;
}

export function branchWriteRules(vault: VaultBranchColumns): BranchWriteRules {
  return {
    defaultBranch: vault.default_branch,
    fastForwardOnly: true,
    denyForcePush: true,
    denyDeleteDefault: true,
    mainAdminOnly: vault.main_admin_only === 1,
  };
}
