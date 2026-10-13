# 搜索索引契约补正建议（S5-T3）

- **状态**：S5-T3 起草（2026-10-13），待 master 评审。评审通过后由 master 落对应契约原文并在 epic 的 Decisions (ADR) 记录——按仓库约束，本文件不改契约。先例：api-md-amendments.md（S4-T1，A1–A5）。**C3 由 S5-T4 追加（2026-10-13，coordinator 批复建议稿形态）——三节一并待 D13 裁决。**
- **范围**：S5-T3 落地的两处契约外事实面——派生索引表的 DDL 归属（storage-model.md 目前明示「派生（不在本 schema）」）与索引可观测管理端点（api.md 无定义）；S5-T4 追加查询端点与搜索页的入册文本（api.md §3 查询端点 + §13 页面行）。另附实现形态选型记录（进程内异步 vs 队列；LIKE vs 全文引擎）供 ADR 归档。
- **实现状态**：全部已实现并测试（迁移 0009；`server/src/search/`；`server/src/web/search/`；35 项新测试；npm test 全绿）。

## C1 派生索引表的 DDL 归属（storage-model.md）

**现状**：storage-model §2 数据分类将「标题/标签/摘要/搜索索引」列为**派生（不在本 schema）**，依据架构 §3.1「可从 Git 重建」。S5-T3 需要落表（索引行 + 可观测状态行），DDL 目前唯一落点是 `server/src/db/migrations.ts` 迁移 0009——契约外的 DDL 事实面。

**建议**（二选一，倾向 (a)）：

**(a) 维持「派生不入权威 schema」，在 storage-model 增设一节「派生数据表（非权威面）」登记 DDL**（编号建议 §3.11，标注「派生：不入备份一致性集合、可全量重建、随 T5 重建入口复核」）。ddl_smoke 测试可扩为对该块做同样的逐字防漂移对照。DDL 逐字可用稿：

```sql
-- 派生元数据索引（架构 §3.1：标题/标签/摘要 = 派生数据，可从 Git 全量重建；
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
  summary    TEXT    NOT NULL,             -- 正文首段摘要片段（截断存储，长度上界 500 字符）
  indexed_at TEXT    NOT NULL,             -- 行写入时间（服务端时钟）
  PRIMARY KEY (vault_id, path)             -- 一库一路径一行（全量替换；旧路径删除即消失）
) STRICT;

-- 索引状态与可观测面（逐库一行）：延迟指标（lag_ms = indexed_at − 触发发布的
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
) STRICT;
```

**(b)** 升 `schema_version` v10 并把两表并入权威 @schema 块——**不建议**：与 §2 的数据分类（派生不入权威库、备份不覆盖）自相矛盾，且派生表带外键会阻塞权威侧删库（实现已裁决无外键）。

**待裁决**：(a) 的落点节号与 ddl_smoke 是否扩防漂移对照；(b) summary 截断上界 500 字符是否入契约常量（当前在 `server/src/search/derive.ts` 的 `SUMMARY_MAX_CHARS`）。

## C2 索引可观测管理端点（api.md）

**现状**：S5-T3 已实现 `GET /api/v1/admin/search-index`（`server/src/search/routes.ts`）：实例管理员门槛（401/403 同 §3.1 语义），只读。api.md 无定义（A1 维护端点同款「已实现、未入册」形态）。

**建议 api.md 文本**（§3 新增小节，编号建议 §3.5）：

```markdown
### 3.5 搜索索引状态（实例管理员；架构 §9 索引延迟可观测）

- **GET /api/v1/admin/search-index**（读）：200 `{running, pollMs, vaults: [{vault_id, slug, branch,
  head_commit, live_commit, up_to_date, indexed_at, triggered_by, triggered_at, duration_ms, lag_ms,
  updates, consecutive_failures, last_error, last_error_at, rows}]}`。
  - `head_commit` = 索引已反映的默认分支头；`live_commit` = 当前实际头；`up_to_date` = 两者相等（实时新鲜度）。
  - `lag_ms` = 发布（审计行 occurred_at）→ 索引完成 的延迟指标；`duration_ms` = 单次派生耗时。
  - 失败告警面：`consecutive_failures` / `last_error` / `last_error_at`（索引失败不阻断发布——架构 §9/D7，只在此与日志可见）。
  - 无 dataDir 接线形态（测试面）：`{running: false, pollMs: null, vaults: []}`。
- 错误：401（§1 通用）；403 E-AUTHZ-001（非实例管理员）。
- 审计：只读端点，不记审计行。
```

