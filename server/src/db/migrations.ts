/**
 * 出厂迁移列表（机制先行；内容随 S2-T2…T7 逐步落地）。
 * DDL 唯一来源是 docs/contracts/storage-model.md 的 -- @schema 块（D6 只读纪律）；
 * S2-T1 只带空基线；S2-T2 落 v2（employees/one_time_tokens）；S2-T4 落 v4（credentials）；
 * S2-T6 落 v5（vaults/vault_members）。v3 为 S2-T3（sessions）；0006+ 为后续任务预留。
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
  {
    // S2-T3（迁移 0003，本任务独占）：sessions。
    // DDL 取自 storage-model.md §3.3 @schema 块（唯一来源，D6）；schema_version 引导块
    // 按 architecture-notes §3 剔除。employees 基础表已由 S2-T2 的 0002 按同一契约
    // §3.2 块整表落地（含 password_hash/active/deactivated_at 全部口令/状态列），
    // 本迁移无需 ALTER 补列，仅建 sessions 表与按账号批量失效索引。
    version: 3,
    description: 'S2-T3: sessions (storage-model §3.3; identity §2/§4/§5.2)',
    statements: [
      `CREATE TABLE sessions (
  id                  INTEGER NOT NULL PRIMARY KEY,
  employee_id         INTEGER NOT NULL REFERENCES employees(id),  -- 依据：identity §1 会话归属员工
  sid_hash            TEXT    NOT NULL UNIQUE,  -- 依据：identity §4 会话表同样以 HMAC 形式存储；唯一索引键查找
  created_at          TEXT    NOT NULL,
  last_seen_at        TEXT    NOT NULL,         -- 依据：identity §4 idle_timeout 滑动续期（默认 7 天可配）
  absolute_expires_at TEXT    NOT NULL          -- 依据：identity §4 absolute_timeout（默认 30 天可配）
) STRICT`,
      `CREATE INDEX idx_sessions_employee ON sessions(employee_id);  -- 依据：identity §2 口令重置/停用需按账号批量失效`,
    ],
  },
  {
    // DDL 来源：storage-model.md §3.4 `-- @schema credentials` 块逐字迁移（防漂移测试对照原文）；
    // schema_version 引导行剔除（runner 持有，architecture-notes §3）。版本号 0004 为 S2-T4 独占。
    version: 4,
    description: 'S2-T4: credentials — ngt_ token HMAC storage (identity §3/D-IC-01/03; storage-model §3.4)',
    statements: [
      `-- ngt_ 前缀不透明 token 的服务端存储（identity §3/D-IC-01）。明文只在创建响应出现一次，
-- 库内只存 HMAC 校验值（identity §3.2/D-IC-03）。撤销 = 置位 revoked_at，不删行
-- （到期或撤销后的 token 不可复活，只能新建——identity §3.5）。
CREATE TABLE credentials (
  id           INTEGER NOT NULL PRIMARY KEY,
  employee_id  INTEGER NOT NULL REFERENCES employees(id),  -- 依据：identity §3.3 归属关系不可变更（无 UPDATE 路径，应用层保证）
  name         TEXT    NOT NULL,               -- 依据：identity §3.3 展示名（员工自起）
  token_hash   TEXT    NOT NULL UNIQUE,        -- 依据：identity §3.2 存 'hmacv1$<hex>'（内嵌 pepper 版本，支撑 §6.2 轮换）；以 HMAC 输出为唯一索引键查表，token 明文从不作索引或日志字段
  scope_access TEXT    NOT NULL DEFAULT 'read_write' CHECK (scope_access IN ('read','read_write')),  -- 依据：identity §3.4 范围只能收窄（access 维）
  scope_vaults TEXT    NOT NULL DEFAULT '[]',  -- 依据：identity §3.4 库允许清单（JSON 数组，存库 id；空 = 全部有权库），每次使用与员工当前权限取交集
  created_at   TEXT    NOT NULL,
  expires_at   TEXT    NOT NULL,               -- 依据：identity §3.3 到期必填，≤ 实例上限（默认 90 天可配）；认证层逐请求比较
  revoked_at   TEXT,                           -- 依据：identity §3.3 NULL = 未撤销；四状态之一
  display_hint TEXT    NOT NULL,               -- D11 增补（2026-10-13 ADR）：形如 ngt_ab…wxyz（前 2+末 4），创建时自明文生成；api.md §4 列表响应与 identity §3.1 展示语义所需，HMAC 单向不可反推
  last_used_at TEXT                            -- 依据：identity §3.3 观测字段，≥60 秒节流批量写，不参与任何授权判断
) STRICT;`,
      `CREATE INDEX idx_credentials_employee ON credentials(employee_id);  -- 依据：identity §3.5 每员工上限（默认 20，应用层）与员工凭据列表查询`,
    ],
  },
  {
    // DDL 来源：storage-model.md §3.5/§3.6 `-- @schema vaults`/`-- @schema vault_members`
    // 块逐字迁移（防漂移测试对照原文）；schema_version 引导行剔除（runner 持有，
    // architecture-notes §3）。版本号 0005 为 S2-T6 独占（仅 append 注册）。
    version: 5,
    description: 'S2-T6: vaults + vault_members — slug 唯一/三档角色/PK 防重复授权 (架构 §4.2/§4.3/§7.2; storage-model §3.5/§3.6)',
    statements: [
      `-- 库 = Git 仓库 = 内容访问权限最小单位（架构 §2/§4.2）。新库默认私有、创建者为库管理员
-- （成员行见 3.6）。仓库路径 /data/git/<vault-id>.git 由稳定 ID 映射（架构 §3.2/§9）。
CREATE TABLE vaults (
  id              INTEGER NOT NULL PRIMARY KEY,  -- 依据：架构 §7.2 内部库 ID 稳定；改 slug 不变
  slug            TEXT    NOT NULL UNIQUE,       -- 依据：架构 §7.2 slug 实例内唯一；可改名（CLI 提示映射变化），格式校验在应用层（对齐 validation.md §4.1 字符集精神）
  name            TEXT    NOT NULL,
  default_branch  TEXT    NOT NULL DEFAULT 'main',  -- 依据：架构 §2 已发布知识以服务端默认分支为准，初始名 main
  main_admin_only INTEGER NOT NULL DEFAULT 0 CHECK (main_admin_only IN (0,1)),  -- 依据：架构 §4.3 可配置 main 仅由库管理员写入（默认关）
  created_by      INTEGER NOT NULL REFERENCES employees(id),  -- 依据：架构 §4.2 创建者为库管理员
  created_at      TEXT    NOT NULL
) STRICT;`,
      `-- 三角色（架构 §4.2）：reader 只读；editor 可 push（受分支规则约束）；admin 兼管理。
-- 授权层实时查本表（identity §5.1 第 2 层，无缓存）；撤权 = DELETE 行（identity §5.2 四状态之一）。
CREATE TABLE vault_members (
  vault_id    INTEGER NOT NULL REFERENCES vaults(id),
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  role        TEXT    NOT NULL CHECK (role IN ('reader','editor','admin')),  -- 依据：架构 §4.2 角色表
  granted_by  INTEGER NOT NULL REFERENCES employees(id),
  granted_at  TEXT    NOT NULL,
  PRIMARY KEY (vault_id, employee_id)          -- 依据：架构 §4.2 成员权限显式授予（一员工一库至多一行）
) STRICT;

CREATE INDEX idx_vault_members_employee ON vault_members(employee_id);  -- 依据：架构 §4.2「我的库」列表/搜索过滤（未授权库不进列表）`,
    ],
  },
];
