# Notegit v0.1.0 发布说明

发布日期：2026-10-14（S9-T7 版本冻结）。本说明是 E1 第一版的交付面文档之一（DOD-15）：
版本清单、功能清单、兼容矩阵、安装、升级步进、回退指引与已知限制。验收证据逐条见
[S9-T1 DoD 证据汇总](dod-evidence.md)；本说明只陈述已交付现状，不宣称 DoD 完成。

## 1. 版本清单（冻结基线）

| 项 | 值 | 来源 |
|---|---|---|
| notegit-server | 0.1.0（私有，随镜像分发） | `server/package.json` |
| notegit（员工 CLI，npm 主包名） | 0.1.0 | `cli/package.json`（`files: dist/ + README.md`） |
| notegit-validation | 0.1.0（私有，CLI 内嵌 + 镜像内分发） | `packages/validation/package.json` |
| monorepo 根 | 0.1.0（私有，非分发） | `package.json` |
| rulesVersion | **1.0.0-draft.2**（三端同版：pre-commit hook / pre-receive / web-submit） | [docs/contracts/rules-version.json](../contracts/rules-version.json)（唯一机器来源，Q4） |
| DB schema | **9** 条出厂迁移（顶版 v9；仅前向、启动自动执行、可重入） | `server/src/db/migrations.ts` |
| 容器镜像 | `notegit:0.1.0`（基 `node:24-alpine`） | [deploy/Dockerfile](../../deploy/Dockerfile) |
| git tag | `v0.1.0` ——**本发布未打**，命令见 [deploy/scripts/tag-release.mjs](../../deploy/scripts/tag-release.mjs)（冻结断言后给出 `git tag -a` 与推送命令；tag 与 push 属发布操作者） |

## 2. 功能清单（epic F01–F12 映射）

| # | 能力（epic 定义） | v0.1.0 交付面 |
|---|---|---|
| F01 | 独立部署包 | 单容器（Dockerfile + compose 示例 + [deploy/README](../../deploy/README.md)）；构建期断言 git-http-backend 在位 + 生产形态自检；首次初始化演练脚本（16 步断言链） |
| F02 | 员工身份与凭据 | 本地账号、邀请/一次性令牌、登录会话、员工名下可过期可撤销 Git 凭据（`ngt_` token）；操作手册 [credentials-ops](../credentials-ops.md) |
| F03 | 库与成员管理 | 私有库、稳定 ID、唯一 slug、阅读/编辑/管理员三级角色、主干写入限制（`main_admin_only`） |
| F04 | 原生 Git HTTPS 服务 | 标准 Git 客户端 clone/fetch/push（git http-backend CGI）；非快进拒绝、默认分支保护、禁 force push/删除、ref 范围规则 |
| F05 | 统一内容校验 | 暂存区 hook / 服务端 pre-receive / 网页提交三端同一规则契约（rulesVersion 1.0.0-draft.2）；结构化错误与退出码 0/1/2；防绕过清单（先写后删/合并夹带/多 ref 等）逐条有拒绝证据（S9-T2） |
| F06 | 人类知识整理入口 | 网页浏览、Markdown 编辑（frontmatter 元数据表单）、图片上传、重命名、删除、预览；[用户贡献文档](../user/contributing.md) |
| F07 | 草稿与并发保护 | 私有草稿、base commit CAS、冲突草稿保留、网页×Git 并发不静默覆盖（S9-T2 并发回归背书） |
| F08 | 历史与查找 | 提交历史、文档 diff、以新提交还原、标题/标签/摘要元数据查找（索引可重建、延迟可观测）；[历史边界](../user/history-boundary.md) |
| F09 | Agent 辅助 CLI | `notegit login / ls / setup / lint`（JSON 输出与退出码契约；hook 安装不执行库内下载脚本）；[cli/README](../../cli/README.md) |
| F10 | 安全同步与 Harness 指引 | `notegit sync`（脏/未推送/分叉/他分支/断网五态逐库报告、保留改动）+ `sync clean`；本地/托管双 Harness 指引（[docs/harness](../harness/)：README、hosted-runbook、agent-guide） |
| F11 | 审计与恢复 | 审计以真实认证主体成链（old→new commit）、Git/数据库对账 CLI、维护模式、一致备份（分置两件）、全新环境恢复、升级三相位 CLI（pre-backup/gate/post）；[backup-recovery 契约](../contracts/backup-recovery.md) |
| F12 | 企业试用与发布材料 | 本说明 + [已知限制](../known-limitations.md) + 用户/管理员/Harness 文档套件（S9-T6）+ DoD 证据汇总；**企业试用（DOD-14）尚未完成**（S9-T3/T4 进行中）——如实记录，不宣称验收完成 |

## 3. 兼容矩阵

| 面 | v0.1.0 基线 | 说明 |
|---|---|---|
| 服务端镜像 | `node:24-alpine`（建议 `--build-arg NODE_IMAGE=node:<24.x.y>-alpine` 钉补丁版） | node:sqlite 处于 RC，行为漂移靠锁定 Node 具体版本规避（roadmap 风险表） |
| 服务端运行时 | Node ≥24 <25（engines 钉死） | 运行时 type-stripping 直跑 TS，镜像内无 tsc/tsx |
| 员工 CLI | Node ≥22.13，macOS / Linux | npm 单 tarball 自包含（校验实现内嵌 dist，无需另装 notegit-validation）；Windows 不在首发承诺 |
| 校验契约 | rulesVersion 1.0.0-draft.2 | 三端引用同一版本号；draft 状态见已知限制 |
| DB schema | v9（9 条前向迁移） | 启动自动迁移；**不支持 schema 降级**（旧二进制 + 新 schema 为未测试组合，backup §9） |
| 部署规格 | Linux x86_64/arm64 Docker 单容器；内存地板 **768MB**（ADR D14 修正），推荐 1GB | [selection §5](../s1/selection.md)；并发 git 子进程上限 `git.maxConcurrentChildren` 默认 8（FIFO 排队） |
| Git 客户端 | 任意标准 Git（HTTPS smart HTTP） | 第一版仅 HTTPS（无 SSH、无 LFS、客户端不可写 tag） |

