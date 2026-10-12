import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLoginBackoff, DEFAULT_LOGIN_BACKOFF } from '../src/auth/backoff.ts';

// identity §2：按「账号 + 来源 IP」指数退避（连续失败后延迟递增，窗口封顶），
// 不做无管理动作的永久锁定。完成标准 2：延迟递增且无永久锁定。
// 进程内计数（storage-model §2：登录限速计数为运行态，不落库）。

const OPTS = { maxFails: 3, baseDelayMs: 1000, maxDelayMs: 30000, windowMs: 60_000 };

test('默认值已定（identity §2 阈值可配、默认 S2 定）', () => {
  assert.equal(DEFAULT_LOGIN_BACKOFF.maxFails, 3);
  assert.equal(DEFAULT_LOGIN_BACKOFF.baseDelayMs, 1000);
  assert.equal(DEFAULT_LOGIN_BACKOFF.maxDelayMs, 30000);
});

test('前 maxFails 次连续失败不产生延迟', () => {
  const bo = createLoginBackoff(OPTS);
  let t = 0;
  for (let i = 0; i < 3; i++) {
    bo.recordFailure('alice', '203.0.113.9', t);
    assert.deepEqual(bo.check('alice', '203.0.113.9', t), { locked: false });
  }
});

test('超出阈值后锁定，且延迟随失败次数指数递增', () => {
  const bo = createLoginBackoff(OPTS);
  let t = 0;
  for (let i = 0; i < 3; i++) bo.recordFailure('alice', '203.0.113.9', (t += 10));
  // 第 4 次失败 → 锁 1s
  bo.recordFailure('alice', '203.0.113.9', (t += 10));
  assert.deepEqual(bo.check('alice', '203.0.113.9', t), { locked: true, retryAfterMs: 1000 });
  // 锁过期后再失败 → 第 5 次 → 2s
  t += 1000;
  bo.recordFailure('alice', '203.0.113.9', t);
  assert.deepEqual(bo.check('alice', '203.0.113.9', t), { locked: true, retryAfterMs: 2000 });
  // 第 6 次 → 4s
  t += 2000;
  bo.recordFailure('alice', '203.0.113.9', t);
  assert.deepEqual(bo.check('alice', '203.0.113.9', t), { locked: true, retryAfterMs: 4000 });
});

test('延迟封顶：持续失败不超过 maxDelayMs（窗口封顶）', () => {
  const bo = createLoginBackoff(OPTS);
  let t = 0;
  for (let i = 0; i < 30; i++) {
    bo.recordFailure('alice', '203.0.113.9', t);
    t += 30_000; // 每次都在锁过期后
  }
  // 最后一次失败发生在 t-30_000；在其后立即检查（不推进时钟）
  const c = bo.check('alice', '203.0.113.9', t - 30_000);
  assert.ok(c.locked);
  assert.equal(c.retryAfterMs, 30_000, '封顶后延迟不再增长');
});

test('无永久锁定：封顶锁过期后放行，成功登录清零计数', () => {
  const bo = createLoginBackoff(OPTS);
  let t = 0;
  for (let i = 0; i < 50; i++) {
    bo.recordFailure('alice', '203.0.113.9', t);
    t += 30_000;
  }
  // 锁过期后（t 已推进超过 lockedUntil）
  assert.deepEqual(bo.check('alice', '203.0.113.9', t), { locked: false }, '封顶锁过期后应放行');
  bo.recordSuccess('alice', '203.0.113.9');
  // 计数清零：单次失败立即回到无锁状态
  bo.recordFailure('alice', '203.0.113.9', t);
  assert.deepEqual(bo.check('alice', '203.0.113.9', t), { locked: false });
});

test('键 = 账号 + 来源 IP：不同 IP / 不同账号互不影响', () => {
  const bo = createLoginBackoff(OPTS);
  let t = 0;
  for (let i = 0; i < 6; i++) bo.recordFailure('alice', '203.0.113.9', t);
  assert.ok(bo.check('alice', '203.0.113.9', t).locked);
  assert.deepEqual(bo.check('alice', '198.51.100.7', t), { locked: false }, '同账号不同 IP 不连带');
  assert.deepEqual(bo.check('bob', '203.0.113.9', t), { locked: false }, '同 IP 不同账号不连带');
});

test('窗口衰减：静置超过 windowMs 后失败重新从 1 计', () => {
  const bo = createLoginBackoff(OPTS);
  let t = 0;
  for (let i = 0; i < 5; i++) bo.recordFailure('alice', '203.0.113.9', (t += 10));
  assert.ok(bo.check('alice', '203.0.113.9', t).locked);
  t += 60_000 + 1; // 超过观察窗口
  assert.deepEqual(bo.check('alice', '203.0.113.9', t), { locked: false });
  bo.recordFailure('alice', '203.0.113.9', t); // 窗口后重新计数 → 第 1 次，无锁
  assert.deepEqual(bo.check('alice', '203.0.113.9', t), { locked: false });
});
