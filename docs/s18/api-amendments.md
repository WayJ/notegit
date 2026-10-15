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

## T2 目录树与文档读取（S18-T2，E6 R01/D36/D37/D38；S18 D2/D3/D4）

- **状态**：S18-T2 起草（2026-10-16）；待 master 裁决。
- **范围**：api.md 新增 §3.9「知识读取（agent 读协议 v1，任意 read 成员）」两行；§1 错误码注册表新增一行 E-RES-009。实现自本任务（`server/src/api-read/{tree,docs}.ts`；测试 `server/test/api-read-{tree,docs}.test.ts` 21 例）。
- **共同语义**（两端点一致，与 §3.6 检索端点同一判定面）：认证=统一缝双载体（匿名 401 E-AUTH-001..004）；门槛=authorize read（reader 即满足，token 载体按 scope 交集收窄 identity §3.4——越范围与无权同 404）；无权/不存在/未知 OID/未知路径一律 404 E-RES-001 同信封（D-IC-06 API 面——反存在性，零存在性泄露）；GET 免 CSRF；只读不记审计行；写通道零变更。缓存=协商缓存（2026-10-15 热修同构）：`ETag: "<commit_oid>"` + `Cache-Control: no-cache`，`If-None-Match` 命中回 304（空体）——内容即 commit 锚定，HEAD 缺省随提交前进即时失效、锚定 ref 的 ETag 恒定。

### B1 GET /api/v1/vaults/{slug}/tree[?ref=<commit OID>]（逐字可用建议文本）

```markdown
- **GET /api/v1/vaults/{slug}/tree[?ref=<commit OID>]**（读；E6 读协议 v1，S18-T2/D4/D38）：库默认分支或指定提交的**全树扁平清单**（agent 自行构树，不预设层级形态）。成功 200 `{vault, ref, commit_oid, entries: [{path, type, size}], truncated}`——`ref`=请求回显（缺省回显默认分支名），`commit_oid`=解析后全 SHA（缺省=默认分支 HEAD）；`entries`=扁平路径数组（`ls-tree -r -t` 全树递归，树序=深度优先字节序；type ∈ tree|blob，blob 的 size=字节数、tree 的 size=null；子模块不属 v1 契约、如实不出现）；上限 1000 条超出 `truncated:true` 如实标注（不承诺分页——Q-E6-1 v1 形态，与检索 100 截断同哲学）。`ref` 语义（D38）：只收 commit OID（hex 缩写/全 SHA，与 version 页同判）；缺省=默认分支 HEAD（空库 unborn → 404 E-RES-001 如实）；分支名等 rev 形态 **400 E-RES-004** 如实拒（分支会漂移、commit 不会——引用锚定优先）；hex 形态但未知/非提交 → 404 E-RES-001 反存在性。错误：401（§1 通用）；400/404/403 同上通用语义；503 无码信封（仓库存储未挂接/读取失败——仅故障形态）。
```

### B2 GET /api/v1/vaults/{slug}/docs/{path}[?ref=<commit OID>]（逐字可用建议文本）

```markdown
- **GET /api/v1/vaults/{slug}/docs/{path}[?ref=<commit OID>]**（读；E6 读协议 v1，S18-T2/D3/D38）：单文档读取（原始 Markdown＋元数据双给全，不预设消费方渲染栈）。成功 200 `{vault, path, ref, commit_oid, frontmatter, body, body_raw, size_bytes, fetched_at}`——`ref`/`commit_oid` 语义同 tree 行；`body_raw`=该提交的文件原文；`body`=frontmatter 剥离后正文（闭合 `---` 之后原文——与 view/version 页、检索 body 派生同一切面）；`size_bytes`=原始字节数；`fetched_at`=服务端响应时刻 ISO 8601（**不可信为内容时间**——内容时间锚=commit_oid）。`frontmatter` 三态如实：闭合块且保守行式解析成功 → 对象（title/tags/status 等标量与字符串列表；与 validation §3 六字段契约对应）；无块（README 等豁免/无 frontmatter）、块未闭合、或块解析失败（畸形）→ **null 且 body=原文全量**（读取面不做发布校验——畸形不阻断读取）。仅 `.md`（与页面族同判）：其余类型 **415 E-RES-009** 如实拒（v1 不提供）；目录路径/不存在路径 → 404 E-RES-001。历史 blob 走 version 页同一读取面（同一棵树——D38 历史 blob 鉴权同源）。错误：401；400 E-RES-004（ref 非 OID 形态）；404 E-RES-001（同上反存在性）；415 E-RES-009；503 无码信封。
```

### B3 §1 错误码注册表新增一行

| 码 | HTTP | 语义 | 依据 |
|---|---|---|---|
| E-RES-009 | 415 | 类型不支持：读协议 v1 仅提供 .md 知识文档（docs 端点） | S18-T2/D3；建议稿（本节），master 裁决落 §1 |

### 理由

1. **ref=OID 与 version 页同一棵树**（D38）：历史读取复用 `readEntryAtCommit`（S5-T2 读取面）而非第三套 ls-tree 解析——「锚定引用」是底座核心承诺，同一实现消除两处语义漂移的可能；分支名 400 如实拒而非静默当 HEAD（避免分支漂移锚）。
2. **frontmatter 三态而非校验复读**（D36）：读取面消费 `extractFrontmatter` 单一切块语义（三入口同一解析面先例），字段解析保守行式（search 派生面同哲学——不引 YAML 依赖）；畸形降级为 null+原文全量而非 4xx——agent 拿原始事实自行判断，读取面不执行发布校验。
3. **truncated 而非分页**（Q-E6-1 v1）：与检索 100 截断同哲学；单库超 1000 条实测出现前不预设分页参数形态（避免契约半成品）。
4. **E-RES-009 独立新码**：415 语义在 §1 无既有码可承载；沿用「沿用既有风格或建议新码」通道进建议稿（D12 先例），不静默复用语义不符的 404/400。

### 待裁决

(a) `ref` 缺省回显默认分支名（本节立场——agent 可知「读到的是哪个分支的头」）还是回显 null（更纯的 echo 语义）；
(b) `frontmatter` 保守解析的边界形态（块标量 `|`/`>`、嵌套映射 → null 降级）是否需要逐形态入契约文，还是保持「解析失败→null」一句承载；
(c) E-RES-009 码名与落 §1 注册表时机（与 B1/B2 同批落契）。

### 落点汇总

| id | 契约文件 | 落点 | 性质 | 实现状态 |
|---|---|---|---|---|
| B1 | api.md | 新增 §3.9 GET /vaults/{slug}/tree 行 | 读协议 v1 端点入册 | 已实现（S18-T2，9 测试） |
| B2 | api.md | 新增 §3.9 GET /vaults/{slug}/docs/{path} 行 | 读协议 v1 端点入册 | 已实现（S18-T2，12 测试） |
| B3 | api.md | §1 注册表新增 E-RES-009 行 | 错误码入册 | 已实现（415 断言锁定） |
