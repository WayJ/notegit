# 全新环境恢复落地契约补正建议（S8-T5）

- **状态**：S8-T5 起草（2026-10-14），待 master 评审。评审通过后由 master 落对应契约原文并在 epic 的 Decisions (ADR) 记录——按仓库约束，本文件不改契约。先例：backup-face-amendments.md（S8-T4，B1–B6，本稿多处以 B-x 承接）。
- **范围**：S8-T5 落地的契约外事实面——恢复运行形态（两相位 CLI 运行手册）、维护态启动机制（§7 步骤 1 的 env 初态）、§7 步骤 7 恢复对账的 T5/T6 分工与衔接缝、恢复前核验与目标全新前置、R14/R10 在恢复语境下的口径实证。
- **实现状态**：全部已实现并测试（`server/src/backup/restore.ts`（离线装载/只读对账/finalize）+ `cli.ts` restore/finalize 子命令 + `maintenance/gate.ts` env 初态；新增 16 项测试（backup-restore 14 + maintenance-start-env 2）；npm test 全绿（801+106+345）；演练 `deploy/scripts/restore-drill.mjs` 对真实容器连续两次全绿留档 `.agents/notes/2026-10-14-S8-T5-restore-drill.txt`（R1–R14 全项 + 负路径）。

## RS1 恢复运行形态：两相位 CLI（backup §7 十步的落地手册）

**选型：恢复 = `restore`（离线相位）+ `finalize`（实例侧相位）两个 CLI 子命令，不做一次性长命令、不做管理端点。** §7 十步映射：

| §7 步骤 | 落地面 |
|---|---|
| 1 部署容器（保持维护模式启动） | `NOTEGIT_MAINTENANCE_ON_START=1` 启动应用（RS2） |
| 2–5 恢复 config/keys/db/git | `restore` 离线装载（应用未启动——SQLite 文件回灌必须避开运行实例的句柄） |
| 6 版本兼容检查 | `restore` 内置（装载前：schema 高于当前必拒 D-BR-05；app 版本差异放行并注记走 §9） |
| 7 恢复对账 | `finalize`（维护内；RS3 分工） |
| 8 §8 清单 | 外部核对（演练脚本 `restore-drill.mjs` 断言化 R1–R14；CLI 不代跑浏览器/Git 客户端核对） |
| 9 重建派生索引 | `finalize` 经实例端点触发 S5-T5 全量重建（gate allowlist 已裁，维护内放行） |
| 10 关闭维护 | **外部显式操作**（DELETE 维护端点）——结构性不在 finalize 内：步骤 10 的前置是「§8 全部通过」，只有外部核对者知道清单结果 |

依据：离线/在线两相位的边界是**诚实性**边界——文件回灌必须无实例参与（运行中的应用持有 SQLite 句柄且启动即迁移/清扫，装载必须先于首启）；而对账/重建/退出维护必须**在维护内**且经实例自身机制（闸门进程内语义，B1 同因）。被拒备选：单命令全流程（要么在命令内起停应用——CLI 越权承担进程编排，要么混合两态——句柄冲突）；管理端点恢复（产物传输与大目录复制不宜绑长请求，B1 同因）。

## RS2 维护态启动机制：`NOTEGIT_MAINTENANCE_ON_START=1`（§7 步骤 1 的落地形态）

- `createMaintenanceGate()` 以 env 设**初态**（`maintenance/gate.ts`；缺省不设/非 '1' 与 S2-T7 行为完全一致——普通部署不触发）。语义不变式：生命周期端点语义不变（POST/DELETE 仍可切换；POST 对已开闸门幂等无迁移、不记审计行——恢复启动的「开闸」不产生 maintenance.enable 行，属预期：§3 运行态生命周期事件「允许发生」非必须）。
- 进度面如实呈现（GET /api/v1/admin/maintenance → enabled=true）——finalize 以此复核「确实以维护态启动」（fail-closed：非维护态执行恢复核对 = §7 违序，拒绝）。
- 留白如实标注：该 env 是**部署编排参数**（恢复/升级场景由部署侧设置），不是业务开关；文档口径随本稿落 deploy 文档时以 RS1 运行手册为准。

## RS3 §7 步骤 7 恢复对账的 T5/T6 分工与衔接缝

- **T5（本任务）交付只读核对** `restoreReconcile`：残留面（`listPendingReconciliation`——S3-T6 消费接口：pending/unresolved 发布行为零，排空保证的恢复侧复核）+ 成链面（`auditChain` 逐库逐 ref：成功事件 old→new 有序相邻、链尾 == ref 当前 OID、ref 无成功记录/审计有记录但 ref 不存在均点名——§5 不变量 1–2 与半应用写两向）。异常态（残留非零或链不一致）**报告并拒绝放行**。
- **T6（并行任务）交付处置任务**：按「行 new_commit vs ref 实际 OID」标终态（相等→succeeded/不等→rejected，架构 §4.4）+ 孤儿检查 + 对账结果报告。T5 不实现处置——两任务的边界即文件边界（T5 只在 `server/src/backup/`，T6 在 audit/reconciliation 域）。
- 衔接缝：异常态备份（drain timeout 强制继续，manifest.drain.outcome=timeout）恢复时，先由 T6 对账任务处置残留，再跑 finalize（其错误信息明示这一顺序）。T6 交付后如提供端点/模块形态，finalize 的对账段可切换为调用其结果——`restoreReconcile` 即为此保留的稳定函数边界。
- R11 的「管理页抽查」：现无审计读取端点，演练以库内独立抽查（只读 SQL：无残留、全部 succeeded、主体=认证员工）+ finalize 输出为证据面。审计读取面（如管理页最近推送）是否补端点，留 master 裁决（非本任务范围）。

