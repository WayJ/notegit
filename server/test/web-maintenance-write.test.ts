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

// S4-T5 维护闸门 web 缝（T4 遗留移交；backup-recovery §3 矩阵 web 行）：
//
// WebRoutesOptions 注入 maintenance gate——全部 web 写操作（upload / rename /
// delete，未来 T7 edit submit POST 自动覆盖）维护模式 503；程序化端点
// （octet-stream 上传）JSON 结构化错误（E-MAINT-001 + maintenance 标志）、
// 页面流程同页提示（503 HTML「维护中」）。读路径与登录放行（矩阵第 7 行）。
// 开关走真实生命周期端点（实例管理员会话 + Origin——与 S2-T7 同缝）。

const DOC = '---\ntitle: 维护样例\n---\n正文\n';

interface Fix {
  h: BrowseHarness;
  repoPath: string;
  seedMain: string;
  maintAdminId: number;
  close(): Promise<void>;
}

let f: Fix;

before(async () => {
  const h = await browseHarness();
  const alice = addEmployee(h.db, { username: 'alice' });
  const maint = addEmployee(h.db, { username: 'maint', is_instance_admin: 1 });
  const vaultId = await seededVault(h, 'alpha', alice, {
    'README.md': '# nav\n',
    'docs/first.md': DOC,
    'notes/raw.txt': '任意文本',
  });
  addMember(h.db, vaultId, alice, 'editor', alice);
  const repoPath = repoPathOf(h, vaultId);
  const seedMain = (await gitOut(['--git-dir', repoPath, 'rev-parse', 'refs/heads/main'])).trim();
  f = {
    h,
    repoPath,
    seedMain,
    maintAdminId: maint,
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

function toggle(method: 'POST' | 'DELETE') {
  return f.h.app.inject({
    method,
    url: '/api/v1/admin/maintenance',
    headers: { origin: 'http://localhost', ...f.h.session(f.maintAdminId) },
    payload: method === 'POST' ? {} : undefined,
  });
}

async function mainHead(): Promise<string> {
  return (await gitOut(['--git-dir', f.repoPath, 'rev-parse', 'refs/heads/main'])).trim();
}

test('维护中：upload 503 JSON（E-MAINT-001 + maintenance 标志）、rename/delete 503 同页提示；默认分支不动', async () => {
  assert.equal((await toggle('POST')).statusCode, 204, '开启维护（实例管理员会话）');
  try {
    const up = await f.h.app.inject({
      method: 'POST',
      url: '/vaults/alpha/upload/assets/x.png',
      headers: { 'content-type': 'application/octet-stream', origin: 'http://localhost', ...f.h.session(1) },
      payload: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    });
    assert.equal(up.statusCode, 503, up.body);
    const upBody = up.json() as { ok: boolean; stage: string; error: { code: string; details?: { maintenance?: boolean } } };
    assert.equal(upBody.ok, false);
    assert.equal(upBody.error.code, 'E-MAINT-001');
    assert.equal(upBody.error.details?.maintenance, true, 'backup §3：结构化错误含 maintenance 标志');

    const ren = await f.h.app.inject({
      method: 'POST',
      url: '/vaults/alpha/rename/docs/first.md',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://localhost', ...f.h.session(1) },
      payload: `to=${encodeURIComponent('docs/second.md')}`,
    });
    assert.equal(ren.statusCode, 503, ren.body);
    assert.match(ren.headers['content-type'] as string, /text\/html/, '页面流程同页提示');
    assert.match(ren.body, /维护中/);

    const del = await f.h.app.inject({
      method: 'POST',
      url: '/vaults/alpha/delete/docs/first.md',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://localhost', ...f.h.session(1) },
      payload: '',
    });
    assert.equal(del.statusCode, 503, del.body);
    assert.match(del.body, /维护中/);

    assert.equal(await mainHead(), f.seedMain, '维护中写操作不产生提交');
  } finally {
    assert.equal((await toggle('DELETE')).statusCode, 204, '关闭维护（运行态写入放行）');
  }
});

test('维护中读路径放行（矩阵第 7 行）：browse/view 200；关闭后写恢复', async () => {
  assert.equal((await toggle('POST')).statusCode, 204);
  try {
    const browse = await f.h.app.inject({ method: 'GET', url: '/vaults/alpha/browse', headers: f.h.session(1) });
    assert.equal(browse.statusCode, 200, '维护中读放行');
    assert.match(browse.body, /docs/, '目录内容如实可见');
    const view = await f.h.app.inject({
      method: 'GET',
      url: `/vaults/alpha/view/${encodeURIComponent('docs')}/${encodeURIComponent('first.md')}`,
      headers: f.h.session(1),
    });
    assert.equal(view.statusCode, 200, '预览读放行');
  } finally {
    assert.equal((await toggle('DELETE')).statusCode, 204);
  }
  // 关闭后同笔写操作恢复可用（写缝只在维护期拦截）
  const ren = await f.h.app.inject({
    method: 'POST',
    url: '/vaults/alpha/rename/docs/first.md',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://localhost', ...f.h.session(1) },
    payload: `to=${encodeURIComponent('docs/second.md')}`,
  });
  assert.equal(ren.statusCode, 302, ren.body);
  assert.notEqual(await mainHead(), f.seedMain);
});
