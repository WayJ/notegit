import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db/connection.ts';
import { migrate } from '../src/db/migrate.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { loadOrCreatePepper } from '../src/bootstrap/pepper.ts';
import { ensureBootstrapToken } from '../src/bootstrap/token.ts';
import { FIXTURE_DDL } from './credentials-fixtures.ts';  // vaults 父表：审计写入（S2-T7 挂接）在 T6 的 0005 前需要
import { buildApp } from '../src/app.ts';
import { verifyPassword } from '../src/auth/password.ts';

// S2-T2 四断言（breakdown §2.1）：初始化态仅初始化端点可用 / token 重放无效 /
// 用后文件被删 / 用户表非空时初始化端点永久不可用。错误码映射 api.md §2.3/§3。

interface Instance {
  app: ReturnType<typeof buildApp>;
  db: ReturnType<typeof openDatabase>;
  tokenFile: string;
  dir: string;
  readToken(): Promise<string>;
  restart(): Promise<Instance>;
  close(): Promise<void>;
}

async function makeInstance(dir?: string, opts?: { realHash?: boolean }): Promise<Instance> {
  const own = dir === undefined;
  const d = dir ?? (await mkdtemp(path.join(tmpdir(), 'notegit-boot-')));
  await mkdir(path.join(d, 'db'), { recursive: true });
  const db = openDatabase(path.join(d, 'db', 't.sqlite'));
  migrate(db, MIGRATIONS);
  for (const ddl of FIXTURE_DDL) db.exec(ddl);  // audit_events.vault_id 外键父表（合并后 no-op）
  const pepper = await loadOrCreatePepper(path.join(d, 'keys', 'token-pepper.key'));
  const tokenFile = path.join(d, 'config', 'admin-bootstrap.token');
  await ensureBootstrapToken(db, pepper, tokenFile, new Date());
  const app = buildApp({
    db,
    pepper,
    bootstrapTokenFile: tokenFile,
    // Argon2id 绑定经协调人 2026-10-12 批复由本任务落地（src/auth/password.ts，S2-T3 复用）；
    // 默认注入桩以省 ~20ms/次哈希，真实链路见文末用例（realHash）
    hashPassword: opts?.realHash ? undefined : stubHash,
    authenticateRequest: () => ({ ok: false, carrier: null, code: 'E-AUTH-001', reason: 'unauthenticated' }),
  });
  await app.ready();
  const inst: Instance = {
    app,
    db,
    tokenFile,
    dir: d,
    readToken: () => readFile(tokenFile, 'utf8'),
    restart: () => (async () => {
      await app.close();
      db.close();
      return makeInstance(d);
    })(),
    close: async () => {
      await app.close();
      db.close();
      if (own) await rm(d, { recursive: true, force: true });
    },
  };
  return inst;
}

const BOOTSTRAP = '/api/v1/auth/bootstrap';
const VALID_PASSWORD = 'a-valid-password-123';
const stubHash = async (p: string) => `stub-hash$${p}`;

function body(token: string, over: Record<string, unknown> = {}) {
  return { bootstrap_token: token, username: 'admin', display_name: '管理员', password: VALID_PASSWORD, ...over };
}

test('断言 1：初始化态仅初始化端点可用（业务入口 503 E-AUTH-007；bootstrap 可达；healthz 放行）', async () => {
  const inst = await makeInstance();
  try {
    for (const [method, url] of [
      ['GET', '/api/v1/admin/employees'],
      ['POST', '/api/v1/auth/password-reset'],
      ['GET', '/api/v1/anything-else'],
    ] as const) {
      const res = await inst.app.inject({ method, url, ...(method === 'POST' ? { payload: {} } : {}) });
      assert.equal(res.statusCode, 503, `${method} ${url}`);
      assert.equal(res.json().error.code, 'E-AUTH-007', `${method} ${url}`);
    }
    // 初始化端点本身可用（token 错 → 401 E-AUTH-001，而非 503/404）
    const boot = await inst.app.inject({ method: 'POST', url: BOOTSTRAP, payload: body('wrong-token') });
    assert.equal(boot.statusCode, 401);
    assert.equal(boot.json().error.code, 'E-AUTH-001');
    // 健康检查属基础设施，不属于业务入口
    const health = await inst.app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(health.statusCode, 200);
  } finally {
    await inst.close();
  }
});

test('断言 2：bootstrap token 重放无效（端点已永久关闭 → 410；竞态窗口下已用 token → 401）', async () => {
  const inst = await makeInstance();
  try {
    const token = await inst.readToken();
    const first = await inst.app.inject({ method: 'POST', url: BOOTSTRAP, payload: body(token) });
    assert.equal(first.statusCode, 201);
    // 初始化已完成后：前置不满足（api.md §3：否则 410 E-RES-006），重放被拒且不建二号账号
    const replay = await inst.app.inject({ method: 'POST', url: BOOTSTRAP, payload: body(token) });
    assert.equal(replay.statusCode, 410);
    assert.equal((inst.db.prepare('SELECT COUNT(*) AS n FROM employees').get() as { n: number }).n, 1);
    // 已用 token 在令牌层的拒绝路径（并发竞态窗口：已过前置检查、令牌已被消费）→ 401 E-AUTH-001
    inst.db.exec('DELETE FROM employees'); // 回到空库以越过 410 前置，直指令牌校验
    const raced = await inst.app.inject({ method: 'POST', url: BOOTSTRAP, payload: body(token) });
    assert.equal(raced.statusCode, 401);
    assert.equal(raced.json().error.code, 'E-AUTH-001');
    assert.equal((inst.db.prepare('SELECT COUNT(*) AS n FROM employees').get() as { n: number }).n, 0);
  } finally {
    await inst.close();
  }
});

