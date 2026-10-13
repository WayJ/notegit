import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  browseHarness,
  seededVault,
  addMember,
  gitOut,
  repoPathOf,
  type BrowseHarness,
} from './web-browse-fixtures.ts';
import { addEmployee } from './web-browse-fixtures.ts';

// S4-T5 重命名路由（breakdown §2.3 S4-T5 行；validation §2.5；架构 §5.2）：
//
// 重命名按**目标路径**重新判定知识文档规则——改 .md 须有合法 frontmatter
// （E-FM 码映射回表单），改名 README.md 即豁免（反向同理：README 改名普通
// .md 即不再豁免）。变更 = upsert(新路径) + delete(旧路径) 单提交，走
// S3-T7 publishWebSubmit 唯一发布入口；拒绝不移动默认分支。
//
// 被测形态：真实 SQLite + 真实 bare 仓库（web-browse-fixtures 夹具）+ 会话
// Cookie（与 upload 路由测试同源）；ref/树前后比对用直通 git（不经生产读面）。

const DOC = '---\ntitle: 移动前\n---\n正文\n';

interface Fix {
  h: BrowseHarness;
  repoPath: string;
  seedMain: string;
  close(): Promise<void>;
}

let f: Fix;

before(async () => {
  const h = await browseHarness();
  const alice = addEmployee(h.db, { username: 'alice' });
  const carol = addEmployee(h.db, { username: 'carol' });
  const vaultId = await seededVault(h, 'alpha', alice, {
    'README.md': '# nav\n',
    'docs/first.md': DOC,
    'notes/raw.txt': '任意文本（非 .md，不套 frontmatter）',
  });
  addMember(h.db, vaultId, alice, 'editor', alice);
  addMember(h.db, vaultId, carol, 'reader', alice);
  const repoPath = repoPathOf(h, vaultId);
  const seedMain = (await gitOut(['--git-dir', repoPath, 'rev-parse', 'refs/heads/main'])).trim();
  f = {
    h,
    repoPath,
    seedMain,
    close: async () => {
      await h.close();
    },
  };
});

after(async () => {
  await f.close();
});

beforeEach(async () => {
  // 每用例重置默认分支到种子（写测试互不依赖）
  await gitOut(['--git-dir', f.repoPath, 'update-ref', 'refs/heads/main', f.seedMain]);
});

function rename(slug: string, from: string, to: string, who?: number) {
  return f.h.app.inject({
    method: 'POST',
    url: `/vaults/${slug}/rename/${from.split('/').map(encodeURIComponent).join('/')}`,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'http://localhost',
      ...(who === undefined ? {} : f.h.session(who)),
    },
    payload: `to=${encodeURIComponent(to)}`,
  });
}

async function mainHead(): Promise<string> {
  return (await gitOut(['--git-dir', f.repoPath, 'rev-parse', 'refs/heads/main'])).trim();
}

async function treePaths(): Promise<string[]> {
  const out = await gitOut(['--git-dir', f.repoPath, 'ls-tree', '-r', '--name-only', 'refs/heads/main']);
  return out.split('\n').filter((x) => x !== '');
}

test('完成标准（改名 .md 通过）：同 frontmatter .md → .md 单提交改名，旧路径消失、内容逐字保留、默认分支恰进一笔', async () => {
  const res = await rename('alpha', 'docs/first.md', 'docs/second.md', 1);
  assert.equal(res.statusCode, 302, res.body);
  assert.equal(res.headers['location'], `/vaults/alpha/view/${encodeURIComponent('docs')}/${encodeURIComponent('second.md')}`);
  assert.deepEqual(await treePaths(), ['README.md', 'docs/second.md', 'notes/raw.txt']);
  // 内容逐字保留（目标路径重判定：frontmatter 合法 → 通过）
  const body = await gitOut(['--git-dir', f.repoPath, 'show', 'refs/heads/main:docs/second.md']);
  assert.equal(body, DOC);
  // 恰一笔提交（upsert+delete 单变更集），parent == 种子
  assert.notEqual(await mainHead(), f.seedMain, '默认分支前进');
  const parent = (await gitOut(['--git-dir', f.repoPath, 'rev-parse', 'refs/heads/main^'])).trim();
  assert.equal(parent, f.seedMain, '恰一笔提交');
  const subject = (await gitOut(['--git-dir', f.repoPath, 'log', '-1', '--format=%s', 'refs/heads/main'])).trim();
  assert.match(subject, /Web 重命名/, '提交消息标注 Web 重命名');
});

test('完成标准（改 .md 无 frontmatter 被拒）：txt → .md → 422 表单回显 E-FM-001，默认分支不动', async () => {
  const res = await rename('alpha', 'notes/raw.txt', 'notes/raw.md', 1);
  assert.equal(res.statusCode, 422, res.body);
  assert.match(res.body, /E-FM-001/, 'E-FM 码映射回表单（validation §2.5 目标路径重判定）');
  assert.match(res.body, /notes\/raw\.md/, '回显用户提交的目标值');
  assert.deepEqual(await treePaths(), ['README.md', 'docs/first.md', 'notes/raw.txt'], '拒绝：树不变');
  assert.equal(await mainHead(), f.seedMain, '拒绝：默认分支不动');
});

test('完成标准（改名 README 豁免）：无 frontmatter 内容改名为子目录 README.md → 通过', async () => {
  const res = await rename('alpha', 'notes/raw.txt', 'docs/README.md', 1);
  assert.equal(res.statusCode, 302, res.body);
  assert.deepEqual(await treePaths(), ['README.md', 'docs/README.md', 'docs/first.md']);
  const body = (await gitOut(['--git-dir', f.repoPath, 'show', 'refs/heads/main:docs/README.md'])).toString();
  assert.equal(body, '任意文本（非 .md，不套 frontmatter）');
});

