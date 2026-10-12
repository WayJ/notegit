# 存储模型契约（storage-model）

| 项目 | 内容 |
|---|---|
| 契约版本 | v0.1（S1 草案，供 S2 实现） |
| 日期 / 产出 | 2026-10-12 / S1-T5 |
| 架构依据 | [architecture.md](../../architecture.md) §3.1、§4、§6、§7.2、§9；DOD-02/03/07/11 |
| 配套契约 | [identity-credentials.md](identity-credentials.md)（凭据/会话/密钥语义唯一来源）、[validation.md](validation.md)（配置键与版本化）、[backup-recovery.md](backup-recovery.md)（备份一致性集合、迁移纪律） |
| 实现语境 | SQLite `node:sqlite`（epic D10：WAL + busy_timeout=5000，Node 24，单实例单容器） |
| 自检门禁 | `node --test docs/contracts/tools/ddl_smoke.test.mjs`（见 §8；DDL 唯一来源即本文件） |

## 0. 范围

本契约把架构 §4 的存储模型具体化为可执行的 SQLite schema DDL 草案：员工 / 会话 / 凭据 / 库 / 成员角色 / 审计事件 / 草稿 / 一次性令牌 / 配置 / 迁移表，并给出认证与授权的**运行时检查查询**（实时查库、无缓存，[identity §5.1](identity-credentials.md)）。

不在范围：业务规则语义（API 行为见 [api.md](api.md)）、内容校验规则（[validation.md](validation.md)）、备份流程（[backup-recovery.md](backup-recovery.md)）、派生索引存储（架构 §3.1：派生数据可从 Git 重建，不入权威库）。

**本文件是 DDL 的唯一来源**：`docs/contracts/tools/ddl_smoke.test.mjs` 从本文提取标记为 `-- @schema` 的 SQL 块按序执行并验证关键约束（slug 唯一、外键、撤权路径、审计预记录、迁移表不可改），文档与测试不会漂移。修改 schema 必须同时升 `schema_version` 并按下文来源标注复核。

## 1. 约定

- **引擎与运行参数**（epic D10，[selection.md §4](../s1/selection.md)）：SQLite 经 `node:sqlite`（`DatabaseSync`）；建库即 `PRAGMA journal_mode = WAL`；每连接 `PRAGMA busy_timeout = 5000` 与 `PRAGMA foreign_keys = ON`（外键必须显式开启，否则本契约的 FK 约束不生效——T1 spike 实测要点）。
- **写事务**：写路径使用 `BEGIN IMMEDIATE` 起事务（单写者串行化，避免 busy 死锁；T1 spike `db-sqlite-tests.txt` S2）。
- **时间**：全部时间列为 TEXT，ISO-8601 UTC 毫秒（`YYYY-MM-DDTHH:MM:SS.sssZ`），仅服务端时钟生成与比较（[identity §5.3](identity-credentials.md) 时钟权威）；同格式下字典序即时间序，比较运算直接可用。
- **表型**：全部 `STRICT`（类型强制，SQLite ≥3.37；Node 24 内置版本满足）；布尔以 INTEGER 0/1 + CHECK 表达；主键为 `INTEGER PRIMARY KEY`（rowid 别名）。
- **ID 策略**：内部 ID 为 INTEGER 自增 rowid；对外 URL/路径使用 slug 或显式 id 字段。库的稳定内部 ID 即仓库目录名 `/data/git/<vault-id>.git`（架构 §3.2/§9；[backup-recovery §2](backup-recovery.md)），不拼接用户输入。
- **来源标注**：每张表/约束/索引的行尾 `-- 依据：…` 标注架构节号或契约文件节号；无编号者标「T5 建议」。

## 2. 数据分类（对齐 backup-recovery §1）

| 表 | 权威性 | 说明 |
|---|---|---|
| employees、credentials、vaults、vault_members、drafts、audit_events、one_time_tokens、app_settings、schema_version | **权威**（入数据库一致快照，恢复必须回灌） | backup-recovery §1「管理数据库」清单的落表 |
| sessions | **运行态** | [backup-recovery §3](backup-recovery.md) 写分类：会话是运行态写入，备份中的陈旧会话无害，回退/恢复时随快照丢弃属预期；失效 = DELETE 行 |
| 登录限速计数、维护模式标志 | **运行态（不落库）** | 进程内状态（[identity §2](identity-credentials.md) 限速；[backup-recovery §3](backup-recovery.md) 闸门为进程内同步标志，传播上界 0） |
| 标题/标签/摘要/搜索索引、库容量计量 | **派生（不在本 schema）** | 架构 §3.1：可从 Git 重建；容量判定（E-LIMIT-005）用 Git 侧计量，不设权威列 |

