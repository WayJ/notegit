import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db/connection.ts';
import { migrate } from '../src/db/migrate.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { loadOrCreatePepper } from '../src/bootstrap/pepper.ts';
import { ensureBootstrapToken } from '../src/bootstrap/token.ts';
import { FIXTURE_DDL, dumpAllText } from './credentials-fixtures.ts';
import { buildApp } from '../src/app.ts';

// S2-T8 关键流程 e2e（breakdown §2.1 S2-T8 完成标准「管理员全流程可用：
// 邀请→员工登录→建库→授权」+ 员工凭据创建与「明文仅一次」）：
// 从空库 bootstrap 起，全程真实载体（argon2 真哈希、真实会话/凭据），走页面
// 所调的同一组 api.md 端点（Cookie 写请求带同源 Origin——页面 fetch 行为）。

interface Harness {
  app: ReturnType<typeof buildApp>;
  db: DatabaseSync;
  bootstrapTokenFile: string;
  close(): Promise<void>;
}

async function freshInstance(): Promise<Harness> {
  const dir = await mkdtemp(path.join(tmpdir(), 'notegit-e2e-'));
  await mkdir(path.join(dir, 'db'), { recursive: true });
  const db = openDatabase(path.join(dir, 'db', 't.sqlite'));
  migrate(db, MIGRATIONS);
  for (const ddl of FIXTURE_DDL) db.exec(ddl); // 合并后 no-op
  const pepper = await loadOrCreatePepper(path.join(dir, 'keys', 'token-pepper.key'));
  const bootstrapTokenFile = path.join(dir, 'config', 'admin-bootstrap.token');
  await ensureBootstrapToken(db, pepper, bootstrapTokenFile, new Date());
  const app = buildApp({ db, pepper, bootstrapTokenFile }); // 真实哈希/载体（无注入桩）
  await app.ready();
  return {
    app,
    db,
    bootstrapTokenFile,
    close: async () => {
      await app.close();
      db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function sidOf(res: { headers: Record<string, unknown> }): string {
  const sc = res.headers['set-cookie'];
  const raw = Array.isArray(sc) ? sc.join(';') : (sc as string | undefined);
  const sid = raw?.match(/ngt_sid=([^;]+)/)?.[1];
  assert.ok(sid, '应发放会话 Cookie');
  return sid!;
}

/** 页面 fetch 的请求形态：同源 Cookie + Origin（浏览器对非安全方法自动带） */
function pageHeaders(sid: string): Record<string, string> {
  return { cookie: `ngt_sid=${sid}`, origin: 'http://localhost' };
}

test('e2e：邀请→员工登录→建库→授权→凭据创建（管理员全流程可用 + 明文仅一次）', async () => {
  const h = await freshInstance();
  try {
    // ── 0. bootstrap 初始管理员（identity §7.1；真实 argon2） ──
    const token = await readFile(h.bootstrapTokenFile, 'utf8');
    const boot = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/bootstrap',
      payload: { bootstrap_token: token, username: 'root', display_name: 'Root Admin', password: 'root-password-123456' },
    });
    assert.equal(boot.statusCode, 201, boot.body);

    // ── 1. 管理员登录（登录页 fetch 的同一调用） ──
    const loginRoot = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'root', password: 'root-password-123456' },
    });
    assert.equal(loginRoot.statusCode, 200, loginRoot.body);
    const rootSid = sidOf(loginRoot);

    // 页面：管理员看得到管理入口
    const rootIndex = await h.app.inject({ method: 'GET', url: '/', headers: { cookie: `ngt_sid=${rootSid}` } });
    assert.ok(rootIndex.body.includes('/admin'), '实例管理员应看到管理入口');

    // ── 2. 邀请员工（管理页「邀请创建」fetch 的同一调用） ──
    const invite = await h.app.inject({
      method: 'POST',
      url: '/api/v1/admin/employees',
      headers: pageHeaders(rootSid),
      payload: { username: 'alice', display_name: 'Alice Chen' },
    });
    assert.equal(invite.statusCode, 201, invite.body);
    const { password_reset_token } = invite.json() as { password_reset_token: string };
    assert.match(password_reset_token, /^[A-Za-z0-9_-]{43}$/);

    // ── 3. 员工设初始口令并登录（api.md §3.2 公开端点 → 登录页 fetch） ──
    const consume = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password-reset',
      payload: { reset_token: password_reset_token, new_password: 'alice-password-123456' },
    });
    assert.equal(consume.statusCode, 204, consume.body);
    const loginAlice = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'alice', password: 'alice-password-123456' },
    });
    assert.equal(loginAlice.statusCode, 200, loginAlice.body);
    const aliceSid = sidOf(loginAlice);

    // 页面：普通员工看不到管理入口（验收断言）
    const aliceIndex = await h.app.inject({ method: 'GET', url: '/', headers: { cookie: `ngt_sid=${aliceSid}` } });
    assert.ok(!aliceIndex.body.includes('/admin'), '普通成员不得看到管理入口');
    assert.ok(aliceIndex.body.includes('/credentials'));

    // ── 4. 员工建库（管理页/任意员工「建库」fetch 的同一调用；创建者自动库管理员） ──
    const createVault = await h.app.inject({
      method: 'POST',
      url: '/api/v1/vaults',
      headers: pageHeaders(aliceSid),
      payload: { name: '团队知识库', slug: 'team-kb' },
    });
    assert.equal(createVault.statusCode, 201, createVault.body);
    assert.equal((createVault.json() as { role: string }).role, 'admin');

    // ── 5. 授权（管理页「成员与角色」fetch 的同一调用：alice 给 root 授 editor） ──
    const grant = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/vaults/team-kb/members/root',
      headers: pageHeaders(aliceSid),
      payload: { role: 'editor' },
    });
    assert.equal(grant.statusCode, 200, grant.body);
    // root 现在能在自己的库列表里看到 team-kb（授权生效，实时查库）
    const rootVaults = await h.app.inject({ method: 'GET', url: '/api/v1/vaults', headers: { cookie: `ngt_sid=${rootSid}` } });
    assert.ok(
      ((rootVaults.json() as { vaults: { slug: string }[] }).vaults).some((v) => v.slug === 'team-kb'),
      '授权后下一请求即生效（无权限缓存）',
    );

    // ── 6. 员工创建凭据（凭据页「创建」fetch 的同一调用）——明文仅一次 ──
    const createCred = await h.app.inject({
      method: 'POST',
      url: '/api/v1/credentials',
      headers: pageHeaders(aliceSid),
      payload: {
        name: '本地 Harness',
        expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        scope: { access: 'read_write', vaults: ['team-kb'] },
      },
    });
    assert.equal(createCred.statusCode, 201, createCred.body);
    const cred = createCred.json() as { token: string; display_hint: string; id: number };
    assert.match(cred.token, /^ngt_[A-Za-z0-9_-]{43}$/);
    assert.equal(cred.display_hint, `${cred.token.slice(0, 6)}…${cred.token.slice(-4)}`);

    // 明文仅一次（identity §3.1）：列表只回 display_hint
    const list = await h.app.inject({ method: 'GET', url: '/api/v1/credentials', headers: { cookie: `ngt_sid=${aliceSid}` } });
    assert.ok(!list.body.includes(cred.token), '列表不得回显明文');
    assert.ok(list.body.includes(cred.display_hint), '列表以脱敏 hint 呈现');
    // 凭据页 HTML 不含明文（外壳 + 列表 fetch 均不含）
    const credPage = await h.app.inject({ method: 'GET', url: '/credentials', headers: { cookie: `ngt_sid=${aliceSid}` } });
    assert.ok(!credPage.body.includes(cred.token));
    // 全库转储不含明文（存储只有 hmacv1$ 哈希）
    assert.ok(!dumpAllText(h.db).includes(cred.token), '明文不得落入任何存储');

    // ── 7. 凭据可用且 scope 收窄生效：token 访问 team-kb 200；越范围库 404 ──
    const bearer = { authorization: `Bearer ${cred.token}` };
    const me = await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer });
    assert.equal(me.statusCode, 200);
    const inScope = await h.app.inject({ method: 'GET', url: '/api/v1/vaults/team-kb', headers: bearer });
    assert.equal(inScope.statusCode, 200);
    h.db.prepare(
      `INSERT INTO vaults (slug, name, created_by, created_at) VALUES ('other-kb', 'Other', ?, ?)`,
    ).run(1, new Date().toISOString());
    const outScope = await h.app.inject({ method: 'GET', url: '/api/v1/vaults/other-kb', headers: bearer });
    assert.equal(outScope.statusCode, 404, '越出 scope 清单与无权库同 404（D-IC-06）');

    // ── 8. 管理员代管视角：员工列表可见 alice；重置口令令牌可开新轮 ──
    const employees = await h.app.inject({ method: 'GET', url: '/api/v1/admin/employees', headers: { cookie: `ngt_sid=${rootSid}` } });
    assert.ok(((employees.json() as { employees: { username: string }[] }).employees).some((e) => e.username === 'alice'));
    const reset = await h.app.inject({
      method: 'POST',
      url: '/api/v1/admin/employees/alice/password-reset',
      headers: pageHeaders(rootSid),
    });
    assert.equal(reset.statusCode, 200);
    assert.match((reset.json() as { password_reset_token: string }).password_reset_token, /^[A-Za-z0-9_-]{43}$/);
  } finally {
    await h.close();
  }
});
