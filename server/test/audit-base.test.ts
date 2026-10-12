import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { newDb, addEmployee, addVault } from './credentials-fixtures.ts';
import {
  AuditMaskingError,
  recordAuditEvent,
  settleAuditEvent,
  drainCount,
  AUDIT_DRAIN_COUNT_SQL,
  type AuditSubjectRef,
} from '../src/audit/audit.ts';

// S2-T7 审计主体基座（identity §8 唯一语义源；storage-model §3.8/§5 落库形态）：
// - 主体字段 = 认证员工 + 凭据载体标识（credential:<id> / session:<id>，不含任何
//   token 材料）+ 入口（web/api/git，architecture-notes §7.4 归因）；
// - commit author 仅作内容元数据（detail），永不进主体字段（identity §8）；
// - 敏感信息脱敏：ngt_ 明文/口令类字段不进审计（守卫 fail-closed）；
// - pending → 终态排空计数（backup-recovery §4 步骤 2 的 audit.drain_count）。

const NOW = '2026-10-13T10:00:00.000Z';

/** 带两名员工的库：主体字段指向真实员工（employee 外键生效） */
function seededDb(): { db: DatabaseSync; emp1: number; emp2: number } {
  const db = newDb();
  return { db, emp1: addEmployee(db, { username: 'alice' }), emp2: addEmployee(db, { username: 'bob' }) };
}

function subject(over?: Partial<AuditSubjectRef>, employeeId = 1): AuditSubjectRef {
  return { employeeId, carrierRef: 'session:7', entry: 'web', ...over };
}

function lastRow(db: DatabaseSync): Record<string, unknown> {
  return db.prepare('SELECT * FROM audit_events ORDER BY id DESC LIMIT 1').get() as Record<string, unknown>;
}

test('recordAuditEvent：employee 主体行落全量主体字段，管理类默认终态 succeeded', () => {
  const { db, emp1 } = seededDb();
  recordAuditEvent(db, {
    occurredAt: NOW,
    actorKind: 'employee',
    subject: subject(undefined, emp1),
    eventKind: 'employee.create',
    detail: { username: 'newbie' },
  });
  const row = lastRow(db);
  assert.equal(row['actor_kind'], 'employee');
  assert.equal(row['employee_id'], emp1);
  assert.equal(row['credential_ref'], 'session:7');
  assert.equal(row['entry'], 'web');
  assert.equal(row['event_kind'], 'employee.create');
  assert.equal(row['vault_id'], null, '实例级事件 vault_id NULL（storage-model §3.8）');
  assert.equal(row['status'], 'succeeded', '管理类事件直接终态（storage-model §5）');
  assert.equal(row['occurred_at'], NOW);
  assert.deepEqual(JSON.parse(row['detail'] as string), { username: 'newbie' });
  db.close();
});

test('recordAuditEvent：token 载体主体记 credential:<id> + entry=api（architecture-notes §7.4）', () => {
  const { db, emp2 } = seededDb();
  recordAuditEvent(db, {
    occurredAt: NOW,
    actorKind: 'employee',
    subject: subject({ carrierRef: 'credential:42', entry: 'api' }, emp2),
    eventKind: 'credential.revoke',
  });
  const row = lastRow(db);
  assert.equal(row['employee_id'], emp2);
  assert.equal(row['credential_ref'], 'credential:42');
  assert.equal(row['entry'], 'api');
  assert.equal(row['detail'], '{}', 'detail 缺省 {}（DDL 默认）');
  db.close();
});

test('recordAuditEvent：bootstrap 主体 employee_id NULL（DDL 注释：NULL 当且仅当 actor_kind != employee），目标记 detail', () => {
  const db = newDb();
  recordAuditEvent(db, {
    occurredAt: NOW,
    actorKind: 'bootstrap',
    eventKind: 'account.bootstrap',
    entry: 'api',
    detail: { username: 'first-admin', employee_id: 1 },
  });
  const row = lastRow(db);
  assert.equal(row['actor_kind'], 'bootstrap');
  assert.equal(row['employee_id'], null);
  assert.equal(row['credential_ref'], null);
  db.close();
});

test('伪造 author 仅落 detail，主体恒为认证员工（identity §8：commit author 不进主体字段）', () => {
  const { db, emp1 } = seededDb();
  const vaultId = addVault(db, 'alpha', emp1);
  // S3 的 vault.push 将携带客户端可填的 commit_author——基座层面证明：
  // 无论 detail 里伪造什么 author，主体字段只来自认证缝的 subject。
  recordAuditEvent(db, {
    occurredAt: NOW,
    actorKind: 'employee',
    subject: subject({ carrierRef: 'credential:9', entry: 'api' }, emp1),
    eventKind: 'vault.push',
    vaultId,
    refName: 'refs/heads/main',
    oldCommit: 'a'.repeat(40),
    newCommit: 'b'.repeat(40),
    status: 'pending',
    detail: { commit_author: 'someone-else <evil@forged>', committer: 'also-forged' },
  });
  const row = lastRow(db);
  assert.equal(row['employee_id'], emp1, '主体 = 认证员工，不信任 author');
  assert.equal(row['credential_ref'], 'credential:9');
  assert.equal(row['ref_name'], 'refs/heads/main');
  assert.equal(row['old_commit'], 'a'.repeat(40));
  assert.equal(row['new_commit'], 'b'.repeat(40));
  assert.equal(row['status'], 'pending', '发布类事件预记录 pending（storage-model §6）');
  const detail = JSON.parse(row['detail'] as string);
  assert.equal(detail['commit_author'], 'someone-else <evil@forged>', 'author 仅作内容元数据留在 detail');
  db.close();
});

