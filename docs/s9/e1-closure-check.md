# S9-T8 E1 关闭核对（终核记录）

- 记录日期：2026-10-14
- 记录人：S9-T8 worker（Orca dispatch `ctx_f0669faadda7`，task `task_1b5e5ed67be9`）
- 运行分支：`WayJ/s9-t8-closure`，rebase 到 `sprint/S9`（HEAD `cc4547e`——含 T7 @ `4748892` 及其收口台账、T5/T6/T2 全部产出）
- 任务定义：[implementation-breakdown §2.8 S9-T8 行](../s1/implementation-breakdown.md)（epic DoD 全勾选且各附证据链接；关闭核对记录留档；如存在不达标项则 E1 保持 open 并记录缺口，不得静默降级）
- 输入底稿：[S9-T1 DoD 证据汇总](dod-evidence.md)（2026-10-14，下称「T1 底稿」）+ S9-T2/T5/T6/T7 产出 + S1–S8 八份验收记录（均 verdict=pass）

**性质声明**：本文是 **epic 级 DoD 终核记录**。T1 底稿的「不提前勾选」限制（epic 开工规则 3）自本任务解除：以下每个勾选均附可点击证据链接；不达标项如实记缺口、不勾整条、不静默移除、不降级（epic 开工规则 3/4 与 S9-T8 行「不得静默降级」条款）。本文不修改 [roadmap](../superpowers/roadmaps/2026-10-12-notegit-v01.md) 与 sprint 计划文件——两者的同步动作以 §8 建议清单移交 master 执行。

## 0. 终核环境与复跑（2026-10-14，本 worktree 实测）

| 门禁 | 命令 | 结果 |
|---|---|---|
| product | `npm ci --no-audit --no-fund && npm test` | **exit 0；871 + 106 + 369 全绿，0 失败**（server 871 / packages/validation 106 / cli 369；npm ci fresh；运行时树已含本文 §7 的 known-limitations 修复——delivery-docs-consistency 抽检在终态通过） |
| contracts | `python3 docs/contracts/tools/verify_validation_contracts.py` | exit 0；82/82 |
| tests | `node --test docs/s1/spikes/git-http-backend/test/route-b.test.mjs` | exit 0；7/7 |
| storage | `node --test docs/contracts/tools/ddl_smoke.test.mjs` | exit 0；14/14 |

环境：Node v24.21.0、macOS（Apple Silicon）。计数口径与 T5/T7 记录一致（cli 369 = S7 基线 345 + T6 抽检 13 + T5 常驻 11；server 871 = S8 基线 850 + T2 回归 21）。按 AGENTS.md 约定：gates 通过不等于 E1 DoD 完成——以下逐条终判才是。

## 1. 终判总表（DOD-01~15）

| DoD | 终判 | 相对 T1 底稿的关键更新 | 主证据 |
|---|---|---|---|
| DOD-01 独立部署 | ✅ 达标 | T7 冻结态从零复验 ×4（补齐 T1 底稿唯一待办子项） | [S8 验收](../superpowers/acceptances/2026-10-14-S8-acceptance.md)、[S9-T7 init-drill ×4](../../.agents/notes/2026-10-14-S9-T7-init-drill.txt) |
| DOD-02 身份与权限 | ✅ 达标 | T2 三入口全谱矩阵终回归背书（零缺陷） | [T2 套件](../../server/test/e2e-final-regression.test.ts)、[S2 验收](../superpowers/acceptances/2026-10-13-S2-acceptance.md)、[S3 验收](../superpowers/acceptances/2026-10-13-S3-acceptance.md) |
| DOD-03 员工凭据 | ✅ 达标 | T2 审计主体终核（伪造 author 双入口） | [T2 套件](../../server/test/e2e-final-regression.test.ts)、[S2 验收](../superpowers/acceptances/2026-10-13-S2-acceptance.md)、[S6 验收](../superpowers/acceptances/2026-10-13-S6-acceptance.md) |
| DOD-04 原生 Git | ✅ 达标 | T2 并发面复测（网页×真实 git push） | [S1 spike](../superpowers/acceptances/2026-10-12-S1-acceptance.md)→[S3 验收](../superpowers/acceptances/2026-10-13-S3-acceptance.md)→[S8 验收](../superpowers/acceptances/2026-10-14-S8-acceptance.md)→[T2 套件](../../server/test/e2e-final-regression.test.ts) |
| DOD-05 内容校验 | ✅ 达标 | T2 防绕过清单 11 项全量复测逐条拒；D14 落契清偿 T1 遗留 G1 | [T2 套件](../../server/test/e2e-final-regression.test.ts)、[ADR D14](../superpowers/roadmaps/2026-10-12-notegit-v01.md)、[S6 验收](../superpowers/acceptances/2026-10-13-S6-acceptance.md) |
| DOD-06 Web 整理 | ✅ 达标 | T2 Web 越权面复测 + T6 用户文档成套 | [S4 验收](../superpowers/acceptances/2026-10-13-S4-acceptance.md)、[T2 套件](../../server/test/e2e-final-regression.test.ts)、[用户文档](../user/README.md) |
| DOD-07 草稿与并发 | ✅ 达标 | T2 并发写不丢改动终核（409/草稿保留/非快进恢复/两网页冲突） | [T2 套件](../../server/test/e2e-final-regression.test.ts)、[S4 验收](../superpowers/acceptances/2026-10-13-S4-acceptance.md) |
| DOD-08 历史与查找 | ✅ 达标 | T2 无权面矩阵复测 | [S5 验收](../superpowers/acceptances/2026-10-13-S5-acceptance.md)、[T2 套件](../../server/test/e2e-final-regression.test.ts)、[历史边界](../user/history-boundary.md) |
| DOD-09 CLI | ✅ 达标 | T2 多员工多库面 + T6 命令抽检 13 测试常驻 | [S6 验收](../superpowers/acceptances/2026-10-13-S6-acceptance.md)、[S7 验收](../superpowers/acceptances/2026-10-13-S7-acceptance.md)、[抽检套件](../../cli/test/delivery-docs-consistency.test.ts) |
| DOD-10 Harness 与同步 | ✅ 达标（仓内可证面全收口） | T5 双 Harness 收口：读写闭环 + 隔离复查 + 五态 127 用例复跑 + 2 常驻测试 | [本地收口](harness-local-closeout.md)、[托管收口](harness-hosted-closeout.md)、[留档](../../.agents/notes/2026-10-14-S9-T5-harness-closeout.txt) |
| DOD-11 审计与异常恢复 | ✅ 达标 | T2 审计主体面复测（DOD-03/11 联合） | [S3 验收](../superpowers/acceptances/2026-10-13-S3-acceptance.md)、[S8 验收](../superpowers/acceptances/2026-10-14-S8-acceptance.md)、[T2 套件](../../server/test/e2e-final-regression.test.ts) |
| DOD-12 备份恢复 | ✅ 达标 | （T1 即无待办；T7 manifest 断言随 0.1.0 冻结） | [S8 验收](../superpowers/acceptances/2026-10-14-S8-acceptance.md)、[恢复演练](../../.agents/notes/2026-10-14-S8-T5-restore-drill.txt) |
| DOD-13 运维与限制 | ✅ 达标 | D14 落契清偿 T1 遗留 G3（768MB 地板）；Q9 数值随 DOD-14 链（§5） | [容量档案](../../.agents/notes/2026-10-14-S8-T8-capacity.md)、[升级演练](../../.agents/notes/2026-10-14-S8-T7-upgrade-drill-1.txt)、[ADR D14](../superpowers/roadmaps/2026-10-12-notegit-v01.md) |
| DOD-14 企业试用 | ❌ **缺口（发布阻碍级）** | 无新增证据——试用方未落实（§3 正式记录） | [epic Q5](../superpowers/roadmaps/2026-10-12-notegit-v01.md)（open） |
| DOD-15 交付材料 | ✅ 达标 | T6 三面文档 + 已知限制成套；T7 v0.1.0 冻结发布包 + 发布说明 + 候选 epic | [发布说明](release-notes-v0.1.md)、[已知限制](../known-limitations.md)、[T7 记录](../../.agents/notes/2026-10-14-S9-T7-release.md) |

