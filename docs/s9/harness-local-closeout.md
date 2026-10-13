# S9-T5 本地 Harness 环境验证收口（DOD-10）

- 记录日期：2026-10-14
- 记录人：S9-T5 worker（Orca dispatch `ctx_668fbe5dbd2e`，task `task_ecff7776b3ef`）
- 运行分支：`WayJ/s9-t5-harness`，rebase 到 `local/sprint/S9`（HEAD `8b175cd`，含 T6 @ `7cb6ae2`）
- 任务定义：[implementation-breakdown §2.8 S9-T5 行](../s1/implementation-breakdown.md)（DOD-10 收口义务）
- 性质声明：本文是**环境验证收口记录**，供 master 复核与 S9-T8 终核引用；不勾选任何 DoD 条目（epic 开工规则 3）。

## 0. 结论、环境与复跑方式

**结论：本地 Harness 在真实实例上完成「读取 + 修改」读写闭环（L1–L11 十一步全绿），双通道（Git push / 网页提交）互见会合；同步异常五态在最新合并态全量复跑通过（§3）。** 完整逐步输出留档：[.agents/notes/2026-10-14-S9-T5-harness-closeout.txt](../../.agents/notes/2026-10-14-S9-T5-harness-closeout.txt)。

| 项 | 值 |
|---|---|
| 实例形态 | **真实服务实例**：server/ 现码 `startApp`（不打桩、不 mock），`127.0.0.1` 随机端口，独立临时数据目录（db/git/keys/config 全套） |
| 员工电脑模拟 | 独立临时 `HOME` + `NOTEGIT_CREDENTIALS_FILE` + `NOTEGIT_LOCAL_ROOT`（~/knowbase 语义）+ `NOTEGIT_SERVER/TOKEN`，真实 dist 产物 CLI（`cli/dist/bin/notegit.js`） |
| 环境 | macOS（Apple Silicon）、Node v24.21.0、git 2.50.1（Apple Git-155）；rulesVersion `1.0.0-draft.2`（D14 落契后版本） |
| 演练复跑（记录即证据） | `cd cli && npm run build && node test-support/harness-closeout-drill.ts`（逐步断言，任一步失败非零退出；stdout 即验证记录，建议 tee 留档） |
| 常驻守卫（演练即测试） | `cli/test/local-harness-closeout.test.ts`（6 测试，随 `npm test` 运行——本闭环永久回归） |

## 1. 读写闭环逐步记录（L1–L11）

演练世界：实例 → 管理员 bootstrap → 邀请员工 alice → alice 网页凭据页创建访问令牌（`ngt_`，明文仅一次）→ 建库 `v-handbook`（alice=editor）→ 首批内容经真实 pre-receive 校验入库（种子 HEAD `af43da4`）。以下摘录均出自留档件（令牌一律脱敏）。

### 读面（L1–L5）

**L1 login**（令牌经环境变量，免交互；凭据落盘 0600；注册 git credential helper）：

```text
$ NOTEGIT_TOKEN=ngt_PTlF…4Q notegit login http://127.0.0.1:58468 --username alice
已登录 alice@127.0.0.1:58468（凭据 ngt_PT…ts4Q）
凭据已保存（权限 0600）：…/laptop/credentials
已注册 Git credential helper：credential.http://127.0.0.1:58468.helper
```

断言：退出 0；输出不含明文令牌（演练逐步执行泄漏扫描）。

**L2 ls --json**（同步前，`local.status=not_cloned`）：

```text
"slug": "v-handbook", "role": "editor", "default_branch": "main",
"clone_url": "http://127.0.0.1:58468/git/v-handbook.git",
"local": { "status": "not_cloned", "head": null, "last_sync": null }
```

**L3 sync**（新库完整克隆；HEAD 与服务端种子逐字一致，演练以 `git rev-parse` 比对）：