test('脱敏守卫：detail 含 ngt_ 明文 → AuditMaskingError 且无行写入（fail-closed）', () => {
  const db = newDb();
  const plaintext = 'ngt_' + 'A'.repeat(43);  // 43 字符 base64url 形态（identity §3.1）
  assert.throws(
    () =>
      recordAuditEvent(db, {
        occurredAt: NOW,
        actorKind: 'employee',
        subject: subject(),
        eventKind: 'employee.create',
        detail: { note: `created with ${plaintext}` },
      }),
    AuditMaskingError,
  );
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM audit_events').get() as { n: number }).n, 0);
  db.close();
});

test('脱敏守卫：掩码形态（前 2+…+末 4）不误伤——display_hint 可入 detail', () => {
  const { db, emp1 } = seededDb();
  recordAuditEvent(db, {
    occurredAt: NOW,
    actorKind: 'employee',
    subject: subject(undefined, emp1),
    eventKind: 'credential.revoke',
    detail: { display_hint: 'ngt_ab…wxyz' },
  });
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM audit_events').get() as { n: number }).n, 1);
  db.close();
});

test('脱敏守卫：口令/密钥类键名与外传 credential_ref 彝断（不含任何凭据材料）', () => {
  const db = newDb();
  assert.throws(
    () =>
      recordAuditEvent(db, {
        occurredAt: NOW, actorKind: 'employee', subject: subject(), eventKind: 'employee.create',
        detail: { password: 'whatever-it-is' },
      }),
    AuditMaskingError,
  );
  assert.throws(
    () =>
      recordAuditEvent(db, {
        occurredAt: NOW, actorKind: 'employee', subject: subject(), eventKind: 'employee.create',
        detail: { nested: { client_secret: 'x' } },
      }),
    AuditMaskingError,
  );
  // credential_ref 只接受 credential:<id> / session:<id> 形态（DDL 注释契约）
  assert.throws(
    () =>
      recordAuditEvent(db, {
        occurredAt: NOW, actorKind: 'employee',
        subject: subject({ carrierRef: 'ngt_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij' }),
        eventKind: 'employee.create',
      }),
    AuditMaskingError,
  );
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM audit_events').get() as { n: number }).n, 0);
  db.close();
});

test('主体一致性守卫：employee 必带 subject 或 employeeId；非 employee 不得带主体（DDL 注释由写入口径保证）', () => {
  const db = newDb();
  assert.throws(() =>
    recordAuditEvent(db, { occurredAt: NOW, actorKind: 'employee', eventKind: 'employee.create', entry: 'api' }),
  );
  assert.throws(() =>
    recordAuditEvent(db, {
      occurredAt: NOW, actorKind: 'system', subject: subject(), eventKind: 'backup.completed', entry: 'api',
    }),
  );
  assert.throws(() =>
    recordAuditEvent(db, {
      occurredAt: NOW, actorKind: 'system', employeeId: 1, eventKind: 'backup.completed', entry: 'api',
    }),
  );
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM audit_events').get() as { n: number }).n, 0);
  db.close();
});

test('K5 无载体形态：employee 主体可仅带 employeeId（credential_ref NULL）——口令重置消费归因', () => {
  const { db, emp1 } = seededDb();
  // identity §8 载体 = credential_id / session；K5 一次性令牌不属凭据载体——
  // employee.password_reset 消费事件记目标员工（token 归属），credential_ref NULL。
  recordAuditEvent(db, {
    occurredAt: NOW,
    actorKind: 'employee',
    employeeId: emp1,
    entry: 'api',
    eventKind: 'employee.password_reset',
    detail: { via: 'password_reset_token' },
  });
  const row = lastRow(db);
  assert.equal(row['employee_id'], emp1);
  assert.equal(row['credential_ref'], null, 'K5 非凭据载体（identity §8）');
  assert.equal(row['entry'], 'api');
  assert.equal(row['status'], 'succeeded');
  db.close();
});

test('排空计数：pending → 终态（settleAuditEvent）后归零（backup-recovery §4 步骤 2）', () => {
  const { db, emp1 } = seededDb();
  const vaultId = addVault(db, 'alpha', emp1);
  recordAuditEvent(db, {
    occurredAt: NOW, actorKind: 'employee', subject: subject(undefined, emp1), eventKind: 'vault.push',
    vaultId, refName: 'refs/heads/main', status: 'pending',
  });
  assert.equal(drainCount(db), 1, '在途写 1 条');
  const id = lastRow(db)['id'] as number;
  settleAuditEvent(db, id, 'succeeded');
  assert.equal(drainCount(db), 0, '终态后无 pending/unresolved');
  assert.equal(lastRow(db)['status'], 'succeeded');
  // unresolved 同样计入排空口径（部分索引谓词）
  recordAuditEvent(db, {
    occurredAt: NOW, actorKind: 'employee', subject: subject(undefined, emp1), eventKind: 'vault.push',
    vaultId, refName: 'refs/heads/dev', status: 'unresolved',
  });
  assert.equal(drainCount(db), 1);
  db.close();
});

test('audit.drain_count 规范 SQL 与契约逐字一致（storage-model §4，防漂移）', () => {
  const doc = readFileSync(path.resolve(import.meta.dirname, '../../docs/contracts/storage-model.md'), 'utf8');
  const m = /```sql\n-- @query audit\.drain_count\n([\s\S]*?)```/.exec(doc);
  assert.ok(m, 'storage-model.md 应含 -- @query audit.drain_count 块');
  const contractLines = m[1]!.split('\n').map((l) => l.trimEnd()).filter((l) => l.length > 0);
  const mine = AUDIT_DRAIN_COUNT_SQL.split('\n').map((l) => l.trimEnd()).filter((l) => l.length > 0);
  assert.deepEqual(mine, contractLines);
});