## 3. DDL（v1，`-- @schema` 块按序执行）

### 3.1 schema_version —— 迁移表

```sql
-- @schema schema_version
-- 迁移纪律：仅前向、有序、可重入检查，历史行不可改（backup-recovery §9）。
-- 版本 1 = 本契约 DDL。应用启动时按 version 顺序补齐缺失行。
CREATE TABLE schema_version (
  version     INTEGER NOT NULL PRIMARY KEY,  -- 依据：backup-recovery §9「版本、顺序」
  applied_at  TEXT    NOT NULL,
  description TEXT    NOT NULL
) STRICT;

CREATE TRIGGER schema_version_no_update       -- 依据：backup-recovery §9「历史行不可改」
BEFORE UPDATE ON schema_version
BEGIN
  SELECT RAISE(ABORT, 'schema_version is append-only (backup-recovery §9)');
END;

CREATE TRIGGER schema_version_no_delete
BEFORE DELETE ON schema_version
BEGIN
  SELECT RAISE(ABORT, 'schema_version is append-only (backup-recovery §9)');
END;
```

### 3.2 employees —— 员工账号

```sql
-- @schema employees
-- 认证主体 = 员工账号（架构 §4.1；identity §1）。第一版本地账号、管理员邀请创建、
-- 无自助注册（identity §2）。
CREATE TABLE employees (
  id                INTEGER NOT NULL PRIMARY KEY,
  username          TEXT    NOT NULL UNIQUE,   -- 依据：identity §2 账号由管理员邀请创建；NFC 规范化后精确唯一（T5 建议，见 §7 开放项）
  display_name      TEXT    NOT NULL,
  password_hash     TEXT    NOT NULL,          -- 依据：identity §2/D-IC-02 Argon2id（m=19456,t=2,p=1，modular 格式含盐）；格式校验在应用层
  is_instance_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_instance_admin IN (0,1)),  -- 依据：架构 §4.2 实例管理员
  active            INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),  -- 依据：identity §5.2 账号停用（四状态之一），认证层逐请求检查
  invited_by        INTEGER REFERENCES employees(id),  -- 依据：identity §2 邀请创建；首个管理员为 NULL（bootstrap）
  created_at        TEXT    NOT NULL,
  deactivated_at    TEXT                       -- 依据：identity §5.2 停用时间；NULL = 未停用（T5 建议：审计辅助）
) STRICT;
```

### 3.3 sessions —— Web 会话（运行态）

```sql
-- @schema sessions
-- 服务端会话表 + 不透明 ID（identity §4/D-IC-04）。sid 存 HMAC-SHA256(pepper, sid)
-- （identity §4/D-IC-03，键管理与凭据同源 K1）。失效 = DELETE（运行态，见本文件 §2）；
-- 口令重置后该账号全部会话失效 = DELETE WHERE employee_id = ?（identity §2）。
CREATE TABLE sessions (
  id                  INTEGER NOT NULL PRIMARY KEY,
  employee_id         INTEGER NOT NULL REFERENCES employees(id),  -- 依据：identity §1 会话归属员工
  sid_hash            TEXT    NOT NULL UNIQUE,  -- 依据：identity §4 会话表同样以 HMAC 形式存储；唯一索引键查找
  created_at          TEXT    NOT NULL,
  last_seen_at        TEXT    NOT NULL,         -- 依据：identity §4 idle_timeout 滑动续期（默认 7 天可配）
  absolute_expires_at TEXT    NOT NULL          -- 依据：identity §4 absolute_timeout（默认 30 天可配）
) STRICT;

CREATE INDEX idx_sessions_employee ON sessions(employee_id);  -- 依据：identity §2 口令重置/停用需按账号批量失效
```

### 3.4 credentials —— 员工访问凭据（token）

```sql
-- @schema credentials
-- ngt_ 前缀不透明 token 的服务端存储（identity §3/D-IC-01）。明文只在创建响应出现一次，
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
) STRICT;

CREATE INDEX idx_credentials_employee ON credentials(employee_id);  -- 依据：identity §3.5 每员工上限（默认 20，应用层）与员工凭据列表查询
```

### 3.5 vaults —— 库

