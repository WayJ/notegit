# S9-T1 E1 DoD 证据汇总与缺口清单

- 记录日期：2026-10-14
- 记录人：S9-T1 worker（Orca dispatch `ctx_36fea4378d1b`，task `task_01f6263c357a`）
- 运行分支：`WayJ/s9-t1-evidence`，rebase 到 `local/sprint/S9`（HEAD `9022933`）
- 任务定义：[implementation-breakdown §2.8 S9-T1 行](../s1/implementation-breakdown.md)
- 性质声明：本文是**现状汇总，供 master 复核，不代替 S9-T8 终核**。全文不勾选任何 DoD 条目（epic 开工规则 3：部分满足不勾选整条）；缺口如实标注、无静默移除。文末所有复选框均为 **T8 终核时的缺口/待办勾销项**，不是 DoD 条目勾选。

## 0. 引用规范与证据源

| 证据类型 | 引用方式 |
|---|---|
| 验收记录 | 仓库相对路径，[docs/superpowers/acceptances/](../superpowers/acceptances/) 下 S1–S8 共 8 份（均 verdict=pass） |
| 演练档案 | `.agents/notes/` 下留档文件名（init/backup/restore/upgrade/load 五类，均断言化可复跑） |
| 测试 | 套件名 + 最新计数 |

- **最新测试计数**：产品门禁 `npm ci && npm test` = **850+106+345**（root `npm test --workspaces` 依次为 server 850 / packages/validation 106 / cli 345；出自 S8 验收记录 [2026-10-14-S8-acceptance.md](../superpowers/acceptances/2026-10-14-S8-acceptance.md) 场景 S6，环境 sprint/S8 @ 98a75b5 npm ci fresh）。2026-10-14 本任务在 sprint/S9 @ 9022933 复跑三条轻门禁：contracts **82/82**、spike route-b **7/7**、storage ddl_smoke **14/14**，全 exit 0；产品门禁全量复跑属 S9-T2。
- **D14 并行提示**（S9 计划 D6）：S8 五组建议稿（M/B/RS/U/G）正由并行 D14 契约整备落契；落定后 S9 内验收引用新契约版本。本文引用的契约路径为落契前版本，T8 终核须按落契后版本复核。

## 1. 现状预判总表（15 条全覆盖）

预判基线（供 master 复核）：**DOD-01/04/05/11/12/13 证据基本齐（S8 演练）；DOD-02/03/06/07/08/09/10 各有测试面但需 T2 终回归背书；DOD-14 依赖 T3/T4 外部试用（预期缺口或进行中）；DOD-15 依赖 T6/T7。** 复核后两点细化：DOD-04/05 的证据主源是 S1 spike + S3 产品级测试（S8 真实容器链路为旁证）；DOD-10 除 T2 外还须 S9-T5 收口（breakdown T5 明文「DOD-10 收口」）。

