import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  browseHarness,
  seededVault,
  addMember,
  gitOut,
  repoPathOf,
  addEmployee,
  type BrowseHarness,
} from './web-browse-fixtures.ts';

// S4-T5 删除路由（breakdown §2.3 S4-T5 行；validation §2.5；架构 §5.2/§6）：
//
// 删除**不做元数据校验**（validation §2.5 第 5 点：删除文件不套 frontmatter
// 规则）——单条 delete 变更走 S3-T7 publishWebSubmit 唯一发布入口；Git 历史
// 不动（旧提交与 blob 原样保留，S5 历史页可查旧版本）。

const DOC = '---\ntitle: 待删文档\n---\n正文\n';

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
    'notes/raw.txt': '任意文本（无 frontmatter——删除不做元数据校验的对照样本）',
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
  await gitOut(['--git-dir', f.repoPath, 'update-ref', 'refs/heads/main', f.seedMain]);
});

function del(slug: string, path: string, who?: number) {
  return f.h.app.inject({
    method: 'POST',
    url: `/vaults/${slug}/delete/${path.split('/').map(encodeURIComponent).join('/')}`,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'http://localhost',
      ...(who === undefined ? {} : f.h.session(who)),
    },
    payload: '',
  });
}

async function mainHead(): Promise<string> {
  return (await gitOut(['--git-dir', f.repoPath, 'rev-parse', 'refs/heads/main'])).trim();
}

async function treePaths(): Promise<string[]> {
  const out = await gitOut(['--git-dir', f.repoPath, 'ls-tree', '-r', '--name-only', 'refs/heads/main']);
  return out.split('\n').filter((x) => x !== '');
}

test('完成标准：删除后文件从目录消失、默认分支恰进一笔、Git 历史不动（旧提交可查旧版本）', async () => {
  const res = await del('alpha', 'docs/first.md', 1);
  assert.equal(res.statusCode, 302, res.body);
  assert.equal(res.headers['location'], '/vaults/alpha/browse/docs');
  assert.deepEqual(await treePaths(), ['README.md', 'notes/raw.txt'], '目录消失该文件');
  assert.notEqual(await mainHead(), f.seedMain, '默认分支前进');
  const parent = (await gitOut(['--git-dir', f.repoPath, 'rev-parse', 'refs/heads/main^'])).trim();
  assert.equal(parent, f.seedMain, '恰一笔提交');
  const subject = (await gitOut(['--git-dir', f.repoPath, 'log', '-1', '--format=%s', 'refs/heads/main'])).trim();
  assert.match(subject, /Web 删除/, '提交消息标注 Web 删除');
  // 历史保留：种子提交仍可达，旧版本逐字可查（S5 历史页的数据基础）
  const historical = await gitOut(['--git-dir', f.repoPath, 'show', `${f.seedMain}:docs/first.md`]);
  assert.equal(historical, DOC, '历史提交中旧版本原样保留');
  const newTreeHasIt = await gitOut(['--git-dir', f.repoPath, 'ls-tree', 'refs/heads/main', 'docs/']).catch(() => '');
  assert.ok(!newTreeHasIt.includes('first.md'), '新 tree 无该文件');
});

test('完成标准：删除不做元数据校验——无 frontmatter 的 README.md 与 raw.txt 均可删除', async () => {
  const readme = await del('alpha', 'README.md', 1);
  assert.equal(readme.statusCode, 302, readme.body);
  await gitOut(['--git-dir', f.repoPath, 'update-ref', 'refs/heads/main', f.seedMain]);
  const raw = await del('alpha', 'notes/raw.txt', 1);
  assert.equal(raw.statusCode, 302, raw.body);
  assert.ok(!(await treePaths()).includes('notes/raw.txt'));
});

test('删除不存在路径 404（反存在性同页），分支不动；目录路径 302 → browse', async () => {
  const missing = await del('alpha', 'docs/none.md', 1);
  assert.equal(missing.statusCode, 404);
  assert.equal(await mainHead(), f.seedMain);
  const dir = await del('alpha', 'docs', 1);
  assert.equal(dir.statusCode, 302);
  assert.equal(dir.headers['location'], '/vaults/alpha/browse/docs');
});

test('只读成员：确认页可达，提交被发布组件拒绝 403，树与分支不动', async () => {
  const page = await f.h.app.inject({
    method: 'GET',
    url: '/vaults/alpha/delete/docs/first.md',
    headers: f.h.session(2),
  });
  assert.equal(page.statusCode, 200, page.body);
  assert.match(page.body, /docs\/first\.md/);
  assert.match(page.body, /历史/, '确认页如实标注历史保留');
  const res = await del('alpha', 'docs/first.md', 2);
  assert.equal(res.statusCode, 403, res.body);
  assert.deepEqual(await treePaths(), ['README.md', 'docs/first.md', 'notes/raw.txt']);
  assert.equal(await mainHead(), f.seedMain);
});

test('无成员关系 404；未认证 302 /login；缺 Origin 403 E-AUTH-006', async () => {
  const outsider = addEmployee(f.h.db, { username: 'dave' });
  assert.equal((await del('alpha', 'docs/first.md', outsider)).statusCode, 404);
  const unauth = await del('alpha', 'docs/first.md');
  assert.equal(unauth.statusCode, 302);
  assert.equal(unauth.headers['location'], '/login');
  const noOrigin = await f.h.app.inject({
    method: 'POST',
    url: '/vaults/alpha/delete/docs/first.md',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...f.h.session(1) },
    payload: '',
  });
  assert.equal(noOrigin.statusCode, 403);
  assert.equal((noOrigin.json() as { error: { code: string } }).error.code, 'E-AUTH-006');
});

test('删除确认页（GET）：展示路径、历史保留提示、POST action 同路径', async () => {
  const page = await f.h.app.inject({
    method: 'GET',
    url: '/vaults/alpha/delete/docs/first.md',
    headers: f.h.session(1),
  });
  assert.equal(page.statusCode, 200, page.body);
  assert.match(page.headers['content-type'] as string, /text\/html/);
  assert.match(page.body, /action="\/vaults\/alpha\/delete\/docs\/first\.md"/, 'POST 到同路径');
  assert.match(page.body, /历史/, '标注 Git 历史保留（可还原的数据基础）');
});