```text
$ notegit sync
v-handbook：已克隆（HEAD af43da4）→ …/laptop/knowbase/v-handbook
同步完成：共 1 库（成功 1、跳过 0、失败 0）
```

**L4 ls --json**（复看）：`local.status: not_cloned → cloned`。

**L5 引用取回**（架构 §7.1 三要素 = 库/路径/commit）：

```text
引用：v-handbook / docs/getting-started.md @ af43da4（af43da41e74c…d4f912）
$ git show af43da41e74c…:docs/getting-started.md → 与种子逐字一致（32 字节）
```

### 写面·Git 通道（L6–L7）

**L6 本地修改 → lint → commit**（改既有文档 + 新增 `notes/local-edit.md`；提交前校验与服务端同一契约）：

```text
$ git add . && git diff --cached --stat
 docs/getting-started.md | 5 +++++
 notes/local-edit.md     | 5 +++++
 2 files changed, 10 insertions(+)
$ notegit lint --staged   # exit 0
notegit lint --staged（scope=pre-commit，规则版本 1.0.0-draft.2）
docs/getting-started.md：通过（W-FM-101 可选字段缺失警告 ×3，不影响提交）
notes/local-edit.md：通过
小结：2 个文件，0 个未通过，0 个错误，6 个警告
```

**L7 push**（默认分支快进推送成功即发布；经 credential helper 免交互，令牌不进 URL/输出；服务端 tip 经 `ls-remote` 核对等于本地 HEAD）：

```text
$ git push origin main
remote: [notegit pre-receive] employee=2 v-handbook：1 个 ref 命令全部通过（rulesVersion=1.0.0-draft.2，files=2）
To http://127.0.0.1:58468/git/v-handbook.git
   af43da4..0dcfbfd  main -> main
```

### 双通道会合（L8–L11）

**L8 Web 看 Git**：alice 网页会话浏览 `notes/` 目录，页面列出 Git 通道刚发布的 `local-edit.md`（`GET /vaults/v-handbook/browse/notes/` → 200 含文件名）。

**L9 Web 通道写回**（网页提交端点，base_commit=当前 tip 的预期旧 commit 检查）：

```text
$ POST /api/v1/vaults/v-handbook/submissions {base_commit: 0dcfbfd, changes: [notes/from-web.md]} → 201
服务端 tip 0dcfbfd → aebbbfc
```

**L10 Git 看 Web**（再 sync 快进到网页提交，本地副本出现网页通道内容——**双通道闭环**）：

```text
$ notegit sync
v-handbook：已快进 0dcfbfd → aebbbfc
同步完成：共 1 库（成功 1、跳过 0、失败 0）
```

断言：`notes/from-web.md` 本地内容与网页发布逐字一致；本地 HEAD == 网页提交 tip。

**L11 新引用取回**：

```text
引用：v-handbook / notes/from-web.md @ aebbbfc（aebbbfc81704…eec40cd）→ git show 解析一致
```

## 2. 收口判定

DOD-10「本地、托管两种 Harness 完成读取与修改」的本地半边：读取（clone/浏览/引用）与修改（Git push、网页提交两通道）均以真实实例 + 真实 CLI 产物走通并留档；本闭环由 `cli/test/local-harness-closeout.test.ts` 常驻看守。托管半边见 [harness-hosted-closeout.md](harness-hosted-closeout.md)。

## 3. 同步异常五态逐库报告复验（最新合并态全量复跑）

DOD-10 五态 = **脏工作区（dirty）/ 未推送提交（ahead）/ 分叉（diverged）/ 非默认分支（other_branch）/ 断网（net_unreachable·timeout·http_error）**；产品另覆盖第六态撤权（revoked，fetch 404 同体）。行为契约：五态一律**跳过并逐库报告**（绝不自动 stash/reset/rebase，改动保留；断网为逐库失败码 + 离线副本 commit 与上次同步时间明示）。