**结论：15 条终判齐全——14 条达标（各附证据链接于 §2），1 条缺口（DOD-14，§3 正式记录）。**

## 2. 逐条终核明细

### DOD-01 独立部署 —— ✅ 达标

| 子项 | 终核证据 |
|---|---|
| 全新目标环境按文档启动、管理员初始化 | [S8 验收场景 S1](../superpowers/acceptances/2026-10-14-S8-acceptance.md)：init-drill 真实容器 16 步全链绿；T7 冻结态从零复验 **×4 全绿**（含构建 23.6s / `--no-build` 复跑 / 发布材料落地后 26.6s / 含 T5 合并态 28.7s）——留档 [2026-10-14-S9-T7-init-drill.txt](../../.agents/notes/2026-10-14-S9-T7-init-drill.txt)；文档 [deploy/README.md](../../deploy/README.md)（compose + Dockerfile 构建期断言 git-http-backend） |
| 不依赖外部 Git 平台 | [S1 验收](../superpowers/acceptances/2026-10-12-S1-acceptance.md)（D10 选型：自带 Git 服务）；全部 Git 服务由容器内 git http-backend 提供 |
| 重启后账号、权限、知识和历史仍存在 | [S8 验收场景 S1](../superpowers/acceptances/2026-10-14-S8-acceptance.md) expected「重启数据在」（持久卷断言）；升级演练同链复证 [upgrade-drill](../../.agents/notes/2026-10-14-S8-T7-upgrade-drill-2.txt) |

T1 底稿唯一待办（v0.1 冻结包从零复验）已由 T7 履行；S9 验收场景 S5「复用 init-drill 路径」如约。

### DOD-02 身份与权限 —— ✅ 达标

| 子项 | 终核证据 |
|---|---|
| ≥2 员工 × ≥2 不同成员集库，Web/API/Git 一致授权 | 分面：[S2 验收](../superpowers/acceptances/2026-10-13-S2-acceptance.md) `vaults-matrix` 7/7（Web/API）；[S3 验收](../superpowers/acceptances/2026-10-13-S3-acceptance.md) `vaults-policy`+`githttp-ref-rules` 14/14（Git）；真实容器 [S8 升级演练](../../.agents/notes/2026-10-14-S8-T7-upgrade-drill-1.txt) 步骤 06/07（alice/bob 两库两成员集）。**终面：[T2 终回归](../../server/test/e2e-final-regression.test.ts) 21 测试——DOD-02 三入口矩阵（含实例管理员陷阱、无权 404 同体）在同一真实世界全拒**（真实 Fastify + 文件 SQLite + 真实 bare 仓库 + 标准 git 客户端经真实 /git HTTP） |
| 无权库、历史、附件、refs、对象、搜索结果不可访问 | 附件 404：[S4 验收](../superpowers/acceptances/2026-10-13-S4-acceptance.md) 18/18 内；搜索：[S5 验收](../superpowers/acceptances/2026-10-13-S5-acceptance.md) `search-authz-e2e` 3/3；refs/对象：S1 spike B4 + [S3 验收](../superpowers/acceptances/2026-10-13-S3-acceptance.md) 13/13；历史：S5 6/6；**T2 三入口实时撤权新组合复测全拒** |
| 只读成员不能写入 | [S3 验收](../superpowers/acceptances/2026-10-13-S3-acceptance.md)（reader push 拒、`main_admin_only` 三态）；T2 矩阵内复测 |

