// Notegit 存储模型 DDL 冒烟测试与 api.md 文档 lint（S1-T5）。
//
// 用法（仓库根目录执行）：
//     node --test docs/contracts/tools/ddl_smoke.test.mjs
//
// 依赖：Node >= 22.13（node:sqlite）；推荐 Node 24（与 D10 选型一致）。
// 通过判据：全部测试 pass（退出码 0）。
//
// 单一来源约定（本脚本的解析契约）：
//   - DDL 与运行时检查查询的唯一来源是 docs/contracts/storage-model.md，本脚本不复制
//     任何 SQL，防止文档与测试漂移；
//   - fenced 代码块（```sql）中，首行注释以 `-- @schema` 开头的块按文档顺序拼接执行；
//   - 首行注释以 `-- @query <name>` 开头的块注册为命名查询（authn.token / authn.session /
//     authz.role / audit.drain_count / audit.chain），供各断言按名调用；
//   - docs/contracts/api.md 的 lint：API 错误码注册表内聚（正文用码均在注册表内）、
//     区域前缀与 T2 注册表不相交、rules-version.json 的 rulesVersion 字符串出现在 api.md。
//
// 本文件是契约验证工具，不是产品代码（任务边界：不写产品代码）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CONTRACTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STORAGE_MD = path.join(CONTRACTS, 'storage-model.md');
const API_MD = path.join(CONTRACTS, 'api.md');
const VALIDATION_MD = path.join(CONTRACTS, 'validation.md');
const RULES_VERSION_JSON = path.join(CONTRACTS, 'rules-version.json');

// —— markdown fenced 代码块提取 ——————————————————————————————

function fencedBlocks(mdPath) {
  const md = readFileSync(mdPath, 'utf8');
  const blocks = [];
  const re = /^```(\w*)[^\n]*\n([\s\S]*?)^```[ \t]*$/gm;
  let m;
  while ((m = re.exec(md)) !== null) {
    blocks.push({ lang: m[1], body: m[2] });
  }
  return blocks;
}

function firstLine(body) {
  return body.split('\n').find((l) => l.trim() !== '') ?? '';
}

/** 按文档顺序返回 storage-model.md 中标记为 `-- @schema` 的 DDL 块。 */
export function extractSchemaDdl() {
  return fencedBlocks(STORAGE_MD)
    .filter((b) => b.lang === 'sql' && firstLine(b.body).startsWith('-- @schema'))
    .map((b) => b.body);
}

/** 返回 `-- @query <name>` 命名查询映射。 */
export function extractQueries() {
  const queries = {};
  for (const b of fencedBlocks(STORAGE_MD)) {
    if (b.lang !== 'sql') continue;
    const head = firstLine(b.body);
    const m = head.match(/^--\s*@query\s+([A-Za-z0-9_.]+)/);
    if (m) queries[m[1]] = b.body;
  }
  return queries;
}

/** 建库：fresh :memory: + foreign_keys=ON（storage-model.md §2 运行约定），执行全部 @schema 块。 */
export function buildDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  const blocks = extractSchemaDdl();
  assert.ok(blocks.length >= 10, `storage-model.md 应含 ≥10 个 @schema 块，实得 ${blocks.length}`);
  for (const b of blocks) db.exec(b);
  db.prepare(
    "INSERT INTO schema_version (version, applied_at, description) VALUES (1, '2026-10-12T00:00:00.000Z', 'S1-T5 storage-model draft v1')"
  ).run();
  return db;
}

/** 断言 fn 抛出且消息匹配 re（约束/触发器违规检测）。 */
function expectRaise(fn, re, what) {
  assert.throws(
    fn,
    (err) => re.test(err.message),
    `应抛出约束违规：${what}（期望消息匹配 ${re}）`
  );
}

// —— fixtures（ISO-8601 UTC，服务端时钟；identity §5.3 时钟权威） ——————————

