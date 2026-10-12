# 2026-10-13 S3-T6 — receive 审计预记录与结果核对

Orca dispatch `ctx_32292fddb747`（task_1455cce6b29f，branch `WayJ/s3-t6-audit`）。任务定义 = implementation-breakdown §2.2 S3-T6 行。基点 sprint/S3：起步 @ 61c0e9d（含 T4），任务中 T5 并入后 rebase @ ea56f56（预记录/终态逻辑与 T5 的 ref-rules/update 重构合流无冲突；audit.ts 的 entry 'git' 扩宽两边同做，取 T5 文案）。语义唯一来源（只读）：架构 §4.4、backup-recovery §4.2/§5 不变量 1–2/§7 步骤 7、storage-model §3.8/§4/§5/§6、identity §8。本文记实现裁决与移交。

## decisions

- **生命周期（storage-model §6 的逐锚点落地）**：pre-receive 在命令解析后、成员检查/内容校验/引用更新**之前**预记 pending 行（每 ref 命令一行，`BEGIN IMMEDIATE` 单事务批量）；pre-receive 自身拒绝（授权/校验）即 settle `rejected`；post-receive 按「ref 实际 OID == 行 new_commit」置 `succeeded`（old→new 成链）否则 `rejected`（update 拒绝/非快进等未到达预期值——不虚报成功）；中断（receive-pack 被杀/post-receive 未跑完）→ 行停留 pending，由 HTTP 层子进程退出清扫或启动清扫标 `unresolved`（待核对）。
- **预记早于校验（而非校验后）**：崩溃覆盖窗口最大化（校验期被杀也有 pending 残留可标待核对——S6 验收场景的注入点即此窗口），且「receive 开始预记」按字面成立。主体字段=REMOTE_USER 认证员工 + `credential:<id>` 载体 + entry=git（identity §8）；commit author 不入行（E2E 以伪造 author 断言）。
- **审计写失败 fail-closed**：预记录失败 → 整包拒绝（宁可拒推送，不产生无审计的引用更新）。post-receive 异常不影响推送结果（refs 已更新，退出码无作用）——行留 pending 由清扫接手。
- **pushId 关联键**：HTTP 层对每次 receive-pack POST 生成 `push-<uuid>` 经 CGI env（`NOTEGIT_PUSH_ID`）透传给全部 hook；审计行 detail.pushId 是终态核对与中断清扫的定域键（清扫只动本 push 的行，不误伤并发在途推送）。hook 缺此 env 时自行生成（直调/旁路形态退化）。
- **中断清扫两级**：①进程内——`git http-backend` 子进程 close 时按 pushId 清扫本 push 残留 pending → unresolved（`reason='receive-aborted'`）；②启动——`startApp` 在 migrate 后全量清扫 pending → unresolved（`reason='startup-orphan'`；单进程假设下启动时无在途写，残留皆上次进程崩溃所留）。
- **S8 恢复对账消费面（最小实现）**：`audit/reconciliation.ts` —— `AUDIT_CHAIN_SQL`（storage-model §4 `@query audit.chain` 逐字化身，防漂移测试对照契约原文）+ `auditChain(db, vaultId)`；`listPendingReconciliation(db)`（pending/unresolved 发布行清单，对账流程按「行 new_commit vs ref 实际 OID」定终态——E2E 测试演示了完整消费闭环）；`sweepOrphanedPending`。
- **与 T5 执行点拒绝的合流（T5 notes 留给集成的仲裁点，本次裁决）**：update hook 拒绝时——HTTP 形态（有 pushId）settle 该 ref 的预记行（detail 合入 `checkpoint:'update'`），**一行一命令的生命周期，不另起行**；无 pushId/无预记行（T5 直调测试形态、旁路调用）回退 T5 原独立插行。两种形态 detail.checkpoint 同源标记。T5 的 githttp-execution-point 测试全数保持绿。
- **quarantine 原子性兜底（说明 + 断言）**：receive-pack 把在途对象写入 `<repo>/objects/incoming-*` 隔离区，全部 ref 更新成功才迁移主对象库；进程被杀 ⇒ 不迁移 ⇒ 无半写对象、refs 不动。E2E 中断测试以 `git cat-file -e <推送头>` 在 bare 库失败作实证断言；`measureVaultBytes` 同理排除 `objects/incoming-*`（容量口径=推送前存量）。废弃隔离目录为惰性垃圾（git 不自动清），清理属运维任务（S8 备份/维护流程可扫），不阻塞推送。
- **E-LIMIT-004/005 计量挂接（T4 honest-gap 消费侧）**：pushBytes=HTTP 请求体字节（CONTENT_LENGTH 直取；chunked 推送经计数透传流累计，flush 时同步落盘 `notegit-push-<pushId>.bytes`，hook 侧带短重试读；计数流与终值精确性有单元测试）；vaultCurrentBytes=pre-receive 就地库目录求和（排除隔离区）。两值进校验器输入（包内 E-LIMIT-004/005 判定对默认阈值即刻生效——契约 suggested 值 50MiB/5GiB）与审计行 detail（预记与终态各留一份，终态以计数文件为准）。管理员可配阈值与逐码触发测试属 T8。