T2 结论：**零产品缺陷**（全部 21 测试绿）——T1 底稿「待 T2 背书」清偿。

### DOD-03 员工凭据 —— ✅ 达标

| 子项 | 终核证据 |
|---|---|
| 凭据归属当前员工、scope 只收窄 | [S2 验收](../superpowers/acceptances/2026-10-13-S2-acceptance.md)（HMAC 存储、422 防漂移）；[S6 验收](../superpowers/acceptances/2026-10-13-S6-acceptance.md)（凭据面） |
| 到期、撤销、停用、撤权阻断后续请求 | [S2 验收](../superpowers/acceptances/2026-10-13-S2-acceptance.md) `lifecycle` 15/15（四状态×双入口、下一请求零延迟）；S5 撤权下一查询消失；S7 revoked 套件；**T2 三入口实时撤权复测** |
| 审计以认证主体为准、不信任可填写的 commit 作者 | 分面：[S3 验收](../superpowers/acceptances/2026-10-13-S3-acceptance.md) `receive-audit` 18/18 + [档案](../../.agents/notes/2026-10-13-S3-T6-receive-audit.md)。**终面：T2 伪造 author 双入口（Git push 伪造作者 + 网页面）+ 跨入口审计成链 + tail=ref + 零排空断言** |
| 凭据不泄漏（CLI 面） | [S6 验收](../superpowers/acceptances/2026-10-13-S6-acceptance.md)：URL/.git/config/输出泄漏扫描断言绿 |

### DOD-04 原生 Git —— ✅ 达标

| 子项 | 终核证据 |
|---|---|
| 标准客户端 clone/fetch/commit/push | [S1 spike](../superpowers/acceptances/2026-10-12-S1-acceptance.md) B1/B2（7/7）→ [S3 验收](../superpowers/acceptances/2026-10-13-S3-acceptance.md) `githttp-behavior` 13/13（产品级）→ [S8 验收](../superpowers/acceptances/2026-10-14-S8-acceptance.md) 真实容器演练链（init/restore/upgrade 均含真实 git 客户端操作）→ T2 回归内复测 |
| 编辑者直接快进发布、无需 PR | [S3 验收](../superpowers/acceptances/2026-10-13-S3-acceptance.md)（B2 FF push；D2 不强制 PR）；T5 本地闭环 L 面真实 push 发布 |
| 默认分支保护、禁 force push/删除、ref 范围规则 | S1 spike B3–B6（7/7）；[S3 验收](../superpowers/acceptances/2026-10-13-S3-acceptance.md)（非快进拒、逐 ref 授权、先写后删拒、多 ref 原子拒）；[S8 验收](../superpowers/acceptances/2026-10-14-S8-acceptance.md) 维护矩阵真实客户端 receive 403；**T2 并发面：网页编辑×真实 HTTP git push → 409 + 草稿保留 + 刷新闭环 / 非快进恢复** |

三层独立证据链（spike→产品级→真实容器）+ T2 并发面终核——T1 底稿待办清偿。

### DOD-05 内容校验 —— ✅ 达标

| 子项 | 终核证据 |
|---|---|
| 暂存区、服务端、网页同一规则契约 | [S3 验收](../superpowers/acceptances/2026-10-13-S3-acceptance.md) `publish-isomorphism` 2/2；[S6 验收](../superpowers/acceptances/2026-10-13-S6-acceptance.md) `rules-version-consistency` 10 用例（三端一致、端点常量==api.md、MAJOR 漂移失败）；contracts 门禁 82/82（本文 §0 复跑）；**rulesVersion `1.0.0-draft.2`（D14 落契，三端同版）**——[rules-version.json](../contracts/rules-version.json) 唯一机器来源 |
| 无效 Schema、危险 tree 条目、超限输入被阻止 | [S3 验收](../superpowers/acceptances/2026-10-13-S3-acceptance.md) B 面真实校验；limits [S3-T8 档案](../../.agents/notes/2026-10-13-S3-T8-limits.md) + packages/validation 106；限制可配置（[S8-T8 容量档案](../../.agents/notes/2026-10-14-S8-T8-capacity.md) 九键 + `git.maxConcurrentChildren`，D14 后 `maxValidationMemoryMb`=512） |
| 跳过 hook / 先写坏后删 / 合并提交 / 多 ref 推送不能绕过 | **T2 终回归：validation §1 防绕过清单 11 项全量复测逐条拒绝**（--no-verify 与无 hook 克隆、先写坏后删、合并夹带 + 良性合并不误拒、根提交全检、多 ref 原子拒、tag 写入拒、网页直改引用 CAS 拒、symlink、大小写碰撞 + 结构性断言——映射见 [T2 套件头注](../../server/test/e2e-final-regression.test.ts)）；spike B5/B6 与 S3 分面证据在库 |

T1 底稿一般遗留 G1（`maxValidationMemoryMb` 256→512 + rulesVersion 升版）已由 [ADR D14](../superpowers/roadmaps/2026-10-12-notegit-v01.md) 落契清偿；`1.0.0` 定稿升版未发生——非 DoD 条件，已在 [已知限制 §3](../known-limitations.md) 如实声明。

### DOD-06 Web 整理 —— ✅ 达标