const NOW = '2026-10-12T12:00:00.000Z';
const IDLE_CUTOFF = '2026-10-05T12:00:00.000Z'; // NOW - 7d（idle 默认窗口）

function seedEmployee(db, id = 1, active = 1, username = 'zhangsan') {
  db.prepare(
    `INSERT INTO employees (id, username, display_name, password_hash, is_instance_admin, active, created_at)
     VALUES (?, ?, ?, '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA', 0, ?, '2026-10-01T00:00:00.000Z')`
  ).run(id, username, username, active);
}

function seedVault(db, id = 1, slug = 'handbook', createdBy = 1) {
  db.prepare(
    `INSERT INTO vaults (id, slug, name, default_branch, main_admin_only, created_by, created_at)
     VALUES (?, ?, ?, 'main', 0, ?, '2026-10-01T00:00:00.000Z')`
  ).run(id, slug, slug, createdBy);
}

function seedMember(db, vaultId = 1, employeeId = 1, role = 'editor') {
  db.prepare(
    `INSERT INTO vault_members (vault_id, employee_id, role, granted_by, granted_at)
     VALUES (?, ?, ?, ?, '2026-10-01T00:00:00.000Z')`
  ).run(vaultId, employeeId, role, employeeId);
}

function seedCredential(db, id = 1, employeeId = 1, tokenHash = 'hmacv1$aa', extra = {}) {
  db.prepare(
    `INSERT INTO credentials (id, employee_id, name, token_hash, scope_access, scope_vaults,
       created_at, expires_at, revoked_at, display_hint)
     VALUES (?, ?, '本地 Harness', ?, ?, ?, '2026-10-01T00:00:00.000Z',
       ?, ?, ?)`
  ).run(
    id, employeeId, tokenHash,
    extra.scopeAccess ?? 'read_write', extra.scopeVaults ?? '[]',
    extra.expiresAt ?? '2026-12-01T00:00:00.000Z', extra.revokedAt ?? null,
    extra.displayHint ?? 'ngt_xx…yyyy'  // D11 增补列（master 2026-10-13 同步修 seed）
  );
}

// —— DDL 冒烟测试 ————————————————————————————————————————

test('DDL：storage-model.md 全部 @schema 块可顺序执行，schema_version 含 v1 行', () => {
  const db = buildDb();
  const row = db.prepare('SELECT version FROM schema_version WHERE version = 1').get();
  assert.equal(row?.version, 1);
});

test('vaults.slug 实例内唯一：重复插入被拒（架构 §7.2）', () => {
  const db = buildDb();
  seedEmployee(db);
  seedVault(db, 1, 'handbook');
  seedVault(db, 2, 'other');
  expectRaise(
    () => seedVault(db, 3, 'handbook'),
    /UNIQUE constraint failed: vaults\.slug/,
    'slug 重复'
  );
});

test('外键生效：凭据指向不存在的员工被拒（identity §3.3 归属外键）', () => {
  const db = buildDb();
  expectRaise(
    () => seedCredential(db, 1, 999),
    /FOREIGN KEY constraint failed/,
    'credentials.employee_id 无对应员工'
  );
});

test('四状态之过期/撤销/停用：authn.token 查询实时判定（identity §5.1/§5.2）', () => {
  const q = extractQueries()['authn.token'];
  assert.ok(q, 'storage-model.md 应含 -- @query authn.token');

  // 基线：有效凭据 + active 员工 → 命中
  const db = buildDb();
  seedEmployee(db);
  seedCredential(db, 1, 1, 'hmacv1$valid');
  assert.ok(db.prepare(q).get('hmacv1$valid', NOW));

  // 状态 1 过期：expires_at ≤ now → 不命中（零延迟，下一请求生效）
  seedCredential(db, 2, 1, 'hmacv1$expired', { expiresAt: '2026-10-12T11:59:59.999Z' });
  assert.equal(db.prepare(q).get('hmacv1$expired', NOW), undefined);

  // 状态 2 撤销：revoked_at 置位 → 不命中
  seedCredential(db, 3, 1, 'hmacv1$revoked', { revokedAt: '2026-10-10T00:00:00.000Z' });
  assert.equal(db.prepare(q).get('hmacv1$revoked', NOW), undefined);

  // 状态 3 账号停用：employee.active=0 → 该账号全部 token 不命中
  seedEmployee(db, 2, 0, 'lisi');
  seedCredential(db, 4, 2, 'hmacv1$disabled');
  assert.equal(db.prepare(q).get('hmacv1$disabled', NOW), undefined);
});