收口口径（breakdown T5 行）：S7 已有测试面，收口 = **对最新合并态全量复跑 + 结果摘录入档**。2026-10-14 于本分支（`8b175cd`，含 T2 终回归与 T6 文档抽检的合并态）复跑产品门禁：

```text
$ npm ci --no-audit --no-fund && npm test
（三工作区全绿：server 871 / packages/validation 106 / cli 369 = 1346；exit 0）
```

五态对应套件逐一面（均在 `cli/test/`，走真实 git http-backend 链路）：

| 套件 | 覆盖 | 复跑结果（2026-10-14 本分支实测） |
|---|---|---|
| `sync.test.ts` + `sync-unit.test.ts` | 六态策略表逐类行为（新库克隆/干净快进/四类跳过/撤权/断网） | 9/9 + 22/22 |
| `sync-noclobber.test.ts` + `sync-noclobber-unit.test.ts` | 八态前后工作树指纹逐字节不变（不覆盖红线） | 3/3 + 22/22 |
| `sync-report.test.ts` + `sync-report-unit.test.ts` | 逐库报告（status/reason_code/细节）与汇总一致、退出码 iff 失败 | 5/5 + 11/11 |
| `sync-offline.test.ts` + `sync-offline-unit.test.ts` | 断网三态逐库失败码 + 离线副本 commit/上次同步时间明示 | 4/4 + 15/15 |
| `sync-state.test.ts` + `sync-state-unit.test.ts` | 状态文件（删态无损重建/并发互斥） | 3/3 + 19/19 |
| `sync-revoked.test.ts` + `sync-revoked-unit.test.ts` | 撤权 404→标记→恢复复常（第六态） | 8/8 + 6/6 |

五态套件合计 127 用例逐套件复跑全绿（`node --test test/<套件>.test.ts` 逐个实测，`cd cli && npm run build` 后）。

单套件复跑命令（本次收口实测同绿）：`cd cli && npm run build && node --test test/<套件名>.test.ts`（上表数字即此命令实测输出）。

如实声明：断网态以不可达地址/mock 断连注入模拟（真实跨网断流不可在仓内确定性复现）；五态「保留改动」由指纹逐字节断言背书，不依赖人眼比对。

## 4. DOD-10 收口索引（供 S9-T8 终核）

> 本节汇总 T5 产出的 DOD-10 证据面（两环境），并标注既有证据源；勾选动作归 T8。

| DOD-10 子项 | T5 收口证据（本 sprint 新增） | 既有证据源 |
|---|---|---|
| 本地 Harness 完成读取与修改 | 本文 §1（L1–L11 真实实例读写闭环 + 双通道会合）；演练脚本 `cli/test-support/harness-closeout-drill.ts`；留档 `.agents/notes/2026-10-14-S9-T5-harness-closeout.txt`；常驻测试 `local-harness-closeout.test.ts`（6） | S7 验收 345/345（读面/六态）；[harness/README.md](../harness/README.md) |
| 托管 Harness 完成读取与修改 | [harness-hosted-closeout.md](harness-hosted-closeout.md) §1–§2（runbook 布局两员工各自 login/ls/sync + 共享库协作）；同演练脚本 H 面 + `hosted-harness-closeout.test.ts`（5） | 同上 |
| 托管凭据和目录按员工隔离 | [harness-hosted-closeout.md](harness-hosted-closeout.md) §3（权限位/凭据内容/helper 串读/状态面复查） | S7-T7 `hosted-isolation.test.ts`（mock 面 + 并行/收紧边角） |
| 五态保留改动并逐库报告 | 本文 §3（最新合并态全量复跑全绿 + 套件对照） | S7 验收场景 S1–S5；S9-T2 终回归（21，并发面） |

- 待 T8 注意：DOD-10 全句尚含「同步遇到…时**保留改动**」——由 noclobber 指纹断言背书（§3 表行 2）；试用方真实环境（DOD-14 链）不属于 T5 可闭合范围，随 DOD-14 缺口链计。
