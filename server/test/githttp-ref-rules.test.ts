import { test } from 'node:test';
import assert from 'node:assert/strict';
import { branchWriteRules } from '../src/vaults/branch-rules.ts';
import { isZeroOid, refCommandRejection, ZERO_OID, type RefCommand } from '../src/githttp/ref-rules.ts';

// S3-T5 分支/ref 规则模块单元测试（githttp/ref-rules.ts——pre-receive 与 update
// hook 的同一判定源；架构 §4.3）。规则对象全部经真实 branchWriteRules(vault 行)
// 派生（禁手拼字面量/全等硬编码）；行为级闭环见 githttp-execution-point.test.ts
// 与 githttp-behavior.test.ts（B4）。

const rules = (over: Partial<{ default_branch: string; main_admin_only: number }> = {}) =>
  branchWriteRules({ default_branch: 'main', main_admin_only: 0, ...over });
const oid = (c: string) => c.repeat(40);
const cmd = (ref: string, newOid = oid('a'), oldOid = oid('0')): RefCommand => ({ ref, oldOid, newOid });

// ── 数据模型扩展（vaults/branch-rules.ts；S2-T6 落数据面 → T5 建模执行维度） ──

test('branchWriteRules：非默认分支可写维度（编辑者创建/快进/删除，固定 true，架构 §4.3）', () => {
  assert.equal(rules().nonDefaultBranchesWritable, true);
});

test('branchWriteRules：客户端可写命名空间仅 refs/heads（tag 与其他命名空间拒绝的模型面）', () => {
  assert.equal(rules().clientWritableNamespace, 'refs/heads');
});

// ── 零 OID 判定（ref 删除命令的 new 值） ──────────────────────────────────────

test('isZeroOid：全零 40 位 → true；任意非零位 → false', () => {
  assert.equal(isZeroOid(ZERO_OID), true);
  assert.equal(isZeroOid('0'.repeat(39) + '1'), false);
  assert.equal(isZeroOid(''), false);
});

// ── refCommandRejection：逐 ref 授权判定（架构 §4.3） ─────────────────────────

test('默认分支——删除全员拒；main_admin_only 开启时编辑者拒写、管理员放行、关闭时编辑者放行', () => {
  assert.match(
    refCommandRejection(cmd('refs/heads/main', ZERO_OID), rules(), 'admin')!,
    /删除默认分支/,
    '默认分支删除对任何角色（含管理员）都拒绝',
  );
  assert.match(
    refCommandRejection(cmd('refs/heads/main'), rules({ main_admin_only: 1 }), 'editor')!,
    /仅库管理员|main_admin_only/,
  );
  assert.equal(refCommandRejection(cmd('refs/heads/main'), rules({ main_admin_only: 1 }), 'admin'), null);
  assert.equal(refCommandRejection(cmd('refs/heads/main'), rules({ main_admin_only: 0 }), 'editor'), null);
});

test('非默认分支——编辑者创建/更新/删除均放行', () => {
  assert.equal(refCommandRejection(cmd('refs/heads/feature/x', oid('a'), ZERO_OID), rules(), 'editor'), null);
  assert.equal(refCommandRejection(cmd('refs/heads/feature/x'), rules(), 'editor'), null);
  assert.equal(refCommandRejection(cmd('refs/heads/feature/x', ZERO_OID), rules(), 'editor'), null);
  assert.equal(refCommandRejection(cmd('refs/heads/feature/x'), rules({ main_admin_only: 1 }), 'editor'), null);
});

test('reader 任何写命令拒绝（含非默认分支）', () => {
  assert.match(refCommandRejection(cmd('refs/heads/feature/x'), rules(), 'reader')!, /只读成员/);
  assert.match(refCommandRejection(cmd('refs/heads/main'), rules({ main_admin_only: 0 }), 'reader')!, /只读成员/);
});

test('命名空间收紧：refs/heads 之外一律拒（tag、notes、replace——第一版仅客户端分支写入）', () => {
  for (const ref of ['refs/tags/v1', 'refs/notes/commits', 'refs/replace/deadbeef', 'refs/merge-requests/1/head', 'refs/merges/1']) {
    const rejection = refCommandRejection(cmd(ref), rules(), 'admin');
    assert.ok(rejection !== null, `${ref} 应被命名空间规则拒绝`);
    assert.match(rejection, /tag|命名空间|refs\/heads/, `${ref} 的拒绝原因应指明命名空间限制`);
  }
  assert.match(refCommandRejection(cmd('refs/tags/v1', ZERO_OID), rules(), 'admin')!, /tag|命名空间/);
});

test('默认分支名取自库配置（非硬编码 main）', () => {
  const trunk = rules({ default_branch: 'trunk', main_admin_only: 1 });
  assert.match(refCommandRejection(cmd('refs/heads/trunk'), trunk, 'editor')!, /仅库管理员|main_admin_only/);
  assert.equal(refCommandRejection(cmd('refs/heads/main'), trunk, 'editor'), null, 'main 在该库只是普通分支');
  assert.match(refCommandRejection(cmd('refs/heads/trunk', ZERO_OID), trunk, 'admin')!, /删除默认分支/);
});