test('四状态之成员撤权：authz.role 查询实时判定，DELETE 即撤权（identity §5.2）', () => {
  const q = extractQueries()['authz.role'];
  assert.ok(q, 'storage-model.md 应含 -- @query authz.role');
  const db = buildDb();
  seedEmployee(db);
  seedVault(db);
  seedMember(db, 1, 1, 'editor');
  assert.equal(db.prepare(q).get(1, 1)?.role, 'editor');

  db.prepare('DELETE FROM vault_members WHERE vault_id = 1 AND employee_id = 1').run();
  assert.equal(db.prepare(q).get(1, 1), undefined, '撤权后无行 → 404 语义（D-IC-06）');
});

test('vault_members：role CHECK 三角色（架构 §4.2），PK 防重复授权', () => {
  const db = buildDb();
  seedEmployee(db);
  seedVault(db);
  expectRaise(() => seedMember(db, 1, 1, 'owner'), /CHECK constraint failed/, "role='owner'");
  seedMember(db, 1, 1, 'admin');
  expectRaise(
    () => seedMember(db, 1, 1, 'reader'),
    /UNIQUE constraint failed: vault_members\.(vault_id|employee_id)/,
    '重复成员行'
  );
});

test('Web 会话：authn.session 查询覆盖 idle/absolute 过期与账号停用（identity §4/§5.2）', () => {
  const q = extractQueries()['authn.session'];
  assert.ok(q, 'storage-model.md 应含 -- @query authn.session');
  const db = buildDb();
  seedEmployee(db);
  const ins = db.prepare(
    `INSERT INTO sessions (id, employee_id, sid_hash, created_at, last_seen_at, absolute_expires_at)
     VALUES (?, 1, ?, '2026-10-01T00:00:00.000Z', ?, ?)`
  );
  ins.run(1, 'sidhash$a', NOW, '2026-10-20T00:00:00.000Z');
  ins.run(2, 'sidhash$idle-stale', '2026-10-01T00:00:00.000Z', '2026-10-20T00:00:00.000Z');
  ins.run(3, 'sidhash$abs-expired', NOW, '2026-10-12T11:00:00.000Z');
  ins.run(4, 'sidhash$unique-check', NOW, '2026-10-20T00:00:00.000Z');

  assert.ok(db.prepare(q).get('sidhash$a', NOW, IDLE_CUTOFF), '活跃会话命中');
  assert.equal(db.prepare(q).get('sidhash$idle-stale', NOW, IDLE_CUTOFF), undefined, 'idle 超时');
  assert.equal(db.prepare(q).get('sidhash$abs-expired', NOW, IDLE_CUTOFF), undefined, 'absolute 超时');

  // 账号停用：全部会话即刻无效（identity §5.2）
  db.prepare('UPDATE employees SET active = 0 WHERE id = 1').run();
  assert.equal(db.prepare(q).get('sidhash$a', NOW, IDLE_CUTOFF), undefined);

  expectRaise(
    () => ins.run(5, 'sidhash$a', NOW, '2026-10-20T00:00:00.000Z'),
    /UNIQUE constraint failed: sessions\.sid_hash/,
    'sid_hash 重复'
  );
});

