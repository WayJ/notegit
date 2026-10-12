import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { branchWriteRules } from '../src/vaults/branch-rules.ts';
import { vaultRepoPath } from '../src/vaults/repo-path.ts';

// S2-T6 数据模型面：仓库路径映射（架构 §3.2/§9——稳定 ID 映射，不拼接用户输入）
// 与默认分支写入规则（架构 §4.3——固定规则 + 可配置 main_admin_only）。
// 路径函数的消费者是 S3-T1（建库即 git init --bare）；规则模型消费者是 S3-T5
// （pre-receive / 发布组件的分支检查）。

// ── vaultRepoPath：ID → /data/git/<vault-id>.git（不拼接用户输入） ────────────

test('vaultRepoPath：数值 id 映射到 <dataDir>/git/<id>.git', () => {
  assert.equal(vaultRepoPath('/data', 42), path.join('/data', 'git', '42.git'));
  assert.equal(vaultRepoPath('/srv/notegit', 7), path.join('/srv/notegit', 'git', '7.git'));
});

test('vaultRepoPath：非正整数 id 一律拒绝（不拼接用户输入的注入防线）', () => {
  for (const bad of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1, 2 ** 53]) {
    assert.throws(() => vaultRepoPath('/data', bad), RangeError, `id=${bad} 应被拒绝`);
  }
  // 字符串形态的用户输入即使混入也过不了类型与整数检查（TS 面之外的双重防线）
  assert.throws(() => vaultRepoPath('/data', '7/../../etc' as unknown as number), RangeError);
});

test('vaultRepoPath：安全整数边界内接受（含 MAX_SAFE_INTEGER）', () => {
  assert.equal(vaultRepoPath('/data', Number.MAX_SAFE_INTEGER), path.join('/data', 'git', `${Number.MAX_SAFE_INTEGER}.git`));
});

// ── branchWriteRules：默认分支写入规则数据模型（架构 §4.3） ──────────────────

test('branchWriteRules 默认形态：main 快进、禁 force、禁删除默认分支、main_admin_only 默认关', () => {
  const rules = branchWriteRules({ default_branch: 'main', main_admin_only: 0 });
  assert.deepEqual(rules, {
    defaultBranch: 'main',
    fastForwardOnly: true,
    denyForcePush: true,
    denyDeleteDefault: true,
    mainAdminOnly: false,
  });
});

test('branchWriteRules：main_admin_only 开启随库配置生效（可配置维度，架构 §4.3）', () => {
  const rules = branchWriteRules({ default_branch: 'main', main_admin_only: 1 });
  assert.equal(rules.mainAdminOnly, true);
  assert.equal(rules.fastForwardOnly, true, '固定维度不随配置变化');
  assert.equal(rules.denyForcePush, true);
  assert.equal(rules.denyDeleteDefault, true);
});

test('branchWriteRules：default_branch 随库行（初始 main，非默认分支规则不在本模型）', () => {
  assert.equal(branchWriteRules({ default_branch: 'trunk', main_admin_only: 0 }).defaultBranch, 'trunk');
});