**待裁决**：(a) 是否补 `POST /api/v1/admin/search-index/rebuild`（T5 全量重建入口的端点形态——当前 T5 未启动，留待其任务定义）；(b) `pollMs` 是否作为 app_settings 配置键暴露（当前仅 `NOTEGIT_SEARCH_POLL_MS` 环境变量）。

## C3 元数据查找：查询端点与搜索页（api.md，S5-T4）

**现状**：S5-T4 已实现两处查找入口（消费 C1 的 search_index 表）：
- **GET /api/v1/search?q=**（`server/src/search/routes.ts` + `server/src/search/query.ts`）：任意认证员工；鉴权过滤 = 查询 SQL 实时 JOIN `vault_members`（identity §5.1 第 2 层同一张表、逐请求查库——D7「过滤与授权层同一无缓存原则」，不建权限缓存；撤权下一查询即消失）+ token scope 交集（identity §3.4，与 §5 GET /vaults 同一收窄面）。api.md 无定义（C2 同款「已实现、未入册」形态）。
- **GET /search?q=**（`server/src/web/search/`，S4 骨架 append）：会话认证（未认证 302 /login）；与 API 端点同一查询面同一判定面；§13 表行待入册。

**建议 api.md 文本**（§3 新增小节，编号建议 §3.6；§13 表 append 一行）：

```markdown
### 3.6 元数据查找（任意认证员工；架构 §9 派生索引按权限过滤、§4.2 未授权的库不进搜索结果）

- **GET /api/v1/search?q=<关键词>**（读）：按标题/标签/摘要关键词查找**本人有权库**的已发布元数据（S5-T4）。
  - 匹配语义：SQL LIKE 子串（不引全文引擎——当前容量选型，见 search-index-amendments 选型记录）；`%`/`_`/`\` 一律字面化不充当通配符；ASCII 大小写不敏感（SQLite LIKE 内建语义），其他文字精确子串。
  - **鉴权过滤**：实时 JOIN 当前成员关系（identity §5.1 第 2 层同一无缓存判定面；撤权下一查询即消失，§5.2 行 4 同源）；token scope 清单非空时再取交集（§3.4）。
  - 成功 200：`{q, truncated, results: [{vault_slug, vault_name, path, commit_oid, title, tags, summary, matched}]}`。结果行 = 库/路径/commit 三要素 + 标题 + 标签序列 + 摘要片段（首段、≤500 字符）+ 命中字段（`matched ⊆ {title, tags, summary}`，逐标签精确——跨标签 JSON 边界的子串不算命中）；title=null = frontmatter 豁免文件（README 等，如实记录）。确定性排序（vault slug → path）；上限 100 行，超出 `truncated: true`（不承诺分页）。
  - 错误：401（§1 通用）；400 E-RES-004（缺/空 q）；422 E-RES-007（q 超 200 字符）。
  - 审计：只读端点，不记审计行。索引滞后语义见 §3.5（最终一致，不阻断发布）。
```

§13 表 append 行（页面路由族）：

```markdown
| GET /search[?q=] | 元数据查找页（S5-T4）：标题/标签/摘要关键词表单（maxlength=200）+ 结果表（库→browse、路径→view 链接；行含 库/路径/commit 三要素、标题、标签、摘要片段、命中字段标注；frontmatter 豁免文件如实标注无标题）；与 §3.6 GET /api/v1/search 同一查询面同一鉴权判定面（实时成员关系，撤权下一渲染即消失）；结果超 100 行如实标注截断；空 q 表单空态、超长 q 422 同页提示；插值唯一通道 HTML 转义（XSS 诱饵不执行）；未认证 302 /login；GET 免 CSRF | S5-T4 |
```