## 4. 安装

- **服务端（推荐）**：`docker build -f deploy/Dockerfile -t notegit:0.1.0 .` → 运行/compose →
  首次初始化（bootstrap 管理员）。完整步骤与 HTTPS 反代接入见
  [deploy/README.md](../../deploy/README.md)；从零到可用实例的断言化演练：
  `node deploy/scripts/init-drill.mjs`（本发布冻结态复验：两次连续全绿，见 §8 证据）。
- **员工 CLI**：`cd cli && npm pack`（或使用发布 tarball `notegit-0.1.0.tgz`）→
  `npm install -g notegit-0.1.0.tgz` → `notegit --version`（期望 `notegit 0.1.0`）。
  主线用法见 [cli/README.md](../../cli/README.md)（安装 → 登录 → ls → lint → setup → sync）。

## 5. 升级步进指引

v0.1.0 是首个版本，无旧版步进；**自 v0.1.0 起**的升级遵循
[backup-recovery §9](../contracts/backup-recovery.md) 框架与落地手册（ADR D14 U1）：

1. 读本说明兼容矩阵（跨多版本逐大版本步进，不跳级）；
2. `upgrade pre-backup`（开维护 + 升级前一致备份，**不关闸**）；
3. `upgrade gate`（D-BR-08 强制面：备份件可验证且 schema ≤ 当前镜像，否则拒绝）；
4. 换镜像 tag → 启动自动迁移（`NOTEGIT_MAINTENANCE_ON_START=1` 维持维护连续）；
5. `upgrade post`（healthz/维护断言/迁移形态）→ 维护内读面冒烟 → 恢复对账 → **显式退出维护** → 写面冒烟（一次 push + 一次网页提交 = 升级接受判据）。

真实容器演练证据（32 步全绿：§9 升级+回退全链、D-BR-08 负路径 ×2、跨版本 8→9、重启可重入）：
[upgrade-drill-1](../../.agents/notes/2026-10-14-S8-T7-upgrade-drill-1.txt)、
[upgrade-drill-2](../../.agents/notes/2026-10-14-S8-T7-upgrade-drill-2.txt)。

## 6. 回退指引

- **回退 = 恢复升级前一致备份**（backup §9）：升级全程维护模式、业务零写入，备份点即升级前状态，
  业务数据零损失（锚定备份点；备份点后的运维审计行/会话/冒烟发布随回退丢弃，属预期语义）。
- 恢复执行面：restore CLI（`--data-item`/`--keys-item` 两件分置）+ 恢复验证清单；全新环境恢复演练
  证据见 [restore-drill](../../.agents/notes/2026-10-14-S8-T5-restore-drill.txt)。
- **不支持 schema 降级**：回退后实例运行的是备份 manifest 所记 schema 行集（恢复工具断言锚定
  manifest.schema_version），不得以旧镜像直挂新 schema 库。

## 7. 已知限制

集中声明见 [docs/known-limitations.md](../known-limitations.md)：架构边界 8 条（设计决定）、
第一版明确排除清单（roadmap 范围决定）、本周期遗留 11 项（附依据）。发布时点须特别知悉：
单实例无高可用承诺；rulesVersion 仍为 draft；企业试用（DOD-14）未完成。后续需求已单列为
候选清单 [next-epics.md](next-epics.md)（epic 规则 7，不塞入 E1）。

## 8. 发布产物与验证证据（2026-10-14，冻结态实测）

| 产物/验证 | 结果 |
|---|---|
| CLI 包 `notegit-0.1.0.tgz` | npm pack exit 0：48 文件（dist/ + README + package.json），80.4 kB / 解包 241.9 kB，npm shasum `3ad12cf990b473cfd4898aad94504afa96c495be`（sha256 `f06dd425e34f4ded16c55901f962ef5775234102c5b148a7058b7f5e8bfe83b9`）；清单断言（仅 dist/、bin 0o755、无 .ts/dev 文件）= `cli/test/pack.test.ts`，随 npm test 常绿 |
| tarball 从零安装 | 临时目录 `npm install notegit-0.1.0.tgz` exit 0 → `notegit --version` = `notegit 0.1.0` exit 0（自包含，无 registry 依赖） |
| 镜像 `notegit:0.1.0` | docker build exit 0；构建期断言全过（git-http-backend 存在性 + 生产形态自检打印 `selfcheck rules-version 1.0.0-draft.2`）；运行 Node v24.21.0；留档 `.agents/notes/2026-10-14-S9-T7-release.md` |
| init-drill 从零复验（DOD-01 路径，S9 场景 S5） | 三次全绿（冻结态两次：含构建 16 步 23.6s、`--no-build` 复跑 exit 0；终态 HEAD 全构建复跑 exit 0）；留档 [.agents/notes/2026-10-14-S9-T7-init-drill.txt](../../.agents/notes/2026-10-14-S9-T7-init-drill.txt) |
| 产品测试（gates product） | `npm ci --no-audit --no-fund && npm test` exit 0：冻结态 server 871 + validation 106 + cli 358；并入 S9-T5 常驻测试后合并态 871 + 106 + 369，均 0 失败 |
| 其余三 gates | contracts 82/82、tests（route-b）7/7、storage 14/14，均 exit 0 |