| 子项 | 终核证据 |
|---|---|
| 浏览、编辑、上传 Markdown 与图片、重命名、删除 | [S4 验收](../superpowers/acceptances/2026-10-13-S4-acceptance.md) 场景 S1–S3（visibility 2/2、render-xss + attach-routes 18/18、edit-errors 9/9）+ 任务档案（upload/rename/visibility）；T2 矩阵内 Web 越权面复测 |
| 必填元数据清楚提示 | [S4 验收](../superpowers/acceptances/2026-10-13-S4-acceptance.md)（E-FM 按路径与规则定位、W 级不阻断）；[用户文档](../user/contributing.md) 修正循环指引（T6） |
| 预览和附件遵循内容及访问限制 | [S4 验收](../superpowers/acceptances/2026-10-13-S4-acceptance.md)：XSS 全清 + 附件越权 404（18/18 内） |

### DOD-07 草稿与并发 —— ✅ 达标

| 子项 | 终核证据 |
|---|---|
| 私有草稿可恢复 | [S4 验收](../superpowers/acceptances/2026-10-13-S4-acceptance.md) `drafts-routes` 15/15（草稿私有、撤权拒、Git 无痕） |
| Web×Git / 两次 Web 冲突不静默覆盖、冲突草稿保留 | 分面：[S4 验收](../superpowers/acceptances/2026-10-13-S4-acceptance.md) `web-submissions-routes` 9/9。**终面：T2 并发终核——网页编辑×真实 HTTP git push → 409 + 草稿保留 + 刷新闭环、非快进恢复路径、两次网页提交冲突**（不丢改动断言） |
| 预期旧 commit 检查 + 统一权限规则 | [S4 验收](../superpowers/acceptances/2026-10-13-S4-acceptance.md)（base commit CAS 语义）；契约=api.md 发布检查点 0–5；T2 C10 结构面复测 |

### DOD-08 历史与查找 —— ✅ 达标

| 子项 | 终核证据 |
|---|---|
| Web 与 Git 看到相同已发布内容 | [S4 验收](../superpowers/acceptances/2026-10-13-S4-acceptance.md)（双向一致 2/2）+ [S5 验收](../superpowers/acceptances/2026-10-13-S5-acceptance.md) `web-history-consistency` 6/6（历史/diff 脚本比对 git）；T5 本地闭环双通道互见会合（L 面） |
| 历史、diff、还原可用，还原产生新提交 | [S5 验收](../superpowers/acceptances/2026-10-13-S5-acceptance.md) `web-history-restore` 11/11；边界文档 [history-boundary.md](../user/history-boundary.md)（行为测试固化） |
| 元数据查找不泄露无权知识 | [S5 验收](../superpowers/acceptances/2026-10-13-S5-acceptance.md) `search-authz-e2e` 3/3；**T2 无权面矩阵复测** |
| 索引可重建并能观察延迟 | [S5 验收](../superpowers/acceptances/2026-10-13-S5-acceptance.md) `search-e2e` 4/4（实测 78/51ms vs 5s 上界）+ `search-rebuild` 2/2；[S8 验收](../superpowers/acceptances/2026-10-14-S8-acceptance.md) 恢复链含索引重建核对 |

### DOD-09 CLI —— ✅ 达标

| 子项 | 终核证据 |
|---|---|
| login、ls、setup、lint、sync 有文档和可理解错误 | [S6 验收](../superpowers/acceptances/2026-10-13-S6-acceptance.md) 193/193 + [S7 验收](../superpowers/acceptances/2026-10-13-S7-acceptance.md) 345/345（sync 全套件）；[cli/README.md](../../cli/README.md)；**T6 常驻抽检 [delivery-docs-consistency.test.ts](../../cli/test/delivery-docs-consistency.test.ts) 13 测试：三文档 sh 围栏逐命令 ↔ 真实 `--help` 比对**（「不留无法运行示例」的机械守卫） |
| JSON 输出与退出码契约确定 | [S6 验收](../superpowers/acceptances/2026-10-13-S6-acceptance.md)（deepEqual schema + 退出码 0/1/2） |
| hook 安装不破坏现有 hook、不执行库内下载脚本 | [S6 验收](../superpowers/acceptances/2026-10-13-S6-acceptance.md) hooks-sandbox/setup 组（恶意样本不执行、兼容两模式、卸载还原） |
| 凭据不进入仓库或日志 | [S6 验收](../superpowers/acceptances/2026-10-13-S6-acceptance.md) 泄漏扫描断言绿；T5 闭环复现（凭据落盘 0600、token 脱敏留档） |

### DOD-10 Harness 与同步 —— ✅ 达标（仓内可证面全部收口）

| 子项 | 终核证据 |
|---|---|
| 本地、托管两种 Harness 完成读取与修改 | **T5 收口**：[本地收口记录](harness-local-closeout.md)（L1–L11 十一步全绿——真实服务实例 `startApp` 不打桩、真实 dist 产物 CLI、Git push / 网页提交双通道互见会合）；[托管收口记录](harness-hosted-closeout.md)（H0–H8 九步——两员工隔离布局下各自 login→ls→sync 读取闭环 + 共享库修改协作）；完整输出留档 [2026-10-14-S9-T5-harness-closeout.txt](../../.agents/notes/2026-10-14-S9-T5-harness-closeout.txt)；分面基线 [S7 验收](../superpowers/acceptances/2026-10-13-S7-acceptance.md) 345/345 |
| 托管凭据和目录按员工隔离 | **T5 复查**：同一 OS 账号最苛刻形态（共享 HOME 与 git 全局配置），目录/凭据/状态四层隔离复查全绿；常驻守卫 [hosted-harness-closeout.test.ts](../../cli/test/hosted-harness-closeout.test.ts) |
| 五态（脏/未推送/分叉/非默认分支/断网）保留改动并逐库报告 | [S7 验收](../superpowers/acceptances/2026-10-13-S7-acceptance.md) noclobber 八态指纹逐字节不变；**T5 五态 12 套件 127 用例逐套件复跑全绿**（[本地收口记录 §3](harness-local-closeout.md)）；常驻守卫 [local-harness-closeout.test.ts](../../cli/test/local-harness-closeout.test.ts) |

