# Agent 使用指南（凭据 → login → ls → sync → 引用）

> S9-T6 交付，补充 [Harness 主指引](README.md)（S7-T8，面向部署者与员工电脑接入）与 [托管隔离手册](hosted-runbook.md)（S7-T7）。本文面向**在 Notegit 实例上工作的 Agent**（本地员工电脑或企业托管 Harness 两种形态）：怎么拿到知识、怎么安全地改、怎么引用产出。
>
> 逐命令的行为细节（选项、退出码、JSON 契约、错误修正）以 [cli/README.md](../../cli/README.md) 为准，本文不重复；与主指引冲突时以主指引为准。

## 你以员工身份工作

Notegit 没有独立的 Agent 权限体系：你的每次操作都以**雇主的员工身份**进行，权限与该员工完全一致（凭据只能更窄，不能更大），审计也记在该员工名下。由此两条纪律：

- 凭据按设备/任务分离发放、按最小范围收窄（见下）；
- 不要依赖 commit author 字段表明身份——服务端审计只认认证主体。

## 五步上手

### 1) 拿到访问凭据（ngt_ 令牌）

由雇主员工在网页「我的凭据」页（`/credentials`）创建：`name` 标明用途（如 `agent-laptop`）、`expires_at` 设短（≤90 天），可选 `scope` 收窄为只读或限定库。**明文 `ngt_…` 仅创建时显示一次**——当面/安全渠道交付，凭据不进仓库、不进 remote URL、不进日志。

### 2) 登录

```sh
# 令牌经环境变量或隐藏交互输入（不接受 --token 参数——防进程列表泄漏）
NOTEGIT_TOKEN=ngt_… notegit login <服务器地址> --username <员工用户名>
# 成功后：凭据落盘 0600；注册 git credential helper——此后 clone/fetch/push 免交互
```

### 3) 发现有权库

```sh
NOTEGIT_SERVER=<服务器地址> NOTEGIT_TOKEN=ngt_… notegit ls
# 列出当前员工有权访问的库、clone URL、本地状态（not_cloned/cloned/behind/unknown）
```

### 4) 同步到本地

```sh
notegit sync
# 新库完整克隆；干净且在默认分支的副本 fetch 后快进；
# 脏/领先/分叉/他分支/撤权 → 跳过并逐库报告，绝不自动 stash/reset/rebase
```

多库世界建议先看 `notegit ls --json` 再决定动哪些库；同步异常五态的逐项语义见主指引与 cli/README。

### 5) 原生 Git 工作流

```sh
cd ~/knowbase/<slug>
# 读：README.md 导航 → rg / cat 查找知识（用知识，不要凭记忆编）
# 改：编辑 Markdown → git diff 检查 → 选择性 git add
notegit lint --staged
# 通过后提交并推送（默认分支快进推送成功即发布；被拒不硬来，报告原因）
git commit -m "…"
git push origin main
```

- 提交前校验与服务端同一规则（当前 `1.0.0-draft.2`）；`notegit setup` 可装 pre-commit hook 自动执行。
- push 被拒（非快进/越权/校验失败）时保留本地改动、向雇主如实报告原因，不要 force、不要绕。

## 引用格式：库 / 路径 @ commit

实例内每次产出**记录引用**，三要素（库/路径/commit）缺一不可：

```text
引用：v-handbook / docs/getting-started.md @ 4c55b7a0d1e2f3a4…
```

- commit 取工作副本 `git rev-parse HEAD`（或所依据的历史版本）；可回放核对：`git show <commit>:<路径>`，Web 端对应版本预览页/「引用解析」（`/cite`）。
- **同步失败/离线时照记**，并附离线副本 commit 与上次同步时间（`notegit ls` 可查）——明确「可能过期」，不声称一定用了最新知识。
- 引用含 commit，指向旧版本的引用在文档被改名/移动/删除后仍可解析（[历史边界](../user/history-boundary.md)）。

## 托管 Harness 形态的补充

在企业服务器上多员工共置时：目录与凭据**按员工隔离**（每员工独立 `NOTEGIT_LOCAL_ROOT` / `NOTEGIT_CREDENTIALS_FILE`，0700/0600 权限位由 CLI 保证），环境变量按会话注入、不落共享文件——布局规范与隔离断言见 [hosted-runbook.md](hosted-runbook.md)。跨员工共享只读对象缓存本版不提供（[已知限制](../known-limitations.md)）。

## 出问题时

| 现象 | 含义 | 动作 |
|---|---|---|
| 401（`E-AUTH-002/003/004`） | 令牌到期/撤销/账号停用 | 报告雇主，换新凭据 |
| 某库从 `ls` 消失、fetch 404 | 权限被撤（与不存在同体） | 停止使用该库；副本本地保留，清理须显式 `notegit sync clean` |
| sync 报 `net_unreachable/timeout` | 断网 | 用离线副本并在引用中标注；恢复后重新 sync |
| push 被拒 | 非快进/越权/校验失败 | 按回显错误码修正；报告，不重试轰炸 |
