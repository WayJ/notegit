import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../src/validate.ts';
import type { FileInput } from '../src/validate.ts';

// S3-T8：web-submit 的 push 级容量判定接线（T7 honest-gap 的移交项——「E-LIMIT-005
// 的 web 侧判定随 T8 配置生效时一并接线」）。语义：scope=web-submit 且给定
// ref + 计量（pushBytes=变更字节合计口径、vaultCurrentBytes=库占用）时，与
// pre-receive 同一 checkPushLimits 判定（E-LIMIT-004/005，validation.md §5.3
// push 级判定、问题带 ref 定位）；计量缺省时不判定（惰性输入——既有调用面
// 语义不变，pre-commit 无 ref 天然不判）。

function file(path: string, content: string | Uint8Array = '---\ntitle: T\n---\n正文\n', mode = '100644'): FileInput {
  return { path, mode, content };
}

test('web-submit + ref + 计量：pushBytes 超 maxPushBytes → E-LIMIT-004 顶层 issue 带 ref/limit/limitKey', async () => {
  const r = await validate({
    scope: 'web-submit',
    vaultId: 'v1',
    commit: 'abc',
    ref: 'refs/heads/main',
    pushBytes: 52428800,
    files: [file('docs/a.md')],
    config: { maxPushBytes: 1048576 },
  });
  assert.equal(r.result, 'fail');
  assert.equal(r.exitCode, 1);
  const issue = r.issues?.find((i) => i.code === 'E-LIMIT-004');
  assert.ok(issue, '顶层 issues 应含 E-LIMIT-004');
  assert.equal(issue!.ref, 'refs/heads/main');
  assert.equal(issue!.limit, 1048576);
  assert.equal(issue!.limitKey, 'validation.limits.maxPushBytes');
  assert.equal('refs' in r, false, 'web-submit 报告无 refs（schema：仅 pre-receive 必填）');
});

test('web-submit + ref + 计量：vaultCurrentBytes+pushBytes 超 vaultCapacityBytes → E-LIMIT-005', async () => {
  const r = await validate({
    scope: 'web-submit',
    ref: 'refs/heads/main',
    pushBytes: 1000,
    vaultCurrentBytes: 995,
    files: [file('docs/a.md')],
    config: { vaultCapacityBytes: 1500 },
  });
  assert.equal(r.result, 'fail');
  const issue = r.issues?.find((i) => i.code === 'E-LIMIT-005');
  assert.ok(issue);
  assert.equal(issue!.limit, 1500);
  assert.equal(issue!.limitKey, 'validation.limits.vaultCapacityBytes');
  assert.equal(issue!.actual, 1995);
});

test('web-submit 计量缺省：不做 push 级判定（惰性输入，既有语义不变）', async () => {
  const r = await validate({
    scope: 'web-submit',
    ref: 'refs/heads/main',
    files: [file('docs/a.md')],
    config: { maxPushBytes: 1, vaultCapacityBytes: 1 },
  });
  assert.equal(r.result, 'pass');
  assert.equal(r.issues, undefined);
});

test('web-submit 有 ref 无计量、有计量无 ref：均不判定（两输入须同时给出）', async () => {
  const noMetering = await validate({
    scope: 'web-submit',
    ref: 'refs/heads/main',
    files: [file('docs/a.md')],
    config: { maxPushBytes: 1 },
  });
  assert.equal(noMetering.result, 'pass');

  const noRef = await validate({
    scope: 'web-submit',
    pushBytes: 999,
    files: [file('docs/a.md')],
    config: { maxPushBytes: 1 },
  });
  assert.equal(noRef.result, 'pass');
});

test('web-submit push 级拒绝与逐文件问题并存：两者都进报告、errorCount 合计', async () => {
  const r = await validate({
    scope: 'web-submit',
    ref: 'refs/heads/main',
    pushBytes: 999,
    files: [file('docs/bad.md', '无 frontmatter')],
    config: { maxPushBytes: 100 },
  });
  assert.equal(r.result, 'fail');
  assert.equal(r.summary.errorCount, 2, 'E-FM-001（文件级）+ E-LIMIT-004（push 级）');
  assert.ok(r.issues?.some((i) => i.code === 'E-LIMIT-004'));
  assert.ok(r.files.some((f) => f.issues.some((i) => i.code === 'E-FM-001')));
});
