import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../src/db/migrate.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { addEmployee } from './credentials-fixtures.ts';
import { AUTHZ_ROLE_SQL, createDbMembershipSource } from '../src/vaults/membership.ts';
import { authorize, reauthorizeAtExecutionPoint, type MembershipSource } from '../src/auth/lifecycle.ts';

// S2-T6 授权缝接真实表（architecture-notes §7.5）：MembershipSource 由 vaults/
// vault_members 实现（storage-model §4 authz.role 规范查询 + slug→id 映射），
// Web/API/Git 三入口共用的 authorize() 以本源判定——Git 入口 S3 落地，本文件以
// 接口契约测试覆盖其将消费的语义（含 scope 交集与执行点复查钩子）。

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db, MIGRATIONS);
  return db;
}

interface Seed {
  db: DatabaseSync;
  source: MembershipSource;
  emp(username: string): number;
  vault(slug: string, createdBy: number): number;
  member(vaultId: number, employeeId: number, role: 'reader' | 'editor' | 'admin', grantedBy: number): void;
  revokeMember(vaultId: number, employeeId: number): void;
}

function seed(): Seed {
  const db = freshDb();
  const now = new Date().toISOString();
  return {
    db,
    source: createDbMembershipSource(db),
    emp(username) {
      return addEmployee(db, { username });
    },
    vault(slug, createdBy) {
      db.prepare(`INSERT INTO vaults (slug, name, created_by, created_at) VALUES (?, ?, ?, ?)`).run(slug, slug, createdBy, now);
      return (db.prepare('SELECT id FROM vaults WHERE slug = ?').get(slug) as { id: number }).id;
    },
    member(vaultId, employeeId, role, grantedBy) {
      db.prepare(`INSERT INTO vault_members (vault_id, employee_id, role, granted_by, granted_at) VALUES (?, ?, ?, ?, ?)`).run(vaultId, employeeId, role, grantedBy, now);
    },
    revokeMember(vaultId, employeeId) {
      db.prepare(`DELETE FROM vault_members WHERE vault_id = ? AND employee_id = ?`).run(vaultId, employeeId);
    },
  };
}

test('authz.role 规范 SQL 与契约逐字一致（仅空白差异；storage-model §4）', () => {
  const doc = readFileSync(path.resolve(import.meta.dirname, '../../docs/contracts/storage-model.md'), 'utf8');
  const m = /```sql\n-- @query authz\.role\n([\s\S]*?)```/.exec(doc);
  assert.ok(m, 'storage-model.md 应含 @query authz.role 块');
  const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim();
  assert.equal(norm(AUTHZ_ROLE_SQL), norm(m[1]!), 'authz.role 查询须与契约逐字一致（仅空白差异）');
});

test('lookup：成员命中返回库 id 与角色；slug→id 映射与 authz.role 规范查询同源', () => {
  const s = seed();
  const owner = s.emp('owner');
  const editor = s.emp('editor');
  const alpha = s.vault('alpha', owner);
  s.member(alpha, owner, 'admin', owner);
  s.member(alpha, editor, 'editor', owner);
  assert.deepEqual(s.source.lookup('alpha', owner), { vaultId: alpha, role: 'admin' });
  assert.deepEqual(s.source.lookup('alpha', editor), { vaultId: alpha, role: 'editor' });
  s.db.close();
});

test('lookup：非成员与库不存在一律 undefined，两者不可区分（D-IC-06 的数据层根基）', () => {
  const s = seed();
  const owner = s.emp('owner');
  const outsider = s.emp('outsider');
  const alpha = s.vault('alpha', owner);
  s.member(alpha, owner, 'admin', owner);
  assert.equal(s.source.lookup('alpha', outsider), undefined, '非成员 → undefined');
  assert.equal(s.source.lookup('ghost', owner), undefined, '库不存在 → undefined');
  assert.equal(s.source.lookup('ghost', outsider), undefined);
  // 撤权（DELETE 成员行）后与从未授权不可区分（identity §5.2 行 4）
  s.revokeMember(alpha, owner);
  assert.equal(s.source.lookup('alpha', owner), undefined, '撤权 → undefined');
  s.db.close();
});

test('lookup：改 slug 不改内部 id——id 稳定，slug 只是实例内唯一别名（架构 §7.2）', () => {
  const s = seed();
  const owner = s.emp('owner');
  const alpha = s.vault('alpha', owner);
  s.member(alpha, owner, 'admin', owner);
  s.db.prepare('UPDATE vaults SET slug = ? WHERE id = ?').run('alpha-renamed', alpha);
  assert.deepEqual(s.source.lookup('alpha', owner), undefined, '旧 slug 不再命中');
  assert.deepEqual(s.source.lookup('alpha-renamed', owner), { vaultId: alpha, role: 'admin' }, 'id 不变，新 slug 命中');
  s.db.close();
});

