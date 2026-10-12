import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../src/app.ts';
import { createSession, DEFAULT_SESSION_TIMEOUTS, sidHash } from '../src/auth/sessions.ts';
import { CredentialsService } from '../src/credentials/service.ts';
import { hashToken } from '../src/credentials/token.ts';
import { newDb, addEmployee } from './credentials-fixtures.ts';
import type { PepperFile } from '../src/bootstrap/pepper.ts';

// S2-T8：pepper 轮换的 rehash-on-use（identity §6.2 步骤 2；S2-T4 留言「轮换的
// rehash-on-use 操作留 S2-T8」的落地）。文档 docs/credentials-ops.md 的轮换步骤
// 与本测试同构——抽查「轮换步骤可执行至 rehash-on-use 验证」即复跑本套语义。

function rotatedPepper(oldActive: PepperFile['active']): PepperFile {
  return { active: { version: oldActive.version + 1, key: randomBytes(32) }, retired: [oldActive] };
}

function harness(pepper: PepperFile, db: DatabaseSync): ReturnType<typeof buildApp> {
  return buildApp({ db, pepper, bootstrapTokenFile: '/tmp/notegit-rotation-test.token' });
}

test('token rehash-on-use：轮换后旧 token 经 retired 校验成功，token_hash 立即重算为 active 版本', async () => {
  const v1 = { version: 1, key: randomBytes(32) };
  const seed = newDb();
  const pepperV1: PepperFile = { active: v1, retired: [] };
  const svc = new CredentialsService({ db: seed, pepper: pepperV1 });
  const emp = addEmployee(seed, { username: 'alice' });
  const { token } = svc.createCredential(emp, {
    name: 'old-era',
    expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  });
  const rowBefore = seed.prepare('SELECT token_hash FROM credentials WHERE employee_id = ?').get(emp) as { token_hash: string };
  assert.match(rowBefore.token_hash, /^hmacv1\$/);

  // 轮换：新 active（v2），原 v1 移入 retired；应用以新 pepper 文件重启（同库重建 app）
  const pepperV2 = rotatedPepper(v1);
  const app = harness(pepperV2, seed);
  try {
    // 旧 token 仍可用（retired 键校验，identity §6.2 步骤 2 迁移期语义）
    const res = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.statusCode, 200, `旧 token 应经 retired 校验通过，实际 ${res.statusCode}: ${res.body}`);
    // rehash-on-use：哈希已回写为 active（v2）版本
    const rowAfter = seed.prepare('SELECT token_hash FROM credentials WHERE employee_id = ?').get(emp) as { token_hash: string };
    assert.equal(rowAfter.token_hash, hashToken(pepperV2.active, token));
    assert.match(rowAfter.token_hash, /^hmacv2\$/);
    // 再次使用走 active 直查（不再依赖 retired）
    const again = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: `Bearer ${token}` } });
    assert.equal(again.statusCode, 200);
    // 宽限期后 retired 移除（identity §6.2 步骤 3）：已迁移 token 不受影响
    const pruned: PepperFile = { active: pepperV2.active, retired: [] };
    const prunedApp = buildApp({ db: seed, pepper: pruned, bootstrapTokenFile: '/tmp/notegit-rotation-test.token' });
    try {
      const afterPrune = await prunedApp.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: `Bearer ${token}` } });
      assert.equal(afterPrune.statusCode, 200, '已 rehash 的 token 在 retired 移除后仍可用');
    } finally {
      await prunedApp.close();
    }
  } finally {
    await app.close();
    seed.close();
  }
});

