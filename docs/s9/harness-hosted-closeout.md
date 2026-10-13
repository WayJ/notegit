# S9-T5 托管 Harness 环境验证收口（DOD-10）

- 记录日期：2026-10-14
- 记录人：S9-T5 worker（Orca dispatch `ctx_668fbe5dbd2e`，task `task_ecff7776b3ef`）
- 运行分支：`WayJ/s9-t5-harness`，rebase 到 `local/sprint/S9`（HEAD `8b175cd`，含 T6 @ `7cb6ae2`）
- 任务定义：[implementation-breakdown §2.8 S9-T5 行](../s1/implementation-breakdown.md)；布局规范：[hosted-runbook.md](../harness/hosted-runbook.md)（S7-T7）
- 性质声明：本文是**环境验证收口记录**，供 master 复核与 S9-T8 终核引用；不勾选任何 DoD 条目。

## 0. 结论、环境与复跑方式

**结论：按托管运行手册起两员工隔离布局（同一 OS 账号最苛刻形态）对真实实例各自完成 login→ls→sync 读取闭环与共享库修改协作；目录/凭据/状态四层隔离复查全绿（H0–H8 九步）。** 完整逐步输出与本地闭环同档留档：[.agents/notes/2026-10-14-S9-T5-harness-closeout.txt](../../.agents/notes/2026-10-14-S9-T5-harness-closeout.txt)（L/H 两面同一次运行）。

| 项 | 值 |
|---|---|
| 实例形态 | 真实服务实例（server/ 现码 `startApp`）；**真实授权面**——可见库即成员关系，非 mock |
| 布局 | runbook §1：`employees/`（0755 共享父目录）下 `alice/`、`bob/` 各含 `credentials` + `knowbase/`；**同一 OS 账号**（`HOME` 与 git 全局配置共享），仅会话环境三变量隔离（`NOTEGIT_LOCAL_ROOT` / `NOTEGIT_CREDENTIALS_FILE` / `NOTEGIT_TOKEN`） |
| 世界 | 两员工两成员集：`alice-notes`（仅 alice）、`bob-notes`（仅 bob）、`team-docs`（两人皆 editor，共享）；演练中 alice 另可见 L 面的 `v-handbook`（合计 3 库），常驻测试世界为纯三库形态（alice/bob 各 2 库） |
| 演练复跑 | `cd cli && npm run build && node test-support/harness-closeout-drill.ts`（H 面为同脚本第二相位） |
| 常驻守卫 | `cli/test/hosted-harness-closeout.test.ts`（5 测试，随 `npm test` 运行） |

## 1. 两员工各自读取闭环（H0–H3）

**H1 各自 login**：凭据落各自私有文件（0600），员工目录由 CLI 创建/收紧 0700：

```text
$ notegit login … --username alice → credentials 0600 @ <演练根>/hosted/employees/alice/credentials
$ notegit login … --username bob   → credentials 0600 @ <演练根>/hosted/employees/bob/credentials
```

**H2 可见库各归各**（真实 API 授权面——成员关系即可见性）：

```text
$ notegit ls（alice 会话）→ alice-notes、team-docs、v-handbook
$ notegit ls（bob 会话）→ bob-notes、team-docs
```

**H3 各自 sync**：各自根下恰克隆各自可见库（目录互不交叉；同步输出不含对方库）：

```text
$ notegit sync（alice 会话）           $ notegit sync（bob 会话）
alice-notes：已克隆（HEAD 59b79c6）…    bob-notes：已克隆（HEAD 7453da3）…
team-docs：已克隆（HEAD 74f2bc0）…      team-docs：已克隆（HEAD 74f2bc0）…
v-handbook：已克隆（HEAD aebbbfc）…
同步完成：共 3 库（成功 3、跳过 0、失败 0）  同步完成：共 2 库（成功 2、跳过 0、失败 0）
```

断言：alice 根内容恰为 `[.notegit, alice-notes, team-docs, v-handbook]`，bob 根恰为 `[.notegit, bob-notes, team-docs]`。

## 2. 共享库修改协作（H8）

隔离不阻断共享工作流：alice 在自己会话向 `team-docs` push（经她的 credential helper），bob 再 sync 快进到同一提交：

```text
$ git push origin main（alice 会话，team-docs）→ 74f2bc0..feb46e7  main -> main
$ notegit sync（bob 会话）→ team-docs 已快进 feb46e7；bob-notes 不受影响
bob 根内容：.notegit、bob-notes、team-docs（仍无 alice-notes）
```

断言：bob 副本 `team-docs/notes/alice-post.md` 内容与 alice 发布逐字一致；bob 根仍无 `alice-notes`。

## 3. 目录/凭据隔离复查（H4–H7，runbook §1 逐行）

**H4 权限位**：

```text
employees/ 0755；alice{ dir 0700, root 0700, cred 0600 }；bob{ dir 0700, root 0700, cred 0600 }
```

**H5 凭据内容**（各文件互只含各自令牌；bob login 未改写 alice 文件——演练快照比对）：

```text
alice credentials：仅含 alice 令牌（ngt_PTlF…4Q）
bob credentials：仅含 bob 令牌（ngt_1Vxb…84）
```

**H6 helper 串读面**（同一 OS 账号、同一实例：`credential get` 按会话环境各取各自令牌，不串读）：

```text
$ notegit credential get（alice 会话）→ password=ngt_PTlF…4Q
$ notegit credential get（bob 会话）→ password=ngt_1Vxb…84
```

**H7 状态面**（`sync-state.json` 随根隔离，条目恰为各自可见库）：

```text
alice .notegit/sync-state.json：alice-notes、team-docs、v-handbook
bob   .notegit/sync-state.json：bob-notes、team-docs
```

## 4. 与既有测试面的分工及边界

- mock 面三断言（helper 协议、并行双进程、预存在宽松根收紧）由 S7-T7 `cli/test/hosted-isolation.test.ts` 常驻看守，本收口不重复；本记录补的是**真实实例上的 runbook 布局复查**（真实授权 + 真实 git http-backend），并由 `hosted-harness-closeout.test.ts`（5 测试）常驻看守。
- 边界（如实）：本演练在同一 uid 下运行，跨员工「读取被拒」以权限位断言（0700/0600）背书，与 runbook §1 的威胁模型一致（其他 OS 用户不可列举/读取）；跨 uid 实机阵列不在仓内确定性复现范围。
- DOD-10 收口索引（两环境证据汇总）见 [harness-local-closeout.md §4](harness-local-closeout.md)；勾选动作归 S9-T8。
