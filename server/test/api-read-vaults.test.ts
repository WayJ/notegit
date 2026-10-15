import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db/connection.ts';
import { migrate } from '../src/db/migrate.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { createSession, DEFAULT_SESSION_TIMEOUTS } from '../src/auth/sessions.ts';
import { FIXTURE_DDL, addEmployee, addVault, addMember } from './credentials-fixtures.ts';

// S18-T1 机器面读协议（api.md §3 建议稿 docs/s18/api-amendments.md「## T1」）：
// GET /api/v1/vaults（清单 +doc_count——与工作台 vaultCards 同源同过滤）与
// GET /api/v1/vaults/{slug}/index-status（search_index_state 逐库行——变更感知面）。
// 安全不变量（E6 cross-cutting / D-IC-06 API 面）：匿名 401 JSON 信封（非页面 302）；
// 无权库清单零出现；index-status 门槛=read 成员；无权与不存在 404 同体零区分；
// 撤权下一请求即消失（实时 JOIN vault_members，无缓存）。

interface Harness {
  app: FastifyInstance;
  db: DatabaseSync;
  pepper: { active: { version: number; key: Buffer }; retired: never[] };
  close(): Promise<void>;
}

let h: Harness;
let aliceId: number;
let bobId: number;
let carolId: number;
let rootId: number;
let vAlpha: number;
let vBeta: number;
let vEmpty: number;
let vNotes: number;