边界注记（如实）：试用方自有环境中的实地运行属 DOD-14「两种 Harness 环境」试用覆盖，该缺口随 §3 记录——不影响本条「能力与环境验证收口」的达标判定（epic 风险行 6 的应对已按「经试用方认可的隔离部署环境，不能用纯文档替代实测」执行到仓内可及范围）。

### DOD-11 审计与异常恢复 —— ✅ 达标

| 子项 | 终核证据 |
|---|---|
| 推送及网页提交记录主体、库、时间、旧新 commit、结果 | [S3 验收](../superpowers/acceptances/2026-10-13-S3-acceptance.md) `receive-audit` 18/18（预记录成链）；[S4/S5 验收](../superpowers/acceptances/2026-10-13-S5-acceptance.md)（网页提交与还原审计成链）；audit-tail poller + 启动 reconcile 双通道（[ADR D13/D14](../superpowers/roadmaps/2026-10-12-notegit-v01.md) 追认）；**T2 跨入口成链 + tail=ref + 零排空终核** |
| Git/数据库间失败可核对 | [S8 验收](../superpowers/acceptances/2026-10-14-S8-acceptance.md) 对账 CLI（异常注入 18 测试）+ 维护排空 15/15 |
| 超时或重试不静默重复发布、不虚假成功 | [S3 验收](../superpowers/acceptances/2026-10-13-S3-acceptance.md)（SIGKILL 中断注入、quarantine 原子性）；[S8 升级演练](../../.agents/notes/2026-10-14-S8-T7-upgrade-drill-1.txt) D-BR-08 双拒 + 零数据丢失断言 |

### DOD-12 备份恢复 —— ✅ 达标

| 子项 | 终核证据 |
|---|---|
| 维护模式覆盖网页/API/Git 写入 | [S8 验收](../superpowers/acceptances/2026-10-14-S8-acceptance.md) `maintenance-matrix` + `maintenance-drain` 15/15（真实 git 客户端 receive 403） |
| 完整备份数据库、Git 仓库、配置、必要密钥 | [S8 验收](../superpowers/acceptances/2026-10-14-S8-acceptance.md) `backup-snapshot`+`backup-verify` 18/18（分置两件 + manifest + 离线验证）；[备份演练留档](../../.agents/notes/2026-10-13-S8-T4-backup-drill.txt)；T7 后 manifest 断言绑定 0.1.0 |
| 全新环境恢复并验证权限、内容、历史、索引重建 | [恢复演练 R1–R14 全项 35 步 ×2 PASS](../../.agents/notes/2026-10-14-S8-T5-restore-drill.txt)（S8 verdict：「证据义务已履行」；终核勾选在本条完成） |

### DOD-13 运维与限制 —— ✅ 达标

| 子项 | 终核证据 |
|---|---|
| 容量、超时、并发限制可配置 | [S8-T8 容量档案](../../.agents/notes/2026-10-14-S8-T8-capacity.md)：Q7 九键终值 + `git.maxConcurrentChildren`（默认 8、FIFO 排队不拒绝、热生效）+ 实测 gate 断言；首个负载数据点 [S7-T8](../../.agents/notes/2026-10-13-S7-T8-load.md) |
| 健康、磁盘和失败指标可查看 | [S8 验收](../superpowers/acceptances/2026-10-14-S8-acceptance.md) 指标面 M 组全绿（api.md §3.8，D14 落契） |
| 部署、升级与兼容边界明确 | [deploy/README.md](../../deploy/README.md)（768MB 地板与推荐档 1GB）；[发布说明 v0.1](release-notes-v0.1.md) 兼容矩阵 + 升级步进（接 backup §9 三相位）+ 回退指引 |
| 至少完成一次升级/恢复验证 | [升级演练 32 步 ×2 PASS](../../.agents/notes/2026-10-14-S8-T7-upgrade-drill-2.txt)（升级冒烟/回退原状/跳备份拒）；恢复见 DOD-12 |

T1 底稿一般遗留三项处置：G1（值修订+升版）✅ D14 落契清偿；G3（768MB 地板 selection §5 / roadmap Q2 修订）✅ D14 落契清偿（本文 §7 同步修复文档残行）；Q9 三要素数值待试用方确认 → 未清偿，随 DOD-14 缺口链如实记录（§3/§5）——非 DoD-13 子项文本要求的条件，不因此降级本条，亦不静默抹除。

### DOD-14 企业试用 —— ❌ 缺口（发布阻碍级）

四子项（真实团队试用 / 三角色覆盖 / 两 Harness 环境覆盖 / 关键阻碍记录与处置）**全部无证据**——正式缺口记录见 §3。

### DOD-15 交付材料 —— ✅ 达标

