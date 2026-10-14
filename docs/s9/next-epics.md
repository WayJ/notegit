# 后续需求候选清单（v0.1 发布时点）

S9-T7 交付（epic 规则 7：后续需求单列候选、不塞入 E1）。汇总口径：本周期（S1–S9）
`.agents/notes/` 与 `docs/s1/` 各建议稿中所有「后续 / 留作 / 后置 / 待定」标注项，加上
[known-limitations.md](../known-limitations.md) §3「本周期遗留」中指向未来工作的行；每项标来源。
本清单是**候选登记**（供 master 立项时取舍），不是承诺，也不改变 E1 的 DoD——按 roadmap
约定，立项时各自成 epic。

## 1. 主题级候选（roadmap「后续演进」四行，引用不复制）

企业治理（SSO、账号停用联动、分支审核/提案工作流）、知识整理增强（Word/PDF/TXT 转换、批量导入、
AI 摘要）、接入与查找增强（只读 MCP、在线查询、正文/语义搜索）、运维与规模增强（性能、大附件、
SSH、Git LFS、多实例、知识巡检）——定义、依赖与验证要点见
[roadmap 后续演进表](../superpowers/roadmaps/2026-10-12-notegit-v01.md)。下列具体项按主题归入或独立立项。

## 2. 功能候选

| 项 | 内容 | 来源 |
|---|---|---|
| 管理配置端点 HTTP 挂接 | `GET/PUT /api/v1/admin/config` 与库删除端点契约定稿（api.md §3.4/§5）、HTTP 未挂接；含 `config.update` 审计接线——当前管理员经 SQL/ops 写 `app_settings` 行（热生效） | [capacity-face-amendments G5](../s1/capacity-face-amendments.md)、[api-md-amendments A2/A3](../s1/api-md-amendments.md)、[known-limitations §3](../known-limitations.md)、S8-T8 容量档案 |
| 维护状态查询端点 | `GET /api/v1/admin/maintenance`（当前开关状态；S2-T8 管理页曾因缺此端点不显示状态） | [api-md-amendments](../s1/api-md-amendments.md)（待裁决留后续） |
| tree/blob 机器消费端点 | api.md §6 已契约、未实现（页面族走服务端直读；未来 API 消费面如 CLI 扩展） | [api-md-amendments](../s1/api-md-amendments.md) |
| `notegit logout` | CLI 撤销入口（当前撤销走网页 DELETE；本地清理 `credential erase`） | [S6-T2 note](../../.agents/notes/2026-10-13-S6-T2-login.md) |
| ls 远端 tip 端点 | `GET /api/v1/vaults` 并入 default-branch tip，`ls` 免每库一次 fetch（N 库 = N 网络往返） | [S6-T3 note](../../.agents/notes/2026-10-13-S6-T3-ls.md)（留待后续 sprint/master 裁定） |
| `notegit admin recover` | 主机侧管理员锁死恢复命令 + 「最后管理员」保护（当前无自助恢复路径；过渡措施：保持 ≥2 名实例管理员） | [known-limitations §3](../known-limitations.md)、architecture-notes §6.3/§6.6 |
| rulesVersion 定稿 | 1.0.0-draft.2 → 1.0.0 定稿升版（不破坏三端一致性，全链同版） | [known-limitations §3](../known-limitations.md)、S9-T1 证据汇总（一般遗留） |
| 备份调度形态 | 应用内定时 vs 外部触发（当前 CLI 为外部触发最小完备形态） | [backup-face-amendments](../s1/backup-face-amendments.md)（§10 待定项留部署规格） |
| 共享只读对象缓存 | 托管 Harness 跨员工 git 对象/浅克隆缓存（引入前须独立评估：对象可达性本身是权限数据） | breakdown S7-T7 行（显式边界声明）、[hosted-runbook §5](../harness/hosted-runbook.md)、known-limitations §3 |

## 3. 工程与质量候选

| 项 | 内容 | 来源 |
|---|---|---|
| lineOfIndex 预控行号索引 | 搜索索引 W1 二次项优化机会（病态稠密当前由超时兜底；真实用量落地前不动） | [capacity-face-amendments W1](../s1/capacity-face-amendments.md)（原建议入 tech-debt-tracker 或后续演进；tracker 文件尚未建） |
| docs-consistency 整块比对 | 「文档内 --help 原文块 == --help 全文」机制化断言（本次 sync 块漂移靠人工复写闭合） | [S9-T6 note](../../.agents/notes/2026-10-14-S9-T6-docs.md)（遗留给后续，无阻断） |
| 搜索索引折叠标量 | frontmatter `>`/`\|` 多行标量在索引退化 title=NULL/tags=[]（行仍入索引；罕见形态） | [known-limitations §3](../known-limitations.md)、S5-T3 索引档案 |
| 指标口径增强 | `auth_failures` 持久化（现进程内计数、重启归零）；校验耗时分布覆盖 pre-receive 子进程 | [known-limitations §3](../known-limitations.md) |
| 小屏导航折叠 | <768px 视口菜单簇折叠按钮（当前隐藏菜单簇保留字标+CTA） | [known-limitations §3](../known-limitations.md)、UI-RESTYLE 档案 |
| web font 自托管 | Inter / Cormorant Garamond 随实例分发（当前落系统兜底字体；未引外部字体服务是安全决定） | [known-limitations §3](../known-limitations.md)、UI-RESTYLE 档案 |
| 写路径 500 注册码 | candidate/audit/settle 500 body 无注册错误码（如需要须走 ADR 补注册） | [S4-T7 note](../../.agents/notes/2026-10-13-S4-T7-conflict.md) |

## 4. 运维决策候选

| 项 | 内容 | 来源 |
|---|---|---|
| K5 一次性令牌迁移期保活 | pepper 轮换后未消费的邀请/重置/bootstrap 令牌立即失效（active-only）；迁移期保活与否属运维任务决策 | [S2-T8 note](../../.agents/notes/2026-10-13-S2-T8-pages.md) |

## 5. 边界声明（不入本清单的在途/已完成项）

- **Q9 三要素数值**（可用性/备份频率/RPO/RTO）：属 S9-T3/T4 试用链（E1 内在途），不是候选 epic。
- **DOD-14 企业试用缺口**：E1 内在途义务，按 epic 规则如实记录，不外移。
- **768MB 内存地板的 selection §5 / roadmap Q2 修订**：已由 ADR D14 执行（2026-10-14），非候选。
  known-limitations §3「部署地板修订挂账」行未同步该事实（T6 撰写时 D14 已在 sprint/S9 落契），
  现已过时——提请 S9-T8/master 复核该行（v0.1 发布说明兼容矩阵与 deploy/README 均已按 768MB 陈述）。
- 单实例/HA、多实例、Windows CLI、SSH、Git LFS 等**第一版明确排除项**：roadmap 后续演进主题已
  覆盖（§1），不重复登记。

## E2 收口追记（2026-10-14）

| 候选 | 说明 | 来源 |
|---|---|---|
| 升级后索引重建提示 | 迁移 0010 后存量库需一次 search-index rebuild 回填 body——upgrade-drill 补一行提示 | S11 acceptance Obstacles |
| edit 域共享块抽取候选 | composeDoc/renderReport/自动保存（域内单源，迁移即行为面外溢——须单列任务） | S12 D 批裁决 (c) |
| 两族错误信封统一 | ngt.api/ngt.apiEnvelope 双语义保留为行为零变化所依；统一须单列任务 | S12 D 批裁决 (b) |
| restorePage viewer 接线 | T2 批准面外的收口候选（已由 T3 同形态覆盖大部分状态页） | S12-T2 A3-3 |
