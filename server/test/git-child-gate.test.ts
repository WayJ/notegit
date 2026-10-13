import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db/connection.ts';
import { migrate } from '../src/db/migrate.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { FIXTURE_DDL, addEmployee } from './credentials-fixtures.ts';
import { effectiveConfig, effectiveOverrides, setAppSetting } from '../src/limits/engine.ts';
import {
  GIT_CHILDREN_DEFAULT,
  GIT_LIMIT_KEYS,
  createGitChildGate,
  effectiveGitLimits,
  type GitChildGate,
  type GitChildSlot,
} from '../src/limits/git-gate.ts';
import { envNameOf } from '../src/limits/keys.ts';

// S8-T8 每请求 git 子进程并发上限（implementation-breakdown §2.7 S8-T8 行；N2 风险
// 收口）：新运维键 git.maxConcurrentChildren——与 validation.* 键同一覆盖链
// （契约默认 ← NOTEGIT_ 环境变量 ← app_settings 行，DB 同键胜环境；fail-closed）
// 与同一写入面（setAppSetting）；消费点 = githttp 每请求 http-backend 子进程 spawn
// （接线断言在 githttp-concurrency.test.ts）。默认值与排队语义的量化依据见
// docs/s1/capacity-face-amendments.md G2（每链 ~17MB、峰值 ≈2×并发、c=4 无塌陷）。

async function freshDb(): Promise<DatabaseSync> {
  const dir = await mkdtemp(path.join(tmpdir(), 'notegit-t8-git-'));
  const dbFile = path.join(dir, 'db', 'notegit.sqlite');
  await mkdir(path.dirname(dbFile), { recursive: true });
  const db = openDatabase(dbFile);
  migrate(db, MIGRATIONS);
  for (const ddl of FIXTURE_DDL) db.exec(ddl);
  return db;
}

const KEY = 'git.maxConcurrentChildren';
const ENV_NAME = 'NOTEGIT_GIT_MAX_CONCURRENT_CHILDREN';

// ── 配置链（键 · 默认值 · 环境通道 · DB 通道 · fail-closed）──────────────────

test('git 键注册表与环境变量名派生（git.maxConcurrentChildren → NOTEGIT_GIT_MAX_CONCURRENT_CHILDREN）', () => {
  assert.deepEqual(GIT_LIMIT_KEYS, [KEY]);
  assert.equal(envNameOf(KEY), ENV_NAME);
});

test(`默认值 = ${GIT_CHILDREN_DEFAULT}（量化依据：每链 ~17MB × ${GIT_CHILDREN_DEFAULT} ≈ 136MB 子进程预算 + 本体 232MB 基线，768MB 修正地板内自洽）`, () => {
  assert.equal(GIT_CHILDREN_DEFAULT, 8);
  assert.equal(effectiveGitLimits({ db: undefined, env: {} }).maxConcurrentChildren, 8);
});

test('环境通道：NOTEGIT_GIT_MAX_CONCURRENT_CHILDREN 覆盖默认', () => {
  assert.equal(effectiveGitLimits({ db: undefined, env: { [ENV_NAME]: '2' } }).maxConcurrentChildren, 2);
});

test('DB 行同键胜环境；setAppSetting 写入面接受 git 键（upsert）', async () => {
  const db = await freshDb();
  const emp = addEmployee(db, { username: 'op-git' });
  setAppSetting(db, { key: KEY, value: 3, updatedBy: emp });
  assert.equal(effectiveGitLimits({ db, env: { [ENV_NAME]: '5' } }).maxConcurrentChildren, 3, 'app_settings 行应胜过环境值');
  setAppSetting(db, { key: KEY, value: 4, updatedBy: emp }); // upsert 不增行
  const rows = db.prepare('SELECT key, value FROM app_settings').all() as unknown as { key: string; value: string }[];
  assert.equal(rows.filter((r) => r.key === KEY).length, 1);
  assert.equal(JSON.parse(rows.find((r) => r.key === KEY)!.value), 4);
  assert.throws(() => setAppSetting(db, { key: KEY, value: 0, updatedBy: emp }), /git\.maxConcurrentChildren/);
  db.close();
});