test('凭据存储：token_hash 唯一索引（identity §3.2 查找方式），scope CHECK', () => {
  const db = buildDb();
  seedEmployee(db);
  seedCredential(db, 1, 1, 'hmacv1$dup');
  expectRaise(
    () => seedCredential(db, 2, 1, 'hmacv1$dup'),
    /UNIQUE constraint failed: credentials\.token_hash/,
    'token_hash 重复'
  );
  expectRaise(
    () => seedCredential(db, 3, 1, 'hmacv1$x', { scopeAccess: 'admin' }),
    /CHECK constraint failed/,
    "scope_access='admin'"
  );
});

test('审计事件：pending 预记录 → 终态，排空计数与 old→new 成链查询（架构 §4.4、backup-recovery §4/§5）', () => {
  const qs = extractQueries();
  const db = buildDb();
  seedEmployee(db);
  seedVault(db);
  db.prepare(
    `INSERT INTO audit_events (occurred_at, actor_kind, employee_id, credential_ref, entry,
       event_kind, vault_id, ref_name, old_commit, new_commit)
     VALUES (?, 'employee', 1, 'cred:1', 'git', 'vault.push', 1, 'refs/heads/main',
       '0000000000000000000000000000000000000001', '0000000000000000000000000000000000000002')`
  ).run(NOW); // status 缺省 pending（预记录）

  assert.equal(db.prepare(qs['audit.drain_count']).get().n, 1, '在途 push → 排空条件不满足');

  db.prepare("UPDATE audit_events SET status = 'succeeded' WHERE event_kind = 'vault.push'").run();
  assert.equal(db.prepare(qs['audit.drain_count']).get().n, 0, '终态后可排空');

  const chain = db.prepare(qs['audit.chain']).all(1);
  assert.equal(chain.length, 1);
  assert.equal(chain[0].old_commit, '0000000000000000000000000000000000000001');
  assert.equal(chain[0].new_commit, '0000000000000000000000000000000000000002');

  // actor_kind / entry CHECK
  expectRaise(
    () => db.prepare(
      `INSERT INTO audit_events (occurred_at, actor_kind, entry, event_kind) VALUES (?, 'robot', 'web', 'vault.push')`
    ).run(NOW),
    /CHECK constraint failed/,
    "actor_kind='robot'"
  );
});

test('schema_version 历史行不可改（backup-recovery §9）：UPDATE/DELETE 均被触发器拒绝', () => {
  const db = buildDb();
  expectRaise(
    () => db.prepare("UPDATE schema_version SET description = 'tampered' WHERE version = 1").run(),
    /schema_version is append-only/,
    'UPDATE 历史行'
  );
  expectRaise(
    () => db.prepare('DELETE FROM schema_version WHERE version = 1').run(),
    /schema_version is append-only/,
    'DELETE 历史行'
  );
});

test('草稿：按作者私有且每路径一份（UNIQUE），status CHECK（架构 §6）', () => {
  const db = buildDb();
  seedEmployee(db);
  seedVault(db);
  const ins = db.prepare(
    `INSERT INTO drafts (vault_id, employee_id, path, content, base_commit, created_at, updated_at)
     VALUES (1, 1, ?, '# 草稿', '0000000000000000000000000000000000000001',
       '2026-10-11T00:00:00.000Z', '2026-10-11T00:00:00.000Z')`
  );
  ins.run('docs/a.md');
  expectRaise(() => ins.run('docs/a.md'), /UNIQUE constraint failed: drafts\./, '同作者同路径重复草稿');

  db.prepare("UPDATE drafts SET status = 'committed', committed_at = ? WHERE path = 'docs/a.md'").run(NOW);
  expectRaise(
    () => db.prepare("UPDATE drafts SET status = 'published' WHERE path = 'docs/a.md'").run(),
    /CHECK constraint failed/,
    "status='published'"
  );
});