| DoD | 现状预判 | 证据主源（最強面） | 待补（sprint 内） | 当前缺口分级 |
|---|---|---|---|---|
| DOD-01 独立部署 | 证据基本齐 | S8 init-drill 16 步（真实容器） | T7 v0.1 从零复验 | sprint 内待办 |
| DOD-02 身份与权限 | 有测试面 | S2 矩阵 7/7 + S3 policy 14/14 | T2 矩阵全拒终核 | 待 T2 背书 |
| DOD-03 员工凭据 | 有测试面 | S2 lifecycle 15/15 + S3 审计 18/18 | T2 审计主体终核 | 待 T2 背书 |
| DOD-04 原生 Git | 证据基本齐 | S1 spike 7/7 → S3 13/13+14/14 → S8 容器链 | T2 并发面复测 | 基本齐，T2 补并发面 |
| DOD-05 内容校验 | 证据基本齐 | S3 同构 2/2 + S6 三端一致 10 | T2 防绕过清单全量复测 | 基本齐 + 值定稿遗留（D14） |
| DOD-06 Web 整理 | 有测试面 | S4 全场景（2/18/9/15/9 用例） | T2 Web 越权面 | 待 T2 背书 |
| DOD-07 草稿与并发 | 有测试面 | S4 drafts 15/15 + submissions 9/9 | T2 并发写不丢改动终核 | 待 T2 背书 |
| DOD-08 历史与查找 | 有测试面 | S5 全场景（6/11/4/3/2） | T2 无权面矩阵 | 待 T2 背书 |
| DOD-09 CLI | 有测试面 | S6 193 + S7 345（sync） | T2 多员工多库面 | 待 T2 背书 |
| DOD-10 Harness 与同步 | 有测试面 | S7 345/345（六态/隔离/指纹） | T2 回归 + **T5 收口** | 待 T2/T5；试用方环境随 DOD-14 链 |
| DOD-11 审计与异常恢复 | 证据基本齐 | S3 18/18 + S8 演练对账 | T2 主体面复测 | 基本齐 |
| DOD-12 备份恢复 | 证据基本齐 | S8 恢复 R1–R14 ×2 + 备份/维护演练 | 仅 T8 终核 | 基本齐（证据义务已履行） |
| DOD-13 运维与限制 | 证据基本齐 | S8 升级/回退 ×2 + 容量收口 | Q9 数值确认（T3 链） | 基本齐 + 一般遗留（G1/G3/Q9） |
| DOD-14 企业试用 | **缺口（外部依赖）** | 无 | T3 组织 → T4 执行 | **发布阻碍**（E1 关闭硬条件） |
| DOD-15 交付材料 | 部分（依赖 T6/T7） | 8 份验收记录 + 文档骨架 | T6 文档成套 + T7 发布包 | sprint 内待办；T8 时不齐则为发布阻碍 |

## 2. 逐条明细

状态标记：✅ 已满足（附证据）；⏳ 待 sprint 内任务背书/产出；❌ 缺口（当前无证据）。

### DOD-01 独立部署

| 子项 | 证据 | 状态 |
|---|---|---|
| 全新目标环境按文档启动 | S8 验收场景 S1（init-drill 真实容器 16 步全链绿，29.3s）；档案 `.agents/notes/2026-10-13-S8-T1-init-drill.txt`（第 3 次连续运行留档——可复跑性即证）；文档 [deploy/README.md](../../deploy/README.md)（docker-compose.yml + Dockerfile，构建期断言 git-http-backend 存在） | ✅ |
| 完成管理员初始化 | init-drill 含 bootstrap 链；升级演练步骤 05 同链复证（`.agents/notes/2026-10-14-S8-T7-upgrade-drill-1.txt`） | ✅ |
| 不依赖外部 Git 平台 | S1 验收场景 S1（D10 + selection.md「自带 Git 服务，不依赖外部平台」）；全部 Git 服务由容器内 git http-backend 提供 | ✅ |
| 重启后账号、权限、知识和历史仍存在 | S8 验收场景 S1 expected「重启数据在」（持久卷断言） | ✅ |

- 未满足子项：v0.1 冻结发布包的从零安装复验（S9-T7；S9 验收场景 S5 明文「复用 init-drill 路径」）。
- 分级：现状证据基本齐；未满足子项为 sprint 内待办，若 T8 时 T7 复验未做 → 发布阻碍。

### DOD-02 身份与权限

| 子项 | 证据 | 状态 |
|---|---|---|
| ≥2 员工 × ≥2 不同成员集库，Web/API/Git 一致授权 | Web/API：S2 验收场景 S1 `vaults-matrix.test.ts` 7/7（可见性/读写/载体一致）；Git：S3 验收场景 S3 `vaults-policy` + `githttp-ref-rules` 14/14；真实容器：S8 升级演练步骤 06/07（alice/bob 两库两成员集） | ✅（分面）⏳（同一矩阵全谱终核 = T2） |
| 无权库、历史、附件、refs、对象、搜索结果不可访问 | 附件 404：S4 验收场景 S2（`web-attach-routes` 18/18 内）；搜索：S5 验收场景 S4 `search-authz-e2e` 3/3（陷阱用例 + 撤权下一查询消失）；refs/对象：S1 spike B4 逐 ref 授权（7/7 内）+ S3 `githttp-behavior` 13/13；历史：S5 场景 S1 6/6 | ✅（分面）⏳（矩阵全拒 = T2） |
| 只读成员不能写入 | S3 验收场景 S3（reader push 拒、main_admin_only 三态，14/14 内） | ✅ ⏳（T2 复测） |

