import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../src/app.ts';
import { startApp } from '../src/main.ts';
import { CredentialsService } from '../src/credentials/service.ts';
import { VaultService } from '../src/vaults/service.ts';
import { createVaultRepoOps } from '../src/gitrepo/lifecycle.ts';
import { vaultRepoPath } from '../src/vaults/repo-path.ts';
import { openDatabase } from '../src/db/connection.ts';
import { migrate } from '../src/db/migrate.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { FIXTURE_DDL, addEmployee, addMember, newDb } from './credentials-fixtures.ts';
import { drainCount, recordAuditEvent, settleAuditEvent } from '../src/audit/audit.ts';
import {
  AUDIT_CHAIN_SQL,
  auditChain,
  listPendingReconciliation,
  sweepOrphanedPending,
} from '../src/audit/reconciliation.ts';
import {
  createPushByteCounter,
  measureVaultBytes,
  newPushId,
  preRecordPendingPush,
  settlePushByRefState,
  settlePushRejected,
  type PushCommand,
} from '../src/githttp/receive-audit.ts';
import { rulesVersion } from 'notegit-validation';

// S3-T6 receive 审计预记录与结果核对（implementation-breakdown §2.2 S3-T6 行完成标准）：
// - 正常 push 审计成链（old→new 相邻，backup §5 不变量 1）
// - 注入中断（kill receive-pack）后无「审计成功但 ref 未更新」或反向（§5 不变量 2），
//   残留行标待核对 unresolved；quarantine 原子性兜底（对象不入主库）
// - 超时/重试不重复发布不虚报成功
// - 待核对状态可被 S8 恢复对账消费（查询接口最小实现，backup §7 步骤 7）
// - E-LIMIT-004/005 计量挂接（push 字节与库容量采集进审计 detail；判定阈值 T8 生效）
//
// 被测形态与 prereceive-validation.test.ts 同构：真实 Fastify 应用 + 文件 SQLite +
// tmp dataDir 真实 bare 仓库 + 标准 git 客户端。D6：断言禁全等硬编码——期望值一律
// 自运行时派生（rev-parse / 实测字节数 / 运行时 rulesVersion）。

const run = promisify(execFile);
const runSync = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: 'utf8' });

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
};

async function git(args: string[], opts: { cwd?: string } = {}): Promise<{ stdout: string; stderr: string }> {
  return run('git', args, { ...opts, env: GIT_ENV });
}

interface PushError extends Error {
  code?: number | string;
  stdout?: string;
  stderr?: string;
}

async function writeMd(dir: string, file: string, body: string): Promise<void> {
  const abs = path.join(dir, file);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, body);
}

// ── 单元面：审计链模块（先于 E2E 的 RED 基线）────────────────────────────────

const NOW = new Date().toISOString();
const ZERO_OID = '0'.repeat(40);

test('preRecordPendingPush：每 ref 命令一行 pending，主体=认证员工 + credential 载体 + git 入口（identity §8）', () => {
  const db = newDb();
  const emp = addEmployee(db, { username: 'alice' });
  const vaultId = 1; // FK 由夹具表存在性满足即可？——vaults 需真实行（foreign_keys=ON）
  db.prepare(`INSERT INTO vaults (slug, name, created_by, created_at) VALUES ('v1', 'V1', ?, ?)`).run(emp, NOW);
  const commands: PushCommand[] = [
    { ref: 'refs/heads/main', oldOid: ZERO_OID, newOid: 'a'.repeat(40) },
    { ref: 'refs/heads/topic', oldOid: 'b'.repeat(40), newOid: 'c'.repeat(40) },
  ];
  const pushId = newPushId();
  const ids = preRecordPendingPush(db, {
    subject: { employeeId: emp, carrierRef: 'credential:7', entry: 'git' },
    vaultId,
    commands,
    pushId,
    occurredAt: NOW,
  });
  assert.equal(ids.length, 2, '多 ref push 每 ref 一行');
  const rows = db
    .prepare(`SELECT * FROM audit_events WHERE event_kind = 'vault.push' ORDER BY id`)
    .all() as Record<string, unknown>[];
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row['status'], 'pending');
    assert.equal(row['employee_id'], emp, '主体=认证员工（非 commit author）');
    assert.equal(row['credential_ref'], 'credential:7');
    assert.equal(row['entry'], 'git', 'identity §8 入口=git');
    assert.equal(row['vault_id'], vaultId);
    assert.equal(row['occurred_at'], NOW);
    const detail = JSON.parse(row['detail'] as string) as { pushId: string };
    assert.equal(detail.pushId, pushId, 'detail 携带 pushId（终态核对与中断清扫的关联键）');
  }
  const byRef = new Map(rows.map((r) => [r['ref_name'], r]));
  assert.equal(byRef.get('refs/heads/main')!['old_commit'], ZERO_OID);
  assert.equal(byRef.get('refs/heads/main')!['new_commit'], 'a'.repeat(40));
  assert.equal(byRef.get('refs/heads/topic')!['old_commit'], 'b'.repeat(40));
  db.close();
});