| 子项 | 终核证据 |
|---|---|
| 版本化发布包 | **T7**：v0.1.0 四包冻结（root/server/cli/validation + CLI VERSION 常量与断言跟随）；[pack 证据](../../.agents/notes/2026-10-14-S9-T7-release.md)（`notegit-0.1.0.tgz` 48 文件、从零安装冒烟 `notegit --version` = 0.1.0）；镜像 `notegit:0.1.0` 构建绿（构建期断言 + 自检 rulesVersion draft.2）；[tag 脚本](../../deploy/scripts/tag-release.mjs) dry-run 默认（打 tag/push 属 master `--apply`） |
| 用户与管理员文档 | [docs/user/](../user/README.md) 四篇 + 索引（T6）；[docs/admin/README.md](../admin/README.md) 运维手册（T6） |
| CLI/Harness 指引 | [cli/README.md](../../cli/README.md)（与真实 `--help` 逐字节一致）；[docs/harness/](../harness/README.md)：README + [hosted-runbook](../harness/hosted-runbook.md) + [agent-guide](../harness/agent-guide.md)（T6 补齐凭据→login→sync→引用三要素主线） |
| 已知限制清单 | [known-limitations.md](../known-limitations.md)（T6：架构 §12 八条逐条对齐 + 第一版排除 + 周期遗留 11 项；§3 stale 行已由本任务修复——见 §7；一致性由 [delivery-docs-consistency](../../cli/test/delivery-docs-consistency.test.ts) 常驻看守） |
| 验收记录齐全 | S1–S8 八份 verdict=pass 在库（[acceptances/](../superpowers/acceptances/)）；**S9 验收记录随 sprint 验收动作产生（本文即其 DoD 终核输入）——非材料缺口，属验收流程本身** |
| 命令与文档对应实际实现、不留无法运行示例 | T6 13 抽检测试常驻（命令↔`--help`、backup CLI、API 路径↔api.md、网页路径↔路由源）；T7 发布说明安装/升级步骤引演练可复跑路径 |

后续需求未混入第一版：[next-epics.md](next-epics.md) 候选清单单列（epic 规则 7，T7 义务履行）。

## 3. DOD-14 缺口正式记录（发布阻碍级，epic 规则 4 口径）

| 要素 | 记录 |
|---|---|
| **状态** | **试用方未落实——用户决策中**（截至 2026-10-14 无任何试用证据；[S8-T8 容量档案](../../.agents/notes/2026-10-14-S8-T8-capacity.md) Q9 节明文「试用方尚未接洽——不虚构」）。S9-T3（试用组织与 Q5/Q9 关闭）与 S9-T4（试用执行与反馈处置）两任务挂起——外部依赖，非仓内可闭合。**2026-10-16 追记：解锁条件链第 1–2 步完成——试用方指定「天穹智能」（epic Q5 closed）＋ T3 仓内部分完成（[trial-plan.md](trial-plan.md)：三角色/两 Harness/真实知识集/步进/反馈分级，S23）；第 3 步 T4（真实试用执行）挂起不变——待天穹智能真人参与，master 不代演；DOD-14 不勾，E1 保持 open** |
| **影响** | DOD-14 四子项全部不达标 → **E1 保持 open（唯一阻塞项）**；M4「第一版试用发布」的正式发布动作（`tag-release.mjs --apply` 打 tag/push、npm 发布）在缺口闭合前不执行（D8：真实试用是 E1 关闭条件；发布定位=「第一版试用发布」） |
| **解锁条件** | 用户指定试用团队（覆盖管理员、知识贡献者、Agent 三角色 + 真实知识集 + 本地/托管两种 Harness 环境）→ **T3 执行**（试用计划、角色与环境清单；Q5/Q9 在 epic Open Questions 置 closed 附证据）→ **T4 执行**（三角色 × 两 Harness 全走通；反馈分级处置，发布阻碍项修复后附重验证据）→ 以本文件同格式追加复核记录，DOD-14 终判更新 |
| **引用** | [epic Q5](../superpowers/roadmaps/2026-10-12-notegit-v01.md)（open——「S9 前落实；没有真实试用不得关闭 DOD-14」）；[epic Q9](../superpowers/roadmaps/2026-10-12-notegit-v01.md)（open——三要素框架已备、数值待试用方）；[ADR D8](../superpowers/roadmaps/2026-10-12-notegit-v01.md)（真实试用是 E1 关闭条件）；[S9 计划已知边界](../superpowers/sprints/2026-10-14-S9-plan.md)（开工即记录：外部团队无法落实则如实记缺口、E1 保持 open、不得静默降级）；[T1 底稿 §3 二](dod-evidence.md)（本缺口自 T1 起持续在册，无静默移除） |

## 4. 发布阻碍核查（epic 规则 4 五类，T8 完成标准「无未处理越权/数据丢失/不可恢复问题」）

| 规则 4 类别 | 核查结论 | 证据 |
|---|---|---|
| 越权 | **无未处理项**——三入口矩阵 + 实时撤权 + 分面谱系全拒，T2 零缺陷 | [T2 套件](../../server/test/e2e-final-regression.test.ts)；[S2](../superpowers/acceptances/2026-10-13-S2-acceptance.md)/[S3](../superpowers/acceptances/2026-10-13-S3-acceptance.md)/[S4](../superpowers/acceptances/2026-10-13-S4-acceptance.md)/[S5](../superpowers/acceptances/2026-10-13-S5-acceptance.md) 验收 |
| 凭据泄露 | **无未处理项**——HMAC 无明文、明文仅显示一次、泄漏扫描断言、托管四层隔离 | [S2 验收](../superpowers/acceptances/2026-10-13-S2-acceptance.md)；[S6 验收](../superpowers/acceptances/2026-10-13-S6-acceptance.md)；[托管收口](harness-hosted-closeout.md) |
| 数据丢失 | **无未处理项**——并发 409+草稿保留、五态改动逐字节保留 127 用例、恢复演练零丢失断言 | [T2 套件](../../server/test/e2e-final-regression.test.ts)；[本地收口 §3](harness-local-closeout.md)；[恢复演练](../../.agents/notes/2026-10-14-S8-T5-restore-drill.txt) |
| 校验/分支规则可绕过 | **无未处理项**——防绕过清单 11 项全量复测逐条拒绝；三端同版 | [T2 套件](../../server/test/e2e-final-regression.test.ts)（清单映射头注）；[S6 验收](../superpowers/acceptances/2026-10-13-S6-acceptance.md) |
| 备份不可恢复 | **无未处理项**——恢复 R1–R14 ×2、升级/回退 ×2、维护模式三端覆盖 | [S8 验收](../superpowers/acceptances/2026-10-14-S8-acceptance.md)；[恢复](../../.agents/notes/2026-10-14-S8-T5-restore-drill.txt)/[升级](../../.agents/notes/2026-10-14-S8-T7-upgrade-drill-1.txt)演练留档 |

