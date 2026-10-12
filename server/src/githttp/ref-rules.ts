import type { VaultRole } from '../auth/lifecycle.ts';
import type { BranchWriteRules } from '../vaults/branch-rules.ts';

/**
 * 逐 ref 分支规则判定（S3-T5；架构 §4.3 唯一判定源）——pre-receive（整包检查
 * 段）与 update hook（执行点复查段）消费同一函数，发布组件（S3-T7）同源复用，
 * 保证三入口的 ref 级规则同构。规则对象由 branchWriteRules(vaults 行) 派生，
 * 调用方不手拼（数据模型见 vaults/branch-rules.ts）。
 *
 * 覆盖维度（均实时取库配置，普通 Git 提交不能修改）：
 * - 命名空间：客户端仅可写 refs/heads/*（tag 与其他命名空间一律拒，架构 §4.3
 *   「第一版不支持客户端写入 tag 或其他 ref 命名空间」）；
 * - 默认分支删除：全员拒（原生 receive.denyDeleteCurrent 之外的第二层）；
 * - 角色：reader 任何写拒（授权层判定之外的兜底同语义）；
 * - main_admin_only：开启时默认分支仅库管理员写。
 * force push 不在本函数：原生 receive.denyNonFastForwards（全分支）拦截。
 */

/** 全零 OID（ref 删除命令的 new 值） */
export const ZERO_OID = '0'.repeat(40);

export const isZeroOid = (oid: string): boolean => /^0+$/.test(oid);

export interface RefCommand {
  readonly ref: string;
  readonly oldOid: string;
  readonly newOid: string;
}

/** 逐 ref 授权判定；返回 null = 放行，否则拒绝原因（hook stderr）。 */
export function refCommandRejection(cmd: RefCommand, rules: BranchWriteRules, role: VaultRole): string | null {
  if (!cmd.ref.startsWith(`${rules.clientWritableNamespace}/`)) {
    return `${cmd.ref}：客户端仅可写 refs/heads 分支命名空间（第一版不支持写入 tag 或其他 ref 命名空间，架构 §4.3）`;
  }
  const isDefault = cmd.ref === `${rules.clientWritableNamespace}/${rules.defaultBranch}`;
  if (isDefault && rules.denyDeleteDefault && isZeroOid(cmd.newOid)) {
    return `${cmd.ref}：不允许删除默认分支（架构 §4.3）`;
  }
  if (role === 'reader') {
    return `${cmd.ref}：只读成员不可推送`;
  }
  if (isDefault && rules.mainAdminOnly && role !== 'admin') {
    return `${cmd.ref}：main_admin_only 已开启，仅库管理员可写默认分支`;
  }
  return null;
}