```sql
-- @schema vaults
-- 库 = Git 仓库 = 内容访问权限最小单位（架构 §2/§4.2）。新库默认私有、创建者为库管理员
-- （成员行见 3.6）。仓库路径 /data/git/<vault-id>.git 由稳定 ID 映射（架构 §3.2/§9）。
CREATE TABLE vaults (
  id              INTEGER NOT NULL PRIMARY KEY,  -- 依据：架构 §7.2 内部库 ID 稳定；改 slug 不变
  slug            TEXT    NOT NULL UNIQUE,       -- 依据：架构 §7.2 slug 实例内唯一；可改名（CLI 提示映射变化），格式校验在应用层（对齐 validation.md §4.1 字符集精神）
  name            TEXT    NOT NULL,
  default_branch  TEXT    NOT NULL DEFAULT 'main',  -- 依据：架构 §2 已发布知识以服务端默认分支为准，初始名 main
  main_admin_only INTEGER NOT NULL DEFAULT 0 CHECK (main_admin_only IN (0,1)),  -- 依据：架构 §4.3 可配置 main 仅由库管理员写入（默认关）
  created_by      INTEGER NOT NULL REFERENCES employees(id),  -- 依据：架构 §4.2 创建者为库管理员
  created_at      TEXT    NOT NULL
) STRICT;
```

### 3.6 vault_members —— 库成员与角色

```sql
-- @schema vault_members
-- 三角色（架构 §4.2）：reader 只读；editor 可 push（受分支规则约束）；admin 兼管理。
-- 授权层实时查本表（identity §5.1 第 2 层，无缓存）；撤权 = DELETE 行（identity §5.2 四状态之一）。
CREATE TABLE vault_members (
  vault_id    INTEGER NOT NULL REFERENCES vaults(id),
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  role        TEXT    NOT NULL CHECK (role IN ('reader','editor','admin')),  -- 依据：架构 §4.2 角色表
  granted_by  INTEGER NOT NULL REFERENCES employees(id),
  granted_at  TEXT    NOT NULL,
  PRIMARY KEY (vault_id, employee_id)          -- 依据：架构 §4.2 成员权限显式授予（一员工一库至多一行）
) STRICT;

CREATE INDEX idx_vault_members_employee ON vault_members(employee_id);  -- 依据：架构 §4.2「我的库」列表/搜索过滤（未授权库不进列表）
```

### 3.7 drafts —— 网页草稿

```sql
-- @schema drafts
-- 草稿保存在数据库、按作者私有（架构 §3.1/§6）。访问时再次检查库权限（应用层，
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
) STRICT;
```

### 3.8 audit_events —— 审计事件

```sql
-- @schema audit_events
-- 以服务端认证身份记录主体、库、时间、旧新 commit 和结果（架构 §4.4）。
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
) STRICT;

CREATE INDEX idx_audit_vault_time ON audit_events(vault_id, occurred_at);   -- 依据：架构 §4.4 按库/时间查询（api.md §8 审计查询）
CREATE INDEX idx_audit_employee_time ON audit_events(employee_id, occurred_at);  -- 依据：按主体检索
CREATE INDEX idx_audit_open ON audit_events(status) WHERE status IN ('pending','unresolved');  -- 依据：backup-recovery §4 步骤 2 排空检查 / §7 步骤 7 恢复对账（部分索引，行数≈在途写数）
```

### 3.9 one_time_tokens —— 一次性令牌（K5）

```sql
-- @schema one_time_tokens
-- 引导/恢复令牌（identity §6.1 K5）：库内只存哈希 + 过期 + 单次计数（used_at 置位，
-- 应用层原子 UPDATE 判单次）。过期行由清理任务删除（T5 建议）。
CREATE TABLE one_time_tokens (
  id          INTEGER NOT NULL PRIMARY KEY,
  purpose     TEXT    NOT NULL CHECK (purpose IN ('bootstrap','password_reset','admin_recover')),  -- 依据：identity §7.1 初始化 / §7.2 口令重置 / §7.2 管理员锁死主机侧恢复
  token_hash  TEXT    NOT NULL UNIQUE,         -- 依据：identity §6.1 K5 只存哈希（与凭据同源 HMAC 形式，D-IC-03 同则）
  employee_id INTEGER REFERENCES employees(id),  -- bootstrap 无归属（NULL）
  expires_at  TEXT    NOT NULL,                -- 依据：identity §6.1 K5 短时效
  used_at     TEXT,                            -- 依据：identity §6.1 K5 单次；NULL = 未用
  created_at  TEXT    NOT NULL
) STRICT;
```

### 3.10 app_settings —— 运行时管理配置