- 未满足子项：三入口在同一多员工多库矩阵下的全谱终回归（breakdown T2 完成标准「越权访问矩阵全拒（DOD-02）」）。
- 分级：有测试面，待 T2 终回归背书。

### DOD-03 员工凭据

| 子项 | 证据 | 状态 |
|---|---|---|
| Agent 凭据归属当前员工 | S2 验收（HMAC 存储、scope 收窄 422 防漂移；`vaults-matrix` 7/7 载体一致） | ✅ |
| 到期、撤销、停用、撤权阻断后续请求 | S2 验收场景 S3 `lifecycle.test.ts` 15/15（四状态×双入口 8 用例、下一请求零延迟）；S5 撤权下一查询消失（3/3 内）；S7 revoked 套件（404→标记/恢复复常） | ✅ |
| 审计以认证主体为准，不信任可填写的 commit 作者 | S3 验收场景 S6 `receive-audit.test.ts` 18/18（真实主体断言）；档案 `.agents/notes/2026-10-13-S3-T6-receive-audit.md` | ✅ ⏳（T2 终核：breakdown T2「审计主体正确（DOD-03/11）」） |
| 凭据不泄漏（CLI 面） | S6 验收场景 S2（URL/.git/config/输出泄漏扫描断言绿，193 内） | ✅ |

- 分级：有测试面，待 T2 终回归背书。

### DOD-04 原生 Git

| 子项 | 证据 | 状态 |
|---|---|---|
| 标准客户端 clone/fetch/commit/push | S1 spike B1/B2（7/7）→ S3 验收场景 S1 `githttp-behavior` 13/13（产品级闭环）→ S8 真实容器演练链（init/restore/upgrade 均含真实 git 客户端操作） | ✅ |
| 允许编辑者直接快进发布、无需 PR | S3 验收场景 S1（B2 FF push；D2 不强制 PR） | ✅ |
| 默认分支保护、禁 force push/删除、ref 范围规则真实生效 | S1 spike B3–B6（7/7）；S3 验收场景 S2/S3（非快进拒、逐 ref 授权、先写后删拒、多 ref 原子拒，13/13 + 14/14）；S8 维护矩阵真实客户端 receive 403（15/15 内） | ✅ |

- 未满足子项：原生 Git × Web 并发面复测（T2）；T8 终核。
- 分级：证据基本齐（spike→产品级→真实容器三层独立证据链）。

### DOD-05 内容校验

| 子项 | 证据 | 状态 |
|---|---|---|
| 暂存区、服务端、网页同一规则契约 | S3 验收场景 S4 `publish-isomorphism` 2/2（同一违规样本两入口同 rulesVersion 同错误集）；S6 `rules-version-consistency` 10 用例（三端一致、端点常量==api.md、MAJOR 漂移失败）；contracts 门禁 82/82（sprint/S9 复跑） | ✅ |
| 无效 Schema、危险 tree 条目、超限输入被阻止 | S3 `githttp-behavior` B 面真实校验（13/13 内）；limits/资源限制：S3-T8 档案（`.agents/notes/2026-10-13-S3-T8-limits.md`、`-benchmark.md`）+ packages/validation 套件 106；限制可配置（S8-T8 九键 + `git.maxConcurrentChildren`） | ✅ |
| 跳过本地 hook、先写坏内容再删除、合并提交、多 ref 推送均不能绕过 | spike B5/B6（7/7）；S3 验收场景 S2（先写后删拦截、多 ref 原子拒绝，13/13 内）；S6 部分暂存只校验暂存内容（lint 19 用例）；未装/跳过 hook 服务端仍拒（S3 服务端统一校验 + S6 完成标准） | ✅ |

