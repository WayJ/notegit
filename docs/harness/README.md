---
task: S7-T8
依据: architecture.md §7.1–§7.2、§7.3；docs/s1/selection.md §5/§6；cli/README.md（逐命令详情）
冒烟: cli/test/harness-guide.test.ts（指引-实现一致性：结构锚点 + 对真实服务实例照做跑通）
---

# Notegit Harness 指引（本地与托管）

本文是把 Notegit 用起来的**最小启动路径**：部署者起服务、员工在电脑上接入、Agent 在实例内工作。两种形态（架构 §1.1、§7.2）：

| 形态 | 位置 | 本文覆盖 |
|---|---|---|
| 本地 Harness | 员工电脑（macOS/Linux） | 安装 → login → ls → sync → 原生 git 工作流 |
| 托管 Harness | 企业服务器 | 实例启动、管理员初始化、员工入驻、建库授权；**按员工隔离详规见 S7-T7 托管隔离手册**（并行交付，见 §托管·隔离） |

逐命令的行为细节（选项、退出码、JSON 契约、错误修正）以 [cli/README.md](../../cli/README.md) 为准，本文不重复；两文档一致性由 `cli/test/docs-consistency.test.ts` 与本文冒烟测试共同看守。

## 本地 Harness（员工电脑）

### 前置

- Node ≥ 22.13 与 git（selection §6：CLI 经 npm 分发，macOS/Linux 首发承诺；用户侧 git 必备）
- 本地根目录默认 `~/knowbase`，库副本约定 `<根>/<slug>`；`NOTEGIT_LOCAL_ROOT` 环境变量或 `notegit setup --local-root <路径>` 可覆盖/持久化

### 步骤

```bash
# 1) 安装（单 tarball 自包含——validation 已内嵌 dist；或使用发布提供的 tarball）
npm install -g notegit-<version>.tgz
notegit --version

# 2) 网页端「查看访问凭据」页创建访问令牌（ngt_ 前缀，明文仅创建时显示一次）

# 3) 登录（令牌经环境变量 NOTEGIT_TOKEN 或隐藏交互输入，不接受命令行参数；
#    成功后注册 git credential helper——后续 clone/fetch/push 免交互，token 不进 URL/日志）
NOTEGIT_TOKEN=ngt_… notegit login <服务器地址> --username <员工用户名>

# 4) 日常环境（API 面：ls/sync 走 NOTEGIT_SERVER 与 NOTEGIT_TOKEN；
#    凭据文件位置可用 NOTEGIT_CREDENTIALS_FILE 覆盖）
export NOTEGIT_SERVER=<服务器地址>
export NOTEGIT_TOKEN=ngt_…

# 5) 看库：列出有权访问的库、clone URL 与本地状态（not_cloned/cloned/behind/unknown，
#    逐库附上次同步时间与离线副本 HEAD）
notegit ls --json

# 6) 同步：新库完整克隆、干净默认分支 fetch 后快进；脏/领先/分叉/他分支跳过并逐库报告
#    （不自动 stash/reset/rebase）；断网失败明示离线副本 commit 与上次同步时间（可能过期）
notegit sync
```

### 工作流（架构 §7.1 原生六步）

同步完成后即原生 git 工作流：读 `README.md` 导航 → `rg` / `cat` 查找知识 → 修改 Markdown、`git diff` 检查、选择性 `git add` → `notegit lint` 本地校验（或 `notegit setup` 装 pre-commit hook）→ `git commit` → `git push`（默认分支成功推送即发布；非快进/越权由服务端拒绝并报告原因，本地改动保留）。

### 实例工作流记录与引用格式

在实例内工作的每次产出**记录引用**，格式 = **库/路径/commit** 三要素（对齐 S5-T6 文档引用规范——引用 = 库 + 路径 + commit，可解析到 Web 历史版本页；该规范并行交付中，冲突时以其为准并回写本节）：

```text
引用：v-handbook / docs/getting-started.md @ 4c55b7a0d1e2f3a4…
```

- 库 = vault slug；路径 = 库内相对路径；commit = 回答所依据的提交（工作副本 `git rev-parse HEAD`，或引用具体历史版本）
- 同步失败的离线场景照记，并附离线副本 commit 与上次同步时间——**不声称一定使用最新知识**（架构 §7.1）
- 引用三要素可回放核对：`git show <commit>:<路径>`（对应 Web 历史页）