test('一次性令牌（K5）：purpose CHECK + token_hash 唯一（identity §6.1/§7）', () => {
  const db = buildDb();
  const ins = db.prepare(
    `INSERT INTO one_time_tokens (purpose, token_hash, employee_id, expires_at, created_at)
     VALUES (?, ?, NULL, '2026-10-12T13:00:00.000Z', '2026-10-12T12:00:00.000Z')`
  );
  ins.run('bootstrap', 'k5hash$1');
  expectRaise(() => ins.run('bootstrap', 'k5hash$1'), /UNIQUE constraint failed/, 'token_hash 重复');
  expectRaise(() => ins.run('login', 'k5hash$2'), /CHECK constraint failed/, "purpose='login'");
});

test('app_settings：键唯一，可覆盖写入需 DELETE+INSERT 或先删（T2 §5.1 配置存储）', () => {
  const db = buildDb();
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ('validation.limits.maxPushBytes', '52428800', ?)`
  ).run(NOW);
  expectRaise(
    () => db.prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('validation.limits.maxPushBytes', '1', ?)`
    ).run(NOW),
    /UNIQUE constraint failed: app_settings\.key/,
    '重复配置键'
  );
});

// —— api.md 文档 lint（Task 2 交付后启用） ————————————————————

test('api.md lint：API 错误码注册表内聚、前缀与 T2 不相交、rulesVersion 引用一致', { skip: !existsSync(API_MD) && 'api.md 尚未交付（Task 2）' }, () => {
  const apiMd = readFileSync(API_MD, 'utf8');
  const validationMd = readFileSync(VALIDATION_MD, 'utf8');
  const rulesVersion = JSON.parse(readFileSync(RULES_VERSION_JSON, 'utf8')).rulesVersion;

  // 1. 注册表行：`| E-AUTH-001 | ... |` 形式（api.md §错误码注册表）
  const registryRows = [...apiMd.matchAll(/^\| (E|W|N)-(AUTH|AUTHZ|MAINT|RES)-\d{3} \|/gm)].map(
    (m) => m[1] + '-' + m[2] + '-' + (m[0].match(/\d{3}/)?.[0] ?? '')
  );
  assert.ok(registryRows.length >= 8, `api.md 注册表应含 ≥8 码，实得 ${registryRows.length}`);
  const registry = new Set(registryRows);

  // 2. 正文用码（排除注册表行自身）均在注册表内
  const body = apiMd.replace(/^\| (E|W|N)-(AUTH|AUTHZ|MAINT|RES)-\d{3} \|.*$/gm, '');
  const used = new Set([...body.matchAll(/\b[EWN]-(?:AUTH|AUTHZ|MAINT|RES)-\d{3}\b/g)].map((m) => m[0]));
  const unregistered = [...used].filter((c) => !registry.has(c));
  assert.deepEqual(unregistered, [], `api.md 正文使用了未注册的 API 错误码：${unregistered}`);

  // 3. 区域前缀与 T2 注册表不相交（coordinator 边界要求：两层关系）
  const t2Prefixes = new Set(
    [...validationMd.matchAll(/^\| [EWN]-([A-Z]+)-\d{3} \|/gm)].map((m) => m[1])
  );
  const apiPrefixes = new Set(
    [...apiMd.matchAll(/^\| [EWN]-([A-Z]+)-\d{3} \|/gm)].map((m) => m[1])
  );
  const overlap = [...apiPrefixes].filter((p) => t2Prefixes.has(p));
  assert.deepEqual(overlap, [], `API 注册表区域前缀与 T2 重叠：${overlap}`);

  // 4. rulesVersion 唯一机器来源被 api.md 以同串引用（sprint 场景 S3 核对点）
  assert.ok(
    apiMd.includes(rulesVersion),
    `api.md 应引用 rules-version.json 的 rulesVersion=${rulesVersion}`
  );
  assert.ok(apiMd.includes('rules-version.json'), 'api.md 应引用 docs/contracts/rules-version.json 路径');
});