- 未满足子项：validation §1 防绕过清单**全量复测**逐条拒绝证据（breakdown T2 完成标准「绕过路径逐条留拒绝证据（DOD-05 实证）」）。
- 一般遗留：rulesVersion 仍为 1.0.0-draft.1（S3 定稿升版未发生），定稿与 G1 值修订（`maxValidationMemoryMb` 256→512）待 D14 执行——不破坏「同一契约」成立，但牵 DOD-15 文档一致性面。
- 分级：证据基本齐；T2 全量复测 + 定稿遗留（一般遗留，随 D14）。

### DOD-06 Web 整理

| 子项 | 证据 | 状态 |
|---|---|---|
| 浏览、编辑、上传 Markdown 与图片、重命名和删除 | S4 验收场景 S1–S3（`web-visibility-e2e` 2/2、`web-render-xss`+`web-attach-routes` 18/18、`web-edit-errors` 9/9）；任务档案 `.agents/notes/2026-10-13-S4-T4-upload.md`、`-T5-rename.md`、`-T8-visibility.md` | ✅ |
| 必填元数据有清楚提示 | S4 验收场景 S3（E-FM 按路径与规则定位、W 级不阻断） | ✅ |
| 预览和附件遵循内容及访问限制 | XSS 全清 + 附件越权 404（18/18 内，含安全渲染） | ✅ |

- 未满足子项：T2 终回归中的 Web 越权面复测（多员工多库矩阵含 Web 面）。
- 分级：有测试面，待 T2 终回归背书。

### DOD-07 草稿与并发

| 子项 | 证据 | 状态 |
|---|---|---|
| 私有草稿可恢复 | S4 验收场景 S4 `drafts-routes` 15/15（草稿私有、撤权拒、Git 无痕） | ✅ |
| Web×Git 并发 / 两次 Web 提交冲突不静默覆盖、冲突草稿保留 | S4 验收场景 S5 `web-submissions-routes` 9/9（冲突 409 不覆盖、草稿保留） | ✅ ⏳（并发写不丢改动终核 = T2） |
| 发布使用预期旧 commit 检查和统一权限规则 | S4（base commit 语义；契约=api.md 发布检查点 0–5，S1 交付） | ✅ |

- 分级：有测试面，待 T2 终回归背书（并发面为 T2 完成标准「并发写不丢改动（DOD-07）」）。

### DOD-08 历史与查找

| 子项 | 证据 | 状态 |
|---|---|---|
| Web 与 Git 看到相同已发布内容 | S4 验收场景 S1（双向一致 2/2）+ S5 验收场景 S1 `web-history-consistency` 6/6（历史/diff 脚本比对 git） | ✅ |
| 历史、diff 和还原可用，还原产生新提交 | S5 验收场景 S2 `web-history-restore` 11/11（还原不删历史、审计成链、diff 正确） | ✅ |
| 元数据查找不泄露无权知识 | S5 验收场景 S4 `search-authz-e2e` 3/3 | ✅ ⏳（T2 无权面矩阵复测） |
| 索引可重建并能观察延迟 | S5 验收场景 S3 `search-e2e` 4/4（实测 78/51ms vs 5s 上界）+ 场景 S5 `search-rebuild` 2/2（R9 对账一致）；S8 恢复演练 R1–R14 含索引重建核对 | ✅ |

- 边界文档：[docs/user/history-boundary.md](../user/history-boundary.md)（重命名/跨库移动历史边界，行为由 `web-history-rename-boundary.test.ts` 固化）。
- 分级：有测试面，待 T2 终回归背书。

### DOD-09 CLI

