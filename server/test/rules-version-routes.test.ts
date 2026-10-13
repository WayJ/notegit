import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { CredentialsService } from '../src/credentials/service.ts';
import { createSession, DEFAULT_SESSION_TIMEOUTS } from '../src/auth/sessions.ts';
import { newDb } from './credentials-fixtures.ts';

// S6-T7 GET /api/v1/rules-version（api.md §3.3 补录）：三端规则版本一致性的服务端
// 链（validation §7.3：运行时权威=服务端；值取 docs/contracts/rules-version.json
// 唯一机器来源，服务端运行时经 notegit-validation 读取，不另行复制）。
// 一致性断言不经 notegit-validation 缓存：直接重读 manifest 文件比对端点响应，
// 锁定「服务端 == manifest」链；CLI 内嵌 == manifest 链在 cli/test 固化
// （rules-version-consistency.test.ts），CI 两链合成三端一致。

interface Harness {
  app: FastifyInstance;
  db: DatabaseSync;
  employeeId: number;
  token: string;
  sid: string;
  close: () => Promise<void>;
}

async function harness(): Promise<Harness> {
  const db = newDb();
  const pepper = { active: { version: 1, key: randomBytes(32) }, retired: [] as never[] };
  const dir = await mkdtemp(path.join(tmpdir(), 'notegit-rulesver-'));
  const bootstrapTokenFile = path.join(dir, 'admin-bootstrap.token');
  await writeFile(bootstrapTokenFile, 'fixture-unused'); // 本域测试不触发 bootstrap 端点
  const app = buildApp({ db, pepper, bootstrapTokenFile });
  const now = new Date();
  db.prepare(
    `INSERT INTO employees (username, display_name, password_hash, is_instance_admin, active, invited_by, created_at)
     VALUES ('alice', 'alice', 'fixture-not-argon2', 0, 1, NULL, ?)`,
  ).run(now.toISOString());
  const employeeId = (db.prepare(`SELECT id FROM employees WHERE username = 'alice'`).get() as { id: number }).id;
  const seed = new CredentialsService({ db, pepper });
  const token = seed
    .createCredential(employeeId, {
      name: 'seed',
      expires_at: new Date(now.getTime() + 30 * 86_400_000).toISOString(),
    })
    .token;
  const sid = createSession(db, employeeId, pepper.active.key, now, DEFAULT_SESSION_TIMEOUTS).sid;
  return {
    app,
    db,
    employeeId,
    token,
    sid,
    close: async () => {
      await app.close();
      db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** 直接重读唯一机器来源（不经包缓存）：端点响应与文件的比对才是真实一致性断言。 */
function manifestFile(): { rulesVersion: string; status: string } {
  return JSON.parse(
    readFileSync(new URL('../../docs/contracts/rules-version.json', import.meta.url), 'utf8'),
  ) as { rulesVersion: string; status: string };
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

test('GET /api/v1/rules-version（Bearer）→ 200 {rulesVersion, status}，与 rules-version.json 文件逐字一致', async () => {
  const h = await harness();
  try {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/rules-version', headers: bearer(h.token) });
    assert.equal(res.statusCode, 200);
    const m = manifestFile();
    // 形状锁定：恰两键（不泄露 manifest 其余内部字段）
    assert.deepEqual(res.json(), { rulesVersion: m.rulesVersion, status: m.status });
  } finally {
    await h.close();
  }
});

test('GET /api/v1/rules-version（ngt_sid 会话载体）→ 200 同值（api.md §1 Bearer/会话双载体）', async () => {
  const h = await harness();
  try {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/rules-version', headers: { cookie: `ngt_sid=${h.sid}` } });
    assert.equal(res.statusCode, 200);
    const m = manifestFile();
    assert.deepEqual(res.json(), { rulesVersion: m.rulesVersion, status: m.status });
  } finally {
    await h.close();
  }
});

test('未认证 → 401 E-AUTH-001（api.md §1 通用 401 映射；信封 + reason）', async () => {
  const h = await harness();
  try {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/rules-version' });
    assert.equal(res.statusCode, 401);
    const body = res.json() as { error: { code: string; details: { reason: string } } };
    assert.equal(body.error.code, 'E-AUTH-001');
    assert.equal(body.error.details.reason, 'unauthenticated');
  } finally {
    await h.close();
  }
});

test('坏 token → 401（无效凭据同 E-AUTH-001；不泄露端点内容）', async () => {
  const h = await harness();
  try {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/rules-version',
      headers: bearer('ngt_' + 'x'.repeat(43)),
    });
    assert.equal(res.statusCode, 401);
  } finally {
    await h.close();
  }
});