## RS4 恢复前核验与目标全新前置（负路径复用）

- **恢复前核验 = 复用 T4 离线验证全量**（`verifyBackupSet`：manifest 在、件数齐、逐文件哈希、HEAD/库行互证、快照库完整性）——篡改产物在装载前被拒且**目标不被触碰**（演练负路径实测）。不另立恢复侧校验命令：离线验证（§4 步骤 8）与恢复前核验（§7 前置）本就是同一份产物核对。
- **目标全新前置**：目标四域（db/git/config/keys）任一非空即拒——恢复不得覆盖既有实例（覆盖 = 半恢复混合态，无核对语义）。镜像 `/data` 预建四空域（T1 布局）视为全新 ✓。
- 版本兼容（§7 步骤 6 前移到装载前）：schema 版本**高于**当前镜像必拒（D-BR-05 不支持降级）；等于（同版）或低于（启动自动前向迁移，§9）放行；app 版本差异放行并注记（数据面恢复不因 app 版本阻断——升级/兼容矩阵属 §9，T7 演练覆盖）。
- 装载后完整性（「恢复后完整性核对」）：两件清单逐文件在**目标**复算哈希 + 每库 HEAD == manifest + 目标库 integrity/库行互证——装载环节自身的损坏可检（独立函数 `postLoadIntegrity`）。

## RS5 恢复语境下 R14/R10 的口径实证（记录在案）

- **R14 备份完成时间**：恢复实例的 `backup.last_completed_at` 如实为 **null**——`backup.completed` 是快照之后的运行态审计行（B4/M4(a)：运维行不入备份），恢复实例「尚无自己的备份」是正确状态而非缺陷；`backup.wired=true` 照常呈现。首次对恢复实例做备份后该字段自然出现。
- **R10 草稿可编辑性**：草稿**存在性与内容一致**在维护内核对（GET）；**可编辑性**（PUT 成功）在退出维护后补证——维护模式拒草稿写是 §3 矩阵第 2 行的既定语义，「恢复后可编辑」的完整语义即「退出维护后可编辑」。演练两段都留档。

## RS6 K3/K4 义务口径承 B6（不变，恢复侧如实标注）

- 恢复流程不代管 K3（TLS 私钥）/K4（DB 口令——SQLite 单文件形态现无此项）的搬运与就位核验；`config-restored` 核对项以注记呈现该运维义务（记录随密钥件同置保管，B6）。K5（一次性令牌哈希）随 DB 快照走。

## 测试与证据锚点

- 离线装载/对账/finalize/CLI（绿路径 + 篡改拒/密钥件缺位/目标非全新/降级拒/app 版本注记/装载后复核/残留点名/半应用写点名/维护态强制/结构性不退出维护/参数面）：`server/test/backup-restore.test.ts`（14 项）。
- 维护态启动（闸门单元 + 应用级：进度面/503/登录读放行/可退出）：`server/test/maintenance-start-env.test.ts`（2 项）。
- 演练（D5）：`deploy/scripts/restore-drill.mjs`——真实容器 35 步全绿 ×2 留档 `.agents/notes/2026-10-14-S8-T5-restore-drill.txt`（R1–R14 全项 + 篡改负路径 + pepper 轮换窗口恢复 R12）。
- TDD：restore/gate-env 两组先 RED（模块缺失/断言未满足）后实现转绿。

## 落点汇总

| id | 契约文件 | 落点 | 性质 | 实现状态 |
|---|---|---|---|---|
| RS1 | backup-recovery §7 | 两相位 CLI 运行手册（十步映射表） | 落地形态定稿 | 已实现（restore.ts + cli.ts） |
| RS2 | backup-recovery §7 步骤 1 | NOTEGIT_MAINTENANCE_ON_START env 初态 | 机制补正建议 | 已实现（gate.ts） |
| RS3 | backup-recovery §7 步骤 7 / §10 待定项「触发形态待 T5」 | T5 只读核对 + T6 处置的分工与衔接缝 | 触发形态定稿（本任务义务） | 已实现（restoreReconcile/finalize） |
| RS4 | backup-recovery §7 前置/步骤 6 | 恢复前核验复用 + 目标全新 + 版本兼容口径 | 精确化建议 | 已实现 |
| RS5 | backup-recovery §8（R10/R14） | 恢复语境口径记录 | 口径实证记录 | 已留档（演练） |
| RS6 | backup-recovery §6（承 B6） | K3/K4 恢复侧义务标注 | 如实标注 | 已实现（核对项注记） |
