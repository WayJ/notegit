# 维护排空与矩阵对账契约补正建议（S8-T3）

- **状态**：S8-T3 起草（2026-10-13），待 master 评审。评审通过后由 master 落对应契约原文并在 epic 的 Decisions (ADR) 记录——按仓库约束，本文件不改契约。先例：api-md-amendments.md（S4-T1，A1–A5）、search-index-amendments.md（S5-T3，C1–C4）。
- **范围**：S8-T3 落地过程中发现的契约外事实面与语义缺口——维护进度端点（api.md §3.3 无 GET 定义）、排空原语语义定稿（backup §4 步骤 2 的实现形态）、Git receive 403 文案在标准 git 客户端的可见性、「运维审计行不入备份」与 §4 步骤时序的精确化、维护 403 对非成员 receive 的判定顺序。
- **实现状态**：M1/M2 已实现并测试（`server/src/maintenance/drain.ts`、`maintenance/routes.ts` GET 面；`server/test/maintenance-drain.test.ts` 8 项、`maintenance-matrix.test.ts` 7 项——矩阵逐行 + 排空两路径）；M3–M5 为如实记录的缺口/裁决项，实现维持现状（见各节「建议」）。

## M1 维护进度端点入册（api.md §3.3）

**现状**：api.md §3.3 只定义 POST/DELETE 两个生命周期端点。S8-T3 为 backup §4 步骤 2「排空进度可查」落地了 GET 面：

- `GET /api/v1/admin/maintenance`（读；实例管理员）：`200 {enabled: boolean, drain: {pending: number}}`。`pending` = storage-model §4 `audit.drain_count` 规范查询（pending|unresolved 在途写计数）——维护关闭时恒为当前计数（通常 0），维护开启时即排空进度。GET 属安全方法，维护中放行（§3 矩阵第 7 行）。
- `drain.pending` 设计为 S8-T2 指标面（R14）可直接消费的预留字段；T2 若落 `/healthz` 扩展或独立指标端点，建议从此端点/查询取数而不是另建口径。

**建议**：api.md §3.3 追加 GET 端点行（上列形状）；同时把「S8-T3 实现于维护端点、T2 指标面消费」记入 ADR。

## M2 排空原语语义定稿（backup §4 步骤 2 的实现形态）

**现状**（`server/src/maintenance/drain.ts`，均由测试锁定）：

- 判据 = `audit.drain_count` 规范查询逐字（pending|unresolved 计数）——**unresolved（待核对）行同样阻塞排空**：快照前必须无残留（§5 不变量 1），待核对行只能经恢复对账（S8-T6）清算。
- 有界等待默认 `DRAIN_TIMEOUT_DEFAULT_MS = 300_000`（§4 步骤 2 原文缺省），`timeoutMs` 可配（T4 备份流程注入）；轮询节奏 `pollMs` 缺省 250ms（无契约约束，测试缩窗注入）。
- 首轮判据先行：无在途写立即 `drained`（`waitedMs=0`）——对应 §3 传播上界 0、开启生效后即可查。
- 超时返回 `timeout`（携带到界时如实计数）；**原语不持有闸门**——「超时中止保持维护模式（不半退出）」由结构保证：排空无从触碰闸门，退出维护只能走显式 DELETE 端点。
- 超时中止目前**无审计行**：storage-model §5 注册表无对应 kind（`backup.completed` 只覆盖成功路径）。排空中止的可观测面 = GET 进度端点 + 进程日志。

**建议**：(a) backup §4 步骤 2 增补一句实现锚点：「排空判据 = audit.drain_count（含待核对行）；超时中止经维护进度端点可观测」。(b) 若验收需要中止留痕，注册表需增 kind（如 `maintenance.drain_timeout`，直接终态、运行态写入）——注册表为唯一源（D6），本任务不自行发明，留 D13 裁决。

## M3 Git receive 403「维护中」文案的客户端可见性

