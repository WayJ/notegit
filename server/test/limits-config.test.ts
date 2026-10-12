import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db/connection.ts';
import { migrate } from '../src/db/migrate.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { FIXTURE_DDL, addEmployee } from './credentials-fixtures.ts';
import { defaultConfig, type Report } from 'notegit-validation';
import {
  LIMIT_KEY_FIELDS,
  envNameOf,
  effectiveConfig,
  effectiveOverrides,
  runServerValidation,
  setAppSetting,
} from '../src/limits/engine.ts';

// S3-T8 限制配置引擎（implementation-breakdown §2.2 S3-T8 行：validation-defaults.json
// 全键管理员可配置且真实生效）。覆盖链（T8 裁决）：默认值（validation-defaults.json）
// ← 环境变量（部署级静态覆盖，键名 NOTEGIT_<大写下划线>) ← app_settings 行（管理员
// 运行时配置，storage-model §3.10——键名即配置键、值为 JSON）。DB 行同键胜环境：
// 管理员运行时配置是权威配置面，环境值仅为缺行时的部署级缺省。
//
// 生效语义（T8 裁决，见 notes）：全部键在每次判定点实时读取（判定型与运维型一致
// 热生效——pre-receive 每次推送开库读取、发布组件每请求读取）；进程内共享并发闸门
// 随配置代次重建（重建瞬间的在途计数不跨代，运维型语义、自愈）。
//
// D6：断言禁全等硬编码——键清单与 validation-defaults.json 运行时交叉核对，
// 默认值自 defaultConfig() 派生。

async function freshDb(): Promise<DatabaseSync> {
  const dir = await mkdtemp(path.join(tmpdir(), 'notegit-t8-cfg-'));
  const dbFile = path.join(dir, 'db', 'notegit.sqlite');
  await mkdir(path.dirname(dbFile), { recursive: true });
  const db = openDatabase(dbFile);
  migrate(db, MIGRATIONS);
  for (const ddl of FIXTURE_DDL) db.exec(ddl);
  return db;
}

const INT_KEYS = [
  'validation.limits.maxDocumentBytes',
  'validation.limits.maxAttachmentBytes',
  'validation.limits.maxPushBytes',
  'validation.limits.vaultCapacityBytes',
] as const;

const LIST_KEYS = [
  'validation.limits.attachmentAllowedExtensions',
  'validation.exemptions.additionalNavPatterns',
  'validation.exemptions.specialFilePatterns',
] as const;

const RUNTIME_KEYS = [
  'validation.runtime.validationTimeoutMs',
  'validation.runtime.maxConcurrentValidations',
  'validation.runtime.maxValidationMemoryMb',
] as const;

test('键注册表：与 validation-defaults.json 双向一致（adminConfigurable + runtime 全集）', () => {
  const raw = JSON.parse(
    readFileSync(path.resolve(import.meta.dirname, '../../docs/contracts/validation-defaults.json'), 'utf8'),
  ) as { adminConfigurable: Record<string, unknown>; runtime: Record<string, unknown> };
  const contractKeys = [...Object.keys(raw.adminConfigurable), ...Object.keys(raw.runtime)].sort();
  assert.deepEqual(
    [...Object.keys(LIMIT_KEY_FIELDS)].sort(),
    contractKeys,
    '引擎键注册表应与契约默认值文件的全键集合一致（防漂移）',
  );
});

test('envNameOf：配置键 → 环境变量名（NOTEGIT_ + 大写下划线）', () => {
  assert.equal(envNameOf('validation.limits.maxPushBytes'), 'NOTEGIT_VALIDATION_LIMITS_MAX_PUSH_BYTES');
  assert.equal(
    envNameOf('validation.limits.attachmentAllowedExtensions'),
    'NOTEGIT_VALIDATION_LIMITS_ATTACHMENT_ALLOWED_EXTENSIONS',
  );
  assert.equal(envNameOf('validation.runtime.validationTimeoutMs'), 'NOTEGIT_VALIDATION_RUNTIME_VALIDATION_TIMEOUT_MS');
});

test('覆盖链：全缺省 = 契约默认值（deepEqual 对 defaultConfig 派生）', () => {
  const db = new DatabaseSync(':memory:'); // 无表——容忍（未迁移形态），返回零覆盖
  const cfg = effectiveConfig({ db, env: {} });
  const d = defaultConfig();
  assert.equal(cfg.maxPushBytes, d.maxPushBytes);
  assert.equal(cfg.validationTimeoutMs, d.validationTimeoutMs);
  assert.deepEqual(cfg.attachmentAllowedExtensions, d.attachmentAllowedExtensions);
  db.close();
});