## 托管 Harness（服务器侧）

### 启动测试实例

```bash
cd server
NOTEGIT_DATA_DIR=<数据目录> PORT=<端口> npm start
# 缺省：数据目录 /data（容器持久卷布局：db/ git/ keys/ config/）、监听 0.0.0.0:3000
```

- 首次启动（空库）自动生成**管理员 bootstrap token**，落盘 `<数据目录>/config/admin-bootstrap.token`（单次有效）
- 健康检查 `GET /healthz`；库 bare 仓库位于 `<数据目录>/git/<内部ID>.git`（URL 一律走 `/git/<slug>.git`，内部 ID 稳定不随改名变化）

### 管理员初始化与员工入驻

```bash
# 一次性初始化（employees 空表时可用；完成后端点永久关闭 410）
curl -X POST <服务器地址>/api/v1/auth/bootstrap -H 'content-type: application/json' \
  -d '{"bootstrap_token":"<文件内容>","username":"admin","display_name":"Instance Admin","password":"<≥12 字符>"}'

# 管理员登录拿会话 Cookie（ngt_sid），随后邀请员工（一次性口令重置令牌，明文仅此一次，经企业内渠道交付）
curl -X POST <服务器地址>/api/v1/auth/login -c cookies.txt -H 'content-type: application/json' \
  -d '{"username":"admin","password":"…"}'
curl -X POST <服务器地址>/api/v1/admin/employees -b cookies.txt -H 'content-type: application/json' \
  -d '{"username":"alice","display_name":"Alice"}'   # → {"password_reset_token":"…"}

# 员工设口令（公开端点，消费一次性令牌）
curl -X POST <服务器地址>/api/v1/auth/password-reset -H 'content-type: application/json' \
  -d '{"reset_token":"…","new_password":"<≥12 字符>"}'
```

### 建库与授权（管理员会话）

```bash
curl -X POST <服务器地址>/api/v1/vaults -b cookies.txt -H 'content-type: application/json' \
  -d '{"name":"员工手册","slug":"v-handbook"}'      # 默认分支 main；同时初始化 bare 仓库
curl -X PUT <服务器地址>/api/v1/vaults/v-handbook/members/alice -b cookies.txt \
  -H 'content-type: application/json' -d '{"role":"editor"}'   # reader | editor | admin
```

### 员工访问凭据（员工会话）

员工 `POST /api/v1/auth/login` 拿会话后，在网页「查看访问凭据」页（`POST /api/v1/credentials`，`name` + `expires_at` 必填）创建访问令牌：`ngt_` 前缀，**明文仅创建时显示一次**。该令牌即本地 Harness 步骤 2–4 的输入；Git 通道 Smart HTTP `<服务器地址>/git/<slug>.git` 以 Basic 认证（用户名任意、口令 = token）。

首批内容经原生 git 推送入库（默认分支成功推送即发布；内容经服务端 pre-receive 同一规则校验——`README.md` 免 frontmatter，知识文档须带 `title` 等 frontmatter，见 validation 契约 §2–§3）。

### 按员工隔离（架构 §7.2 为规范基线）

- 托管环境的目录与凭据**按员工/会话隔离**；不同员工的**可写工作目录不共享**
- 如未来共享对象缓存，必须独立评估缓存读取权限（当前未实现，边界声明）
- 隔离断言与操作详规见 **S7-T7 托管隔离手册**（docs/harness/ 内并行交付）；本文与手册冲突时以手册为准，并把冲突点回写记录到本节

## 负载数据点

首个并发 sync 负载数据（2–4 并发、多库世界、真实服务实例：服务端耗时/RSS/子进程峰值）记录于 [.agents/notes/2026-10-13-S7-T8-load.md](../../.agents/notes/2026-10-13-S7-T8-load.md)，复跑脚本 `cli/test-support/load-sync-datapoint.mjs`。数据交 **S8-T8** 收口（selection §7：服务端每请求 git 子进程并发上限量化链——S1-T4 基线 + 本数据点 → S8 终值）。