test('反向重判定：README.md 改名普通 .md 不再豁免（内容无 frontmatter → E-FM-001 被拒）', async () => {
  const res = await rename('alpha', 'README.md', 'intro.md', 1);
  assert.equal(res.statusCode, 422, res.body);
  assert.match(res.body, /E-FM-001/);
  assert.deepEqual(await treePaths(), ['README.md', 'docs/first.md', 'notes/raw.txt']);
  assert.equal(await mainHead(), f.seedMain);
});

test('目标路径已存在：拒绝不覆盖（409 表单回显），树与分支不动', async () => {
  const res = await rename('alpha', 'docs/first.md', 'README.md', 1);
  assert.equal(res.statusCode, 409, res.body);
  assert.match(res.body, /已存在/, '回显「目标已存在」提示');
  assert.deepEqual(await treePaths(), ['README.md', 'docs/first.md', 'notes/raw.txt']);
  assert.equal(await mainHead(), f.seedMain);
});

test('只读成员：页面可达（read 成员），提交被发布组件拒绝 403，树与分支不动', async () => {
  const page = await f.h.app.inject({
    method: 'GET',
    url: '/vaults/alpha/rename/docs/first.md',
    headers: f.h.session(2),
  });
  assert.equal(page.statusCode, 200, page.body);
  const res = await rename('alpha', 'docs/first.md', 'docs/second.md', 2);
  assert.equal(res.statusCode, 403, res.body);
  assert.deepEqual(await treePaths(), ['README.md', 'docs/first.md', 'notes/raw.txt']);
  assert.equal(await mainHead(), f.seedMain);
});

test('无成员关系 404 同页；未认证 302 /login', async () => {
  const outsider = addEmployee(f.h.db, { username: 'dave' });
  const noMember = await rename('alpha', 'docs/first.md', 'docs/second.md', outsider);
  assert.equal(noMember.statusCode, 404);
  const unauth = await rename('alpha', 'docs/first.md', 'docs/second.md');
  assert.equal(unauth.statusCode, 302);
  assert.equal(unauth.headers['location'], '/login');
});

test('源路径不存在 404；目录路径 302 → browse；畸形目标路径 404', async () => {
  const missing = await rename('alpha', 'docs/none.md', 'docs/x.md', 1);
  assert.equal(missing.statusCode, 404);
  const dir = await rename('alpha', 'docs', 'docs2', 1);
  assert.equal(dir.statusCode, 302);
  assert.equal(dir.headers['location'], '/vaults/alpha/browse/docs');
  const bad = await rename('alpha', 'docs/first.md', 'docs/../escape.md', 1);
  assert.equal(bad.statusCode, 404);
});

test('二进制改名逐字节保留：png 改名后 blob OID 等价（sha1("blob <len>\\0"+bytes)）', async () => {
  const bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 0x61)]);
  const up = await f.h.app.inject({
    method: 'POST',
    url: '/vaults/alpha/upload/assets/logo.png',
    headers: { 'content-type': 'application/octet-stream', origin: 'http://localhost', ...f.h.session(1) },
    payload: bytes,
  });
  assert.equal(up.statusCode, 200, up.body);
  const res = await rename('alpha', 'assets/logo.png', 'assets/brand.png', 1);
  assert.equal(res.statusCode, 302, res.body);
  const oid = (await gitOut(['--git-dir', f.repoPath, 'rev-parse', 'refs/heads/main:assets/brand.png'])).trim();
  const want = createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex');
  assert.equal(oid, want, 'blob 字节逐字保留');
  const oldEntry = await gitOut(['--git-dir', f.repoPath, 'ls-tree', 'refs/heads/main', 'assets/']).catch(() => '');
  assert.ok(!oldEntry.includes('logo.png'), '旧路径消失');
});

test('unicode 目标路径可往返（逐段编码）', async () => {
  const res = await rename('alpha', 'docs/first.md', 'docs/中文 改名.md', 1);
  assert.equal(res.statusCode, 302, res.body);
  const oid = (await gitOut(['--git-dir', f.repoPath, 'rev-parse', `refs/heads/main:${'docs/中文 改名.md'}`])).trim();
  assert.match(oid, /^[0-9a-f]{40}$/);
});

test('同路径改名（无操作）：400 表单回显，分支不动', async () => {
  const res = await rename('alpha', 'docs/first.md', 'docs/first.md', 1);
  assert.equal(res.statusCode, 400, res.body);
  assert.match(res.body, /未变化/);
  assert.equal(await mainHead(), f.seedMain);
});

test('重命名表单页（GET）：预填当前路径、POST action 同路径、无写操作', async () => {
  const page = await f.h.app.inject({
    method: 'GET',
    url: '/vaults/alpha/rename/docs/first.md',
    headers: f.h.session(1),
  });
  assert.equal(page.statusCode, 200, page.body);
  assert.match(page.headers['content-type'] as string, /text\/html/);
  assert.match(page.body, /docs\/first\.md/, '预填当前路径');
  assert.match(page.body, /action="\/vaults\/alpha\/rename\/docs\/first\.md"/, 'POST 到同路径');
});

test('会话 POST 受 CSRF 同源校验（缺 Origin → 403 E-AUTH-006）', async () => {
  const res = await f.h.app.inject({
    method: 'POST',
    url: '/vaults/alpha/rename/docs/first.md',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...f.h.session(1) },
    payload: `to=${encodeURIComponent('docs/second.md')}`,
  });
  assert.equal(res.statusCode, 403);
  assert.equal((res.json() as { error: { code: string } }).error.code, 'E-AUTH-006');
});
