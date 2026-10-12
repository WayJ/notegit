import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  loadOrCreatePepper,
  resolvePepperPath,
  DEFAULT_PEPPER_PATH,
  PEPPER_PATH_ENV,
} from '../src/credentials/pepper.ts';
import { generateToken, hashToken, pepperVersionOf, displayHint } from '../src/credentials/token.ts';

// identity §3.2/§6.1 K1：pepper 为 32B 随机文件（0600），版本化列表支持 §6.2 轮换
// （轮换操作留 S2-T8，本域只须存储格式支持——active + retired[] 按版本取键）。

test('loadOrCreatePepper：文件不存在时自动生成 32B pepper（0600），active 版本 1、retired 为空', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'notegit-pepper-'));
  try {
    const file = path.join(dir, 'token-pepper.key');
    const pepper = loadOrCreatePepper(file);
    assert.equal(pepper.active.id, 1);
    assert.equal(pepper.active.key.length, 32);
    assert.deepEqual(pepper.retired, []);
    const mode = (await stat(file)).mode & 0o777;
    assert.equal(mode, 0o600, `pepper 文件权限应为 0600，实得 ${mode.toString(8)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadOrCreatePepper：重复加载同一文件返回同一 key（稳定）', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'notegit-pepper-'));
  try {
    const file = path.join(dir, 'token-pepper.key');
    const a = loadOrCreatePepper(file);
    const b = loadOrCreatePepper(file);
    assert.deepEqual(b.active.key, a.active.key);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('pepperFor：active 版本可取；未知版本 undefined（校验按版本选键）', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'notegit-pepper-'));
  try {
    const pepper = loadOrCreatePepper(path.join(dir, 'token-pepper.key'));
    assert.equal(pepper.pepperFor(1)?.key, pepper.active.key);
    assert.equal(pepper.pepperFor(99), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('版本化列表：active v2 + retired v1 可解析，pepperFor 按版本各取其键（D-IC-09 存储格式）', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'notegit-pepper-'));
  try {
    const k1 = randomBytes(32);
    const k2 = randomBytes(32);
    const file = path.join(dir, 'token-pepper.key');
    await writeFile(
      file,
      JSON.stringify({
        format: 1,
        active: { id: 2, key: k2.toString('hex') },
        retired: [{ id: 1, key: k1.toString('hex'), retired_at: '2026-10-01T00:00:00.000Z' }],
      }),
    );
    const pepper = loadOrCreatePepper(file);
    assert.equal(pepper.active.id, 2);
    assert.deepEqual(pepper.pepperFor(1)?.key, k1);
    assert.deepEqual(pepper.pepperFor(2)?.key, k2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('非法 pepper 文件被拒：key 非 64 位 hex / 版本号冲突', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'notegit-pepper-'));
  try {
    const bad = path.join(dir, 'bad.key');
    await writeFile(bad, JSON.stringify({ format: 1, active: { id: 1, key: 'zz' }, retired: [] }));
    assert.throws(() => loadOrCreatePepper(bad), /pepper/);

    const dup = path.join(dir, 'dup.key');
    const k = randomBytes(32).toString('hex');
    await writeFile(
      dup,
      JSON.stringify({ format: 1, active: { id: 1, key: k }, retired: [{ id: 1, key: k, retired_at: '2026-10-01T00:00:00.000Z' }] }),
    );
    assert.throws(() => loadOrCreatePepper(dup), /pepper/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolvePepperPath：env 覆盖优先，否则契约默认路径（identity §6.1 K1）', () => {
  assert.equal(resolvePepperPath({ [PEPPER_PATH_ENV]: '/tmp/x.key' }), '/tmp/x.key');
  assert.equal(resolvePepperPath({}), DEFAULT_PEPPER_PATH);
  assert.equal(DEFAULT_PEPPER_PATH, '/data/keys/token-pepper.key');
});

// identity §3.1/D-IC-01：ngt_ 前缀 + 32B CSPRNG base64url（43 字符随机部）。

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
  const k1 = { id: 1, key: randomBytes(32) };
  const k2 = { id: 2, key: randomBytes(32) };
  const t = generateToken();
  const h = hashToken(k1, t);
  assert.match(h, /^hmacv1\$[0-9a-f]{64}$/);
  assert.equal(hashToken(k1, t), h);
  assert.notEqual(hashToken(k2, t), h);
  assert.notEqual(hashToken(k1, generateToken()), h);
});

test('pepperVersionOf：解析存储串内嵌版本；非本形态返回 undefined', () => {
  assert.equal(pepperVersionOf(hashToken({ id: 7, key: randomBytes(32) }, 'ngt_x')), 7);
  assert.equal(pepperVersionOf('sha256$abcd'), undefined);
  assert.equal(pepperVersionOf('hmacv$abcd'), undefined);
  assert.equal(pepperVersionOf('hmacvx$abcd'), undefined);
});

// identity §3.1：此后仅显示前缀与末 4 位（识别用）；api.md §4：display_hint 形如 ngt_ab…wxyz。

test('displayHint：前缀 + 随机部前 2 字符 + … + 末 4 位；不含明文中段', () => {
  const t = generateToken();
  const hint = displayHint(t);
  assert.equal(hint, `ngt_${t.slice(4, 6)}…${t.slice(-4)}`);
  // 中段（随机部第 3 至倒数第 5 字符）不得出现在提示串中
  const middle = t.slice(6, -4);
  assert.ok(middle.length > 0);
  assert.ok(!hint.includes(middle));
  assert.ok(!hint.includes(middle.slice(0, 8)));
});
