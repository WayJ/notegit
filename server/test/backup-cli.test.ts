import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBackupArgs } from '../src/backup/cli.ts';

// S8-T4 备份 CLI 参数面（备份触发 = 脚本模式——建议稿 B1；端点被否理由见建议稿）。
// 凭据卫生：管理令牌只走 --token-file 或环境变量，不接受 argv 明文（DOD-09 同则：
// 凭据不进 argv/日志/仓库）。解析纯函数化——执行路径由真实实例测试（backup-run）
// 与容器演练（deploy/scripts/backup-drill.mjs）覆盖。

test('backup：最小合法参数（--token-file）解析齐全，fsck 默认 sample:3、排空默认 300s', () => {
  const a = parseBackupArgs([
    'backup',
    '--data-dir', '/data',
    '--out', '/backup',
    '--url', 'http://127.0.0.1:3000',
    '--token-file', '/run/secrets/admin.token',
  ]);
  assert.equal(a.command, 'backup');
  assert.equal(a.dataDir, '/data');
  assert.equal(a.out, '/backup');
  assert.equal(a.url, 'http://127.0.0.1:3000');
  assert.equal(a.tokenFile, '/run/secrets/admin.token');
  assert.equal(a.keysOut, undefined);
  assert.equal(a.drainTimeoutMs, 300_000, 'backup §4 步骤 2 默认 300 秒');
  assert.deepEqual(a.fsck, { mode: 'sample', sampleSize: 3 });
  assert.equal(a.forceAfterDrainTimeout, false);
});

test('backup：环境变量令牌兜底；--token-file 优先于环境变量（明示来源可审计）', () => {
  const prev = process.env.NOTEGIT_ADMIN_TOKEN;
  try {
    process.env.NOTEGIT_ADMIN_TOKEN = 'env-token';
    const a = parseBackupArgs(['backup', '--data-dir', '/data', '--out', '/b', '--url', 'http://x', ]);
    assert.equal(a.tokenFile, undefined);
    assert.equal(a.envToken, 'env-token');
    const b = parseBackupArgs(['backup', '--data-dir', '/data', '--out', '/b', '--url', 'http://x', '--token-file', '/f']);
    assert.equal(b.tokenFile, '/f');
    assert.equal(b.envToken, 'env-token');
  } finally {
    if (prev === undefined) delete process.env.NOTEGIT_ADMIN_TOKEN;
    else process.env.NOTEGIT_ADMIN_TOKEN = prev;
  }
});

test('backup：无任何令牌来源 → 拒绝且不回显令牌材料', () => {
  const prev = process.env.NOTEGIT_ADMIN_TOKEN;
  delete process.env.NOTEGIT_ADMIN_TOKEN;
  try {
    assert.throws(
      () => parseBackupArgs(['backup', '--data-dir', '/data', '--out', '/b', '--url', 'http://x']),
      (err: Error) => /令牌|token/i.test(err.message),
    );
  } finally {
    if (prev !== undefined) process.env.NOTEGIT_ADMIN_TOKEN = prev;
  }
});

test('backup：必填项缺失（--out）与未知参数 → 拒绝并带用法提示', () => {
  assert.throws(
    () => parseBackupArgs(['backup', '--data-dir', '/data', '--url', 'http://x']),
    (err: Error) => /--out/.test(err.message),
  );
  assert.throws(
    () => parseBackupArgs(['backup', '--data-dir', '/data', '--out', '/b', '--url', 'http://x', '--bogus']),
    (err: Error) => /未知|--bogus/.test(err.message),
  );
});

test('backup：fsck 形态解析（all/none/sample/sample:N；非法值拒绝）', () => {
  const base = ['backup', '--data-dir', '/d', '--out', '/b', '--url', 'http://x', '--token-file', '/f'];
  assert.deepEqual(parseBackupArgs([...base, '--fsck', 'all']).fsck, { mode: 'all' });
  assert.deepEqual(parseBackupArgs([...base, '--fsck', 'none']).fsck, { mode: 'none' });
  assert.deepEqual(parseBackupArgs([...base, '--fsck', 'sample']).fsck, { mode: 'sample', sampleSize: 3 });
  assert.deepEqual(parseBackupArgs([...base, '--fsck', 'sample:7']).fsck, { mode: 'sample', sampleSize: 7 });
  assert.throws(() => parseBackupArgs([...base, '--fsck', 'sometimes']), /fsck/);
  assert.throws(() => parseBackupArgs([...base, '--fsck', 'sample:0']), /fsck/);
});

test('verify：--data-item 必填；--keys-item 与 --fsck 可选', () => {
  const a = parseBackupArgs(['verify', '--data-item', '/backup/20261014T000000Z-data']);
  assert.equal(a.command, 'verify');
  assert.equal(a.dataItem, '/backup/20261014T000000Z-data');
  assert.equal(a.keysItem, undefined);
  assert.equal(a.fsck, false);
  const b = parseBackupArgs(['verify', '--data-item', '/d', '--keys-item', '/k', '--fsck']);
  assert.equal(b.keysItem, '/k');
  assert.equal(b.fsck, true);
  assert.throws(() => parseBackupArgs(['verify']), /--data-item/);
});

test('空参数与未知子命令 → 用法提示', () => {
  assert.throws(() => parseBackupArgs([]), /用法|usage/i);
  assert.throws(() => parseBackupArgs(['frobnicate']), /用法|usage/i);
});
