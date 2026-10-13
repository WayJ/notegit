# 已知限制（v0.1 · 2026-10-14）

Notegit 第一版（E1 范围）能力边界的集中声明，DOD-15 交付材料之一。三条来源逐条对齐：**架构 §12 边界**（设计决定，非缺陷）、**第一版明确排除**（roadmap 声明的范围外项）、**本周期遗留**（实现现状中尚未收口的具体项，附依据）。本文只声明现状，不承诺时间表；与架构 §12 的一致性由 `cli/test/delivery-docs-consistency.test.ts` 自动看守。

规则版本基线：`1.0.0-draft.2`（draft；[rules-version.json](contracts/rules-version.json)）。

## 1. 架构边界（架构 §12，逐条）

这些是第一版的**设计边界**，按 §12 的处理方式运行：

| 边界 | 现状说明 |
|---|---|
| 已下载内容不能收回 | 撤权只拦后续请求（网页/API/Git 一致）；终端上的克隆副本与已读走内容由企业设备管理承担。本地副本不自动删除，`notegit sync clean` 显式清理且遇未导出数据先拒绝 |
| 库内没有文档级权限 | 权限最小单位是库；需要隔离的内容拆库。`status`、`owner`、标签不构成访问控制 |
| Agent 使用员工身份 | 无独立 Agent 权限体系：操作权限与员工一致，凭据只能收窄；工具自报身份仅作线索，服务端审计记录真实认证主体 |
| 原生 Git 可跳过本地 hook | 服务端 pre-receive 始终校验（先写后删、合并提交、多 ref 推送同样拦）；格式合规不等于事实正确 |
| 本地副本可能不是最新 | `ls`/`sync` 展示版本与同步时间、断网明示「可能过期」；保留离线能力，不做强一致承诺 |
| 默认不强制审核 | 不强制所有提交走 PR；需要约束时用 `main_admin_only` 限制默认分支写入。完整审核工作流属第二阶段 |
| 复杂文档与大附件 | 第一版限制支持范围与容量（文档/附件大小、类型清单、单次 push、库容量、校验内存等限制键可配置），复杂格式按真实需求再扩展 |
| Git 和数据库状态分离 | 写入结果核对（审计 old→new 成链）、恢复对账 CLI、一致备份（维护模式 + 分置两件）覆盖；极端中断态经对账任务处置 |

## 2. 第一版明确排除（范围外，不是缺陷）

以下能力按 roadmap「第一版明确排除」声明不在 v0.1（详见 [roadmap](superpowers/roadmaps/2026-10-12-notegit-v01.md) 与架构 §1.3/§12）：

- **流程与身份**：强制所有提交走 PR / 完整审核工作流（第二阶段）；SSO 与企业目录对接；文档级权限；独立 Agent 权限体系。
- **内容与格式**：富文本编辑器；Word/PDF/TXT 等复杂格式转换；正文全文/语义搜索（查找=标题/标签/摘要元数据检索）；AI 自动补全元数据；收藏、回收站（删除恢复靠 Git 历史）。
- **Git 侧**：SSH 传输（第一版仅 HTTPS）；客户端写入 tag 及其他 ref 命名空间；Git LFS；跨库永久文档 ID（文档标识=库+路径，跨库移动历史不拼接，见[历史边界](user/history-boundary.md)）。
- **平台与规模**：通用 Git 项目平台功能（issue/CI/看板）；多实例/对象存储/高可用承诺（见「单实例假设」）；自动提交守护进程；MCP 与在线内容查询接口；Windows CLI（首发仅 macOS/Linux）。
- **网页编辑**：仅默认分支（候选修改经 Git 非默认分支）；拖拽目录排序（目录结构由 Git 路径表达）。

## 3. 本周期遗留（实现现状尚未收口）

| 项 | 现状与影响 | 依据 |
|---|---|---|
| 小屏导航折叠后置 | <768px 视口隐藏菜单簇（保留字标+CTA），折叠按钮按任务约定后置——移动端导航不完整 | [UI-RESTYLE 遗留](../.agents/notes/2026-10-13-ui-restyle.txt) |
| web font 未自托管 | Inter/Cormorant Garamond 未随实例分发，多数客户端落到系统兜底字体（Garamond/Times + 系统 sans），品牌观感不一致；未引外部字体服务是安全决定 | 同上 |
| 共享只读对象缓存后续 | 托管 Harness 跨员工共享 git 对象/浅克隆缓存本版不提供；未来引入须独立评估缓存读取权限（对象可达性是权限数据） | [hosted-runbook §5](harness/hosted-runbook.md) |
| 单实例假设 | 初版为单实例、单应用进程：无高可用承诺，进程生命周期靠容器 restart policy；多实例/水平扩展未评估 | 架构 §9/§10、[deploy/README](../deploy/README.md) |
| Q9 未定 | 可用性/备份频率/可接受恢复损失（RPO/RTO）三要素的数值目标尚未与试用方确认——当前备份频率与恢复时限无量化承诺 | [S8-T8 容量档案](../.agents/notes/2026-10-14-S8-T8-capacity.md)、roadmap Q9 |
| 规则版本未定稿 | rulesVersion 仍为 `1.0.0-draft.2`（draft），`1.0.0` 定稿升版未发生；不影响三端一致性（同一版本号全链一致） | [rules-version.json](contracts/rules-version.json) |
| 配置 HTTP 端点未挂接 | `GET/PUT /api/v1/admin/config` 契约已定稿、HTTP 挂接未实现——运行时改限制键走 `app_settings` 行（SQL）或环境变量（均热生效） | [api.md §3.4](contracts/api.md) |
| 管理员锁死恢复未实现 | 规划的主机侧命令 `notegit admin recover` 尚未实现，且无「最后管理员」保护——实例管理员全员锁死当前无自助恢复路径；**保持至少两名实例管理员** | [architecture-notes](dev/architecture-notes.md) §6.3/§6.6 |
| 搜索索引边界 | 重建期间查询降级为部分结果（鉴权过滤不降级）；frontmatter 折叠多行标量（`>`/`|` 罕见形态）在索引中退化为 title=NULL/tags=[]（行仍入索引） | [S5-T3/T5 记录](../.agents/notes/2026-10-13-S5-T3-search-index.md) |
| 指标口径边界 | `auth_failures` 为进程内计数、重启归零；校验耗时分布只覆盖 web-submit scope（pre-receive 运行于 hook 子进程） | [api.md §3.8](contracts/api.md) |
| 部署内存地板 768MB | 全功能服务进程 RSS 基线 232–240MB + 每并发 clone 子进程链 ~17MB ⇒ 内存地板 768MB、推荐 1GB；512MB 档降并发（`git.maxConcurrentChildren`=4）可勉强运行但不承诺。修订已由 ADR D14 正式落契（selection §5、roadmap Q2，2026-10-14），deploy/README 与发布说明一致——无挂账 | [deploy/README](../deploy/README.md)、[selection.md §5](s1/selection.md)、[ADR D14](superpowers/roadmaps/2026-10-12-notegit-v01.md) |

## 4. 后续范围声明

以上任何一项都**没有被静默移出**第一版承诺：排除项是 roadmap 声明的范围决定，遗留项在 [S9-T1 DoD 证据汇总](s9/dod-evidence.md) 的缺口清单中留有勾销义务。后续演进方向（企业治理/知识整理增强/接入查找增强/运维规模增强）按 epic 规则 7 另行立项，不塞入 E1。
