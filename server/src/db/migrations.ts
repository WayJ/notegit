/**
 * 出厂迁移列表（机制先行；内容随 S2-T2…T7 逐步落地）。
 * DDL 唯一来源是 docs/contracts/storage-model.md 的 -- @schema 块（D6 只读纪律）；
 * 本任务只带空基线，不建业务表。
 */
export interface Migration {
  readonly version: number;
  readonly description: string;
  readonly statements: readonly string[];
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: 'baseline: empty — 10-table contract DDL lands with S2-T2…T7',
    statements: [],
  },
  {
    // DDL 逐字取自 storage-model.md §3.2/§3.9 的 -- @schema 块（D6 只读纪律），
    // 剔除 schema_version 引导建表行（runner 已持有，architecture-notes §3）；
    // 其 append-only 触发器（契约 §3.1）以 IF NOT EXISTS 形态随本迁移落地（S2-T1 顺延项）。
    version: 2,
    description: 'S2-T2: employees + one_time_tokens + schema_version append-only triggers (storage-model §3.1/§3.2/§3.9)',
    statements: [
      `CREATE TRIGGER IF NOT EXISTS schema_version_no_update
BEFORE UPDATE ON schema_version
BEGIN
  SELECT RAISE(ABORT, 'schema_version is append-only (backup-recovery §9)');
END`,
      `CREATE TRIGGER IF NOT EXISTS schema_version_no_delete
BEFORE DELETE ON schema_version
BEGIN
  SELECT RAISE(ABORT, 'schema_version is append-only (backup-recovery §9)');
END`,
      `CREATE TABLE employees (
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
      `CREATE TABLE one_time_tokens (
  id          INTEGER NOT NULL PRIMARY KEY,
  purpose     TEXT    NOT NULL CHECK (purpose IN ('bootstrap','password_reset','admin_recover')),
  token_hash  TEXT    NOT NULL UNIQUE,
  employee_id INTEGER REFERENCES employees(id),
  expires_at  TEXT    NOT NULL,
  used_at     TEXT,
  created_at  TEXT    NOT NULL
) STRICT`,
    ],
  },
];