```sql
-- @schema app_settings
-- 管理员可配置项的存储（T5 建议）：键名即 validation-defaults.json 的配置键
-- （validation.md §5.1），缺行 = 用默认值；配置 ≠ 规则版本（validation.md §7.3-4），
-- 变更走管理端点并记审计（api.md）。静态部署配置仍在 /data/config/（backup-recovery §2）。
CREATE TABLE app_settings (
  key        TEXT    NOT NULL PRIMARY KEY,
  value      TEXT    NOT NULL,                 -- JSON 值（与 validation-defaults.json 的类型一致）
  updated_by INTEGER REFERENCES employees(id),
  updated_at TEXT    NOT NULL
) STRICT;
```

## 4. 运行时检查查询（`-- @query`，实时查库、无缓存）

以下查询是 [identity §5.1](identity-credentials.md) 两层检查的规范 SQL，认证/授权实现不得加任何缓存（D-IC-05）。参数按 `?` 顺序由应用层绑定；`now` 一律服务端时钟。

```sql
-- @query authn.token
-- 认证层（Git HTTP Basic / API Bearer）：token 存在、未撤销、未过期、账号 active。
-- 覆盖四状态中的「过期 / 撤销 / 停用」三种（identity §5.2）；无行 = 401。
-- 参数：?1 = token_hash（HMAC 后），?2 = now
SELECT c.id AS credential_id, c.employee_id, c.scope_access, c.scope_vaults,
       e.is_instance_admin
FROM credentials c
JOIN employees e ON e.id = c.employee_id
WHERE c.token_hash = ?
  AND c.revoked_at IS NULL
  AND c.expires_at > ?
  AND e.active = 1;
```

```sql
-- @query authn.session
-- 认证层（Web 会话）：sid 有效、idle 未超时（last_seen_at ≥ idle 截止）、absolute 未过期、
-- 账号 active（identity §4/§5.2 停用 → 全部会话即刻无效）。无行 = 401 并登出。
-- 参数：?1 = sid_hash，?2 = now，?3 = idle_cutoff（now − idle_timeout）
SELECT s.id AS session_id, s.employee_id, e.is_instance_admin
FROM sessions s
JOIN employees e ON e.id = s.employee_id
WHERE s.sid_hash = ?
  AND e.active = 1
  AND s.absolute_expires_at > ?
  AND s.last_seen_at >= ?;
```

```sql
-- @query authz.role
-- 授权层：实时查成员关系与角色（identity §5.1 第 2 层，读路径与写路径一致）。
-- 无行 = 404（撤权/无权与不存在同响应，D-IC-06，不泄露库存在性）。
-- 参数：?1 = vault_id，?2 = employee_id
SELECT role FROM vault_members WHERE vault_id = ? AND employee_id = ?;
```

```sql
-- @query audit.drain_count
-- 排空检查（backup-recovery §4 步骤 2）：权威数据上无 pending/unresolved 写操作。
-- 参数：无
SELECT COUNT(*) AS n FROM audit_events WHERE status IN ('pending','unresolved');
```

```sql
-- @query audit.chain
-- 引用-审计成链核对（backup-recovery §5.1）：库内发布类成功事件的 old→new 序列，
-- 与各 ref 当前 OID 比对（应用层执行；恢复对账 §7 步骤 7 使用）。
-- 参数：?1 = vault_id
SELECT ref_name, old_commit, new_commit
FROM audit_events
WHERE vault_id = ?
  AND event_kind IN ('vault.push','vault.web_submit')
  AND status = 'succeeded'
ORDER BY occurred_at, id;
```

**写路径执行点复查**（identity §5.1 第 3 层）：pre-receive / 网页发布组件 update-ref 前**再次执行** `authz.role` 并复查维护模式标志，避免检查后权限失效仍继续发布（架构 §5.4）。凭据 scope 判定：`authn.token` 命中后，`scope_vaults` 非空则以库 id 求交集，空 = 全部有权库；与角色取更严者（identity §3.4 只收窄不扩大）。

## 5. 审计 event_kind 注册表

| event_kind | status 约定 | vault_id | 来源 |
|---|---|---|---|
| `vault.push` | pending → succeeded/rejected；异常 → unresolved | 是 | 架构 §4.4 |
| `vault.web_submit` | 同上 | 是 | 架构 §4.4/§5.4 |
| `vault.create` / `vault.update`（含 slug 改名、main_admin_only） | 直接终态 | 是 | 架构 §4.2/§4.3 |
| `member.grant` / `member.revoke` | 直接终态 | 是 | 架构 §4.2；identity §5.2 |
| `credential.create` / `credential.revoke` | 直接终态 | 否 | identity §8 凭据域 |
| `employee.create` / `employee.deactivate` / `employee.activate` / `employee.password_reset` | 直接终态 | 否 | identity §8 |
| `account.bootstrap` | 直接终态 | 否 | identity §7.1（actor_kind=bootstrap） |
| `admin.host_recovery` | 直接终态 | 否 | identity §7.2/§8（主机侧恢复，记来源） |
| `keys.pepper_rotate` / `keys.pepper_prune` | 直接终态 | 否 | identity §6.2/§8 |
| `maintenance.enable` / `maintenance.disable` / `backup.completed` | 直接终态（运行态写入，不入备份一致性集合） | 否 | backup-recovery §3 写分类 |

