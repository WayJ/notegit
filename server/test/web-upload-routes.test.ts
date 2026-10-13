import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { defaultConfig } from 'notegit-validation';
import { setAppSetting } from '../src/limits/engine.ts';
import { browseHarness, seededVault, addEmployee, addMember, gitOut, repoPathOf, type BrowseHarness } from './web-browse-fixtures.ts';

// S4-T4 上传端点（breakdown §2.3 S4-T4 行完成标准前两条 + DOD-06「上传 Markdown
// 与图片」）：POST /vaults/{slug}/upload/{path}（application/octet-stream 原始
// 字节）→ 上传即走候选提交（publishWebSubmit——T3 定形的单文件 upsert 形状，
// 附件与引用它的 Markdown 变更分步提交）；判定单一来源 = 发布组件 validation
// 阶段（D7——本端点不另设第二套校验，只做错误映射：E-LIMIT 码含 limit/limitKey）。

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** png 字节（校验器清单制按扩展名判定，不嗅探内容——validation §5.2） */
function pngBytes(fill = 64): Buffer {
  return Buffer.concat([PNG_MAGIC, Buffer.alloc(fill, 0x61)]);
}

interface Ctx {
  h: BrowseHarness;
  repoPath: string;
  seedMain: string;
}

/** 标准夹具：alice=editor、bob=reader、carol=非成员；alpha 含 README 种子 */
async function setup(): Promise<Ctx> {
  const h = await browseHarness();
  const alice = addEmployee(h.db, { username: 'alice' });
  addEmployee(h.db, { username: 'bob' });
  addEmployee(h.db, { username: 'carol' });
  const vaultId = await seededVault(h, 'alpha', alice, { 'README.md': '# nav\n' });
  addMember(h.db, vaultId, alice, 'editor', alice);
  addMember(h.db, vaultId, alice + 1, 'reader', alice);
  const repoPath = repoPathOf(h, vaultId);
  const seedMain = (await gitOut(['--git-dir', repoPath, 'rev-parse', 'refs/heads/main'])).trim();
  return { h, repoPath, seedMain };
}

function upload(h: BrowseHarness, slug: string, path: string, payload: Buffer | string, who?: number) {
  return h.app.inject({
    method: 'POST',
    url: `/vaults/${slug}/upload/${path}`,
    headers: {
      'content-type': 'application/octet-stream',
      origin: 'http://localhost',
      ...(who === undefined ? {} : h.session(who)),
    },
    payload,
  });
}

async function mainHead(repoPath: string): Promise<string> {
  return (await gitOut(['--git-dir', repoPath, 'rev-parse', 'refs/heads/main'])).trim();
}

test('上传完成标准 1：svg 默认被拒（E-LIMIT-002，清单外——清单制）', async () => {
  const { h, repoPath, seedMain } = await setup();
  try {
    const res = await upload(h, 'alpha', 'assets/logo.svg', '<svg onload="x"/>', 1);
    assert.equal(res.statusCode, 422, res.body);
    const body = res.json() as {
      ok: boolean;
      stage: string;
      error: { code: string; message: string; expected: unknown };
    };
    assert.equal(body.ok, false);
    assert.equal(body.stage, 'validation');
    assert.equal(body.error.code, 'E-LIMIT-002');
    assert.match(body.error.message, /不在允许清单/);
    const expected = body.error.expected as string[];
    assert.ok(expected.includes('.png') && !expected.includes('.svg'), '期望清单含 png 不含 svg');
    assert.equal(await mainHead(repoPath), seedMain, '拒绝不移动默认分支');
  } finally {
    await h.close();
  }
});

test('上传完成标准 2：超 10 MiB 附件 E-LIMIT-003（含 limit/limitKey）', async () => {
  const { h, repoPath, seedMain } = await setup();
  try {
    const over = Buffer.alloc(10485760 + 1, 0x61); // 默认上限 10 MiB（validation-defaults.json）
    const res = await upload(h, 'alpha', 'assets/big.png', over, 1);
    assert.equal(res.statusCode, 422, res.body);
    const body = res.json() as {
      error: { code: string; limit: number; limitKey: string; actual: number };
      issues: { code: string; limit?: number; limitKey?: string }[];
    };
    assert.equal(body.error.code, 'E-LIMIT-003');
    assert.equal(body.error.limit, 10485760, 'limit = 数值上限');
    assert.equal(body.error.limitKey, 'validation.limits.maxAttachmentBytes', 'limitKey = 配置键');
    assert.equal(body.error.actual, 10485761);
    const issue = body.issues.find((x) => x.code === 'E-LIMIT-003');
    assert.ok(issue !== undefined, 'issues 数组保留原报告 issue');
    assert.equal(issue.limit, 10485760);
    assert.equal(issue.limitKey, 'validation.limits.maxAttachmentBytes');
    assert.equal(await mainHead(repoPath), seedMain, '拒绝不移动默认分支');
  } finally {
    await h.close();
  }
});

