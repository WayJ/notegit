import { authorize } from '../auth/lifecycle.ts';
import type { MembershipSource } from '../auth/lifecycle.ts';

/**
 * S10 权限感知呈现的共享判定点（E2 epic D17）：页面渲染写入口（编辑/新建/上传/
 * 重命名/删除）前判定「当前会话员工能否写此库」。
 *
 * 语义约束（不得偏离）：
 * - 唯一判定面 = authorize('write')——与 POST 侧全量鉴权同一函数同源；本层是
 *   呈现层优化（reader 不见死按钮），**不构成安全边界**：POST 侧判定原样保留
 *   （D-IC-06/越权测试锁定，E2 DOD-E2-10）。
 * - Web 会话入口不传 scope（员工全量权限），与既有页面 read 判定一致
 *   （lifecycle.ts authorize 注释）。
 * - 实时查源、逐请求调用（D-IC-05），无页内缓存。
 */

/** 当前会话员工对该库是否有写权（editor/admin）。非成员/不存在 = false（同面不可区分）。 */
export function canWriteVault(source: MembershipSource, employeeId: number, vaultSlug: string): boolean {
  return authorize(source, employeeId, vaultSlug, 'write').allowed;
}
