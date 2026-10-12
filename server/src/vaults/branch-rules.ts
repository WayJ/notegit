/**
 * 默认分支写入规则数据模型（架构 §4.3；S2-T6 落数据面，S3-T5 扩展执行维度并
 * 由 pre-receive / update hook / 发布组件统一消费——githttp/ref-rules.ts 是
 * 唯一判定源）。
 *
 * - 固定维度（服务端固定执行，普通 Git 提交不能修改）：默认分支仅快进、
 *   禁 force push、禁删除默认分支；非默认分支对可写成员开放创建/快进/删除；
 *   客户端可写命名空间仅 refs/heads（无 tag 或其他 ref 写入）；
 * - 可配置维度：`main_admin_only`（默认分支仅库管理员写，默认关）——
 *   即 vaults 表行（PATCH /vaults/{slug} 可改）；
 * - 执行层映射：force push 由原生 `receive.denyNonFastForwards`（全分支）拦截、
 *   默认分支删除由原生 `receive.denyDeleteCurrent`（HEAD 目标）与判定层双层拦截、
 *   其余维度由 refCommandRejection 按本模型执行（快进判定本身是 Git 原生语义）。
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
  /** 非默认分支对可写成员开放创建/快进更新/删除（固定 true，架构 §4.3） */
  readonly nonDefaultBranchesWritable: true;
  /** 客户端可写命名空间仅 refs/heads（固定；tag 与其他命名空间一律拒，架构 §4.3） */
  readonly clientWritableNamespace: 'refs/heads';
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
    nonDefaultBranchesWritable: true,
    clientWritableNamespace: 'refs/heads',
  };
}