**待裁决**：(a) 端点落点节号（§3.6 建议）；(b) 上限 100 行与 q 上界 200 字符是否入契约常量（当前在 `server/src/search/query.ts` 的 `SEARCH_RESULT_LIMIT`/`SEARCH_MAX_Q_CHARS`）；(c) 是否需要分页参数（当前 truncated 如实标注、不承诺分页——容量证明需要时再议）。

## 实现形态选型记录（供 epic ADR 归档；breakdown 第 5 点）

**选型：进程内异步（审计尾随轮询 + 逐库串行重索引），不引队列服务。**

- 单进程现实（架构 §9 初版单实例）排除外部队列（Redis/PG 队列等）——运维面不匹配。
- 触发面统一走**审计尾随**：push 的 T6 settle 钩子与网页发布（管线 settle 步）都置
  `succeeded` 审计行，索引器尾随该行触发（默认 250ms 轮询，`NOTEGIT_SEARCH_POLL_MS` 可配）。
  发布路径（hook 子进程 / 发布组件）**零改动**——解耦是结构性的，不是约定的。
- 被否方案：发布路径直接通知（需改 pipeline/多个 web 路由 + hook 子进程跨进程通知，
  接线散、crash 语义复杂）；启动对账已覆盖「通知丢失」形态（逐库比对 state 头 vs 实际头）。
- 最终一致上界 = 轮询间隔 + 派生耗时（E2E 实测：网页发布 78ms、push 51ms，含 50ms
  测试轮询间隔；断言上界 5000ms——见 search-e2e.test.ts 输出留档）。
- 关键修正（实现中发现）：水位线不得越过**在途 pending 行**——发布审计是「预记 pending →
  settle 原位置终态」生命周期（id 不变），按 id 单调推进会漏看本轮 pending、settle 后
  永不再扫的行。扫描上界 = min(max(id), min(pending id) − 1)。

### 查找匹配选型（S5-T4，breakdown 第 1 点「SQL LIKE 或等价——规模内不做全文引擎」）

- **选型：SQLite LIKE 子串匹配**（`server/src/search/query.ts`），不引 FTS5/外部全文引擎：
  当前容量（单实例、库级千行量级派生表）LIKE 全表扫即可满足；`%`/`_`/`\` 字面化
  （ESCAPE '\'）后语义即「子串包含」，无注入面。ASCII 大小写不敏感 = SQLite 内建语义；
  CJK 等其他文字精确子串（如实记录，不做音形归一）。
- tags 匹配两段式：候选行按 JSON 文本 LIKE 粗筛（与 title/summary 同一模式），命中字段
  在应用层**逐标签**精确复核（跨标签 JSON 边界的子串不算命中），无精确认证的候选行
  整行丢弃——粗筛只放大候选集，不产生假阳性结果。
- 升级路径：容量/负载证明需要时迁 FTS5（T5 重建入口同源可灰度重建），授权过滤语义
  （实时 JOIN 成员关系）不变。

## 落点汇总

| id | 契约文件 | 落点 | 性质 | 实现状态 |
|---|---|---|---|---|
| C1 | storage-model.md | §3.11（建议，非权威面登记）或维持现状（migrations.ts 为 DDL 家） | 派生表 DDL 归属 | 已实现（迁移 0009） |
| C2 | api.md | §3.5（建议） | 补录已实现端点 | 已实现（search/routes.ts） |
| C3 | api.md | §3.6（建议）+ §13 表行 | 补录已实现查询端点与搜索页 | 已实现（search/routes.ts + search/query.ts + web/search/） |
| — | 架构 §13 / epic ADR | — | 实现形态选型（进程内异步审计尾随；LIKE 子串不做全文引擎） | 已实现（search/indexer.ts、search/query.ts） |
