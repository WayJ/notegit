import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../src/db/migrate.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';

/**
 * S2-T4 测试夹具：employees / vaults / vault_members / audit_events 属并行任务
 * （S2-T2/T6/T7）的迁移版本，本任务分支上尚不存在。夹具取 storage-model.md
 * 对应 @schema 块的等价 DDL（改写为 IF NOT EXISTS 形态）：合并后真实迁移先建表，
 * 夹具成为 no-op，测试在合并前后均可运行。
 */
const FIXTURE_DDL = [
  `CREATE TABLE IF NOT EXISTS employees (
  id                INTEGER NOT NULL PRIMARY KEY,
  username          TEXT    NOT NULL UNIQUE,
  display_name      TEXT    NOT NULL,
  password_hash     TEXT    NOT NULL,
  is_instance_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_instance_admin IN (0,1)),
  active            INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  invited_by        INTEGER REFERENCES employees(id),
  created_at        TEXT    NOT NULL,
  deactivated_at    TEXT
) STRICT`,
  `CREATE TABLE IF NOT EXISTS vaults (
  id              INTEGER NOT NULL PRIMARY KEY,
  slug            TEXT    NOT NULL UNIQUE,
  name            TEXT    NOT NULL,
  default_branch  TEXT    NOT NULL DEFAULT 'main',
  main_admin_only INTEGER NOT NULL DEFAULT 0 CHECK (main_admin_only IN (0,1)),
  created_by      INTEGER NOT NULL REFERENCES employees(id),
  created_at      TEXT    NOT NULL
) STRICT`,
  `CREATE TABLE IF NOT EXISTS vault_members (
  vault_id    INTEGER NOT NULL REFERENCES vaults(id),
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  role        TEXT    NOT NULL CHECK (role IN ('reader','editor','admin')),
  granted_by  INTEGER NOT NULL REFERENCES employees(id),
  granted_at  TEXT    NOT NULL,
  PRIMARY KEY (vault_id, employee_id)
) STRICT`,
  `CREATE TABLE IF NOT EXISTS audit_events (
  id             INTEGER NOT NULL PRIMARY KEY,
  occurred_at    TEXT    NOT NULL,
  actor_kind     TEXT    NOT NULL CHECK (actor_kind IN ('employee','bootstrap','system')),
  employee_id    INTEGER REFERENCES employees(id),
  credential_ref TEXT,
  entry          TEXT    NOT NULL CHECK (entry IN ('web','api','git')),
  event_kind     TEXT    NOT NULL,
  vault_id       INTEGER REFERENCES vaults(id),
  ref_name       TEXT,
  old_commit     TEXT,
  new_commit     TEXT,
  status         TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','rejected','unresolved')),
  detail         TEXT    NOT NULL DEFAULT '{}'
) STRICT`,
  `CREATE INDEX IF NOT EXISTS idx_audit_vault_time ON audit_events(vault_id, occurred_at)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_employee_time ON audit_events(employee_id, occurred_at)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_open ON audit_events(status) WHERE status IN ('pending','unresolved')`,
];

/** :memory: 库 + foreign_keys + 前向迁移（含本任务 v4）+ 夹具表 */
export function newDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db, MIGRATIONS);
  for (const ddl of FIXTURE_DDL) db.exec(ddl);
  return db;
}

export interface EmployeeSeed {
  username: string;
  display_name?: string;
  is_instance_admin?: number;
  active?: number;
}

export function addEmployee(db: DatabaseSync, seed: EmployeeSeed): number {
  db.prepare(
    `INSERT INTO employees (username, display_name, password_hash, is_instance_admin, active, created_at)
     VALUES (?, ?, 'fixture-not-argon2', ?, ?, ?)`,
  ).run(seed.username, seed.display_name ?? seed.username, seed.is_instance_admin ?? 0, seed.active ?? 1, new Date().toISOString());
  return Number((db.prepare('SELECT id FROM employees WHERE username = ?').get(seed.username) as { id: number }).id);
}

export function addVault(db: DatabaseSync, slug: string, createdBy: number): number {
  db.prepare(
    `INSERT INTO vaults (slug, name, created_by, created_at) VALUES (?, ?, ?, ?)`,
  ).run(slug, slug, createdBy, new Date().toISOString());
  return Number((db.prepare('SELECT id FROM vaults WHERE slug = ?').get(slug) as { id: number }).id);
}

export function addMember(db: DatabaseSync, vaultId: number, employeeId: number, role: string, grantedBy: number): void {
  db.prepare(
    `INSERT INTO vault_members (vault_id, employee_id, role, granted_by, granted_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(vaultId, employeeId, role, grantedBy, new Date().toISOString());
}

/** 全库文本转储：所有表所有行 JSON 串拼接——明文扫描断言遍历用 */
export function dumpAllText(db: DatabaseSync): string {
  const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((r) => r.name);
  const parts: string[] = [];
  for (const t of tables) {
    const rows = db.prepare(`SELECT * FROM "${t}"`).all();
    parts.push(JSON.stringify(rows));
  }
  return parts.join('\n');
}

/** 审计行便捷读取 */
export function auditRows(db: DatabaseSync, eventKind: string): { employee_id: number | null; credential_ref: string | null; entry: string; detail: string; status: string }[] {
  return db.prepare(`SELECT employee_id, credential_ref, entry, detail, status FROM audit_events WHERE event_kind = ? ORDER BY id`).all(eventKind) as never;
}
