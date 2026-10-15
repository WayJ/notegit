# API 契约补正建议（S18 读协议 v1）

- **状态**：S18-T1 起草「## T1」节（2026-10-16），待 master 评审；「## T2」节由 S18-T2 追加。
  评审通过后由 master 落 api.md §3 对应行并在 epic 的 Decisions (ADR) 记录——按仓库约束，
  本文件不改 contracts/。先例：docs/s1/ 各 amendments 建议稿（D11/D12–D14 模式；S18 D5）。
- **范围**：E6 D36 读协议四端点中 T1 份额——库清单（GET /api/v1/vaults，既有端点增量）
  与逐库索引状态（GET /api/v1/vaults/{slug}/index-status，新端点）。

## T1 库清单与索引状态（S18-T1）

### 建议入册文本（api.md §3 新增小节，编号建议 §3.9）

#### GET /api/v1/vaults（更新既有 §5 同名行；机器面 agent 消费口径）
- 认证：§1 通用（Bearer/会话双载体；401 JSON 信封——API 形态，非页面 302）。
- 成功：200 `{vaults: [{slug, name, role, default_branch, main_admin_only, doc_count}]}`——
  仅当前凭据有成员关系的库（实时 JOIN vault_members，与检索/工作台同一判定面，无权库零
  出现；撤权下一请求即消失）；token scope 取交集（identity §3.4，既有语义保持）。
  `doc_count` = `search_index` 行数（标量子查询，与工作台 vaultCards 同源——数字差值不
  泄露无权库）。排序 slug 升序。
- 错误：401（§1 通用）；列表不产生 404（无权库不出现而非报错，既有 §5 语义不变）。

#### GET /api/v1/vaults/{slug}/index-status（新端点）
- 用途：逐库索引状态（变更感知面，agent 轮询判据——agent-guide「变更感知」章数据源）。
- 认证与门槛：§1 通用 401；read 成员（共用 authorize，identity §5.1 第 2 层 + scope 交集）。
- 成功：200 `{slug, head_commit, indexed_at, lag_ms, consecutive_failures, last_error}`——
  `search_index_state` 该库行如实呈现。**无状态行 = 首次未索引语义：除 slug 外字段如实
  全 null**（不用 0 伪造「已索引无失败」）；`head_commit: null` = 分支尚无提交（DDL 既有
  语义）；`lag_ms: null` = 重建型触发/失败无完成延迟（DDL 既有语义）。
- 错误：401（§1 通用）；**404 E-RES-001：无成员关系（含撤权）与不存在同响应同体零区分**
  （D-IC-06 API 面——实例管理员非成员同样 404，存在性不泄露）。
- 只读：GET 免 CSRF、不记审计行、维护模式放行（读路径族）；无 ETag（commit 锚定协商缓存
  是 T2 tree/docs 的份额，本端点状态行非内容寻址）。

### 偏差披露（实现相对任务简报）

1. **响应形态**：任务简报与 D36 草案把清单写作裸数组 `[{slug, name, role, default_branch,
   doc_count}]`。实现保持既有 `{vaults: [...]}` 包裹层并保留 `main_admin_only`，**增量**追加
   `doc_count`。依据：(a) `GET /api/v1/vaults` 已存在于 vaultsPlugin（api.md §5 入册端点），
   Fastify 同路径同方法不可二次注册；(b) 既有消费方以形状校验强依赖现状——CLI
   `cli/src/ls/api.ts`（`vaults` 数组 + 逐项 `main_admin_only: boolean`）、Web 页面
   `server/src/web/pages.ts`（解构 `{vaults}`）、e2e-final-regression 等测试——裸数组/删字段
   即破坏消费面，违背本任务「写通道零变更、全量测试只增不减」约束。选型为**可逆增量**：
   agent 需要的字段（doc_count）齐备，既有契约零回归。若 master 裁决裸数组为目标形态，应
   走 api.md 版本演进（§11 开放项）单独批次，随 CLI/Web 消费方同步迁移。
2. **路由归属**：清单路由处理器自 `server/src/vaults/routes.ts` 迁入
   `server/src/api-read/vaults.ts`（D1 文件所有权：T1 持 api-read/vaults.ts，路由注册在
   各自模块内）；`VaultService.listVaults` 保留并扩展（Web 页面下拉/列表仍消费——doc_count
   为增量字段，页面不消费不受影响）。api-read 路由层零 SQL：权限判定经
   authorize×MembershipSource、数据访问经 VaultService（vaults-matrix 结构断言同一纪律
   在 api-read 域的延续；`getIndexState` 为服务层新增只读方法）。
3. **实现状态**：已实现并测试（`server/src/api-read/vaults.ts`；测试
   `server/test/api-read-vaults.test.ts` 六项：匿名 401 API 信封、清单形状快照、bob 无权
   库零出现、撤权即时、index-status 三态（健康/失败/无行）、404 同体零区分）。TDD 先红后绿。
