/**
 * 出厂迁移列表（机制先行；内容随 S2-T2…T7 逐步落地）。
 * DDL 唯一来源是 docs/contracts/storage-model.md 的 -- @schema 块（D6 只读纪律）；
 * S2-T1 只带空基线；S2-T2 落 v2（employees/one_time_tokens）；S2-T4 落 v4（credentials）；
 * S2-T6 落 v5（vaults/vault_members）；v3 为 S2-T3（sessions）；v6 为 S2-T7（audit_events）；
 * v7 为 S3-T8（app_settings）；v8 为 S4-T6（drafts）。后续版本按任务 append。
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
  {
    // DDL 来源：storage-model.md §3.8 `-- @schema audit_events` 块逐字迁移（防漂移测试对照原文）；
    // schema_version 引导行剔除（runner 持有，architecture-notes §3）。版本号 0006 为 S2-T7
    // 独占；0005 为 S2-T6（vaults/vault_members）并行预留，并入 sprint/S2 时插于 4 与 6 之间。
    version: 6,
    description: 'S2-T7: audit_events — subject/vault/time/commits/result + drain index (identity §8; storage-model §3.8; backup-recovery §4/§5)',
    statements: [
      `-- 以服务端认证身份记录主体、库、时间、旧新 commit 和结果（架构 §4.4）。
-- 发布类事件（vault.push / vault.web_submit）先预记录 pending，引用更新后置终态；
-- 异常 → unresolved（待核对），由恢复对账标为 succeeded/rejected（架构 §4.4；
-- backup-recovery §4 步骤 2、§5.1–2、§7 步骤 7）。
-- commit author/committer 是客户端可填的内容元数据，不进主体字段（identity §8）。
CREATE TABLE audit_events (
  id             INTEGER NOT NULL PRIMARY KEY,
  occurred_at    TEXT    NOT NULL,             -- 依据：架构 §4.4 时间；服务端时钟
  actor_kind     TEXT    NOT NULL CHECK (actor_kind IN ('employee','bootstrap','system')),  -- 依据：identity §8 主体=认证员工；bootstrap=K5 初始化；system=应用自身（对账等）
  employee_id    INTEGER REFERENCES employees(id),  -- NULL 当且仅当 actor_kind != 'employee'（应用层保证）
  credential_ref TEXT,                         -- 依据：identity §8 凭据载体标识（credential:<id> / session:<短哈希>）；不含任何 token 材料
  entry          TEXT    NOT NULL CHECK (entry IN ('web','api','git')),  -- 依据：identity §8 入口
  event_kind     TEXT    NOT NULL,             -- 注册表见 §5
  vault_id       INTEGER REFERENCES vaults(id),  -- NULL = 实例级事件（凭据域、密钥、维护、备份）
  ref_name       TEXT,                         -- 引用更新类事件：refs/heads/<branch>
  old_commit     TEXT,                         -- 依据：架构 §4.4 旧 commit
  new_commit     TEXT,                         -- 依据：架构 §4.4 新 commit（删除 ref 时为全零 OID）
  status         TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','rejected','unresolved')),  -- 依据：架构 §4.4 结果 + 待核对；管理类事件直接以终态插入
  detail         TEXT    NOT NULL DEFAULT '{}' -- JSON：错误码（引用 T2 注册表时含 rulesVersion）、撤销原因、拒绝原因等（T5 建议）
) STRICT;`,
      `CREATE INDEX idx_audit_vault_time ON audit_events(vault_id, occurred_at);   -- 依据：架构 §4.4 按库/时间查询（api.md §8 审计查询）`,
      `CREATE INDEX idx_audit_employee_time ON audit_events(employee_id, occurred_at);  -- 依据：按主体检索`,
      `CREATE INDEX idx_audit_open ON audit_events(status) WHERE status IN ('pending','unresolved');  -- 依据：backup-recovery §4 步骤 2 排空检查 / §7 步骤 7 恢复对账（部分索引，行数≈在途写数）`,
    ],
  },
  {
    // S3-T8（迁移 0007，本任务独占）：app_settings（运行时管理配置——键名即
    // validation-defaults.json 配置键）。DDL 逐字取自 storage-model.md §3.10 的
    // -- @schema 块（D6 只读纪律）；0006 之后 append（迁移独占约束同前任务）。
    version: 7,
    description: 'S3-T8: app_settings — runtime admin config keyed by validation-defaults.json keys (storage-model §3.10; validation.md §5.1/§7.3-4)',
    statements: [
      `-- 管理员可配置项的存储（T5 建议）：键名即 validation-defaults.json 的配置键
-- （validation.md §5.1），缺行 = 用默认值；配置 ≠ 规则版本（validation.md §7.3-4），
-- 变更走管理端点并记审计（api.md）。静态部署配置仍在 /data/config/（backup-recovery §2）。
CREATE TABLE app_settings (
  key        TEXT    NOT NULL PRIMARY KEY,
  value      TEXT    NOT NULL,                 -- JSON 值（与 validation-defaults.json 的类型一致）
  updated_by INTEGER REFERENCES employees(id),
  updated_at TEXT    NOT NULL
) STRICT;`,
    ],
  },
  {
    // S4-T6（迁移 0008，本任务独占）：drafts（网页草稿——按作者私有）。DDL 逐字
    // 取自 storage-model.md §3.7 的 -- @schema 块（D6 只读纪律；契约先行——S1-T5
    // 已定表，本迁移落表 + 防漂移，migration-0006 同款 D11 模式）。0007 之后
    // append（迁移独占约束同前任务）。
    version: 8,
    description: 'S4-T6: drafts — per-author private web drafts with commit-state transition (storage-model §3.7; api.md §7; 架构 §6)',
    statements: [
      `-- 草稿保存在数据库、按作者私有（架构 §3.1/§6）。访问时再次检查库权限（应用层，
-- identity §5.1 第 2 层同源）。发布后清理或标为已提交（架构 §6）。
CREATE TABLE drafts (
  id           INTEGER NOT NULL PRIMARY KEY,
  vault_id     INTEGER NOT NULL REFERENCES vaults(id),
  employee_id  INTEGER NOT NULL REFERENCES employees(id),  -- 依据：架构 §6 按作者私有
  path         TEXT    NOT NULL,               -- 目标路径；重命名按目标路径重新判定（架构 §5.2）
  content      TEXT    NOT NULL,               -- 草稿全文（含 frontmatter 文本）
  base_commit  TEXT    NOT NULL,               -- 依据：架构 §6 打开编辑器时记录 base commit；提交时分支已变 → 保留草稿提示冲突，不静默覆盖
  status       TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','committed')),  -- 依据：架构 §6「发布后清理或标为已提交」
  committed_at TEXT,                           -- 标记已提交的时间（T5 建议）
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL,
  UNIQUE (vault_id, employee_id, path)         -- 每作者每路径一份现行草稿（T5 建议：同路径新草稿覆盖旧稿，配合 updated_at）
) STRICT;`,
    ],
  },
  {
    // S5-T3（迁移 0009，本任务独占）：派生搜索索引两表。架构 §3.1/§9（派生数据、
    // 索引延迟可观测）+ storage-model §2 明示「派生（不在本 schema）」——本表在
    // 契约 DDL 之外落地，DDL 建议稿见 docs/s1/search-index-amendments.md（D11
    // 模式：实现 + ADR 补正建议稿，不动 docs/contracts/）。0008 之后 append
    // （迁移独占约束同前任务）。无外键是结构性裁决：派生行不得阻塞权威侧删库
    // （孤儿行由索引器启动对账清理）；全量替换语义（同库逐路径一行）供 T5 重建复用。
    version: 9,
    description: 'S5-T3: search_index + search_index_state — derived metadata index from published default branch (架构 §3.1/§9; storage-model §2 派生不入权威 schema)',
    statements: [
      `-- 派生元数据索引（架构 §3.1：标题/标签/摘要 = 派生数据，可从 Git 全量重建；
-- §9：内容搜索基于已发布分支派生索引、索引延迟可观测、写入完成不以索引成功为
-- 唯一依据——D7 失败不阻断发布）。行来源 = 已发布默认分支的 .md 文件；逐库逐
-- 路径一行，新版本全量替换（T5 重建走同一写面）。无外键：vaults 行删除不被
-- 陈旧派生行阻塞，孤儿行由启动对账清理（不是删除事务的职责）。
CREATE TABLE search_index (
  vault_id   INTEGER NOT NULL,             -- 来源库（vaults.id，应用层维护；无 FK——见上）
  path       TEXT    NOT NULL,             -- 库内路径（Git tree 条目原样）
  commit_oid TEXT    NOT NULL,             -- 索引行来源的已发布默认分支 commit
  title      TEXT,                         -- frontmatter title；README 等 frontmatter 豁免文件为 NULL（如实记录无 title）
  tags       TEXT    NOT NULL,             -- JSON 数组文本（frontmatter tags；缺失/不可解析 = '[]'）
  summary    TEXT    NOT NULL,             -- 正文首段摘要片段（截断存储，长度上界见索引器）
  indexed_at TEXT    NOT NULL,             -- 行写入时间（服务端时钟）
  PRIMARY KEY (vault_id, path)             -- 一库一路径一行（全量替换；旧路径删除即消失）
) STRICT;`,
      `-- 索引状态与可观测面（逐库一行）：延迟指标（lag_ms = indexed_at − 触发发布的
-- 审计行 occurred_at）与时间戳可查（管理端点消费）；失败告警的数据面
-- （consecutive_failures/last_error——索引失败不阻断发布，只在此可见 + 日志）。
CREATE TABLE search_index_state (
  vault_id             INTEGER NOT NULL PRIMARY KEY,
  branch               TEXT    NOT NULL,             -- 被索引分支 = 库默认分支（vaults.default_branch 快照）
  head_commit          TEXT,                         -- 索引已反映的默认分支 commit（NULL = 分支尚无提交）
  triggered_by         TEXT    NOT NULL CHECK (triggered_by IN ('vault.push','vault.web_submit','startup-reconcile','manual')),
  triggered_at         TEXT,                         -- 触发发布的审计行 occurred_at（延迟分母；重建型触发为 NULL）
  indexed_at           TEXT    NOT NULL,             -- 本次索引完成时间（服务端时钟）
  duration_ms          INTEGER NOT NULL,             -- 派生耗时（读 tree + 解析 + 写行）
  lag_ms               INTEGER,                      -- indexed_at − 触发发布 occurred_at（延迟指标；重建型为 NULL）
  updates              INTEGER NOT NULL DEFAULT 0,   -- 累计成功更新次数
  consecutive_failures INTEGER NOT NULL DEFAULT 0,   -- 连续失败次数（成功后清零）
  last_error           TEXT,                         -- 最近一次失败摘要（告警可见）
  last_error_at        TEXT                          -- 最近失败时间
) STRICT;`,
    ],
  },
  {
    // S11-T1（迁移 0010，本任务独占）：全文检索 v1——search_index 扩 body 列
    // （D20 ADR：派生可重建、LIKE 子串语义；FTS5 因 2 字 CJK 致命被否）。列 =
    // frontmatter 剥离后的 .md 正文（README 豁免文件全文），截断上界与
    // validation.limits.maxDocumentBytes 同源（1MiB——不引入第二套常量；见
    // search/derive.ts）。ALTER ADD COLUMN：既有行自动得 body=''（空串不参与
    // 正文命中——迁移前行如实「无正文」）；STRICT/主键不变；派生可全量重建
    // （T5 重建入口同源）。0009 之后 append（迁移独占约束同前任务）；建议稿
    // docs/s11/storage-amendments.md（D11 模式：实现 + 契约补正建议稿，不动
    // docs/contracts/）。
    version: 10,
    description: "S11-T1: search_index body column — derived full-text of published .md body for path+body search (D20; storage-model §2 派生不入权威 schema)",
    statements: [
      `ALTER TABLE search_index ADD COLUMN body TEXT NOT NULL DEFAULT ''`,
    ],
  },
  {
    // S37（迁移 0011，本任务独占）：凭据 origin 标记——区分员工自助（self）与
    // 管理员代签（admin_delegated，dshent 平台委托签发）。默认 'self'：既有行
    // 语义不变；列表（api.md §4）与审计读面（§9 credential_origin）透出。
    version: 11,
    description: "S37: credentials origin marker — 'self' vs 'admin_delegated' (admin delegation issuance; identity §3.5 amendment)",
    statements: [
      `ALTER TABLE credentials ADD COLUMN origin TEXT NOT NULL DEFAULT 'self' CHECK (origin IN ('self','admin_delegated'))`,
    ],
  },
];
