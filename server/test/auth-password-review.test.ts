import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../src/auth/password.ts';
import { validateNewPassword, DEFAULT_PASSWORD_POLICY } from '../src/auth/password-policy.ts';

// S2-T3 对共享口令模块（S2-T2 落地 @node-rs/argon2，经协调人 2026-10-12 批复复用）
// 的验证性评审断言（完成标准 1：哈希串参数与契约一致；评审结论记
// architecture-notes.md §6.1）：identity §2 / D-IC-02——Argon2id，m=19456 KiB、t=2、
// p=1，盐随机内嵌于 modular（PHC）串。基础往返/哨兵断言见 T2 的 auth-password.test.ts，
// 本文件是 T3 侧独立评审：逐组参数断言 + 跨实现互操作向量 + 口令策略。

const PHC_RE = /^\$argon2id\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

// 跨实现互操作向量：PHC 串由独立实现（hash-wasm，4.12.0）按契约参数生成；
// 共享模块（@node-rs/argon2）必须能校验——证明已存哈希不绑定生成实现。
const INTEROP_VECTOR = {
  password: 'interop-vector-2026',
  hash: '$argon2id$v=19$m=19456,t=2,p=1$GESwZVGzJiLjtXB+Y8e8Ww$e6Y53OK1sev4aqH4NJNvYOKMv966i5gZK7KwwIl8Fo8',
};

test('评审：哈希串 PHC 参数逐组与契约一致（argon2id v=19 m=19456 t=2 p=1）', async () => {
  const hash = await hashPassword('a-secure-passphrase');
  const m = PHC_RE.exec(hash);
  assert.ok(m, `应为 PHC modular 格式，实际：${hash}`);
  assert.equal(m?.[1], '19', 'Argon2 版本号 v=19');
  assert.equal(m?.[2], '19456', '内存参数 m=19456 KiB');
  assert.equal(m?.[3], '2', '迭代参数 t=2');
  assert.equal(m?.[4], '1', '并行参数 p=1');
});

test('评审：盐随机内嵌（同口令两次哈希盐不同）', async () => {
  const a = await hashPassword('same-password-123');
  const b = await hashPassword('same-password-123');
  assert.notEqual(a, b);
  assert.notEqual(PHC_RE.exec(a)?.[5], PHC_RE.exec(b)?.[5], '两次哈希的盐应不同');
});

test('评审：互操作性——共享模块能校验独立实现（hash-wasm）生成的 PHC 串', async () => {
  assert.equal(await verifyPassword(INTEROP_VECTOR.hash, INTEROP_VECTOR.password), true);
  assert.equal(await verifyPassword(INTEROP_VECTOR.hash, 'wrong-vector-password'), false);
});

test('口令策略：长度 12–64（NIST 800-63B 5.1.1，无组合规则；E-AUTH-008）', () => {
  assert.equal(DEFAULT_PASSWORD_POLICY.minLength, 12);
  assert.equal(DEFAULT_PASSWORD_POLICY.maxLength, 64);
  // 长度 11 → 拒
  assert.equal(validateNewPassword('abcdefghijk').ok, false, '11 字符应拒');
  // 长度 12 / 64 → 收
  assert.equal(validateNewPassword('abcdefghijkl').ok, true, '12 字符应收');
  assert.equal(validateNewPassword('a'.repeat(64)).ok, true, '64 字符应收');
  // 长度 65 → 拒
  assert.equal(validateNewPassword('a'.repeat(65)).ok, false, '65 字符应拒');
  // 无组合规则：纯数字 12 位也通过
  assert.equal(validateNewPassword('123456789012').ok, true, '纯数字 12 位应收');
});

test('口令策略拒绝时给出 E-AUTH-008 与可读信息', () => {
  const r = validateNewPassword('short');
  assert.ok(!r.ok);
  assert.equal(r.code, 'E-AUTH-008');
  assert.ok(r.message.includes('12'), `信息应含最小长度：${r.message}`);
});