test('断言 3：单次使用后 token 文件被删（D-IC-07：文件即令牌载体，用后即删）', async () => {
  const inst = await makeInstance();
  try {
    const token = await inst.readToken();
    const res = await inst.app.inject({ method: 'POST', url: BOOTSTRAP, payload: body(token) });
    assert.equal(res.statusCode, 201);
    await assert.rejects(stat(inst.tokenFile), /ENOENT/);
  } finally {
    await inst.close();
  }
});

test('断言 4：用户表非空时初始化端点永久不可用（410 E-RES-006，重启后仍不可用且不再发 token）', async () => {
  let inst = await makeInstance();
  try {
    const token = await inst.readToken();
    const ok = await inst.app.inject({ method: 'POST', url: BOOTSTRAP, payload: body(token) });
    assert.equal(ok.statusCode, 201);
    assert.deepEqual({ employee_id: ok.json().employee_id >= 1, username: ok.json().username }, { employee_id: true, username: 'admin' });
    const gone = await inst.app.inject({ method: 'POST', url: BOOTSTRAP, payload: body(token) });
    assert.equal(gone.statusCode, 410);
    assert.equal(gone.json().error.code, 'E-RES-006');
    // 重启（同数据目录重新走启动接线）：仍 410，且不重发 token 文件
    inst = await inst.restart();
    const after = await inst.app.inject({ method: 'POST', url: BOOTSTRAP, payload: body('any-token') });
    assert.equal(after.statusCode, 410);
    assert.equal(after.json().error.code, 'E-RES-006');
    await assert.rejects(stat(inst.tokenFile), /ENOENT/);
  } finally {
    await inst.close();
  }
});

test('bootstrap 成功创建的账号：is_instance_admin=1、口令经 hashPassword 注入链写入', async () => {
  const inst = await makeInstance();
  try {
    const token = await inst.readToken();
    const res = await inst.app.inject({ method: 'POST', url: BOOTSTRAP, payload: body(token, { password: 'the-password-12345' }) });
    assert.equal(res.statusCode, 201);
    const row = inst.db.prepare('SELECT is_instance_admin, password_hash FROM employees WHERE username = ?').get('admin') as { is_instance_admin: number; password_hash: string };
    assert.equal(row.is_instance_admin, 1);
    assert.equal(row.password_hash, 'stub-hash$the-password-12345');
  } finally {
    await inst.close();
  }
});

test('口令策略不满足 → 422 E-AUTH-008，且 token 未被消耗（可改好口令重试成功）', async () => {
  const inst = await makeInstance();
  try {
    const token = await inst.readToken();
    const short = await inst.app.inject({ method: 'POST', url: BOOTSTRAP, payload: body(token, { password: 'short' }) });
    assert.equal(short.statusCode, 422);
    assert.equal(short.json().error.code, 'E-AUTH-008');
    const over = await inst.app.inject({ method: 'POST', url: BOOTSTRAP, payload: body(token, { password: 'x'.repeat(65) }) });
    assert.equal(over.statusCode, 422);
    const retry = await inst.app.inject({ method: 'POST', url: BOOTSTRAP, payload: body(token) });
    assert.equal(retry.statusCode, 201);
  } finally {
    await inst.close();
  }
});

test('真实哈希链路（不注入桩）：默认 Argon2id 写入并可校验（S2-T3 复用同一模块）', async () => {
  const inst = await makeInstance(undefined, { realHash: true });
  try {
    const token = await inst.readToken();
    const res = await inst.app.inject({ method: 'POST', url: BOOTSTRAP, payload: body(token, { password: 'real-pass-12345' }) });
    assert.equal(res.statusCode, 201);
    const row = inst.db.prepare('SELECT password_hash FROM employees WHERE username = ?').get('admin') as { password_hash: string };
    assert.match(row.password_hash, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    assert.equal(await verifyPassword(row.password_hash, 'real-pass-12345'), true);
    assert.equal(await verifyPassword(row.password_hash, 'wrong-pass-12345'), false);
  } finally {
    await inst.close();
  }
});

test('请求形态错误：缺必填项 / 非法 JSON → 400 E-RES-004', async () => {
  const inst = await makeInstance();
  try {
    const token = await inst.readToken();
    const missing = await inst.app.inject({ method: 'POST', url: BOOTSTRAP, payload: { bootstrap_token: token, username: 'admin' } });
    assert.equal(missing.statusCode, 400);
    assert.equal(missing.json().error.code, 'E-RES-004');
    const badJson = await inst.app.inject({ method: 'POST', url: BOOTSTRAP, payload: '{oops', headers: { 'content-type': 'application/json' } });
    assert.equal(badJson.statusCode, 400);
    assert.equal(badJson.json().error.code, 'E-RES-004');
    // 坏请求不消耗 token
    const ok = await inst.app.inject({ method: 'POST', url: BOOTSTRAP, payload: body(token) });
    assert.equal(ok.statusCode, 201);
  } finally {
    await inst.close();
  }
});