test('png 上传成功：走候选提交（分支推进 + blob 入库 + 响应携带 blob 寻址 URL）', async () => {
  const { h, repoPath, seedMain } = await setup();
  try {
    const bytes = pngBytes();
    const res = await upload(h, 'alpha', 'assets/logo.png', bytes, 1);
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as { ok: boolean; path: string; commit: string; url: string };
    assert.equal(body.ok, true);
    assert.equal(body.path, 'assets/logo.png');
    assert.match(body.commit, /^[0-9a-f]{40}$/, '响应携带新 commit');
    assert.notEqual(body.commit, seedMain);
    assert.equal(await mainHead(repoPath), body.commit, '默认分支推进到新提交');
    assert.match(body.url, /^\/vaults\/alpha\/attach\/[0-9a-f]{40}\/logo\.png$/, 'blob 寻址附件 URL');

    // 入库核对（直通 git，不经生产读面）：tree 含条目；blob OID = sha1("blob <len>\0"+字节)
    // （gitOut 面向文本——二进制字节比对以 OID 等价代替）
    const entry = (await gitOut(['--git-dir', repoPath, 'ls-tree', 'refs/heads/main', 'assets/logo.png'])).trim();
    assert.match(entry, /^100644 blob [0-9a-f]{40}\tassets\/logo\.png$/);
    const oid = entry.split('\t')[0]!.split(' ')[2]!;
    const gitBlobHash = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    assert.equal(gitBlobHash, oid, 'blob 内容与上传字节一致');
  } finally {
    await h.close();
  }
});

test('Markdown 上传：合法 frontmatter 通过；缺 frontmatter 映射 E-FM-001', async () => {
  const { h } = await setup();
  try {
    const ok = await upload(h, 'alpha', 'docs/new.md', '---\ntitle: 新笔记\n---\n正文。\n', 1);
    assert.equal(ok.statusCode, 200, ok.body);
    const bad = await upload(h, 'alpha', 'docs/bare.md', '没有 frontmatter 的正文\n', 1);
    assert.equal(bad.statusCode, 422, bad.body);
    assert.equal((bad.json() as { error: { code: string } }).error.code, 'E-FM-001');
  } finally {
    await h.close();
  }
});

test('写权限与存在性：reader 403（分支规则拒）；非成员/不存在库 404；未认证 302 /login', async () => {
  const { h } = await setup();
  try {
    const reader = await upload(h, 'alpha', 'assets/x.png', pngBytes(), 2);
    assert.equal(reader.statusCode, 403, reader.body);
    assert.equal((reader.json() as { stage: string }).stage, 'branch-rules');

    const outsider = await upload(h, 'alpha', 'assets/x.png', pngBytes(), 3);
    assert.equal(outsider.statusCode, 404);
    assert.match(outsider.headers['content-type'] as string, /^text\/html/, '页面域 404 同页');

    const ghost = await upload(h, 'ghost', 'assets/x.png', pngBytes(), 1);
    assert.equal(ghost.statusCode, 404);
    assert.equal(outsider.body, ghost.body, '无权与不存在同体（D-IC-06）');

    const anon = await upload(h, 'alpha', 'assets/x.png', pngBytes());
    assert.equal(anon.statusCode, 302);
    assert.equal(anomLocation(anon.headers), '/login');
  } finally {
    await h.close();
  }
});

function anomLocation(headers: Record<string, unknown>): string {
  return String(headers['location'] ?? headers['Location'] ?? '');
}

test('会话 POST 受 CSRF 同源校验（缺 Origin → 403 E-AUTH-006）', async () => {
  const { h } = await setup();
  try {
    const res = await h.app.inject({
      method: 'POST',
      url: '/vaults/alpha/upload/assets/x.png',
      headers: { 'content-type': 'application/octet-stream', ...h.session(1) },
      payload: pngBytes(),
    });
    assert.equal(res.statusCode, 403);
    assert.equal((res.json() as { error: { code: string } }).error.code, 'E-AUTH-006');
  } finally {
    await h.close();
  }
});

test('请求形态：非 octet-stream 内容类型 415；路径参数越界（.. 段）404', async () => {
  const { h } = await setup();
  try {
    const wrongType = await h.app.inject({
      method: 'POST',
      url: '/vaults/alpha/upload/assets/x.png',
      headers: { 'content-type': 'text/plain', origin: 'http://localhost', ...h.session(1) },
      payload: 'x',
    });
    assert.equal(wrongType.statusCode, 415, wrongType.body);

    const traversal = await upload(h, 'alpha', 'assets/../../etc/passwd.png', pngBytes(), 1);
    assert.equal(traversal.statusCode, 404);
  } finally {
    await h.close();
  }
});

test('limits 引擎键生效：管理员加 .svg 进清单（app_settings 热改）后 svg 上传通过', async () => {
  const { h } = await setup();
  try {
    setAppSetting(h.db, {
      key: 'validation.limits.attachmentAllowedExtensions',
      value: [...defaultConfig().attachmentAllowedExtensions, '.svg'],
    });
    const res = await upload(h, 'alpha', 'assets/icon.svg', '<svg/>', 1);
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as { ok: boolean };
    assert.equal(body.ok, true);
  } finally {
    await h.close();
  }
});
