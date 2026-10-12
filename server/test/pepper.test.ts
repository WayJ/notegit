import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadOrCreatePepper, hmacTokenHash } from '../src/bootstrap/pepper.ts';

// identity §6.1 K1：pepper 32B、/data/keys/token-pepper.key、0600、首次初始化自动生成；
// §3.2/D-IC-03：库内哈希形态 hmacv1$<hex>（内嵌 pepper 版本）。

const ZERO32 = createHash('sha256').update('notegit-test').digest(); // 定长 32B 参照

function fileMode(p: string): Promise<number> {
  return stat(p).then((s) => s.mode & 0o777);
}

test('首次初始化自动生成 pepper：32B、0600、hmacv1$ 形态', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'notegit-pepper-'));
  try {
    const file = path.join(dir, 'keys', 'token-pepper.key');
    const pepper = await loadOrCreatePepper(file);
    assert.equal(pepper.active.version, 1);
    assert.equal(pepper.active.key.length, 32);
    assert.equal(await fileMode(file), 0o600);
    const hash = hmacTokenHash(pepper, 'sometoken');
    assert.match(hash, /^hmac1\$[0-9a-f]{64}$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('已有 pepper 不重新生成（重启后内容稳定，重生成将废掉全部已存哈希）', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'notegit-pepper-'));
  try {
    const file = path.join(dir, 'token-pepper.key');
    const first = await loadOrCreatePepper(file);
    const before = await readFile(file, 'utf8');
    const second = await loadOrCreatePepper(file);
    assert.deepEqual([...second.active.key], [...first.active.key]);
    assert.equal(await readFile(file, 'utf8'), before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('pepper 派生 HMAC 确定性且随键变化（同 token 不同 pepper → 不同哈希）', async () => {
  const a = { active: { version: 1, key: Buffer.alloc(32, 1) }, retired: [] };
  const b = { active: { version: 1, key: Buffer.alloc(32, 2) }, retired: [] };
  assert.equal(hmacTokenHash(a, 'tok'), hmacTokenHash(a, 'tok'));
  assert.notEqual(hmacTokenHash(a, 'tok'), hmacTokenHash(b, 'tok'));
  // 版本内嵌：pepper 版本 2 → hmacv2$ 前缀（identity §6.2 校验按版本选键的钩子）
  const v2 = { active: { version: 2, key: ZERO32 }, retired: [] };
  assert.match(hmacTokenHash(v2, 'tok'), /^hmac2\$/);
});