test('settlePushRejected：整包拒绝时该 pushId 全部 pending 行置 rejected 并合并原因', () => {
  const db = newDb();
  const emp = addEmployee(db, { username: 'alice' });
  db.prepare(`INSERT INTO vaults (slug, name, created_by, created_at) VALUES ('v1', 'V1', ?, ?)`).run(emp, NOW);
  const pushId = newPushId();
  const ids = preRecordPendingPush(db, {
    subject: { employeeId: emp, carrierRef: 'credential:7', entry: 'git' },
    vaultId: 1,
    commands: [
      { ref: 'refs/heads/main', oldOid: ZERO_OID, newOid: 'a'.repeat(40) },
      { ref: 'refs/heads/topic', oldOid: 'b'.repeat(40), newOid: 'c'.repeat(40) },
    ],
    pushId,
    occurredAt: NOW,
  });
  settlePushRejected(db, { pushId, reason: 'validation', detail: { rulesVersion: 'x' } });
  const rows = db.prepare(`SELECT status, detail FROM audit_events WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as { status: string; detail: string }[];
  for (const row of rows) {
    assert.equal(row.status, 'rejected');
    const detail = JSON.parse(row.detail) as { reason: string; rulesVersion: string };
    assert.equal(detail.reason, 'validation');
    assert.equal(detail.rulesVersion, 'x');
  }
  assert.equal(drainCount(db), 0, '拒绝是终态，不阻排空');
  db.close();
});

test('settlePushByRefState：核对引用实际结果——actual==new 置 succeeded，否则 rejected（storage-model §6 步骤 3）', async () => {
  const db = newDb();
  const emp = addEmployee(db, { username: 'alice' });
  db.prepare(`INSERT INTO vaults (slug, name, created_by, created_at) VALUES ('v1', 'V1', ?, ?)`).run(emp, NOW);
  const pushId = newPushId();
  const ids = preRecordPendingPush(db, {
    subject: { employeeId: emp, carrierRef: 'credential:7', entry: 'git' },
    vaultId: 1,
    commands: [
      { ref: 'refs/heads/main', oldOid: 'p'.repeat(40), newOid: 'a'.repeat(40) },
      { ref: 'refs/heads/gone', oldOid: 'q'.repeat(40), newOid: 'd'.repeat(40) }, // 未生效（如 update 拒绝）
    ],
    pushId,
    occurredAt: NOW,
  });
  void ids;
  // 删除命令：new=全零 OID；成功删除后 ref 不存在（actual=null）
  preRecordPendingPush(db, {
    subject: { employeeId: emp, carrierRef: 'credential:7', entry: 'git' },
    vaultId: 1,
    commands: [{ ref: 'refs/heads/obsolete', oldOid: 'z'.repeat(40), newOid: ZERO_OID }],
    pushId,
    occurredAt: NOW,
  });
  const actual: Record<string, string | null> = {
    'refs/heads/main': 'a'.repeat(40),
    'refs/heads/gone': null, // ref 实际未更新（删除态/不存在）
    'refs/heads/obsolete': null, // 已删除成功
  };
  await settlePushByRefState(db, {
    pushId,
    actualOf: async (ref) => actual[ref] ?? null,
    detail: { rulesVersion: 'rv' },
  });
  const rows = db.prepare(`SELECT ref_name, status FROM audit_events ORDER BY id`).all() as { ref_name: string; status: string }[];
  assert.deepEqual(
    rows.map((r) => [r.ref_name, r.status]),
    [
      ['refs/heads/main', 'succeeded'],
      ['refs/heads/gone', 'rejected'],
      ['refs/heads/obsolete', 'succeeded'],
    ],
    'actual==new → succeeded；删除成功（new=全零、ref 已不在）同样 succeeded；不符 → rejected，不虚报成功',
  );
  assert.equal(drainCount(db), 0);
  db.close();
});

test('sweepOrphanedPending：中断残留 pending → unresolved（待核对）；pushId 定域不误伤并发推送', () => {
  const db = newDb();
  const emp = addEmployee(db, { username: 'alice' });
  db.prepare(`INSERT INTO vaults (slug, name, created_by, created_at) VALUES ('v1', 'V1', ?, ?)`).run(emp, NOW);
  const killed = newPushId();
  const other = newPushId();
  const killedIds = preRecordPendingPush(db, {
    subject: { employeeId: emp, carrierRef: 'credential:7', entry: 'git' },
    vaultId: 1,
    commands: [{ ref: 'refs/heads/main', oldOid: 'p'.repeat(40), newOid: 'a'.repeat(40) }],
    pushId: killed,
    occurredAt: NOW,
  });
  const otherIds = preRecordPendingPush(db, {
    subject: { employeeId: emp, carrierRef: 'credential:7', entry: 'git' },
    vaultId: 1,
    commands: [{ ref: 'refs/heads/feat', oldOid: 'p'.repeat(40), newOid: 'e'.repeat(40) }],
    pushId: other,
    occurredAt: NOW,
  });
  const n = sweepOrphanedPending(db, { pushId: killed, reason: 'receive-aborted' });
  assert.equal(n, 1, '只清扫被中断 push 的行');
  const status = (ids: number[]) =>
    (db.prepare(`SELECT status FROM audit_events WHERE id = ?`).get(ids[0]) as { status: string }).status;
  assert.equal(status(killedIds), 'unresolved');
  assert.equal(status(otherIds), 'pending', '在途推送不受殃及');
  const detail = JSON.parse(
    (db.prepare(`SELECT detail FROM audit_events WHERE id = ?`).get(killedIds[0]) as { detail: string }).detail,
  ) as { reason: string };
  assert.equal(detail.reason, 'receive-aborted');
  // 无 pushId = 全量清扫（启动恢复形态：单进程下启动时不存在在途写）
  assert.equal(sweepOrphanedPending(db, { reason: 'startup-orphan' }), 1);
  assert.equal(status(otherIds), 'unresolved');
  assert.equal(drainCount(db), 2, 'unresolved 计入排空口径——由 S8 恢复对账消费');
  db.close();
});

test('auditChain：成功终态 old→new 有序成链（backup §5 不变量 1 的核对查询）', () => {
  const db = newDb();
  const emp = addEmployee(db, { username: 'alice' });
  db.prepare(`INSERT INTO vaults (slug, name, created_by, created_at) VALUES ('v1', 'V1', ?, ?)`).run(emp, NOW);
  recordAuditEvent(db, {
    occurredAt: NOW, actorKind: 'employee',
    subject: { employeeId: emp, carrierRef: 'credential:1', entry: 'git' },
    eventKind: 'vault.push', vaultId: 1, refName: 'refs/heads/main',
    oldCommit: ZERO_OID, newCommit: 'a'.repeat(40), status: 'pending',
  });
  const first = db.prepare(`SELECT id FROM audit_events ORDER BY id LIMIT 1`).get() as { id: number };
  settleAuditEvent(db, first.id, 'succeeded');
  recordAuditEvent(db, {
    occurredAt: NOW, actorKind: 'employee',
    subject: { employeeId: emp, carrierRef: 'credential:1', entry: 'git' },
    eventKind: 'vault.push', vaultId: 1, refName: 'refs/heads/main',
    oldCommit: 'a'.repeat(40), newCommit: 'b'.repeat(40), status: 'succeeded',
  });
  // 非成功行不得进入链
  recordAuditEvent(db, {
    occurredAt: NOW, actorKind: 'employee',
    subject: { employeeId: emp, carrierRef: 'credential:1', entry: 'git' },
    eventKind: 'vault.push', vaultId: 1, refName: 'refs/heads/main',
    oldCommit: 'b'.repeat(40), newCommit: 'c'.repeat(40), status: 'rejected',
  });
  const chain = auditChain(db, 1);
  assert.deepEqual(
    chain.map((r) => [r.old_commit, r.new_commit]),
    [
      [ZERO_OID, 'a'.repeat(40)],
      ['a'.repeat(40), 'b'.repeat(40)],
    ],
    '相邻成链且只含成功终态',
  );
  db.close();
});

test('audit.chain 规范 SQL 与契约逐字一致（storage-model §4，防漂移）', async () => {
  const doc = await readFile(path.resolve(import.meta.dirname, '../../docs/contracts/storage-model.md'), 'utf8');
  const m = /```sql\n-- @query audit\.chain\n([\s\S]*?)```/.exec(doc);
  assert.ok(m, 'storage-model.md 应含 -- @query audit.chain 块');
  const contractLines = m[1]!.split('\n').map((l) => l.trimEnd()).filter((l) => l.length > 0);
  const mine = AUDIT_CHAIN_SQL.split('\n').map((l) => l.trimEnd()).filter((l) => l.length > 0);
  assert.deepEqual(mine, contractLines);
});

test('listPendingReconciliation：pending/unresolved 发布行可被 S8 恢复对账消费（backup §7 步骤 7）', () => {
  const db = newDb();
  const emp = addEmployee(db, { username: 'alice' });
  db.prepare(`INSERT INTO vaults (slug, name, created_by, created_at) VALUES ('v1', 'V1', ?, ?)`).run(emp, NOW);
  for (const [status, ref] of [['pending', 'refs/heads/a'], ['unresolved', 'refs/heads/b'], ['succeeded', 'refs/heads/c']] as const) {
    recordAuditEvent(db, {
      occurredAt: NOW, actorKind: 'employee',
      subject: { employeeId: emp, carrierRef: 'credential:1', entry: 'git' },
      eventKind: 'vault.push', vaultId: 1, refName: ref,
      oldCommit: ZERO_OID, newCommit: 'a'.repeat(40), status,
    });
  }
  recordAuditEvent(db, {
    occurredAt: NOW, actorKind: 'employee',
    subject: { employeeId: emp, carrierRef: 'credential:1', entry: 'git' },
    eventKind: 'credential.revoke', status: 'succeeded',
  });
  const rows = listPendingReconciliation(db);
  assert.deepEqual(
    rows.map((r) => [r.ref_name, r.status]).sort(),
    [
      ['refs/heads/a', 'pending'],
      ['refs/heads/b', 'unresolved'],
    ],
    '只列发布类待核对行（含 id/主体/时间，供对账定终态）',
  );
  for (const row of rows) {
    assert.ok(row.id > 0);
    assert.ok(row.employee_id === emp);
    assert.ok(typeof row.occurred_at === 'string');
  }
  db.close();
});

test('createPushByteCounter：透传字节并精确计数，终值落盘（chunked 推送无 CONTENT_LENGTH 时的计量）', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'notegit-t6-unit-'));
  try {
    const file = path.join(dir, 'push.bytes');
    const counter = createPushByteCounter(file);
    const sink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        received.push(chunk);
        cb();
      },
    });
    const received: Buffer[] = [];
    const chunks = [Buffer.from('a'.repeat(100)), Buffer.alloc(50, 7), Buffer.from('xyz')];
    const total = chunks.reduce((n, c) => n + c.length, 0);
    await pipeline(Readable.from(chunks), counter, sink);
    assert.equal(Buffer.concat(received).length, total, '透传不改字节');
    assert.equal(counter.bytes, total, '计数精确');
    assert.equal(await readFile(file, 'utf8'), String(total), '终值落盘');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('measureVaultBytes：库目录占用求和，排除在途 quarantine（objects/incoming-*）', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'notegit-t6-unit-'));
  try {
    await mkdir(path.join(dir, 'objects', 'incoming-abc', 'aa'), { recursive: true });
    await mkdir(path.join(dir, 'refs', 'heads'), { recursive: true });
    const body = Buffer.alloc(4096, 1);
    await writeFile(path.join(dir, 'objects', 'incoming-abc', 'aa', 'obj'), body); // quarantine：不计
    await writeFile(path.join(dir, 'refs', 'heads', 'main'), Buffer.from('a'.repeat(40)));
    await writeFile(path.join(dir, 'config'), Buffer.alloc(100));
    const bytes = await measureVaultBytes(dir);
    assert.equal(bytes, 40 + 100, '只计存量占用（incoming-* 为本次推送在途对象）');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


/** 本测试进程派生的 receive-pack PID（http-backend 链：test → git http-backend →
 *  git-http-backend → git receive-pack --stateless-rpc .；命令行无仓库路径，按祖先定域） */
function findMyReceivePackPids(): number[] {
  const table = runSync('ps', ['axww', '-o', 'pid,ppid,command=']);
  const procs = table
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => /^(\d+)\s+(\d+)\s+(.+)$/.exec(l))
    .map((m) => (m === null ? null : { pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] ?? '' }))
    .filter((p): p is { pid: number; ppid: number; cmd: string } => p !== null);
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const isDescendant = (pid: number): boolean => {
    let cur = byPid.get(pid);
    const seen = new Set<number>();
    while (cur !== undefined && !seen.has(cur.pid)) {
      if (cur.pid === process.pid) return true;
      seen.add(cur.pid);
      cur = byPid.get(cur.ppid);
    }
    return false;
  };
  return procs
    .filter((p) => /receive-pack .*--stateless-rpc/.test(p.cmd) && isDescendant(p.pid))
    .map((p) => p.pid);
}

// ── E2E：真实 Fastify 应用 + 文件 SQLite + 真实 bare 仓库 + 标准 git 客户端 ────

interface Harness {
  app: FastifyInstance;
  db: DatabaseSync;
  dataDir: string;
  dbFile: string;
  docsRepo: string;
  vaultId: number;
  port: number;
  aliceId: number;
  aliceCredentialId: number;
  bobCredentialId: number;
  tokens: Record<'alice' | 'bob', string>;
  urlFor(slug: string, who: 'alice' | 'bob'): string;
  seedMain: string;
  close(): Promise<void>;
}

let h: Harness;

async function startE2E(): Promise<Harness> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'notegit-t6-'));
  const dbFile = path.join(dataDir, 'db', 'notegit.sqlite');
  await mkdir(path.dirname(dbFile), { recursive: true });
  const db = openDatabase(dbFile);
  migrate(db, MIGRATIONS);
  for (const ddl of FIXTURE_DDL) db.exec(ddl);

  const pepper = { active: { version: 1, key: randomBytes(32) }, retired: [] as never[] };
  const alice = addEmployee(db, { username: 'alice' });
  const bob = addEmployee(db, { username: 'bob' });

  const vaultService = new VaultService({ db, repoOps: createVaultRepoOps(dataDir) });
  const docs = await vaultService.createVaultWithRepo(
    { name: 'Docs', slug: 'docs' },
    { employeeId: alice, entry: 'web', carrierRef: 'session:fixture' },
  );
  addMember(db, docs.id, bob, 'editor', alice);

  const credentials = new CredentialsService({ db, pepper });
  const expires = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const aliceCred = credentials.createCredential(alice, { name: 'git-alice', expires_at: expires });
  const bobCred = credentials.createCredential(bob, { name: 'git-bob', expires_at: expires });

  const docsRepo = vaultRepoPath(dataDir, docs.id);
  const seed = path.join(dataDir, 'seed');
  await git(['init', '-b', 'main', seed]);
  await writeMd(seed, 'README.md', '# nav\n');
  await writeMd(seed, 'notes/first.md', '---\ntitle: First\n---\nbody\n');
  await git(['-C', seed, 'add', '.']);
  await git(['-C', seed, '-c', 'user.email=seed@notegit.test', '-c', 'user.name=seed', 'commit', '-m', 'seed']);
  await git(['-C', seed, 'push', docsRepo, 'main']);
  const seedMain = (await git(['--git-dir', docsRepo, 'rev-parse', 'main'])).stdout.trim();

  const app = buildApp({
    db,
    pepper,
    bootstrapTokenFile: path.join(dataDir, 'config', 'admin-bootstrap.token'),
    dataDir,
    dbFile,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = app.addresses()[0]!.port;

  return {
    app,
    db,
    dataDir,
    dbFile,
    docsRepo,
    vaultId: docs.id,
    port,
    aliceId: alice,
    aliceCredentialId: aliceCred.record.id,
    bobCredentialId: bobCred.record.id,
    tokens: { alice: aliceCred.token, bob: bobCred.token },
    urlFor: (slug, who) => `http://${who}:${h.tokens[who]}@127.0.0.1:${port}/git/${slug}.git`,
    seedMain,
    close: async () => {
      await app.close();
      db.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

before(async () => {
  h = await startE2E();
});

after(async () => {
  await h.close();
});

interface AuditRow {
  id: number;
  employee_id: number | null;
  credential_ref: string | null;
  entry: string;
  event_kind: string;
  vault_id: number | null;
  ref_name: string | null;
  old_commit: string | null;
  new_commit: string | null;
  status: string;
  occurred_at: string;
  detail: string;
}

function pushRows(status?: string): AuditRow[] {
  const rows = h.db
    .prepare(`SELECT * FROM audit_events WHERE event_kind = 'vault.push' ORDER BY id`)
    .all() as unknown as AuditRow[];
  return status === undefined ? rows : rows.filter((r) => r.status === status);
}

/** 等待审计行进入指定状态（hook 子进程与测试进程经 WAL 相互可见） */
async function waitForRows(status: string, deadlineMs = 30_000): Promise<AuditRow[]> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const rows = pushRows(status);
    if (rows.length > 0) return rows;
    if (Date.now() > deadline) throw new Error(`等待 ${status} 审计行超时`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function oidOf(ref: string): Promise<string> {
  return (await git(['--git-dir', h.docsRepo, 'rev-parse', ref])).stdout.trim();
}

async function oidExists(oid: string): Promise<boolean> {
  try {
    await git(['--git-dir', h.docsRepo, 'cat-file', '-e', `${oid}^{object}`]);
    return true;
  } catch {
    return false;
  }
}

let e2eClone: string;

test('E2E 正常 push：pending→succeeded 审计成链，主体=认证员工（伪造 author 不入主体），计量入 detail', async () => {
  e2eClone = path.join(h.dataDir, 'clone-e2e');
  await git(['clone', h.urlFor('docs', 'alice'), e2eClone]);
  await writeMd(e2eClone, 'notes/second.md', '---\ntitle: Second\n---\nbody\n');
  await git(['-C', e2eClone, 'add', '.']);
  // 伪造 author/committer（架构 §4.4：客户端可填，仅元数据，不作身份凭证）
  await git(['-C', e2eClone, '-c', 'user.email=mallory@evil.test', '-c', 'user.name=Mallory The Forger', 'commit', '-m', 'c1']);
  const head = (await git(['-C', e2eClone, 'rev-parse', 'HEAD'])).stdout.trim();
  await git(['-C', e2eClone, 'push', 'origin', 'main']);

  const succeeded = pushRows('succeeded');
  assert.equal(succeeded.length, 1, '一次 push 一行成功终态');
  const row = succeeded[0]!;
  assert.equal(row.employee_id, h.aliceId, '主体=认证员工（token 归属），非 commit author');
  assert.equal(row.credential_ref, `credential:${h.aliceCredentialId}`, '载体=推送所用凭据');
  assert.equal(row.entry, 'git', '入口=git（identity §8）');
  assert.equal(row.vault_id, h.vaultId);
  assert.equal(row.ref_name, 'refs/heads/main');
  assert.equal(row.old_commit, h.seedMain, 'old=推送前 ref 实际值（派生，非硬编码）');
  assert.equal(row.new_commit, head, 'new=推送后 ref 实际值');
  assert.equal(row.new_commit, await oidOf('main'), '成功行 new 与 ref 当前 OID 一致（§5 不变量 1）');
  assert.ok(!JSON.stringify(row).includes('Mallory'), '客户端伪造的 author 不出现在审计行');
  const detail = JSON.parse(row.detail) as Record<string, unknown>;
  assert.equal(detail['rulesVersion'], rulesVersion(), 'detail 内嵌运行时 rulesVersion（同构性锚点）');
  assert.ok(typeof detail['pushBytes'] === 'number' && (detail['pushBytes'] as number) > 0, 'E-LIMIT-004 计量：push 字节已采集');
  assert.ok(
    typeof detail['vaultCurrentBytes'] === 'number' && (detail['vaultCurrentBytes'] as number) > 0,
    'E-LIMIT-005 计量：库容量已采集',
  );
  // 成链：成功序列 old→new 首尾相接，链尾=ref 当前 OID（backup §5 不变量 1）
  const chain = auditChain(h.db, h.vaultId).filter((r) => r.ref_name === 'refs/heads/main');
  assert.deepEqual(chain.map((r) => [r.old_commit, r.new_commit]), [[h.seedMain, head]]);
  assert.equal(drainCount(h.db), 0, '终态后可排空（backup §4 步骤 2）');
});

test('E2E 多 ref push：每 ref 一行（storage-model §6 批量预记录），各 ref 链独立成链', async () => {
  await writeMd(e2eClone, 'notes/third.md', '---\ntitle: Third\n---\nbody\n');
  await git(['-C', e2eClone, 'add', '.']);
  await git(['-C', e2eClone, '-c', 'user.email=alice@notegit.test', '-c', 'user.name=alice', 'commit', '-m', 'c2']);
  const head = (await git(['-C', e2eClone, 'rev-parse', 'HEAD'])).stdout.trim();
  await git(['-C', e2eClone, 'branch', 'topic']);
  const mainBefore = await oidOf('main');
  await git(['-C', e2eClone, 'push', 'origin', 'main', 'topic']);

  const both = pushRows('succeeded').filter((r) => r.new_commit === head);
  assert.equal(both.length, 2, '一次 push 两个 ref → 两行成功终态');
  assert.deepEqual(new Set(both.map((r) => r.ref_name)), new Set(['refs/heads/main', 'refs/heads/topic']));
  const topicRow = both.find((r) => r.ref_name === 'refs/heads/topic')!;
  assert.equal(topicRow.old_commit, ZERO_OID, '新建分支 old=全零 OID');
  const chainMain = auditChain(h.db, h.vaultId).filter((r) => r.ref_name === 'refs/heads/main');
  assert.equal(chainMain.length, 2, '本 ref 两次成功发布 → 两段');
  assert.equal(chainMain[0]!.new_commit, chainMain[1]!.old_commit, '成功段相邻成链：前段 new=后段 old（backup §5 不变量 1）');
  assert.equal(chainMain[0]!.old_commit, h.seedMain, '链首衔接种子基线');
  assert.equal(chainMain[1]!.new_commit, head, '链尾=ref 当前值');
  assert.equal(chainMain[1]!.new_commit, await oidOf('main'), '与实际 ref 一致');
});

test('E2E 拒绝 push（内容违规）：行置 rejected，ref 不变，成功链不受污染', async () => {
  const mainBefore = await oidOf('main');
  await writeMd(e2eClone, 'notes/bad.md', '# 没有 frontmatter 的正文\n'); // 非 README → E-FM-001
  await git(['-C', e2eClone, 'add', '.']);
  await git(['-C', e2eClone, '-c', 'user.email=bob@notegit.test', '-c', 'user.name=bob', 'commit', '-m', 'bad']);
  const badHead = (await git(['-C', e2eClone, 'rev-parse', 'HEAD'])).stdout.trim();
  const succeededBefore = pushRows('succeeded').length;
  const err = await git(['-C', e2eClone, 'push', 'origin', 'main']).then(
    () => assert.fail('违规推送应被拒绝'),
    (e: PushError) => e,
  );
  assert.ok(err.code !== 0);
  assert.match(String(err.stderr), /E-FM-001|notegit pre-receive/, '拒绝信息可读');

  const rejected = pushRows('rejected');
  assert.equal(rejected.length, 1, '拒绝也留审计行（DOD-11：记录结果）');
  assert.equal(rejected[0]!.new_commit, badHead);
  assert.equal(rejected[0]!.old_commit, mainBefore);
  assert.equal(await oidOf('main'), mainBefore, 'ref 未变');
  assert.equal(pushRows('succeeded').length, succeededBefore, '无虚假成功');
  const detail = JSON.parse(rejected[0]!.detail) as Record<string, unknown>;
  assert.equal(detail['rulesVersion'], rulesVersion());
  assert.equal(typeof detail['reason'], 'string');
  assert.equal(drainCount(h.db), 0);
});

test('E2E 中断注入：kill receive-pack（校验期）→ 无虚假成功、ref 不变、残留行标待核对、quarantine 原子性兜底', async () => {
  // 构造慢校验窗口：chaos 分支多提交（逐提交 git 遍历 + 校验），预记录先于校验落库。
  // 自 origin/main 分出（本地 main 携带上例被拒的 bad.md 提交，不得进入本推送）
  await git(['-C', e2eClone, 'checkout', '-b', 'chaos', 'origin/main']);
  for (let i = 0; i < 120; i++) {
    await writeMd(e2eClone, `notes/chaos-${i}.md`, `---\ntitle: Chaos ${i}\n---\nbody ${i}\n`);
    await git(['-C', e2eClone, 'add', '.']);
    await git(['-C', e2eClone, '-c', 'user.email=alice@notegit.test', '-c', 'user.name=alice', 'commit', '-m', `chaos-${i}`]);
  }
  const chaosHead = (await git(['-C', e2eClone, 'rev-parse', 'HEAD'])).stdout.trim();
  const succeededBefore = pushRows('succeeded').length;

  // 后台起 push；待 pending 预记出现后立即 kill receive-pack。
  // 定位依据：receive-pack 由 http-backend 以 `git receive-pack --stateless-rpc .`
  // 启动（命令行不含仓库路径），故按「本测试进程的后代 + receive-pack 形态」筛选，
  // 不误伤并行测试文件的推送。
  const pushDone = git(['-C', e2eClone, 'push', 'origin', 'chaos']);
  const pending = await waitForRows('pending');
  const chaosPushIds = new Set(pending.map((r) => (JSON.parse(r.detail) as { pushId: string }).pushId));
  let pids: number[] = [];
  const killDeadline = Date.now() + 15_000;
  while (Date.now() < killDeadline) {
    pids = findMyReceivePackPids();
    if (pids.length > 0) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(pids.length > 0, '应能定位本测试进程派生的 receive-pack（校验期存活）');
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // 已退出：无需处理
    }
  }
  const pushResult = await pushDone.then(
    () => 'ok',
    (e: PushError) => `failed(${e.code})`,
  );
  assert.notEqual(pushResult, 'ok', '客户端不得看到成功（kill 注入后响应失败）');

  // 子进程退出 → HTTP 层按 pushId 清扫 → 残留行标待核对
  const unresolved = await waitForRows('unresolved');
  const chaosUnresolved = unresolved.filter((r) => chaosPushIds.has((JSON.parse(r.detail) as { pushId: string }).pushId));
  assert.ok(chaosUnresolved.length >= 1, '被中断推送的残留行标 unresolved（待核对）');
  assert.equal(pushRows('succeeded').length, succeededBefore, '无「审计成功」（§5 不变量 2 前半）');
  for (const row of chaosUnresolved) {
    assert.notEqual(row.status, 'succeeded');
  }
  // ref 未更新（§5 不变量 2 后半）：chaos 分支不存在
  let chaosExists = true;
  try {
    await oidOf('refs/heads/chaos');
  } catch {
    chaosExists = false;
  }
  assert.ok(!chaosExists, 'ref 未更新——不存在「ref 已更新却无成功审计」的反向状态');
  // quarantine 原子性兜底：对象只落隔离区，未迁入主对象库（receive-pack 异常终止）
  assert.ok(!(await oidExists(chaosHead)), '推送对象不得进入主对象库（quarantine 原子性）');
  assert.ok(drainCount(h.db) >= 1, '待核对行在排空口径内——等待 S8 恢复对账');
});

test('E2E S8 恢复对账消费：unresolved 行经查询接口核对 ref 实际值定终态', async () => {
  const pending = listPendingReconciliation(h.db);
  assert.ok(pending.length >= 1, '存在待核对行（上一用例注入的中断残留）');
  for (const row of pending) {
    assert.equal(row.status, 'unresolved');
    let actual: string | null = null;
    if (row.ref_name !== null) {
      try {
        actual = await oidOf(row.ref_name);
      } catch {
        actual = null; // ref 不存在
      }
    }
    // 架构 §4.4：恢复核对按引用实际 OID 标终态——chaos 分支从未创建 → rejected
    settleAuditEvent(h.db, row.id, actual !== null && actual === row.new_commit ? 'succeeded' : 'rejected', {
      reason: 'recovery-reconciled',
    });
  }
  assert.equal(drainCount(h.db), 0, '对账后全部终态，排空条件恢复');
});

test('E2E 超时/重试：中断后重推同分支仅一次成功；up-to-date 重推不新增审计行（不重复发布不虚报）', async () => {
  const succeededBefore = pushRows('succeeded').length;
  await git(['-C', e2eClone, 'push', 'origin', 'chaos']);
  const chaosHead = (await git(['-C', e2eClone, 'rev-parse', 'chaos'])).stdout.trim();
  assert.equal(await oidOf('refs/heads/chaos'), chaosHead, '重推生效');

  const chaosSucceeded = pushRows('succeeded').filter((r) => r.ref_name === 'refs/heads/chaos');
  assert.equal(chaosSucceeded.length, 1, '同一发布恰好一行成功（重试不重复发布）');
  assert.equal(chaosSucceeded[0]!.old_commit, ZERO_OID, '新建分支 old=全零');
  assert.equal(pushRows('succeeded').length, succeededBefore + 1, '仅新增一行');
  const chain = auditChain(h.db, h.vaultId).filter((r) => r.ref_name === 'refs/heads/chaos');
  assert.equal(chain.length, 1);

  // 客户端超时后原样重发（up-to-date）：无 ref 命令 → 不新增任何审计行，更无成功行
  const totalRows = pushRows().length;
  await git(['-C', e2eClone, 'push', 'origin', 'chaos']);
  assert.equal(pushRows('succeeded').length, succeededBefore + 1, 'up-to-date 重推零新增成功行');
  assert.equal(pushRows().length, totalRows, 'up-to-date 重推零新增审计行（任何状态）——不重复发布不虚报');
});

test('E2E 分支删除推送：成链含 new=全零段（删除成功不虚报为 rejected）', async () => {
  const topicHead = await oidOf('refs/heads/topic');
  await git(['-C', e2eClone, 'push', 'origin', ':topic']);
  const delRows = pushRows('succeeded').filter((r) => r.ref_name === 'refs/heads/topic' && r.new_commit === ZERO_OID);
  assert.equal(delRows.length, 1, '删除命令一行成功终态（new=全零 OID）');
  assert.equal(delRows[0]!.old_commit, topicHead, 'old=删除前 ref 值');
  let stillThere = true;
  try {
    await oidOf('refs/heads/topic');
  } catch {
    stillThere = false;
  }
  assert.ok(!stillThere, 'ref 已删除');
  const chain = auditChain(h.db, h.vaultId).filter((r) => r.ref_name === 'refs/heads/topic');
  assert.ok(chain.some((r) => r.old_commit === topicHead && r.new_commit === ZERO_OID), '链含删除段');
  assert.equal(drainCount(h.db), 0);
});

test('执行点拒绝与预记录合流：HTTP 形态（有 pushId）update 拒绝 settle pending 行而非另起一行', async () => {
  // T5 直调形态（无 pushId）保留独立插行；HTTP 集成形态经 NOTEGIT_PUSH_ID 关联
  // 预记录行——一行一命令的生命周期（集成裁决，见 notes）
  const ref = 'refs/tags/oops'; // 非 refs/heads 命名空间：执行点复核必拒（T5 规则）
  const newOid = 'f'.repeat(40);
  const bobEmpRow = h.db.prepare(`SELECT id FROM employees WHERE username='bob'`).get() as { id: number };
  const pushId = 'push-upd-int';
  const ids = preRecordPendingPush(h.db, {
    subject: { employeeId: bobEmpRow.id, carrierRef: `credential:${h.bobCredentialId}`, entry: 'git' },
    vaultId: h.vaultId,
    commands: [{ ref, oldOid: ZERO_OID, newOid }],
    pushId,
    occurredAt: new Date().toISOString(),
  });
  const rowsBefore = pushRows().length;
  const hookEnv: Record<string, string> = {
    ...GIT_ENV,
    REMOTE_USER: `${bobEmpRow.id}:${h.bobCredentialId}`,
    NOTEGIT_DB: h.dbFile,
    NOTEGIT_VAULT_ID: String(h.vaultId),
    NOTEGIT_VAULT_SLUG: 'docs',
    NOTEGIT_PUSH_ID: pushId,
  };
  const hook = await new Promise<{ code: number | null }>((resolve, reject) => {
    const child: ChildProcess = execFile(
      'node',
      [path.resolve(import.meta.dirname, '../src/githttp/update.ts'), ref, ZERO_OID, newOid],
      { env: hookEnv },
      (err) => (err && typeof (err as NodeJS.ErrnoException).code === 'number' ? resolve({ code: (err as unknown as { code: number }).code }) : err ? reject(err) : resolve({ code: 0 })),
    );
    void child;
  });
  assert.notEqual(hook.code, 0, '执行点复查必拒（非 refs/heads 命名空间）');
  const row = h.db
    .prepare(`SELECT status, detail FROM audit_events WHERE id = ?`)
    .get(ids[0]!) as { status: string; detail: string };
  assert.equal(row.status, 'rejected', '预记录行被置 rejected（不新增行）');
  const detail = JSON.parse(row.detail) as Record<string, unknown>;
  assert.equal(detail['checkpoint'], 'update', 'detail 标记执行点来源');
  assert.equal(typeof detail['reason'], 'string');
  assert.equal(pushRows().length, rowsBefore, '不得另起一行（一行一命令生命周期）');
});

test('启动清扫：上次进程残留 pending → 启动时标 unresolved（单进程无在途写）', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'notegit-t6-boot-'));
  try {
    const stubHash = async (p: string) => `stub-hash$${p}`;
    const first = await startApp({ dataDir: dir, host: '127.0.0.1', port: 0, hashPassword: stubHash });
    for (const ddl of FIXTURE_DDL) first.db.exec(ddl);
    const emp = addEmployee(first.db, { username: 'alice' });
    first.db.prepare(`INSERT INTO vaults (slug, name, created_by, created_at) VALUES ('v1', 'V1', ?, ?)`).run(emp, NOW);
    // 模拟上次进程崩溃残留：直接落一行 pending（storage-model §6 步骤 4 形态）
    recordAuditEvent(first.db, {
      occurredAt: NOW, actorKind: 'employee',
      subject: { employeeId: emp, carrierRef: 'credential:1', entry: 'git' },
      eventKind: 'vault.push', vaultId: 1, refName: 'refs/heads/main',
      oldCommit: ZERO_OID, newCommit: 'a'.repeat(40), status: 'pending',
      detail: { pushId: 'push-crash-leftover' },
    });
    await first.close();

    const second = await startApp({ dataDir: dir, host: '127.0.0.1', port: 0, hashPassword: stubHash });
    try {
      const row = second.db.prepare(`SELECT status, detail FROM audit_events`).get() as { status: string; detail: string };
      assert.equal(row.status, 'unresolved', '启动即标待核对（S8 恢复对账消费）');
      assert.equal((JSON.parse(row.detail) as { reason: string }).reason, 'startup-orphan');
    } finally {
      await second.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