| 子项 | 证据 | 状态 |
|---|---|---|
| login、ls、setup、lint、sync 有文档和可理解错误 | S6 验收（五命令四实现 + 文档一致性 13 测试 + 流程 e2e；193/193）；sync 文档随 S7 补齐；[cli/README.md](../../cli/README.md)（`--help` 原文一致性由 `docs-consistency.test.ts` 自动抽检） | ✅ |
| JSON 输出与退出码契约确定 | S6 ls 组 13 用例（deepEqual schema + 退出码）；错误协议 0/1/2（S1 契约，validation.md） | ✅ |
| hook 安装不破坏现有 hook、不执行库内下载脚本 | S6 hooks-sandbox/setup 组（恶意样本不执行、兼容两模式、卸载还原，193 内） | ✅ |
| 凭据不进入仓库或日志 | S6 credentials/login 组泄漏扫描断言绿 | ✅ |

- 未满足子项：T2 终回归背书（多员工多库面）。
- 分级：有测试面，待 T2 终回归背书。

### DOD-10 Harness 与同步

| 子项 | 证据 | 状态 |
|---|---|---|
| 本地、托管两种 Harness 完成读取与修改 | S7 验收 345/345（sync 全套件，六态 e2e 走真实 http-backend 链路）；[docs/harness/README.md](../harness/README.md)、[hosted-runbook.md](../harness/hosted-runbook.md) | ✅ ⏳（双环境收口复验 = S9-T5：breakdown T5「两环境完成读取与修改的记录」） |
| 托管凭据和目录按员工隔离 | S7 验收（双进程双 root 证据，两员工不能经托管目录互读） | ✅ ⏳（T5 隔离复查） |
| 五态（脏工作区/未推送/分叉/非默认分支/断网）保留改动并逐库报告 | S7 验收 noclobber 八态指纹逐字节不变 + report 逐项（混合世界 e2e）+ state 双进程（345/345 内） | ✅ ⏳（T5 五态逐库报告复验） |

- 外部依赖：试用方托管 Harness 环境落实（epic 风险行 6「试用方没有托管 Harness，验收缺一半环境」；关联 Q5/DOD-14 链）。
- 分级：有测试面，待 T2 终回归 + T5 收口；试用方环境缺口随 DOD-14 链计。

### DOD-11 审计与异常恢复

| 子项 | 证据 | 状态 |
|---|---|---|
| 推送及网页提交记录主体、库、时间、旧新 commit 和结果 | 推送：S3 验收场景 S6 `receive-audit` 18/18（预记录成链）；网页：S4 `web-submissions` 9/9 + S5 restore 11/11（审计成链）；audit-tail poller + 启动 reconcile 双通道（D13 追认） | ✅ |
| Git/数据库间失败可核对 | S8 对账 CLI（异常注入 18 测试，S8 close note）；维护排空 `maintenance-drain`（15/15 内） | ✅ |
| 请求超时或重试不静默重复发布、不虚假成功 | `receive-audit` 18/18（含 SIGKILL 中断注入、quarantine 原子性、对账面）；升级演练 D-BR-08 双拒 + 零数据丢失断言（`.agents/notes/2026-10-14-S8-T7-upgrade-drill-{1,2}.txt`） | ✅ |

- 未满足子项：T2 审计主体终核（DOD-03/11 联合）；T8 终核。
- 分级：证据基本齐（S3 测试 + S8 演练双源）。

### DOD-12 备份恢复

| 子项 | 证据 | 状态 |
|---|---|---|
| 维护模式覆盖网页/API/Git 写入 | S8 验收场景 S2 `maintenance-matrix` + `maintenance-drain` 15/15（矩阵逐行 + 排空；真实 git 客户端含 receive 403） | ✅ |
| 完整备份数据库、Git 仓库、配置和必要密钥 | S8 验收场景 S3 `backup-snapshot` + `backup-verify` 18/18（分置两件 + manifest + 离线验证）；档案 `.agents/notes/2026-10-13-S8-T4-backup-drill.txt` | ✅ |
| 全新环境恢复并验证权限、内容、历史和索引重建，附演练证据 | 档案 `.agents/notes/2026-10-14-S8-T5-restore-drill.txt`（R1–R14 全项 35 步 ×2 PASS，验收时复核在案） | ✅ |

- S8 verdict 原文：「DOD-12（备份恢复演练）…的证据义务已履行」；S9 终验勾选留 T8。
- 分级：证据基本齐；无未满足子项，仅余 T8 终核勾选。