（DOD-14 自身是发布条件缺口而非规则 4 缺陷类——试用未发生，故无「试用中发现的安全缺陷」可言；缺口如实记录于 §3。）

## 5. Q5/Q9 落实确认（T8 完成标准项）

| 问题 | 终核确认 |
|---|---|
| Q5 试用团队 | **open，未落实**——epic 行关闭条件（附证据链接）不具备；试用方落实=用户决策中。不虚构、不改状态；解锁链见 §3 |
| Q9 试用运行目标 | **open，框架已备、数值未定**——三要素参数框架（可用性/备份频率/RPO/RTO）随 [S8-T8](../../.agents/notes/2026-10-14-S8-T8-capacity.md) 备妥并经 [ADR D14](../superpowers/roadmaps/2026-10-12-notegit-v01.md) 注记；数值确认依赖试用方接洽，随 DOD-14 链（§3）；[已知限制 §3「Q9 未定」](../known-limitations.md) 对外如实声明 |

## 6. E1 处置结论

**E1 保持 open。**

- 唯一阻塞 = **DOD-14（企业试用）**——发布阻碍级缺口，正式记录于 §3；解锁链 = 用户指定试用团队 → T3 → T4 → 追加复核。
- **其余 14 条全部达标**——终核勾选清单（每勾附主证据链接；逐项完整证据见 §2）：

- [x] **DOD-01 独立部署**（[S8 init-drill 16 步](../superpowers/acceptances/2026-10-14-S8-acceptance.md) + [T7 从零复验 ×4](../../.agents/notes/2026-10-14-S9-T7-init-drill.txt)）
- [x] **DOD-02 身份与权限**（[T2 三入口矩阵全拒](../../server/test/e2e-final-regression.test.ts)，零缺陷）
- [x] **DOD-03 员工凭据**（[T2 伪造 author 双入口审计主体](../../server/test/e2e-final-regression.test.ts) + [S2 lifecycle 15/15](../superpowers/acceptances/2026-10-13-S2-acceptance.md)）
- [x] **DOD-04 原生 Git**（[S3 13/13+14/14](../superpowers/acceptances/2026-10-13-S3-acceptance.md) + [T2 并发面](../../server/test/e2e-final-regression.test.ts)）
- [x] **DOD-05 内容校验**（[T2 防绕过清单 11 项逐条拒](../../server/test/e2e-final-regression.test.ts)；三端同版 draft.2）
- [x] **DOD-06 Web 整理**（[S4 全场景](../superpowers/acceptances/2026-10-13-S4-acceptance.md) + [T2 Web 越权面](../../server/test/e2e-final-regression.test.ts)）
- [x] **DOD-07 草稿与并发**（[T2 并发终核：409+草稿保留+非快进恢复](../../server/test/e2e-final-regression.test.ts)）
- [x] **DOD-08 历史与查找**（[S5 全场景](../superpowers/acceptances/2026-10-13-S5-acceptance.md) + [T2 无权面](../../server/test/e2e-final-regression.test.ts)）
- [x] **DOD-09 CLI**（[S6 193](../superpowers/acceptances/2026-10-13-S6-acceptance.md)/[S7 345](../superpowers/acceptances/2026-10-13-S7-acceptance.md) + [T6 抽检 13 测试常驻](../../cli/test/delivery-docs-consistency.test.ts)）
- [x] **DOD-10 Harness 与同步**（[本地收口 L1–L11](harness-local-closeout.md)、[托管收口 H0–H8](harness-hosted-closeout.md)、[五态 127 用例复跑](../../.agents/notes/2026-10-14-S9-T5-harness-closeout.txt)）
- [x] **DOD-11 审计与异常恢复**（[S3 receive-audit 18/18](../superpowers/acceptances/2026-10-13-S3-acceptance.md) + [T2 审计主体终核](../../server/test/e2e-final-regression.test.ts)）
- [x] **DOD-12 备份恢复**（[恢复演练 R1–R14 ×2](../../.agents/notes/2026-10-14-S8-T5-restore-drill.txt)；[S8 verdict](../superpowers/acceptances/2026-10-14-S8-acceptance.md)）
- [x] **DOD-13 运维与限制**（[容量收口](../../.agents/notes/2026-10-14-S8-T8-capacity.md) + [升级演练 ×2](../../.agents/notes/2026-10-14-S8-T7-upgrade-drill-1.txt)；[ADR D14](../superpowers/roadmaps/2026-10-12-notegit-v01.md) 清偿 G1/G3）
- [x] **DOD-15 交付材料**（[发布说明 v0.1](release-notes-v0.1.md) + [T7 pack/镜像证据](../../.agents/notes/2026-10-14-S9-T7-release.md) + [已知限制](../known-limitations.md)）
- [ ] **DOD-14 企业试用**——缺口，不勾整条（正式记录见本文 §3；[epic Q5 open](../superpowers/roadmaps/2026-10-12-notegit-v01.md)）
- 规则 4 五类发布阻碍：无未处理项（§4）；Q5/Q9 如实 open（§5）。
- 未完成项的归属（防静默移除）：T3/T4 是 **E1 自身剩余任务**（不是「后续范围」）——E1 正因此保持 open；真正的后续范围已按 epic 规则 7 单列于 [next-epics.md](next-epics.md)，无任何 DoD 子项被移出第一版承诺（[T1 底稿 §3 四](dod-evidence.md) 防静默移除声明继续有效）。
- 本文同时承接 [T1 底稿 §3](dod-evidence.md) 的勾销义务：**一（sprint 内待办四项：T2/T5/T6/T7）全部勾销**（证据见 §2 各条）；**二（DOD-14 发布阻碍级）不勾销**（§3 在册）；**三（一般遗留四项）**——G1 ✅ D14 清偿、G3 ✅ D14 清偿（§7 修复残行）、Q9 未清偿随 DOD-14 链、D14 引用切换 ✅（本文全部证据已按 draft.2/落契后版本引用）；**四（后续范围）** 无移入移出。

