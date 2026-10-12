import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { generateToken, hashToken, pepperVersionOf, displayHint } from '../src/credentials/token.ts';

// identity §3.1/D-IC-01：ngt_ 前缀 + 32B CSPRNG base64url（43 字符随机部）。
// pepper 文件加载与版本化列表见 bootstrap/pepper.ts（S2-T2 落地，server/test/pepper.test.ts）。

test('generateToken：形如 ngt_ + 43 字符 base64url，且不重复', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 1000; i++) {
    const t = generateToken();
    assert.match(t, /^ngt_[A-Za-z0-9_-]{43}$/);
    seen.add(t);
  }
  assert.equal(seen.size, 1000);
});

// identity §3.2/D-IC-03：存 HMAC-SHA256(pepper, token)，串内嵌 pepper 版本（hmacv1$<hex>）。

test('hashToken：hmacv<版本>$<64 位小写 hex>，确定性、随键/随 token 变化', () => {
  const k1 = { version: 1, key: randomBytes(32) };
  const k2 = { version: 2, key: randomBytes(32) };
  const t = generateToken();
  const h = hashToken(k1, t);
  assert.match(h, /^hmacv1\$[0-9a-f]{64}$/);
  assert.equal(hashToken(k1, t), h);
  assert.match(hashToken(k2, t), /^hmacv2\$[0-9a-f]{64}$/);
  assert.notEqual(hashToken(k2, t), h);
  assert.notEqual(hashToken(k1, generateToken()), h);
});

test('pepperVersionOf：解析存储串内嵌版本；非本形态返回 undefined', () => {
  assert.equal(pepperVersionOf(hashToken({ version: 7, key: randomBytes(32) }, 'ngt_x')), 7);
  assert.equal(pepperVersionOf('sha256$abcd'), undefined);
  assert.equal(pepperVersionOf('hmacv$abcd'), undefined);
  assert.equal(pepperVersionOf('hmacvx$abcd'), undefined);
});

// identity §3.1：此后仅显示前缀与末 4 位（识别用）；api.md §4：display_hint 形如 ngt_ab…wxyz。

test('displayHint：前缀 + 随机部前 2 字符 + … + 末 4 位；不含明文中段（master 2026-10-12 裁定附加断言）', () => {
  const t = generateToken();
  const hint = displayHint(t);
  assert.equal(hint, `ngt_${t.slice(4, 6)}…${t.slice(-4)}`);
  // 中段（随机部第 3 至倒数第 5 字符）不得出现在提示串中
  const middle = t.slice(6, -4);
  assert.ok(middle.length > 0);
  assert.ok(!hint.includes(middle));
  assert.ok(!hint.includes(middle.slice(0, 8)));
});