test('token 宽限期语义：从未使用而未迁移的旧 token，retired 移除后失效（401）', async () => {
  const v1 = { version: 1, key: randomBytes(32) };
  const seed = newDb();
  const svc = new CredentialsService({ db: seed, pepper: { active: v1, retired: [] } });
  const emp = addEmployee(seed, { username: 'bob' });
  const { token } = svc.createCredential(emp, {
    name: 'never-rehashed',
    expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  });
  // 轮换后从未使用（未触发 rehash），随后 retired 被移除
  const pruned: PepperFile = { active: { version: 2, key: randomBytes(32) }, retired: [] };
  const app = harness(pruned, seed);
  try {
    const res = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.statusCode, 401, '未迁移 token 在 retired 移除后不可用（须重新签发，identity §6.2 步骤 3）');
  } finally {
    await app.close();
    seed.close();
  }
});

test('会话 rehash-on-use：轮换后旧会话 Cookie 经 retired 校验，sid_hash 重算为 active 版本', async () => {
  const v1 = { version: 1, key: randomBytes(32) };
  const seed = newDb();
  const emp = addEmployee(seed, { username: 'carol', is_instance_admin: 1 });
  // v1 时代创建的会话（sid_hash 以 v1 计算）
  const { sid } = createSession(seed, emp, v1.key, new Date(), DEFAULT_SESSION_TIMEOUTS);
  const rowBefore = seed.prepare('SELECT sid_hash FROM sessions WHERE employee_id = ?').get(emp) as { sid_hash: string };
  assert.equal(rowBefore.sid_hash, sidHash(sid, v1.key));

  const pepperV2 = rotatedPepper(v1);
  const app = harness(pepperV2, seed);
  try {
    const cookie = { cookie: `ngt_sid=${sid}` };
    const res = await app.inject({ method: 'GET', url: '/api/v1/me', headers: cookie });
    assert.equal(res.statusCode, 200, `旧会话应经 retired 校验通过，实际 ${res.statusCode}: ${res.body}`);
    // rehash-on-use：sid_hash 已以 active（v2）重算
    const rowAfter = seed.prepare('SELECT sid_hash FROM sessions WHERE employee_id = ?').get(emp) as { sid_hash: string };
    assert.equal(rowAfter.sid_hash, sidHash(sid, pepperV2.active.key));
    // 再次使用走 active 直查
    const again = await app.inject({ method: 'GET', url: '/api/v1/me', headers: cookie });
    assert.equal(again.statusCode, 200);
    // retired 移除后已迁移会话不受影响；未迁移会话（另一 v1 会话）失效
    const { sid: sidUnused } = createSession(seed, emp, v1.key, new Date(), DEFAULT_SESSION_TIMEOUTS);
    const prunedApp = buildApp({ db: seed, pepper: { active: pepperV2.active, retired: [] }, bootstrapTokenFile: '/tmp/notegit-rotation-test.token' });
    try {
      const migrated = await prunedApp.inject({ method: 'GET', url: '/api/v1/me', headers: cookie });
      assert.equal(migrated.statusCode, 200, '已 rehash 的会话在 retired 移除后仍可用');
      const stale = await prunedApp.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: `ngt_sid=${sidUnused}` } });
      assert.equal(stale.statusCode, 401, '未迁移会话在 retired 移除后失效（重新登录，identity §6.2 步骤 3）');
    } finally {
      await prunedApp.close();
    }
  } finally {
    await app.close();
    seed.close();
  }
});

test('轮换后停用账号的旧载体仍精确 E-AUTH-004（retired 校验路径保留四状态映射）', async () => {
  const v1 = { version: 1, key: randomBytes(32) };
  const seed = newDb();
  const emp = addEmployee(seed, { username: 'dave' });
  const svc = new CredentialsService({ db: seed, pepper: { active: v1, retired: [] } });
  const { token } = svc.createCredential(emp, {
    name: 'dave-token',
    expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  });
  seed.prepare('UPDATE employees SET active = 0 WHERE id = ?').run(emp);
  const app = harness(rotatedPepper(v1), seed);
  try {
    const res = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.statusCode, 401);
    const err = res.json() as { error: { code: string } };
    assert.equal(err.error.code, 'E-AUTH-004', '停用账号经 retired 键命中也走归因映射');
  } finally {
    await app.close();
    seed.close();
  }
});