### DOD-13 运维与限制

| 子项 | 证据 | 状态 |
|---|---|---|
| 实际容量、超时、并发限制可配置 | S8-T8 容量收口档案 `.agents/notes/2026-10-14-S8-T8-capacity.md`（Q7 九键终值 + 新键 `git.maxConcurrentChildren` 默认 8、FIFO 排队不拒绝、热生效；实测 gate=2 下 c=4 并发 sync 全部成功、墙钟 +3.6%——`.agents/notes/2026-10-14-S8-T8-load-gate-{default,capped2}.json`）；首个负载数据点 `.agents/notes/2026-10-13-S7-T8-load.md`（+ runA/runB.json） | ✅ |
| 健康、磁盘和失败指标可查看 | S8 指标面（M 组实现全绿；建议稿 [docs/s1/metrics-face-amendments.md](../s1/metrics-face-amendments.md)） | ✅ |
| 部署、升级与兼容边界明确 | [deploy/README.md](../../deploy/README.md)（含 768MB 修正地板与推荐档 1GB）；升级兼容边界接 backup §9（发布说明由 T7 产出） | ✅ ⏳（发布说明=T7） |
| 至少完成一次升级/恢复验证 | 档案 `.agents/notes/2026-10-14-S8-T7-upgrade-drill-{1,2}.txt`（32 步 ×2 PASS：升级冒烟/回退原状/跳备份拒） | ✅ |

- 一般遗留（不阻碍子项成立，影响发布材料与试用承诺）：① G1 值修订（256→512）与 rulesVersion 定稿待 D14 执行——deploy/README 已同步、契约默认值未改；② 512MB→768MB 地板的 selection §5 / roadmap Q2 行修订属 master（建议稿 G3）；③ Q9 三要素（可用性/RPO/RTO）未与试用方确认——截至 S8-T8（2026-10-14）试用方尚未接洽（capacity 档案 Q9 节如实标注），落实=T3 义务。
- 分级：证据基本齐（升级/恢复 ×2 已履行）；上述三项列一般遗留。

### DOD-14 企业试用

| 子项 | 证据 | 状态 |
|---|---|---|
| 完成一个真实团队或企业的试用 | 无（Q5 open；epic Q5 行「没有真实试用不得关闭 DOD-14」） | ❌ |
| 覆盖管理员、知识贡献者、Agent 三种使用角色 | 无 | ❌ |
| 覆盖两种 Harness 环境 | 无（epic 风险行 6：试用方无托管 Harness 则验收缺一半环境） | ❌ |
| 记录关键阻碍并处理发布阻碍项 | 无（待 T4 处置清单） | ❌ |

- 现状：截至 2026-10-14 无任何试用证据；S8-T8 档案 Q9 节明文「试用方尚未接洽——不虚构」。Sprint 计划已知边界开工即记录：若外部团队 sprint 内无法落实，按 epic 规则如实记录缺口、E1 保持 open，不得静默降级。
- 承担任务：S9-T3（试用组织 + Q5/Q9 关闭）→ S9-T4（试用执行与反馈处置，三角色 × 两 Harness）。
- 分级：**发布阻碍**（D8：真实试用是 E1 关闭条件）。预判：依赖 T3/T4 外部试用（预期缺口或进行中）。

### DOD-15 交付材料

| 子项 | 证据 | 状态 |
|---|---|---|
| 版本化发布包 | 未产出（S9-T7 义务；当前 deploy/ 为发行候选形态，非 v0.1 版本化包） | ❌→⏳ |
| 用户与管理员文档 | 骨架在：管理员=[deploy/README.md](../../deploy/README.md)；用户=[docs/user/history-boundary.md](../user/history-boundary.md)（仅一篇） | ⏳（成套三份文档 + 已知限制清单 = T6） |
| CLI/Harness 指引 | [cli/README.md](../../cli/README.md)（自动抽检）+ [docs/harness/](../harness/)（README + hosted-runbook） | ✅ 骨架 ⏳（T6 抽检断言「命令可运行」） |
| 已知限制清单 | 未成清单（T6；与架构 §12 边界一致；单实例无 HA、Windows 不在首发等已在架构/deploy/README 声明） | ⏳ |
| 验收记录齐全 | S1–S8 八份在库（[docs/superpowers/acceptances/](../superpowers/acceptances/)）；S9 验收记录 sprint 结束时产生 | ✅（S1–S8） |
| 命令与文档对应实际实现、不留无法运行示例 | cli/README 已有自动一致性抽检先例；全量命令抽检 = T6（breakdown T6「文档命令抽检可运行」） | ⏳ |