// ── authorize / 执行点复查钩子对真实源的接口契约（Git 入口 S3 的消费面） ──────

test('authorize × 真实源：三档角色的 read/write 判定矩阵（身份 §5.1 第 2 层）', () => {
  const s = seed();
  const owner = s.emp('owner');
  const reader = s.emp('reader');
  const editor = s.emp('editor');
  const admin = s.emp('admin');
  const alpha = s.vault('alpha', owner);
  s.member(alpha, reader, 'reader', owner);
  s.member(alpha, editor, 'editor', owner);
  s.member(alpha, admin, 'admin', owner);
  const cases: Array<[number, string, 'read' | 'write', unknown]> = [
    [reader, 'alpha', 'read', { allowed: true, role: 'reader', access: 'read' }],
    [reader, 'alpha', 'write', { allowed: false, reason: 'forbidden' }],
    [editor, 'alpha', 'read', { allowed: true, role: 'editor', access: 'read_write' }],
    [editor, 'alpha', 'write', { allowed: true, role: 'editor', access: 'read_write' }],
    [admin, 'alpha', 'write', { allowed: true, role: 'admin', access: 'read_write' }],
    [owner, 'ghost', 'read', { allowed: false, reason: 'not_found' }],
  ];
  for (const [empId, slug, action, expected] of cases) {
    assert.deepEqual(authorize(s.source, empId, slug, action), expected, `${empId} ${slug} ${action}`);
  }
  s.db.close();
});

test('authorize × 真实源：token scope 交集（Git Basic 入口同款路径）——清单外/收窄只收窄', () => {
  const s = seed();
  const owner = s.emp('owner');
  const agent = s.emp('agent');
  const alpha = s.vault('alpha', owner);
  const beta = s.vault('beta', owner);
  s.member(alpha, agent, 'editor', owner);
  s.member(beta, agent, 'editor', owner);
  // scope 清单外（beta）与不存在不可区分
  assert.deepEqual(
    authorize(s.source, agent, 'beta', 'read', { access: 'read_write', vaultIds: [alpha] }),
    { allowed: false, reason: 'not_found' },
  );
  // access=read 的 scope 收窄 editor 的写（identity §3.4 只收窄不扩大）
  assert.deepEqual(
    authorize(s.source, agent, 'alpha', 'write', { access: 'read', vaultIds: [alpha] }),
    { allowed: false, reason: 'forbidden' },
  );
  assert.deepEqual(
    authorize(s.source, agent, 'alpha', 'read', { access: 'read', vaultIds: [alpha] }),
    { allowed: true, role: 'editor', access: 'read' },
  );
  // 清单空 = 全部有权库
  assert.deepEqual(
    authorize(s.source, agent, 'beta', 'write', { access: 'read_write', vaultIds: [] }),
    { allowed: true, role: 'editor', access: 'read_write' },
  );
  s.db.close();
});

test('reauthorizeAtExecutionPoint × 真实源：撤权发生在检查后、执行点前 → 在途写被拒（identity §5.1 第 3 层，S3 挂接面）', () => {
  const s = seed();
  const owner = s.emp('owner');
  const pusher = s.emp('pusher');
  const alpha = s.vault('alpha', owner);
  s.member(alpha, pusher, 'editor', owner);
  const atStart = authorize(s.source, pusher, 'alpha', 'write');
  assert.equal(atStart.allowed, true, '前置：起点检查通过');
  s.revokeMember(alpha, pusher);
  assert.deepEqual(reauthorizeAtExecutionPoint(s.source, pusher, 'alpha'), { allowed: false, reason: 'not_found' });
  // 角色降级（editor→reader）在执行点同样拦截写
  s.db.prepare(`INSERT INTO vault_members (vault_id, employee_id, role, granted_by, granted_at) VALUES (?, ?, 'reader', ?, ?)`).run(alpha, pusher, owner, new Date().toISOString());
  assert.deepEqual(reauthorizeAtExecutionPoint(s.source, pusher, 'alpha'), { allowed: false, reason: 'forbidden' });
  assert.equal(atStart.allowed, true, '起点判定不被追溯改写（identity §5.3）');
  s.db.close();
});

test('每次 lookup 全新查库：源对象无状态，判定随表内容即时变化（D-IC-05）', () => {
  const s = seed();
  const owner = s.emp('owner');
  const alpha = s.vault('alpha', owner);
  s.member(alpha, owner, 'reader', owner);
  assert.deepEqual(authorize(s.source, owner, 'alpha', 'write'), { allowed: false, reason: 'forbidden' });
  s.db.prepare(`UPDATE vault_members SET role = 'admin' WHERE vault_id = ? AND employee_id = ?`).run(alpha, owner);
  assert.deepEqual(authorize(s.source, owner, 'alpha', 'write'), { allowed: true, role: 'admin', access: 'read_write' });
  s.db.close();
});