## 7. T7 挂账修复：known-limitations §3 stale 行

[T7 移交](../../.agents/notes/2026-10-14-S9-T7-release.md)指出的过时行——「部署地板修订挂账」（原文称 selection §5 / roadmap Q2 修订「属 master 动作（建议稿 G3）」）——已修复：D14 已于 2026-10-14 正式落契（[selection.md §5](../s1/selection.md) 与 [roadmap Q2](../superpowers/roadmaps/2026-10-12-notegit-v01.md) 均已按 768MB 修正），该行改写为「部署内存地板 768MB」现状声明（含 512MB 档降并发不承诺的边界与 ADR D14 引用），消除「挂账」过时表述。修复仅此一行（Ownership 约束）；改后 [delivery-docs-consistency](../../cli/test/delivery-docs-consistency.test.ts) 在本文 §0 的终态复跑中通过。

## 8. roadmap / sprint 文档同步建议（master 执行——本任务边界禁改 roadmap，只列建议）

以下为建议的具体行级动作（均以本文为证据源；执行与否与措辞微调属 master）：

1. **[roadmap Sprint 状态表](../superpowers/roadmaps/2026-10-12-notegit-v01.md) S9 行**（当前 `| S9 | planned | 完整验收、企业试用与第一版发布；依赖 S8、S1–S7 验收；M4；2026-10-12，[F12](#deliverables) |`）：状态自 `planned` 起步更新——按 S1–S8 行既有格式追加 `2026-10-14 started：[2026-10-14-S9-plan.md](../sprints/2026-10-14-S9-plan.md)`（sprint 实际已物化执行，stub 行滞后；[计划文件](../superpowers/sprints/2026-10-14-S9-plan.md)）；验收后按惯例补验收/合并注记。
2. **roadmap Definition of Done 节**：DOD-01–DOD-13、DOD-15 十四个复选框 `[ ]`→`[x]`，每条追加证据链接（主链=本文 §1/§2 对应行 + 其底层证据）；**DOD-14 保持 `[ ]`** 并追加缺口注记（指向本文 §3）。DoD 节尾「日期与依据」下追加一行注记：`2026-10-14 S9-T8 终核：14/15 达标（证据：docs/s9/e1-closure-check.md）；DOD-14 缺口（试用方未落实）——E1 保持 open，不降级`。
3. **roadmap 文档维护记录**：追加一行 `| 2026-10-14 | S9-T8 E1 关闭核对：DOD-01–13/15 达标、DOD-14 缺口正式记录，E1 保持 open | [docs/s9/e1-closure-check.md](../../s9/e1-closure-check.md) |`。
4. **roadmap Open Questions Q5/Q9 行**：保持 open（如实）；可在 resolution 列追加 `2026-10-14 S9-T8：试用方仍未落实（用户决策中），缺口记录见 docs/s9/e1-closure-check.md §3`——非关闭动作。
5. **[S9 sprint 计划文件](../superpowers/sprints/2026-10-14-S9-plan.md)**：Wave 6 S9-T8 行勾选 `[x]`（完成注记=本文档）；其 DoD 副本十五行与 roadmap 同政策（14 勾 + DOD-14 不勾附缺口注）；Wave 3/4 的 T3/T4 行保持 `[ ]` 并追加挂起注记（状态=试用方未落实/用户决策中，解锁条件见本文 §3）。
6. known-limitations §3 与 roadmap Q2 的 D14 交叉引用已一致（本文 §7 修复 + D14 落契时已改 Q2 行），无需进一步动作。

## 9. 移交

- **S9 验收（master）**：以本文为 DoD 终核输入（验收场景 S1「DoD 证据完备」即本文 §1 总表；S2/S3/S5/S6 场景的证据分别在 T2/T5/T7/T6 产出与本文 §0 复跑）。
- **发布动作（master）**：`node deploy/scripts/tag-release.mjs --apply`（打 tag + push）与 npm 发布——在 DOD-14 缺口闭合与 E1 关闭裁决前，按 M4 定位与 D8 约束执行与否属 master/用户决策。
- **DOD-14 解锁**：见 §3 解锁链；T3/T4 重启时以本文 §3 为缺口基线，完成后另立日期后缀文件追加复核（不覆盖本文）。
- 追加性声明：本文为 S9-T8 首次终核（2026-10-14），不覆盖 [T1 底稿](dod-evidence.md)（其追加性声明维持）；重核另立文件。
