import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ERROR_REGISTRY } from 'notegit-validation';
import { ERROR_HINTS, hintFor } from '../src/web/hints.ts';
import { browseHarness, seededVault, addEmployee, addMember, type BrowseHarness } from './web-browse-fixtures.ts';

// S4-T8 统一错误提示（breakdown §2.3 S4-T8 行「权限不足/格式错误统一提示（错误码+
// 修正建议映射表——消费 validation/api 错误码注册表生成提示文案）」）：
// 映射表以错误码注册表为唯一合法键来源（validation §6.2 机器注册表 ERROR_REGISTRY +
// api.md 错误码表运行时解析），不杜撰码；web 写面（upload/rename/delete）拒绝响应
// 统一携带 code + 修正建议（submissions 端点 422 保持裸 T2 报告——与契约示例同构，
// 见 web-submit-isomorphism.test.ts；409 信封 §8.2 已定形不扩字段）。

const here = path.dirname(fileURLToPath(import.meta.url));

/** api.md 错误码注册表（§1 错误响应表）——运行时解析（消费注册表而非硬编码副本） */
async function apiErrorCodeTable(): Promise<Set<string>> {
  const apiMd = await readFile(path.join(here, '..', '..', 'docs', 'contracts', 'api.md'), 'utf8');
  const codes = new Set<string>();
  for (const m of apiMd.matchAll(/^\| (E-[A-Z]+-\d{3}) \| \d{3} \|/gm)) codes.add(m[1]!);
  return codes;
}

interface Ctx {
  h: BrowseHarness;
}

/** 标准夹具：alice=editor、bob=reader；alpha 含 README/知识文档/纯文本种子 */
async function setup(): Promise<Ctx> {
  const h = await browseHarness();
  const alice = addEmployee(h.db, { username: 'alice' });
  addEmployee(h.db, { username: 'bob' });
  const vaultId = await seededVault(h, 'alpha', alice, {
    'README.md': '# nav\n',
    'docs/guide.md': '---\ntitle: 指南\n---\n\n正文。\n',
    'logo.txt': 'plain\n',
  });
  addMember(h.db, vaultId, alice, 'editor', alice);
  addMember(h.db, vaultId, alice + 1, 'reader', alice);
  return { h };
}

test('映射表：键全部来自注册表（validation ERROR_REGISTRY ∪ api.md 错误码表）——不杜撰码', async () => {
  const apiCodes = await apiErrorCodeTable();
  assert.ok(apiCodes.size >= 8, 'api.md 错误码表应解析出至少 8 码（解析失败=测试自身问题）');
  for (const code of Object.keys(ERROR_HINTS)) {
    assert.ok(
      ERROR_REGISTRY.some((e) => e.code === code) || apiCodes.has(code),
      `未注册的错误码：${code}（键必须来自 validation §6.2 或 api.md 错误码注册表）`,
    );
  }
});

test('映射表：注册表全部 error 级 validation 码都有修正建议（格式类统一提示完备）', () => {
  const errorCodes = ERROR_REGISTRY.filter((e) => e.severity === 'error').map((e) => e.code);
  assert.ok(errorCodes.length >= 20, '注册表 error 级码应 ≥20（消费注册表失败=测试自身问题）');
  for (const code of errorCodes) {
    assert.ok(typeof hintFor(code) === 'string' && hintFor(code)!.length > 0, `${code} 应有修正建议`);
  }
});

test('映射表：web 写面拒绝映射所用的 api 码都有修正建议（权限类统一提示完备）', () => {
  for (const code of ['E-AUTHZ-001', 'E-RES-001', 'E-RES-003', 'E-RES-004', 'E-MAINT-001']) {
    assert.ok(typeof hintFor(code) === 'string' && hintFor(code)!.length > 0, `${code} 应有修正建议`);
  }
});

test('映射表：未注册码返回 undefined（不杜撰回退文案）', () => {
  assert.equal(hintFor('E-XX-999'), undefined);
  assert.equal(hintFor(''), undefined);
});

test('上传端点：权限不足（reader）403 携带 E-AUTHZ-001 与修正建议', async () => {
  const { h } = await setup();
  try {
    const res = await h.app.inject({
      method: 'POST',
      url: '/vaults/alpha/upload/pic.png',
      headers: { 'content-type': 'application/octet-stream', origin: 'http://localhost', ...h.session(2) },
      payload: Buffer.from('png-bytes'),
    });
    assert.equal(res.statusCode, 403, res.body);
    const body = res.json() as { error?: { code?: string; hint?: string } };
    assert.equal(body.error?.code, 'E-AUTHZ-001', '403 应携带权限错误码（统一提示）');
    assert.equal(body.error?.hint, hintFor('E-AUTHZ-001'), '403 应携带注册表修正建议');
  } finally {
    await h.close();
  }
});

test('上传端点：格式错误（svg 清单外）422 携带修正建议', async () => {
  const { h } = await setup();
  try {
    const res = await h.app.inject({
      method: 'POST',
      url: '/vaults/alpha/upload/assets/logo.svg',
      headers: { 'content-type': 'application/octet-stream', origin: 'http://localhost', ...h.session(1) },
      payload: '<svg onload="x"/>',
    });
    assert.equal(res.statusCode, 422, res.body);
    const body = res.json() as { error?: { code?: string; hint?: string } };
    assert.equal(body.error?.code, 'E-LIMIT-002');
    assert.equal(body.error?.hint, hintFor('E-LIMIT-002'), '422 应携带 E-LIMIT-002 修正建议');
  } finally {
    await h.close();
  }
});

test('重命名端点：格式错误（→.md 缺 frontmatter）422 同页回显错误码与修正建议', async () => {
  const { h } = await setup();
  try {
    const res = await h.app.inject({
      method: 'POST',
      url: '/vaults/alpha/rename/logo.txt',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://localhost', ...h.session(1) },
      payload: `to=${encodeURIComponent('logo.md')}`,
    });
    assert.equal(res.statusCode, 422, res.body);
    assert.ok(res.body.includes('E-FM-001'), '应回显错误码 E-FM-001');
    assert.ok(res.body.includes(hintFor('E-FM-001')!), '应回显 E-FM-001 修正建议');
  } finally {
    await h.close();
  }
});

test('重命名端点：权限不足（reader）403 同页回显 E-AUTHZ-001 与修正建议', async () => {
  const { h } = await setup();
  try {
    const res = await h.app.inject({
      method: 'POST',
      url: '/vaults/alpha/rename/logo.txt',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://localhost', ...h.session(2) },
      payload: `to=${encodeURIComponent('renamed.txt')}`,
    });
    assert.equal(res.statusCode, 403, res.body);
    assert.ok(res.body.includes('E-AUTHZ-001'), '应回显权限错误码');
    assert.ok(res.body.includes(hintFor('E-AUTHZ-001')!), '应回显权限不足修正建议');
  } finally {
    await h.close();
  }
});

test('删除端点：权限不足（reader）403 同页回显 E-AUTHZ-001 与修正建议', async () => {
  const { h } = await setup();
  try {
    const res = await h.app.inject({
      method: 'POST',
      url: '/vaults/alpha/delete/logo.txt',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://localhost', ...h.session(2) },
    });
    assert.equal(res.statusCode, 403, res.body);
    assert.ok(res.body.includes('E-AUTHZ-001'), '应回显权限错误码');
    assert.ok(res.body.includes(hintFor('E-AUTHZ-001')!), '应回显权限不足修正建议');
  } finally {
    await h.close();
  }
});