test('覆盖链：环境值覆盖默认；DB 行同键胜环境；不同键并存', async () => {
  const db = await freshDb();
  const emp = addEmployee(db, { username: 'op' });
  setAppSetting(db, { key: 'validation.limits.maxPushBytes', value: 4096, updatedBy: emp });

  const cfg = effectiveConfig({
    db,
    env: { NOTEGIT_VALIDATION_LIMITS_MAX_PUSH_BYTES: '8192' }, // DB 行 4096 胜
  });
  assert.equal(cfg.maxPushBytes, 4096, 'app_settings 行应胜过环境值（管理员运行时配置权威）');

  const cfgEnvOnly = effectiveConfig({ db: undefined, env: { NOTEGIT_VALIDATION_LIMITS_MAX_PUSH_BYTES: '8192' } });
  assert.equal(cfgEnvOnly.maxPushBytes, 8192, '无 DB 行时环境值生效');

  const cfgDefault = effectiveConfig({ db, env: {} });
  const d = defaultConfig();
  assert.equal(cfgDefault.maxDocumentBytes, d.maxDocumentBytes, '未覆盖键保持默认');
  db.close();
});

test('覆盖链：清单键的 JSON 值（环境与 DB 两通道）', async () => {
  const db = await freshDb();
  const cfg = effectiveConfig({
    db: undefined,
    env: { NOTEGIT_VALIDATION_LIMITS_ATTACHMENT_ALLOWED_EXTENSIONS: '[".png",".webp"]' },
  });
  assert.deepEqual(cfg.attachmentAllowedExtensions, ['.png', '.webp']);

  const emp = addEmployee(db, { username: 'op2' });
  setAppSetting(db, { key: 'validation.exemptions.specialFilePatterns', value: [], updatedBy: emp });
  const cfg2 = effectiveConfig({ db, env: {} });
  assert.deepEqual(cfg2.specialFilePatterns, [], 'DB 行 JSON 数组生效（空清单=合法收紧选择）');
  db.close();
});

test('fail-closed：非法环境值抛错并指名配置键（判定面拒绝虚跑）', () => {
  assert.throws(
    () => effectiveConfig({ db: undefined, env: { NOTEGIT_VALIDATION_LIMITS_MAX_PUSH_BYTES: 'not-a-number' } }),
    /validation\.limits\.maxPushBytes/,
  );
  assert.throws(
    () =>
      effectiveConfig({ db: undefined, env: { NOTEGIT_VALIDATION_LIMITS_ATTACHMENT_ALLOWED_EXTENSIONS: 'png' } }),
    /attachmentAllowedExtensions/,
  );
});

test('fail-closed：DB 行非法 JSON/类型抛错并指名配置键', async () => {
  const db = await freshDb();
  db.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES ('validation.limits.maxPushBytes', '{bad json', '2026-10-13T00:00:00.000Z')`).run();
  assert.throws(() => effectiveConfig({ db, env: {} }), /validation\.limits\.maxPushBytes/);

  const db2 = await freshDb();
  db2.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES ('validation.limits.vaultCapacityBytes', '"text-not-number"', '2026-10-13T00:00:00.000Z')`).run();
  assert.throws(() => effectiveConfig({ db: db2, env: {} }), /vaultCapacityBytes/);
  db.close();
  db2.close();
});

