import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canWriteVault } from '../src/web/role-gate.ts';
import type { MembershipSource } from '../src/auth/lifecycle.ts';

// S10 共享地基（E2 D17）：canWriteVault 是 authorize('write') 的薄委托——
// 呈现层判定不得另立第二套规则。用例锁定「角色→布尔」映射与委托语义本身；
// 页面级条件渲染（browse/edit 等）由 T2 各自页面测试覆盖。

function sourceWith(entries: Record<string, { vaultId: number; role: string } | undefined>): MembershipSource {
  return {
    lookup(slug, _employeeId) {
      const hit = entries[slug];
      return hit === undefined ? undefined : { vaultId: hit.vaultId, role: hit.role as 'reader' | 'editor' | 'admin' };
    },
  };
}

const EMP = 7;

test('canWriteVault：editor/admin true、reader false、非成员 false', () => {
  const src = sourceWith({
    'v-editor': { vaultId: 1, role: 'editor' },
    'v-admin': { vaultId: 2, role: 'admin' },
    'v-reader': { vaultId: 3, role: 'reader' },
  });
  assert.equal(canWriteVault(src, EMP, 'v-editor'), true, 'editor 可写');
  assert.equal(canWriteVault(src, EMP, 'v-admin'), true, 'admin 可写');
  assert.equal(canWriteVault(src, EMP, 'v-reader'), false, 'reader 不可写（呈现层隐藏写入口）');
  assert.equal(canWriteVault(src, EMP, 'v-none'), false, '非成员/不存在 false（D-IC-06 不可区分）');
});

test('canWriteVault：委托语义——撤权（成员行消失）下一调用即 false（实时查源）', () => {
  let role: string | undefined = 'editor';
  const src: MembershipSource = {
    lookup: (_slug, _id) => (role === undefined ? undefined : { vaultId: 1, role: role as 'editor' }),
  };
  assert.equal(canWriteVault(src, EMP, 'v'), true);
  role = undefined; // 撤权：成员行删除
  assert.equal(canWriteVault(src, EMP, 'v'), false, '撤权下一调用即 false（无缓存）');
});

test('canWriteVault：角色降级 reader 后立即 false', () => {
  let role: string = 'admin';
  const src: MembershipSource = {
    lookup: (_slug, _id) => ({ vaultId: 1, role: role as 'admin' }),
  };
  assert.equal(canWriteVault(src, EMP, 'v'), true);
  role = 'reader';
  assert.equal(canWriteVault(src, EMP, 'v'), false, '降级立即生效');
});