认证失败不逐条入审计（identity §8），以失败计数指标呈现——计数为进程内运行态，不落库。

| `vault.delete` | 直接终态 | 是（库行删除后历史行解除挂靠） | 架构 §4.2；backup-recovery §5 不变量 3 |
| `config.update` | 直接终态 | 否 | storage-model §3.10（变更走管理端点并记审计）；validation §5.1 |

（2026-10-13 ADR D12 追加两行。）

## 6. 跨存储一致性与发布审计模式

审计与 Git 引用更新**不能假设跨存储原子提交**（架构 §4.4）：

1. `BEGIN IMMEDIATE`：插入 `audit_events`（status=`pending`，含 old/new commit 预期值），提交事务——**预记录先于引用更新**。
2. 更新 Git 引用（git receive-pack 迁移 quarantine / Web 发布组件 update-ref）。
3. 核对引用实际结果，`UPDATE audit_events SET status = 'succeeded'|'rejected'`。
4. 进程在 2–3 之间崩溃 → 行停留 `pending`，由恢复对账（backup-recovery §7 步骤 7）按引用实际 OID 标 `succeeded`/`rejected`，超时未决先标 `unresolved`。
5. 备份排空以 `audit.drain_count` = 0 为条件（backup-recovery §4 步骤 2）；恢复校验以 `audit.chain` 与 refs OID 相邻成链为不变量（§5.1–2）。

多 ref push 按每个 ref 更新各记一行（`vault.push`，同一事务批量预记录），与「所有 ref 先统一检查、通过后才允许更新」的全有或全无语义（架构 §5.4）对应：任一 ref 校验失败 → 全部 ref 不更新、全部行置 `rejected`。

## 7. 开放项（S2 实现期定稿）

- username 大小写策略：当前精确匹配唯一（NFC 规范化后）；是否改为大小写不敏感唯一待 S2 定（影响登录提示一致性，identity §2 统一失败文案不受影响）。
- Argon2id / HMAC 具体库（原生绑定 vs WASM）：S2 按 D10 栈定（identity §9 遗留）。
- 登录限速默认阈值与窗口（identity §2）：S2 实测定；计数器进程内实现。
- 审计保留期限与归档策略：未定，v1 不清理。
- 索引随 S7 负载测试复核（当前按查询路径最小集）。
- drafts 大字段（content）超长控制：保存时按 `maxDocumentBytes` 拒绝（T2 §5.1），schema 不另设限。

## 8. 自检门禁（DDL 冒烟测试）

```sh
# 仓库根目录；依赖 Node ≥22.13（node:sqlite），推荐 Node 24（D10）
node --test docs/contracts/tools/ddl_smoke.test.mjs
```

检查项：全部 `-- @schema` 块在 fresh `:memory:` 库（`foreign_keys=ON`）按序执行；`vaults.slug` 唯一；FK 生效（凭据→员工）；四状态撤权路径经 `authn.token`/`authz.role` 规范查询验证（过期/撤销/停用/移除成员 → 无行）；角色与 purpose/status CHECK；审计 pending→终态与排空/成链查询；`schema_version` 触发器拒绝 UPDATE/DELETE；草稿三元组唯一；一次性令牌与配置键唯一。附 api.md lint（见该文件 §2）。建议 T6 将本命令登记为 contracts gate。

## 9. 与其他任务/契约的关系

| 关联方 | 内容 |
|---|---|
| [api.md](api.md) | 端点读写本 schema 的行为契约；错误码与撤权 404 语义（D-IC-06）在 API 层呈现 |
| S2（实现） | 本契约的直接实现者；开放项定稿处 |
| T6（gates） | 将 §8 命令登记进 AGENTS.md gates（D5：附日期固化） |
| backup-recovery | §2 数据分类、§6 一致性模式、排空/对账查询直接对接其 §4/§5/§7 |
| identity-credentials | §3–§6 表结构与查询为其 §3–§8 的落库形态；语义以该契约为准 |
