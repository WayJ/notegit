# 运维指标面契约补正建议（S8-T2）

- **状态**：S8-T2 起草（2026-10-13），待 master 评审。评审通过后由 master 落对应契约原文并在 epic 的 Decisions (ADR) 记录——按仓库约束，本文件不改契约。先例：api-md-amendments.md（S4-T1，A1–A5）、search-index-amendments.md（S5-T3…T5，C1–C4）。
- **范围**：S8-T2 落地的契约外事实面——运维指标端点（api.md 无定义；架构 §10 最低清单「健康检查、磁盘容量、校验耗时、失败推送、备份完成时间」的可查呈现，R14 方法）。另附实现形态选型记录（独立面 vs healthz 扩展；失败计数以审计行为唯一来源；校验耗时的进程内采样边界；水位阈值）供 ADR 归档。
- **实现状态**：全部已实现并测试（`server/src/metrics/`——collector/disk/routes；接线 `app.ts`（onResponse 认证失败计数 + 路由注册）与 `limits/engine.ts`（runServerValidation 计时）；19 项新测试（collector 6 + disk 5 + routes 8，含递增断言与磁盘填充告警断言）；npm test 全绿）。

## C1 运维指标端点（api.md）

**现状**：S8-T2 已实现 `GET /api/v1/admin/metrics`（`server/src/metrics/routes.ts`）：实例管理员门槛（401/403 同 §3.1 语义），只读。api.md 无定义（A1 维护端点同款「已实现、未入册」形态）。

**建议 api.md 文本**（§3 新增小节，编号建议 §3.8）：

```markdown
### 3.8 运维指标（实例管理员；架构 §10 最低清单、R14 方法）

- **GET /api/v1/admin/metrics**（读）：200 单对象——
  - `disk`：`{wired, data_dir, capacity_bytes, free_bytes, domains: [{name, used_bytes}],
    watermark: {used_ratio, level, alert, warn_ratio, critical_ratio}}`。
    分域清单 = backup §2 四分域（git/db/config/keys）递归字节合计；容量/空闲取
    dataDir 所在文件系统 statfs；`level ∈ ok|warn|critical`（默认阈值 0.80/0.90，
    `used_ratio ≥ critical` 即 critical、`≥ warn` 即 warn；`alert` ⇔ warn/critical）；
    容量不可知 → `level: unknown` 不告警（不伪造比值）。无 dataDir 接线形态
    （测试面）`{wired: false}`。
  - `pushes`：`{failed, unresolved}`——vault.push 终态计数（**审计行为唯一计数
    来源**，storage-model §5/§6；unresolved 为恢复对账可见性，S8-T6 消费）。
  - `web_submits`：`{failed}`——vault.web_submit rejected 计数（同上）。
  - `validation`：`{failed, timing}`——failed = detail.reason='validation' 的拒绝行
    （push 与 web-submit 两入口通吃）；timing 按 scope 呈现
    `{count, p50_ms, p95_ms, max_ms}`（最近邻秩；样本窗口 512/每 scope）。
    **边界**：pre-receive scope 的校验运行于 hook 子进程，样本不驻留 app 进程——
    生产形态 timing 只覆盖 web-submit scope（如实呈现，push 侧失败次数走
    failed 不受影响）。
  - `auth_failures`：`{total, by_entry: {api, web, git}, last_at}`——identity §8
    「认证失败不逐条入审计」的失败计数替代呈现（401 响应归因，E-AUTH-001..004
    全集；429 限速与 403 授权拒绝不计）。进程内运行态计数，**重启归零**（如实呈现）。
  - `backup`：`{wired: false, last_completed_at: null}`——备份完成时间预留字段，
    S8-T4 一致备份落地后接线。
- 错误：401（§1 通用）；403 E-AUTHZ-001（非实例管理员）。
- 审计：只读端点，不记审计行；维护模式读放行（§3 矩阵第 7 行）。
```

**待裁决**：(a) 小节编号（§3.8 建议）；(b) 水位阈值 0.80/0.90 是否入契约常量或
app_settings 配置键（当前 `server/src/metrics/disk.ts` 的
`DEFAULT_WATERMARK_THRESHOLDS` 常量，测试缝可注入）；(c) `pushes.unresolved`
与 S8-T6 恢复对账端点的呈现分工。

## C2 备份完成时间预留（api.md + backup-recovery.md）