test('fail-closed：非法环境值（非 JSON / 非正整数）抛错并指名 git 键', () => {
  assert.throws(() => effectiveGitLimits({ db: undefined, env: { [ENV_NAME]: 'not-a-number' } }), /git\.maxConcurrentChildren/);
  assert.throws(() => effectiveGitLimits({ db: undefined, env: { [ENV_NAME]: '0' } }), /git\.maxConcurrentChildren/);
  assert.throws(() => effectiveGitLimits({ db: undefined, env: { [ENV_NAME]: '2.5' } }), /git\.maxConcurrentChildren/);
});

test('fail-closed：DB 行非法 JSON/类型抛错并指名 git 键', async () => {
  const db = await freshDb();
  db.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, '2026-10-14T00:00:00.000Z')`).run(KEY, '{bad json');
  assert.throws(() => effectiveGitLimits({ db, env: {} }), /git\.maxConcurrentChildren/);
  db.close();
});

test('validation 配置面不受 git 键行干扰：effectiveConfig 正常、不进 validation 覆盖面', async () => {
  const db = await freshDb();
  const emp = addEmployee(db, { username: 'op-git2' });
  setAppSetting(db, { key: KEY, value: 2, updatedBy: emp });
  const o = effectiveOverrides({ db, env: {} });
  assert.equal('maxConcurrentChildren' in o, false, 'git 键不进 validation 覆盖面（独立注册表）');
  const cfg = effectiveConfig({ db, env: {} }); // 不抛错、不告警（git 键非未知键）
  assert.equal(cfg.maxPushBytes, 52428800); // validation 默认不受影响
  db.close();
});

// ── 闸门语义（FIFO 排队 · 容量热读 · 幂等释放 · 峰值高水位）──────────────────

const tick = () => new Promise<void>((r) => setImmediate(r));

test('闸门：容量内即取；超容量 FIFO 排队，释放后按序唤醒', async () => {
  const gate = createGitChildGate(() => 1);
  const a = await gate.acquire();
  assert.equal(gate.activeCount(), 1);
  const order: string[] = [];
  const bP = gate.acquire().then((s) => { order.push('b'); return s; });
  const cP = gate.acquire().then((s) => { order.push('c'); return s; });
  await tick();
  assert.equal(gate.queuedCount(), 2);
  a.release();
  const b = await bP;
  assert.deepEqual(order, ['b']);
  assert.equal(gate.activeCount(), 1);
  b.release();
  const c = await cP;
  assert.deepEqual(order, ['b', 'c']);
  c.release();
  assert.equal(gate.activeCount(), 0);
  assert.equal(gate.queuedCount(), 0);
});

test('闸门：等待中容量上调，唤醒时按新容量放行（容量每次唤醒实时读取）', async () => {
  let cap = 1;
  const gate = createGitChildGate(() => cap);
  const a = await gate.acquire();
  const bP = gate.acquire();
  const cP = gate.acquire();
  await tick();
  assert.equal(gate.queuedCount(), 2);
  cap = 3; // 排队期间管理员放宽
  a.release();
  const [b, c] = await Promise.all([bP, cP]);
  assert.equal(gate.activeCount(), 2, '一次释放按新容量同时唤醒两名等待者');
  assert.equal(gate.queuedCount(), 0);
  b.release();
  c.release();
});

test('闸门：释放幂等（重复 release 不超额放行）', async () => {
  const gate = createGitChildGate(() => 1);
  const a = await gate.acquire();
  a.release();
  a.release(); // 重复释放必须无操作
  assert.equal(gate.activeCount(), 0);
  const b: GitChildSlot = await gate.acquire(); // 不死锁
  b.release();
});

test('闸门：peakActive 高水位（并发 2 → 峰值 2；释放后不回落）', async () => {
  const gate: GitChildGate = createGitChildGate(() => 4);
  const a = await gate.acquire();
  const b = await gate.acquire();
  assert.equal(gate.peakActive(), 2);
  a.release();
  b.release();
  assert.equal(gate.peakActive(), 2, '高水位不随释放回落（观察面）');
});