- 关联：D14 落契后文档引用须更新（S9 计划 D6——S9 内验收引用新契约版本）；rulesVersion 定稿影响文档一致性。
- 分级：待 T6/T7 产出（sprint 内待办）；若 T8 时仍未齐 → 发布阻碍。

## 3. 缺口总清单（供 T8 终核逐项勾销）

> 以下复选框是缺口/待办勾销项，**不是** DoD 条目勾选。T8 逐项核对后勾销并附证据链接；未闭合的发布阻碍项按 epic 规则 4 处置，E1 保持 open。

### 一、sprint 内待办（预判可闭合；T8 核对产出与证据）

- [ ] T2 终回归背书：DOD-02 越权矩阵全拒 / DOD-03 审计主体 / DOD-05 防绕过清单逐条拒绝证据 / DOD-06 Web 越权面 / DOD-07 并发写不丢改动 / DOD-08 无权面 / DOD-09 多员工多库面 / DOD-10 回归（产品门禁全量复跑）
- [ ] T5 双 Harness 收口：DOD-10 两环境读写记录、五态逐库报告复验、托管隔离复查
- [ ] T6 文档与已知限制：DOD-15 用户/管理员/Harness 三份文档成套、已知限制清单、命令抽检可运行
- [ ] T7 版本冻结与发布材料：DOD-01 v0.1 从零安装复验（复用 init-drill 路径）+ DOD-15 版本化发布包、发布说明（兼容矩阵/升级步骤接 backup §9、后续需求单列候选 epic）

### 二、发布阻碍级缺口（当前即存在；内部证据无法闭合，须外部落实）

- [ ] DOD-14 全部子项：真实团队试用（三角色 × 两 Harness）+ 关键阻碍记录与发布阻碍处置——T3 组织（含 Q5/Q9 在 epic Open Questions 置 closed 附证据）→ T4 执行；若 sprint 内无法落实，E1 保持 open（sprint 计划已知边界，不得静默降级）

### 三、一般遗留（不阻碍 DoD 子项成立；T8 复核处置）

- [ ] G1 值修订（`maxValidationMemoryMb` 256→512）与 rulesVersion 1.0.0-draft.1 定稿——待 D14 执行后复核契约/文档一致（牵 DOD-05/15 面）
- [ ] 部署地板 512MB→768MB 的 selection §5 / roadmap Q2 行修订（master 动作，建议稿 G3）
- [ ] Q9 三要素数值与试用方确认（并入 T3/DOD-14 链；sprint 未闭合则随 DOD-14 计缺口）
- [ ] D14 契约整备落定后，本清单及 S9 验收引用切换到新契约版本（S9 计划 D6）

### 四、后续范围（防静默移除声明）

- 当前**无任何 DoD 子项**被移入后续范围。第一版明确排除项（SSO、强制 PR、正文/语义搜索、Git LFS、HA、Windows CLI 等，见 roadmap「第一版明确排除」与架构 §12）不是 DoD 缺口，随 T6 进已知限制清单对外声明；后续演进方向（企业治理/知识整理增强/接入查找增强/运维规模增强）按 epic 规则 7 立项时各自成 epic，不塞 E1。

---

记录追加性声明：本记录为 S9-T1 首次汇总（2026-10-14）。若需重跑或更新，另立日期后缀文件，不覆盖本文件；T8 终核结论记录于 S9 验收记录，不在本文勾选 DoD。