test('DB 行未知键忽略（向前兼容：新版本写入的键不破坏旧版本加载）', async () => {
  const db = await freshDb();
  db.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES ('future.unknown.key', '1', '2026-10-13T00:00:00.000Z')`).run();
  const o = effectiveOverrides({ db, env: {} });
  assert.equal('maxPushBytes' in o, false);
  db.close();
});

test('setAppSetting：upsert 语义（同键覆盖）、非法键/值拒绝', async () => {
  const db = await freshDb();
  const emp = addEmployee(db, { username: 'op3' });
  setAppSetting(db, { key: 'validation.limits.maxDocumentBytes', value: 2048, updatedBy: emp });
  setAppSetting(db, { key: 'validation.limits.maxDocumentBytes', value: 4096, updatedBy: emp });
  const rows = db.prepare('SELECT key, value, updated_by FROM app_settings').all() as unknown as { key: string; value: string; updated_by: number }[];
  assert.equal(rows.length, 1, '同键覆盖不增行（主键 upsert）');
  assert.equal(JSON.parse(rows[0]!.value), 4096);
  assert.equal(rows[0]!.updated_by, emp);

  assert.throws(() => setAppSetting(db, { key: 'unknown.key' as never, value: 1, updatedBy: emp }), /unknown\.key/);
  assert.throws(() => setAppSetting(db, { key: INT_KEYS[0], value: -5, updatedBy: emp }), /maxDocumentBytes/);
  db.close();
});

test('runServerValidation：E-LIMIT-004 经配置链生效（环境 maxPushBytes 覆盖 → 超限拒、limit/limitKey 齐）', async () => {
  const r = await runServerValidation(
    {
      scope: 'pre-receive',
      vaultId: 'v1',
      pushBytes: 500,
      refs: [
        { ref: 'refs/heads/main', headOld: null, headNew: 'n1', commits: [{ commit: 'c1', parent: null, changes: [{ path: 'docs/a.md', mode: '100644', content: '---\ntitle: A\n---\n' }] }] },
      ],
    },
    { env: { NOTEGIT_VALIDATION_LIMITS_MAX_PUSH_BYTES: '100' } },
  );
  assert.equal(r.result, 'fail');
  assert.equal(r.exitCode, 1);
  const issue = r.issues?.find((i) => i.code === 'E-LIMIT-004');
  assert.ok(issue, '顶层 issues 应含 E-LIMIT-004');
  assert.equal(issue!.limit, 100, 'limit=配置生效值');
  assert.equal(issue!.limitKey, 'validation.limits.maxPushBytes');
  assert.equal(issue!.ref, 'refs/heads/main');
  assert.equal(r.refs?.every((x) => x.outcome === 'rejected'), true);
});

test('runServerValidation：超时键生效（环境 validationTimeoutMs + clock 注入 → E-RUN-001 退出码 2）', async () => {
  let t = 0;
  const r = await runServerValidation(
    {
      scope: 'web-submit',
      vaultId: 'v1',
      files: [{ path: 'docs/a.md', mode: '100644', content: '---\ntitle: A\n---\n' }],
      clock: () => (t += 1000),
    },
    { env: { NOTEGIT_VALIDATION_RUNTIME_VALIDATION_TIMEOUT_MS: '1' } },
  );
  assert.equal(r.result, 'error');
  assert.equal(r.exitCode, 2);
  const issue = r.issues?.find((i) => i.code === 'E-RUN-001');
  assert.ok(issue);
  assert.equal(issue!.limitKey, 'validation.runtime.validationTimeoutMs');
});

test('runServerValidation：内存键生效（环境 maxValidationMemoryMb=1 → 进程 RSS 必超 → E-RUN-001）', async () => {
  const r = await runServerValidation(
    { scope: 'web-submit', vaultId: 'v1', files: [] },
    { env: { NOTEGIT_VALIDATION_RUNTIME_MAX_VALIDATION_MEMORY_MB: '1' } },
  );
  assert.equal(r.result, 'error');
  const issue = r.issues?.find((i) => i.code === 'E-RUN-001');
  assert.ok(issue);
  assert.equal(issue!.limitKey, 'validation.runtime.maxValidationMemoryMb');
  assert.equal(issue!.limit, 1);
});

test('runServerValidation：并发键生效（maxConcurrentValidations=1，两路并发第二路 E-RUN-001；配置代次切换后闸门随新限制）', async () => {
  const env1 = { NOTEGIT_VALIDATION_RUNTIME_MAX_CONCURRENT_VALIDATIONS: '1' };
  const input = {
    scope: 'web-submit' as const,
    vaultId: 'v1',
    files: [
      { path: 'docs/a.md', mode: '100644', content: '---\ntitle: A\n---\n' },
      { path: 'docs/b.md', mode: '100644', content: '---\ntitle: B\n---\n' },
    ],
  };
  const [first, second] = await Promise.all([
    runServerValidation(input, { env: env1 }),
    runServerValidation(input, { env: env1 }),
  ]);
  const codes = [first, second].map((r) => r.issues?.some((i) => i.code === 'E-RUN-001' && i.limitKey === 'validation.runtime.maxConcurrentValidations') ?? false);
  assert.equal(codes.filter(Boolean).length, 1, '恰好一路被并发闸门拒绝（E-RUN-001 limitKey=并发键）');

  // 配置代次切换：并发上限 4 → 同样两路并发全部放行（闸门随新配置重建）
  const env4 = { NOTEGIT_VALIDATION_RUNTIME_MAX_CONCURRENT_VALIDATIONS: '4' };
  const [a, b] = await Promise.all([
    runServerValidation(input, { env: env4 }),
    runServerValidation(input, { env: env4 }),
  ]);
  assert.equal((a as Report).result, 'pass');
  assert.equal((b as Report).result, 'pass');
});

test('runServerValidation：DB 行经引擎生效（app_settings vaultCapacityBytes 收紧 → E-LIMIT-005）', async () => {
  const db = await freshDb();
  const emp = addEmployee(db, { username: 'op4' });
  setAppSetting(db, { key: 'validation.limits.vaultCapacityBytes', value: 1000, updatedBy: emp });
  const r = await runServerValidation(
    {
      scope: 'pre-receive',
      vaultId: 'v1',
      pushBytes: 10,
      vaultCurrentBytes: 995,
      refs: [
        { ref: 'refs/heads/main', headOld: null, headNew: 'n1', commits: [{ commit: 'c1', parent: null, changes: [{ path: 'docs/a.md', mode: '100644', content: '---\ntitle: A\n---\n' }] }] },
      ],
    },
    { db, env: {} },
  );
  assert.equal(r.result, 'fail');
  const issue = r.issues?.find((i) => i.code === 'E-LIMIT-005');
  assert.ok(issue);
  assert.equal(issue!.limit, 1000);
  assert.equal(issue!.limitKey, 'validation.limits.vaultCapacityBytes');
  db.close();
});
