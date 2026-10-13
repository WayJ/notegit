import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browseHarness, seededVault, addEmployee, addMember, gitOut, repoPathOf, type BrowseHarness } from './web-browse-fixtures.ts';

// S4-T8 全站页面连通冒烟（breakdown §2.3 S4-T8 行 4：关键页 200/302/404 矩阵）。
// 回归网性质：一人多角色 × 关键路由的状态码断言（含 S4-T8 新增上传 UI 页）；
// 细粒度行为由各路由族自己的测试持有，此处只锁「页面活着且门槛正确」。

type Expect = 200 | 302 | 403 | 404;

interface PageSpec {
  readonly name: string;
  readonly url: string;
  /** 各角色期望：anon（未认证）/ member（editor 成员）/ outsider（非成员）/ admin（实例管理员成员） */
  readonly expect: { anon: Expect; member: Expect; outsider: Expect; admin: Expect };
  /** 302 时的落点（member 视角；anon 统一 /login 不另断言——login 页自身在矩阵内） */
  readonly location?: string;
}

const PAGES: readonly PageSpec[] = [
  { name: '登录页', url: '/login', expect: { anon: 200, member: 200, outsider: 200, admin: 200 } },
  { name: '入口页', url: '/', expect: { anon: 302, member: 200, outsider: 200, admin: 200 } },
  { name: '管理页（仅实例管理员）', url: '/admin', expect: { anon: 302, member: 403, outsider: 403, admin: 200 } },
  { name: '凭据页', url: '/credentials', expect: { anon: 302, member: 200, outsider: 200, admin: 200 } },
  { name: '库列表', url: '/vaults', expect: { anon: 302, member: 200, outsider: 200, admin: 200 } },
  { name: '库根 302→browse', url: '/vaults/alpha', expect: { anon: 302, member: 302, outsider: 404, admin: 302 }, location: '/vaults/alpha/browse' },
  { name: '目录浏览（库根）', url: '/vaults/alpha/browse', expect: { anon: 302, member: 200, outsider: 404, admin: 200 } },
  { name: '目录浏览（子目录）', url: '/vaults/alpha/browse/docs', expect: { anon: 302, member: 200, outsider: 404, admin: 200 } },
  { name: '目录浏览（缺失目录 404）', url: '/vaults/alpha/browse/ghost', expect: { anon: 302, member: 404, outsider: 404, admin: 404 } },
  { name: '预览 .md', url: '/vaults/alpha/view/docs/guide.md', expect: { anon: 302, member: 200, outsider: 404, admin: 200 } },
  { name: '预览图片（直开页）', url: '/vaults/alpha/view/docs/pic.png', expect: { anon: 302, member: 200, outsider: 404, admin: 200 } },
  { name: '预览目录 302→browse', url: '/vaults/alpha/view/docs', expect: { anon: 302, member: 302, outsider: 404, admin: 302 }, location: '/vaults/alpha/browse/docs' },
  { name: '预览缺失 404', url: '/vaults/alpha/view/docs/ghost.md', expect: { anon: 302, member: 404, outsider: 404, admin: 404 } },
  { name: '编辑页（既有）', url: '/vaults/alpha/edit/docs/guide.md', expect: { anon: 302, member: 200, outsider: 404, admin: 200 } },
  { name: '编辑页（新建形态）', url: '/vaults/alpha/edit/docs/new-note.md', expect: { anon: 302, member: 200, outsider: 404, admin: 200 } },
  { name: '编辑 README 豁免页', url: '/vaults/alpha/edit/README.md', expect: { anon: 302, member: 200, outsider: 404, admin: 200 } },
  { name: '编辑非 .md 404', url: '/vaults/alpha/edit/docs/pic.png', expect: { anon: 302, member: 404, outsider: 404, admin: 404 } },
  { name: '上传 UI 页（库根，S4-T8）', url: '/vaults/alpha/upload', expect: { anon: 302, member: 200, outsider: 404, admin: 200 } },
  { name: '上传 UI 页（子目录，S4-T8）', url: '/vaults/alpha/upload/docs', expect: { anon: 302, member: 200, outsider: 404, admin: 200 } },
  { name: '重命名表单页', url: '/vaults/alpha/rename/docs/guide.md', expect: { anon: 302, member: 200, outsider: 404, admin: 200 } },
  { name: '删除确认页', url: '/vaults/alpha/delete/docs/guide.md', expect: { anon: 302, member: 200, outsider: 404, admin: 200 } },
  { name: '未知库 404（browse）', url: '/vaults/ghost/browse', expect: { anon: 302, member: 404, outsider: 404, admin: 404 } },
];