**现状**：/git 入口对 write 动作（receive-pack 的 refs 发现与 pack 双向）返回 `403` + api.md 错误信封 JSON（`E-MAINT-001`、message=「维护中：写入被拒绝」、`details.maintenance=true`）——HTTP 层满足 §3 行 4「403/明确『维护中』文案」。但**标准 git 客户端不渲染 JSON 响应体**：refs 发现 403 时用户看到的是 `fatal: unable to access ... The requested URL returned error: 403`，「维护中」文案到不了 push 的人。

**建议**（三选一，倾向 (b)，维持现状亦可接受）：

- (a) 403 响应体改 `text/plain` 短文案「维护中，请稍后重试」——git 部分流程（如哑协议发现）会展示纯文本体，但智能协议 refs 发现上仍不可靠，且破坏 api.md 错误信封一致性；
- (b) 维持 JSON 信封（契约一致性优先），在管理员文档/部署 README 记录「push 403 = 维护中的可识别信号（E-MAINT-001），经 GET /api/v1/admin/maintenance 复核」；
- (c) 追加 `Retry-After` 头（仅提示语义）——api.md §2.1 现约定 Retry-After 仅 429 使用，需先改 §2.1。

## M4 「运维审计行不进入备份」与 §4 步骤时序的精确化（backup §3 写分类）

**现状**：§3 写分类称运维审计行「产生于快照之后（§4 步骤 3 起），不进入备份」。但按 §4 流程，`maintenance.enable` 审计行写于**步骤 1**（开启即记），早于**步骤 3** 的 DB 快照——若 T4 直接 `VACUUM INTO`，该行物理上会进入备份件。「不进入备份」目前可验证的语义边界是：

- 运行态写入**不阻塞排空**（直接终态、永不 pending——已由 S8-T3 测试锁定）；
- §5 的引用-审计一致性**不依赖**运维审计行（§3 已明示）；
- 恢复侧：回退到备份时，快照点之后的运维行随快照丢弃，属预期而非损失（§3 原文）。

**建议**：backup §3 该句精确化为两种可落地口径之一（T4 实现前定）：(a) 「不入备份」= **语义不入**（不参与一致性判定与排空；快照内的 maintenance.* 行在恢复侧视为运行态遗留，忽略即可——零额外机制）；(b) = **物理不入**（T4 在 manifest 记 t0，恢复/对账时将快照内 `occurred_at ≥ t0` 的运维行标记为已随快照回退的遗留）。倾向 (a)：与「§5 不依赖运维行」自洽，不给 T4 加排除机制。

## M5 维护 403 对非成员 receive 的判定顺序（记录为既定语义）

**现状**：/git 入口检查序为 认证 → 维护 → 授权（`http-backend.ts`）。维护开启时，**任何** receive 请求（成员/非成员/未知库）统一 `403 E-MAINT-001`——非成员在关闭态本应得到的 404 在维护中被 403 替换。

**评估**：统一 403 对所有 receive 请求同体，不泄露库存在性（维护态本身是公开可观察的全局状态，非泄露）；读面（upload-pack）鉴权语义完全不变（非成员/未知库仍 404，S8-T3 矩阵行 4 测试锁定）。

**建议**：无需改实现；在 api.md §8.4「维护模式：receive-pack 403」后补一句「（先于授权判定、对所有 receive 请求同体）」，避免后续任务按 404-优先「修复」。

## 测试与证据锚点

- 矩阵逐行：`server/test/maintenance-matrix.test.ts`（真实应用 + 文件 SQLite + 真实 bare 仓库 + 标准 git 客户端；§3 七行逐行断言 + S2/S4/S5 allowlist 复核 + 写分类断言 + 收口对账）。
- 排空两路径：`server/test/maintenance-drain.test.ts`（drained 立即/等待、timeout 保持维护、默认 300s 可配、unresolved 口径、进度端点门槛与形状、写分类）。
- TDD：排空与进度端点先 RED（drain.ts 缺失、GET 404）后实现转绿；矩阵行对 S2/S4/S5 既有实现逐行对账全绿（无实现缺口，M3–M5 为文案/时序级记录）。