## honest-gaps（如实标注，不虚构）

- **计量文件为单请求生命周期**：post-receive/中断清扫后删除；进程硬崩可残留 `notegit-push-*.bytes`（惰性垃圾，同隔离目录；不阻塞任何路径）。
- **vaultCurrentBytes 全目录 walk**：随对象数线性（5GiB/数十万对象时秒级）；当前规模无碍，T8/S8 基准后可换 `count-objects` 或缓存。T4 的报告文件并发 last-writer-wins 语义不变——DB 审计链才是正式形态，文件只是消费输入；post-receive 读到的 rulesVersion 恒同版本，result 理论上可读到并发推送的报告（值域 {pass,fail,error}，只影响 detail 展示不影响判定）。
- **HTTP 层清扫依赖 db 注入**：buildApp 恒传（生产必经）；若有单测形态不传 db，行留待启动清扫（行为降级不丢失）。
- **E-LIMIT-004/005 触发测试未加**：T3 包内逐码测试已有，S3-T8 行明确「每个限制键各至少一触发测试」归 T8（需可配阈值注入）。
- **unresolved 行计入排空口径**（canonical SQL pending+unresolved）：即待核对行会阻止备份排空直至 S8 对账——契约原文语义，非本任务可改；管理员「显式选择继续」路径在 backup §4。

## evidence

- TDD：单元面（预记/清算/成链/清扫/计量）9 项先 RED（ERR_MODULE_NOT_FOUND）后 GREEN；E2E 面 9 项先 RED（0 行审计）后 GREEN；删除段 settle（new=全零 × actual=null）bug 由先 RED 的用例抓出并修复；T5 合流用例先 RED（独立插行）后 GREEN。
- 中断注入（S6 场景，kill receive-pack）：预记出现即按「本测试进程后代 + `git receive-pack --stateless-rpc .` 形态」定位（**命令行不含仓库路径**——http-backend chdir 后以 `.` 调用，路径 pgrep 匹配不可用；按进程树祖先定域，不误伤并行测试文件的推送）→ SIGKILL → 客户端失败、无 succeeded 行、ref 不变、对象未入主库、残留行 unresolved。
- 断言纪律（D6）：链相邻性/链尾=实际 OID/主体=认证员工/计量>0/rulesVersion=运行时 manifest——全部派生断言，无全等硬编码。
- npm test：**server 337 + validation 96 全绿**（合并态 sprint/S3@ea56f56 基线 319+96，本任务 +18；kill 注入用例三连跑稳定）；gates 四项复跑全过（contracts 82/82、route-b 7/7、storage 14/14、product npm ci+test exit 0）。
- 禁改边界核对：`git diff sprint/S3 -- docs/contracts/ docs/superpowers/ architecture.md AGENTS.md` 零变更。