**现状**：端点已带 `backup: {wired: false, last_completed_at: null}` 预留字段；
S8-T4 一致备份落地时接线（完成时间与产物状态）。R14 演练（T5）消费本字段核对
「备份完成时间可查」。

**建议**：T4 落地时随其管理端点/manifest 一并定稿字段形态（本任务不预设 schema，
只保证键位与「未接线如实 null」语义）。

## 选型记录（供 ADR 归档）

### 独立面 vs healthz 扩展

**选型：独立管理面 `GET /api/v1/admin/metrics`，不扩展 /healthz。** 依据：

- /healthz 是容器基础设施探针（T1 Dockerfile HEALTHCHECK 消费面）：无认证、
  轻量、不耦合管理数据——运维指标含审计计数与认证失败统计，需实例管理员门槛，
  塞进 healthz 要么泄露要么把探针变成认证依赖（探针失败误判容器不健康）。
- healthz 维持 `{status: 'ok'}` 不动；指标面按 R14「运维页/API 可查」取 API 形态
  （最小实现；运维页留待需要时再议——本任务只交 API）。

### 失败计数以审计行为唯一来源（不另立账本）

**选型：pushes/web_submits/validation 的 failed 计数直接查 audit_events 终态行
（rejected/unresolved），不建独立计数表。** 依据：

- 审计链已是发布/推送失败的唯一权威账本（storage-model §5/§6：pending 预记 →
  终态 settle），再立一份计数会在恢复/对账场景出现两本账对不上的面。
- 重启不丢、与 S8-T6 恢复对账同源；代价是逐请求 COUNT 查询（当前容量下与
  drainCount 同量级，毫秒内）。
- 被否方案：进程内计数器持久化到 app_settings——配置域污染 + 与审计面漂移。

### 校验耗时：进程内采样，push 侧如实留界

**选型：`runServerValidation`（limits/engine 判定点统一入口）计时入进程内采集器
（512 样本窗口、最近邻秩分位），不持久化。** 依据：

- engine 是 web-submit（发布组件，app 进程）与 pre-receive（hook 子进程）唯一
  共同入口——单一挂接点覆盖两个判定面，无接线散布。
- pre-receive 样本随 hook 子进程消亡是进程模型的固有边界（非遗漏）：端点如实
  只呈现驻留样本，push 侧失败**次数**走审计面不受影响。持久化 push 侧样本需要
  新表（storage-model 契约面）或审计 detail 扩展（pre-receive/post-receive 两处
  改动）——留给 master 随 T4/T6 批次裁决，本任务不预占。
- 被否方案：Report 增 durationMs 字段——validation-report.schema.json 是 T2
  契约面（禁改域），且 pre-commit scope 无服务端计时语义。

### 认证失败计数：401 响应归因（应用级 onResponse）

**选型：应用级 onResponse 钩子按 401 响应计入（api/web/git 三入口分桶）。** 依据：

- identity §8 要求「失败计数指标」替代逐条审计——401 是认证失败（E-AUTH-001..004）
  的统一传输层呈现，逐路由挂接（auth/lifecycle、githttp、web 各处）接线散且易漏；
  响应级归因一次覆盖三入口，包括 Git Basic 401。
- 429 限速、403 授权拒绝不计（非认证失败）；语义粒度到入口级即可（§8 未要求
  码级细分，401 响应面上 001..004 不可分）。

### 水位阈值：常量 + 注入缝

**选型：0.80/0.90 两档常量（`DEFAULT_WATERMARK_THRESHOLDS`），测试缝可注入。**
依据：架构 §10 未定数值；磁盘填充测试以微阈值/注入用量跨阈（不真灌盘——CI 与
开发者机器不可控）；运行时配置化（app_settings）留待实际运维需要（S8-T8 容量
收口一并议）。

## 落点汇总

| id | 契约文件 | 落点 | 性质 | 实现状态 |
|---|---|---|---|---|
| C1 | api.md | §3.8（建议） | 补录已实现端点 | 已实现（metrics/routes.ts） |
| C2 | api.md + backup-recovery.md | T4 落地时定稿 | 备份完成时间字段预留 | 已实现（wired:false/null） |
| — | 架构 §13 / epic ADR | — | 选型（独立面；审计面唯一计数源；校验耗时进程内采样边界；401 归因；水位常量） | 已实现 |
