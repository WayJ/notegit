# 升级迁移与回退落地契约补正建议（S8-T7）

- **状态**：S8-T7 起草（2026-10-14），待 master 评审。评审通过后由 master 落对应契约原文并在 epic 的 Decisions (ADR) 记录——按仓库约束，本文件不改契约。先例：backup-face-amendments.md（S8-T4，B1–B6）、restore-face-amendments.md（S8-T5，RS1–RS6，本稿多处以 B-x/RS-x 承接）。
- **范围**：S8-T7 落地的契约外事实面——升级运行形态（§9 升级流程的 CLI 运行手册）、升级前备份的维护不关闸语义、D-BR-08 强制面的机器可断言形态、§9 冒烟步骤序的裁决（brief 箭头序 vs 维护闸门语义）、跨版本演练的旧版本构造口径（无历史镜像的诚实仿真边界）、回退丢弃口径的实证。
- **实现状态**：全部已实现并测试（`server/src/backup/upgrade.ts`（pre-backup/gate/迁移核对面）+ `cli.ts` upgrade 三相位子命令；新增 15 项测试（backup-upgrade）RED 先行；演练 `deploy/scripts/upgrade-drill.mjs` 对真实容器连续两次全绿留档 `.agents/notes/2026-10-14-S8-T7-upgrade-drill-{1,2}.txt`（§9 升级+回退全链 + D-BR-08 负路径 ×2 + 跨版本 8→9 + 重启可重入）。

## U1 升级运行形态：三相位 CLI + 部署侧编排（backup §9 升级流程的落地手册）

**选型：升级 = `upgrade pre-backup` / `upgrade gate` / `upgrade post` 三个 CLI 相位 + 部署侧（容器编排/演练脚本）串接，不做一次性长命令、不做管理端点。** B1/RS1 同因（闸门进程内语义——CLI 经运行实例端点诚实断言；产物传输不绑长请求）。§9 步骤映射：

| §9 步骤 | 落地面 |
|---|---|
| 读发布说明兼容矩阵 | 部署侧人工/发布物料（不在代码面） |
| 开维护模式 | `upgrade pre-backup` 内置（控制缝 = T4 同款 `httpMaintenanceControl`；幂等） |
| **升级前一致备份（强制）** | `upgrade pre-backup`（U2 维护不关闸）+ `upgrade gate`（U3 强制面） |
| 更新镜像 | 部署侧（换容器/镜像标签——CLI 不越权承担进程编排，RS1 同因） |
| 启动并自动迁移 | 镜像启动机制自身（main.ts `migrate()`，既有；`NOTEGIT_MAINTENANCE_ON_START=1` 维持维护连续——RS2 机制复用） |
| 冒烟检查 | `upgrade post`（healthz + 维护断言 + 迁移形态核对）+ 读面/写面冒烟（U4 步骤序；演练断言化） |
| 对账 | T6 CLI（`src/audit/reconcile-cli.ts reconcile`）在维护内复跑（consume 既有交付） |
| 关闭维护模式 | **外部显式操作**（DELETE 维护端点）——RS1 步骤 10 同构 |

## U2 升级前备份的维护不关闸语义（§4 步骤 7 与 §9 的分叉点）

T4 备份流程完成即关闸（§4 步骤 7）；**升级前备份不关闸**（`preUpgradeBackup` 与 `runBackup` 的唯一语义差异）：§9 升级全程处于维护模式（备份 → 换镜像 → 启动迁移 → 冒烟 → 对账 → 显式退出），备份后顺手关闸 = 换镜像窗口脱离维护，违背「升级全程维护、业务零写入」前提（回退零损失的根基）。完成审计行同 kind `backup.completed`，detail 增 `upgrade_pre_backup: true` 注记（§9「运维行随回退丢弃」时可辨）。排空超时中止**不设显式继续通道**（T4 的 `--force-drain-timeout` 不进升级相位）：升级前备份是回退唯一依据，异常态下继续升级不可接受——与 T4 备份（例行操作，管理员可裁定继续）不同层。

## U3 D-BR-08 强制面的机器可断言形态

「升级前备份强制、未完成不得升级」的执行面 = `upgrade gate`：跳过（`--skip-pre-upgrade-backup`，解析面可表达、执行面**必拒**——为 breakdown「跳过升级前备份被流程拒绝」提供显式断言位）、无证据（缺 `--data-item`）、证据不可信（T4 离线验证全量复算失败）均退出 1 并点名 D-BR-08/stage；放行 = 备份件可验证 **且** manifest schema ≤ 当前镜像（后者为 D-BR-05 方向核对：高于当前镜像的备份当前二进制读不懂，回退失据，同样不得作为升级依据）。gate 是纯核对面（不动数据、不动闸门）——「不得升级」的物理边界在换镜像动作本身（部署侧），gate 把该边界的判据做成可复跑命令。

