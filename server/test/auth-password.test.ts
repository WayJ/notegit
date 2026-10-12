import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, INVITED_PASSWORD_SENTINEL } from '../src/auth/password.ts';

// identity §2/D-IC-02：Argon2id（m=19456 KiB、t=2、p=1），盐随机内嵌于 modular（PHC）串。
// 参数断言以哈希串内嵌参数为准（T3 验证性评审的同一依据）。

const PASSWORD = 'correct-horse-battery';

test('hashPassword 产出契约参数的 Argon2id PHC 串（$argon2id$v=19$m=19456,t=2,p=1$…）', async () => {
  const hash = await hashPassword(PASSWORD);
  assert.match(hash, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{16,}\$[A-Za-z0-9+/]{16,}$/);
});

test('verifyPassword：正确口令通过、错误口令拒绝；盐随机（同口令两次哈希不同）', async () => {
  const hash = await hashPassword(PASSWORD);
  assert.equal(await verifyPassword(hash, PASSWORD), true);
  assert.equal(await verifyPassword(hash, 'wrong-horse-battery'), false);
  const hash2 = await hashPassword(PASSWORD);
  assert.notEqual(hash, hash2);
  assert.equal(await verifyPassword(hash2, PASSWORD), true);
});

test('受邀哨兵与畸形串一律校验失败（未设口令账号不可登录）', async () => {
  assert.equal(await verifyPassword(INVITED_PASSWORD_SENTINEL, PASSWORD), false);
  assert.equal(await verifyPassword('', PASSWORD), false);
  assert.equal(await verifyPassword('not-a-hash', PASSWORD), false);
});