test('全站连通冒烟矩阵：关键页 × 角色 → 200/302/404（数据驱动）', async () => {
  const h: BrowseHarness = await browseHarness();
  try {
    const alice = addEmployee(h.db, { username: 'alice' }); // editor 成员
    const carol = addEmployee(h.db, { username: 'carol' }); // 非成员
    const root = addEmployee(h.db, { username: 'root', is_instance_admin: 1 }); // 管理员（成员）
    const vaultId = await seededVault(h, 'alpha', alice, {
      'README.md': '# nav\n',
      'docs/guide.md': '---\ntitle: 指南\n---\n\n正文。\n',
      'docs/pic.png': 'png-stub\n',
    });
    addMember(h.db, vaultId, alice, 'editor', alice);
    addMember(h.db, vaultId, root, 'editor', alice);

    const roles = {
      anon: undefined as unknown as number,
      member: alice,
      outsider: carol,
      admin: root,
    };
    const failures: string[] = [];
    for (const page of PAGES) {
      for (const [role, employeeId] of Object.entries(roles)) {
        const res = await h.app.inject({
          method: 'GET',
          url: page.url,
          ...(employeeId === undefined ? {} : { headers: h.session(employeeId) }),
        });
        const want = page.expect[role as keyof PageSpec['expect']];
        const label = `${page.name} [${page.url}] as ${role}：${res.statusCode} ≠ ${want}`;
        if (res.statusCode !== want) failures.push(label);
        if (role === 'member' && page.location !== undefined && res.statusCode === 302) {
          assert.equal(res.headers['location'], page.location, `${page.name} 302 落点`);
        }
        if (role === 'anon' && res.statusCode === 302) {
          assert.equal(res.headers['location'], '/login', `${page.name} 未认证 302 应落 /login`);
        }
        if (want === 200) {
          assert.ok(res.body.startsWith('<!doctype html>'), `${page.name} 200 应为 HTML 页`);
        }
      }
    }
    assert.deepEqual(failures, [], `状态码矩阵全绿（${PAGES.length} 页 × 4 角色）`);
  } finally {
    await h.close();
  }
});

test('冒烟：附件端点真实 OID 200 / 伪造 OID 404（同一成员）', async () => {
  const h = await browseHarness();
  try {
    const alice = addEmployee(h.db, { username: 'alice' });
    const vaultId = await seededVault(h, 'alpha', alice, { 'docs/pic.png': 'png-stub\n' });
    addMember(h.db, vaultId, alice, 'editor', alice);
    const repoPath = repoPathOf(h, vaultId);
    const out = await gitOut(['--git-dir', repoPath, 'ls-tree', 'refs/heads/main', 'docs/pic.png']);
    const oid = out.split(/\s/)[2]!;

    const ok = await h.app.inject({ method: 'GET', url: `/vaults/alpha/attach/${oid}/pic.png`, headers: h.session(alice) });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(ok.headers['x-content-type-options'], 'nosniff');
    const fake = await h.app.inject({ method: 'GET', url: `/vaults/alpha/attach/${'0'.repeat(40)}/x.png`, headers: h.session(alice) });
    assert.equal(fake.statusCode, 404, '库外 OID=不存在（反存在性）');
  } finally {
    await h.close();
  }
});