/** search_index_state 行装配（仅测需要的语义位；其余列给合法定值） */
function addIndexState(
  db: DatabaseSync,
  vaultId: number,
  row: {
    head_commit: string | null;
    indexed_at: string;
    lag_ms: number | null;
    consecutive_failures: number;
    last_error: string | null;
    last_error_at?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO search_index_state
       (vault_id, branch, head_commit, triggered_by, triggered_at, indexed_at,
        duration_ms, lag_ms, updates, consecutive_failures, last_error, last_error_at)
     VALUES (?, 'main', ?, 'vault.web_submit', ?, ?, 42, ?, 7, ?, ?, ?)`,
  ).run(
    vaultId,
    row.head_commit,
    row.indexed_at,
    row.indexed_at,
    row.lag_ms,
    row.consecutive_failures,
    row.last_error,
    row.last_error_at ?? null,
  );
}

function addSearchIndexRow(db: DatabaseSync, vaultId: number, p: string): void {
  db.prepare(
    `INSERT INTO search_index (vault_id, path, commit_oid, title, tags, summary, indexed_at)
     VALUES (?, ?, 'seedoid', NULL, '[]', '', ?)`,
  ).run(vaultId, p, new Date().toISOString());
}

async function startHarness(): Promise<Harness> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'notegit-s18-t1-'));
  const dbFile = path.join(dataDir, 'db', 'notegit.sqlite');
  await mkdir(path.dirname(dbFile), { recursive: true });
  const db = openDatabase(dbFile);
  migrate(db, MIGRATIONS);
  for (const ddl of FIXTURE_DDL) db.exec(ddl);

  aliceId = addEmployee(db, { username: 'alice' });
  bobId = addEmployee(db, { username: 'bob' });
  carolId = addEmployee(db, { username: 'carol' });
  rootId = addEmployee(db, { username: 'root', is_instance_admin: 1 });

  vAlpha = addVault(db, 'alpha', aliceId);
  vBeta = addVault(db, 'beta', bobId);
  vEmpty = addVault(db, 'empty', bobId);
  vNotes = addVault(db, 'product-notes', carolId);
  db.prepare(`UPDATE vaults SET name = 'Alpha 库' WHERE id = ?`).run(vAlpha);
  db.prepare(`UPDATE vaults SET name = 'Beta 库' WHERE id = ?`).run(vBeta);
  db.prepare(`UPDATE vaults SET name = 'Empty 库' WHERE id = ?`).run(vEmpty);
  db.prepare(`UPDATE vaults SET name = '产品笔记' WHERE id = ?`).run(vNotes);

  // 成员关系：alice=alpha(reader)；bob=beta(admin)+empty(reader)；carol=product-notes(admin)。
  // bob 与 product-notes 无成员关系——清单零出现、index-status 404（与不存在同体）。
  addMember(db, vAlpha, aliceId, 'reader', aliceId);
  addMember(db, vBeta, bobId, 'admin', bobId);
  addMember(db, vEmpty, bobId, 'reader', bobId);
  addMember(db, vNotes, carolId, 'admin', carolId);

  // search_index 行数（doc_count 口径——与工作台 vaultCards 同源）：alpha=2、beta=1、
  // empty=0、product-notes=3（无权库行是泄露诱饵，永不出现在 bob 视角）。
  addSearchIndexRow(db, vAlpha, 'guide.md');
  addSearchIndexRow(db, vAlpha, 'intro.md');
  addSearchIndexRow(db, vBeta, 'runbook.md');
  addSearchIndexRow(db, vNotes, 'trap-1.md');
  addSearchIndexRow(db, vNotes, 'trap-2.md');
  addSearchIndexRow(db, vNotes, 'trap-3.md');

  // 索引状态三态：alpha=健康；beta=失败；product-notes=健康（诱饵）；empty=无行。
  addIndexState(db, vAlpha, {
    head_commit: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    indexed_at: '2026-10-16T01:00:00.000Z',
    lag_ms: 120,
    consecutive_failures: 0,
    last_error: null,
  });
  addIndexState(db, vBeta, {
    head_commit: 'f00dfacef00dfacef00dfacef00dfacef00dface',
    indexed_at: '2026-10-16T02:00:00.000Z',
    lag_ms: null,
    consecutive_failures: 3,
    last_error: 'derive failed: E-RUN-001（索引器模拟失败）',
    last_error_at: '2026-10-16T02:00:00.000Z',
  });
  addIndexState(db, vNotes, {
    head_commit: 'feedbeeffeedbeeffeedbeeffeedbeeffeedbeef',
    indexed_at: '2026-10-16T03:00:00.000Z',
    lag_ms: 90,
    consecutive_failures: 0,
    last_error: null,
  });

  const pepper = { active: { version: 1, key: randomBytes(32) }, retired: [] as never[] };
  const app = buildApp({
    db,
    pepper,
    bootstrapTokenFile: path.join(dataDir, 'config', 'admin-bootstrap.token'),
  });
  await app.ready();
  return {
    app,
    db,
    pepper,
    close: async () => {
      await app.close();
      db.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

before(async () => {
  h = await startHarness();
});
after(async () => {
  await h.close();
});

function session(employeeId: number): Record<string, string> {
  const sid = createSession(h.db, employeeId, h.pepper.active.key, new Date(), DEFAULT_SESSION_TIMEOUTS).sid;
  return { cookie: `ngt_sid=${sid}` };
}

async function get(
  url: string,
  headers?: Record<string, string>,
): Promise<{ status: number; body: string; json: () => any }> {
  const res = await h.app.inject({ method: 'GET', url, headers });
  return { status: res.statusCode, body: res.body, json: () => res.json() };
}

test('匿名 401：清单与 index-status 均为 API JSON 信封（非页面 302 形态）', async () => {
  for (const url of ['/api/v1/vaults', '/api/v1/vaults/alpha/index-status']) {
    const res = await get(url);
    assert.equal(res.status, 401, url);
    const payload = res.json();
    assert.equal(payload.error.code, 'E-AUTH-001');
    assert.equal(typeof payload.error.message, 'string');
  }
});

test('清单字段形状快照：{slug,name,role,default_branch,main_admin_only,doc_count}，包裹层与既有字段零回归（CLI/web 消费面）', async () => {
  const res = await get('/api/v1/vaults', session(aliceId));
  assert.equal(res.status, 200);
  assert.deepEqual(res.json(), {
    vaults: [
      {
        slug: 'alpha',
        name: 'Alpha 库',
        role: 'reader',
        default_branch: 'main',
        main_admin_only: false,
        doc_count: 2,
      },
    ],
  });
});

test('清单鉴权：bob 无 product-notes（无权库零出现）；doc_count 与工作台同源（beta=1、empty=0）', async () => {
  const res = await get('/api/v1/vaults', session(bobId));
  assert.equal(res.status, 200);
  assert.deepEqual(
    res.json().vaults.map((v: { slug: string; doc_count: number }) => [v.slug, v.doc_count]),
    [
      ['beta', 1],
      ['empty', 0],
    ],
  );
  assert.ok(!res.body.includes('product-notes'), '无权库全响应零出现（含名称）');
});

test('撤权下一请求即消失（清单与 index-status 同一实时判定面；重新授权恢复可见）', async () => {
  const before1 = await get('/api/v1/vaults/beta/index-status', session(bobId));
  assert.equal(before1.status, 200);
  h.db.prepare('DELETE FROM vault_members WHERE vault_id = ? AND employee_id = ?').run(vBeta, bobId);
  const listedAfter = await get('/api/v1/vaults', session(bobId));
  assert.deepEqual(
    listedAfter.json().vaults.map((v: { slug: string }) => v.slug),
    ['empty'],
    '清单撤权下一请求即消失',
  );
  const statusAfter = await get('/api/v1/vaults/beta/index-status', session(bobId));
  assert.equal(statusAfter.status, 404, 'index-status 撤权下一请求即 404');
  addMember(h.db, vBeta, bobId, 'admin', bobId); // 还原（后续用例仍需 bob=beta）
  const restored = await get('/api/v1/vaults/beta/index-status', session(bobId));
  assert.equal(restored.status, 200, '重新授权恢复可见（数据未删）');
});

test('index-status 三态：健康 / 失败 / 无行（首次未索引如实全 null），字段形状逐态快照', async () => {
  const healthy = await get('/api/v1/vaults/alpha/index-status', session(aliceId));
  assert.equal(healthy.status, 200);
  assert.deepEqual(healthy.json(), {
    slug: 'alpha',
    head_commit: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    indexed_at: '2026-10-16T01:00:00.000Z',
    lag_ms: 120,
    consecutive_failures: 0,
    last_error: null,
  });

  const failing = await get('/api/v1/vaults/beta/index-status', session(bobId));
  assert.equal(failing.status, 200);
  assert.deepEqual(failing.json(), {
    slug: 'beta',
    head_commit: 'f00dfacef00dfacef00dfacef00dfacef00dface',
    indexed_at: '2026-10-16T02:00:00.000Z',
    lag_ms: null,
    consecutive_failures: 3,
    last_error: 'derive failed: E-RUN-001（索引器模拟失败）',
  });

  const noRow = await get('/api/v1/vaults/empty/index-status', session(bobId));
  assert.equal(noRow.status, 200);
  assert.deepEqual(noRow.json(), {
    slug: 'empty',
    head_commit: null,
    indexed_at: null,
    lag_ms: null,
    consecutive_failures: null,
    last_error: null,
  });
});

test('404 同形态零区分：无权库（product-notes）、不存在库、实例管理员非成员——同一信封同体（D-IC-06 API 面）', async () => {
  const forbidden = await get('/api/v1/vaults/product-notes/index-status', session(bobId));
  const missing = await get('/api/v1/vaults/no-such-vault/index-status', session(bobId));
  const adminNonMember = await get('/api/v1/vaults/alpha/index-status', session(rootId));
  for (const res of [forbidden, missing, adminNonMember]) {
    assert.equal(res.status, 404);
  }
  assert.deepEqual(forbidden.json(), missing.json(), '无权与不存在响应体零区分');
  assert.deepEqual(forbidden.json(), adminNonMember.json(), '实例管理员非成员同体（非成员即 404）');
  assert.equal(forbidden.json().error.code, 'E-RES-001');
});
