import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { DatabaseSync as Db } from 'node:sqlite';
import { migrate } from '../src/db/migrate.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { loadOrCreatePepper } from '../src/bootstrap/pepper.ts';
import { ensureBootstrapToken, completeBootstrap, BOOTSTRAP_TOKEN_TTL_MS } from '../src/bootstrap/token.ts';

// identity §7.1：空库→初始化态；一次性 bootstrap token（K5：库内哈希+过期+单次）写
// admin-bootstrap.token（0600）；单次使用后失效。重启不锁死：有效行+文件在→保持；
// 文件丢失或过期→重生成；初始化完成后不再生成。

function freshDb(): DatabaseSync {
  const db = new Db(':memory:');
  migrate(db, MIGRATIONS);
  return db;
}

function unusedBootstrapRows(db: DatabaseSync): number {
  return db.prepare("SELECT COUNT(*) AS n FROM one_time_tokens WHERE purpose='bootstrap' AND used_at IS NULL").get()?.n as number;
}

test('空库 ensure：写 0600 token 文件 + 插入未用 bootstrap 行（hmacv1$ 哈希形态）', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'notegit-bst-'));
  try {
    const db = freshDb();
    const pepper = await loadOrCreatePepper(path.join(dir, 'keys', 'token-pepper.key'));
    const tokenFile = path.join(dir, 'config', 'admin-bootstrap.token');
    const wrote = await ensureBootstrapToken(db, pepper, tokenFile, new Date('2026-10-12T00:00:00Z'));
    assert.equal(wrote, true);
    assert.equal((await stat(tokenFile)).mode & 0o777, 0o600);
    const token = await readFile(tokenFile, 'utf8');
    assert.match(token, /^[A-Za-z0-9_-]{43}$/); // 32B base64url（identity §7.1 K5）
    assert.equal(unusedBootstrapRows(db), 1);
    const row = db.prepare("SELECT token_hash, expires_at FROM one_time_tokens WHERE purpose='bootstrap'").get() as { token_hash: string; expires_at: string };
    assert.match(row.token_hash, /^hmac1\$[0-9a-f]{64}$/); // 不存明文（D-IC-03 同则）
    assert.equal(new Date(row.expires_at).getTime(), new Date('2026-10-12T00:00:00Z').getTime() + BOOTSTRAP_TOKEN_TTL_MS);
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('重复 ensure：有效未用行且文件在 → 文件与行均不变', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'notegit-bst-'));
  try {
    const db = freshDb();
    const pepper = await loadOrCreatePepper(path.join(dir, 'keys', 'token-pepper.key'));
    const tokenFile = path.join(dir, 'config', 'admin-bootstrap.token');
    await ensureBootstrapToken(db, pepper, tokenFile, new Date('2026-10-12T00:00:00Z'));
    const first = await readFile(tokenFile, 'utf8');
    const wrote = await ensureBootstrapToken(db, pepper, tokenFile, new Date('2026-10-12T01:00:00Z'));
    assert.equal(wrote, false);
    assert.equal(await readFile(tokenFile, 'utf8'), first);
    assert.equal(unusedBootstrapRows(db), 1);
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('token 文件丢失但行仍有效 → 重生成新 token（旧行保留），不锁死', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'notegit-bst-'));
  try {
    const db = freshDb();
    const pepper = await loadOrCreatePepper(path.join(dir, 'keys', 'token-pepper.key'));
    const tokenFile = path.join(dir, 'config', 'admin-bootstrap.token');
    await ensureBootstrapToken(db, pepper, tokenFile, new Date('2026-10-12T00:00:00Z'));
    const first = await readFile(tokenFile, 'utf8');
    await rm(tokenFile);
    const wrote = await ensureBootstrapToken(db, pepper, tokenFile, new Date('2026-10-12T01:00:00Z'));
    assert.equal(wrote, true);
    const second = await readFile(tokenFile, 'utf8');
    assert.notEqual(second, first);
    assert.equal(unusedBootstrapRows(db), 2); // 旧行保留（历史），新行为当前有效
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('未用行已过期 → ensure 重生成（K5 短时效 + 重启自愈）', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'notegit-bst-'));
  try {
    const db = freshDb();
    const pepper = await loadOrCreatePepper(path.join(dir, 'keys', 'token-pepper.key'));
    const tokenFile = path.join(dir, 'config', 'admin-bootstrap.token');
    const t0 = new Date('2026-10-12T00:00:00Z');
    await ensureBootstrapToken(db, pepper, tokenFile, t0);
    const wrote = await ensureBootstrapToken(db, pepper, tokenFile, new Date(t0.getTime() + BOOTSTRAP_TOKEN_TTL_MS + 1));
    assert.equal(wrote, true);
    assert.equal(unusedBootstrapRows(db), 2);
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('库已初始化 → ensure 不写文件不添行（§7.1-4 初始化完成后不再发 token）', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'notegit-bst-'));
  try {
    const db = freshDb();
    db.exec("INSERT INTO employees (username, display_name, password_hash, is_instance_admin, created_at) VALUES ('admin', 'Admin', 'h', 1, '2026-10-12T00:00:00Z')");
    const pepper = { active: { version: 1, key: randomBytes(32) }, retired: [] };
    const tokenFile = path.join(dir, 'config', 'admin-bootstrap.token');
    const wrote = await ensureBootstrapToken(db, pepper, tokenFile, new Date());
    assert.equal(wrote, false);
    await assert.rejects(stat(tokenFile), /ENOENT/);
    assert.equal(unusedBootstrapRows(db), 0);
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('completeBootstrap：建实例管理员（is_instance_admin=1、invited_by=NULL）并置 used_at', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'notegit-bst-'));
  try {
    const db = freshDb();
    const pepper = await loadOrCreatePepper(path.join(dir, 'keys', 'token-pepper.key'));
    const tokenFile = path.join(dir, 'config', 'admin-bootstrap.token');
    const now = new Date('2026-10-12T00:00:00Z');
    await ensureBootstrapToken(db, pepper, tokenFile, now);
    const token = await readFile(tokenFile, 'utf8');
    const { employeeId } = completeBootstrap(db, pepper, {
      token,
      username: 'admin',
      displayName: 'Admin',
      passwordHash: '$argon2id$stub',
    }, now);
    const row = db.prepare('SELECT username, is_instance_admin, active, invited_by, password_hash FROM employees WHERE id = ?').get(employeeId) as Record<string, unknown>;
    assert.equal(row.username, 'admin');
    assert.equal(row.is_instance_admin, 1);
    assert.equal(row.active, 1);
    assert.equal(row.invited_by, null);
    assert.equal(row.password_hash, '$argon2id$stub');
    assert.equal(unusedBootstrapRows(db), 0);
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('completeBootstrap 失败原子回滚：员工插入失败 → token 未被消耗（可重试）', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'notegit-bst-'));
  try {
    const db = freshDb();
    const pepper = await loadOrCreatePepper(path.join(dir, 'keys', 'token-pepper.key'));
    const tokenFile = path.join(dir, 'config', 'admin-bootstrap.token');
    const now = new Date('2026-10-12T00:00:00Z');
    await ensureBootstrapToken(db, pepper, tokenFile, now);
    const token = await readFile(tokenFile, 'utf8');
    // displayName 为 null 触发 NOT NULL 违例（模拟建号中途异常），token 必须仍可用
    assert.throws(() => completeBootstrap(db, pepper, {
      token,
      username: 'admin',
      displayName: null as unknown as string,
      passwordHash: 'h',
    }, now));
    assert.equal(unusedBootstrapRows(db), 1);
    const ok = completeBootstrap(db, pepper, { token, username: 'admin', displayName: 'A', passwordHash: 'h' }, now);
    assert.ok(ok.employeeId >= 1);
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('token 重放（已用）→ 拒绝；错误 token → 拒绝；过期 token → 拒绝', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'notegit-bst-'));
  try {
    const db = freshDb();
    const pepper = await loadOrCreatePepper(path.join(dir, 'keys', 'token-pepper.key'));
    const tokenFile = path.join(dir, 'config', 'admin-bootstrap.token');
    const now = new Date('2026-10-12T00:00:00Z');
    await ensureBootstrapToken(db, pepper, tokenFile, now);
    const token = await readFile(tokenFile, 'utf8');
    completeBootstrap(db, pepper, { token, username: 'admin', displayName: 'A', passwordHash: 'h' }, now);
    assert.throws(() => completeBootstrap(db, pepper, { token, username: 'admin2', displayName: 'A', passwordHash: 'h' }, now), /used/);
    assert.throws(() => completeBootstrap(db, pepper, { token: 'wrong-token', username: 'admin3', displayName: 'A', passwordHash: 'h' }, now), /invalid/);
    // 新 token 但时钟已过有效期
    await ensureBootstrapToken(db, pepper, tokenFile, now); // 库又空？不——admin 已存在，ensure 不发
    db.exec("DELETE FROM employees");
    await ensureBootstrapToken(db, pepper, tokenFile, now);
    const fresh = await readFile(tokenFile, 'utf8');
    const later = new Date(now.getTime() + BOOTSTRAP_TOKEN_TTL_MS + 1);
    assert.throws(() => completeBootstrap(db, pepper, { token: fresh, username: 'admin4', displayName: 'A', passwordHash: 'h' }, later), /expired/);
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