## U4 §9 冒烟步骤序的裁决（brief 箭头序 vs 维护闸门语义）

breakdown/brief 的「迁移后冒烟（healthz+关键读面+一次 push/网页写）→对账→退出维护」箭头序**不可按字面执行**：push/网页写在维护内必被拒（§3 写分类，T3 矩阵），对账 CLI 维护外必拒（T6 fail-closed）。按契约语义落定的可执行序：**维护内冒烟读面（healthz/登录/关键读面，写仍 503 属预期）→ T6 对账（维护内）→ 派生重建（如迁移新增派生表）→ 显式退出维护 → 冒烟写面（一次 push + 一次网页提交）**。演练按此序断言化（步骤 20–24），写面冒烟同时充当「升级接受」判据。

## U5 跨版本演练的旧版本构造口径（无历史镜像的诚实仿真）

本仓无历史版本镜像，「旧版本实例」= **当前镜像 + schema N-1 库**（迁移回退手术：删末版 schema_version 行 + DROP 该版新增表 + 复原 append-only 触发器；业务数据零改动；派生表抹除符合 D-BR-07 可重建口径）。被真实证得：新二进制对旧 schema 库的启动自动迁移（8→9 前向、有序、重启可重入）、§9 流程序与强制面、回退 = 备份恢复全链。**不能证得**：旧二进制自身的运行行为（不存在旧二进制）；升级前备份由当前二进制执行（manifest schema=9；生产中由旧二进制执行为 8）——回退版本核对断言因此锚定 **manifest 值**（回退后 schema 行集 == manifest.schema_version），不锚定「旧版 = 8」。手术仅演练构造用（append-only 触发器先落再复原），不是产品能力。

## U6 回退丢弃口径的实证（§9「记录说明」）

§9「维护期间产生的运维审计行与会话随回退丢弃，属预期而非损失」的实测边界：备份点**后**写入的运行态（backup.completed 审计行、升级窗口登录会话、升级接受后的冒烟发布）随回退消失；备份点**前**的（maintenance.enable 行、种子期会话）随备份恢复保留——演练步骤 29/30 两侧都断言。升级接受后的业务写（冒烟 push/web）随回退丢弃是**回退语义本身**（回退到备份点），与「零损失」不冲突：零损失锚定备份点（breakdown「旧快照回退后业务数据零损失」），演练以「回退后业务态逐项 == pre 态指纹」证得。

## 测试与证据锚点

- 单元/集成（TDD RED 先行，15 项）：`server/test/backup-upgrade.test.ts`——维护不关闸 + 审计链形态、幂等开闸、排空超时保守中止、gate 四拒一放行、迁移核对面（当前/旧库/缺口三态）、CLI 解析与执行面（pre-backup 全链、gate 跳过/缺证据/放行、post 维护内外）。
- 演练（D5：断言化可复跑）：`deploy/scripts/upgrade-drill.mjs`——真实容器 32 步；负路径 ×2（宿主侧跳过被拒 + 容器侧缺证据被拒）；跨版本 8→9 启动自动迁移（applied_at 为启动后新写入）+ 重启可重入（行集与 applied_at 逐字不变）；回退 = T5 restore 两相位复用 + 版本核对断言 + 业务零损失 @备份点 + 丢弃口径两侧实证；留档 `.agents/notes/2026-10-14-S8-T7-upgrade-drill-{1,2}.txt`。
- 既有机制核对（brief「既有机制核对」项）：main.ts 启动即 `migrate(db, MIGRATIONS)`（S2-T1 交接序）；migrate.ts 有序/每迁移一事务/已应用跳过；schema_version append-only 触发器（迁移 2）。T7 未改迁移机制本身，只加启动后核对面（verifyUpgradeMigration）。

## 落点汇总

| 落点 | 文件 |
|---|---|
| 升级编排三件（pre-backup/gate/迁移核对） | `server/src/backup/upgrade.ts` |
| CLI 三相位 | `server/src/backup/cli.ts`（upgrade pre-backup / gate / post） |
| 测试 | `server/test/backup-upgrade.test.ts` |
| 演练 | `deploy/scripts/upgrade-drill.mjs` |
| 留档 | `.agents/notes/2026-10-14-S8-T7-upgrade-drill-{1,2}.txt` |
