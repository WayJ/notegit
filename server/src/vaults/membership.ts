import type { DatabaseSync } from 'node:sqlite';
import type { MembershipSource, VaultRole } from '../auth/lifecycle.ts';

/**
 * 授权缝的真实表实现（S2-T6；architecture-notes §7.5 移交项）：identity §5.1
 * 第 2 层的 MembershipSource 由 vaults/vault_members 表落地，Web/API/Git 三入口
 * 的 authorize() 共用本源（Git 入口 S3 落地，接口契约测试已覆盖其消费面）。
 *
 * 判定语义：slug→id 映射 + storage-model §4 `authz.role` 规范查询；非成员与
 * 库不存在一律 undefined（两者不可区分，D-IC-06）。每次 lookup 发起全新查库，
 * 本源无任何跨请求状态（D-IC-05：实时查库、无权限缓存）。
 */

/** storage-model §4 `-- @query authz.role` 规范 SQL（逐字；防漂移测试对照契约原文） */
export const AUTHZ_ROLE_SQL = `-- 授权层：实时查成员关系与角色（identity §5.1 第 2 层，读路径与写路径一致）。
-- 无行 = 404（撤权/无权与不存在同响应，D-IC-06，不泄露库存在性）。
-- 参数：?1 = vault_id，?2 = employee_id
SELECT role FROM vault_members WHERE vault_id = ? AND employee_id = ?;`;

/** slug→id 映射（架构 §7.2：slug 实例内唯一、可改名；内部 id 稳定） */
const SLUG_TO_ID_SQL = `SELECT id FROM vaults WHERE slug = ?`;

/**
 * 以真实表实现 MembershipSource。返回的源对象无状态：lookup 每次重新执行
 * 两条已索引查询（slug 唯一索引 / vault_members 主键），判定随表内容即时
 * 变化——撤权 = DELETE 行，下一 lookup 立即 undefined（identity §5.2 行 4）。
 */
export function createDbMembershipSource(db: DatabaseSync): MembershipSource {
  const bySlug = db.prepare(SLUG_TO_ID_SQL);
  const roleOf = db.prepare(AUTHZ_ROLE_SQL);
  return {
    lookup(vaultSlug: string, employeeId: number) {
      const vault = bySlug.get(vaultSlug) as { id: number } | undefined;
      if (vault === undefined) return undefined; // 不存在 = 非成员，同响应（D-IC-06）
      const row = roleOf.get(vault.id, employeeId) as { role: VaultRole } | undefined;
      if (row === undefined) return undefined;
      return { vaultId: vault.id, role: row.role };
    },
  };
}
