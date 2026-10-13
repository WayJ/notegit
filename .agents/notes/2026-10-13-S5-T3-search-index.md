# 2026-10-13 S5-T3 — 元数据索引建立与更新核对

Orca dispatch `ctx_be0716d26ed6`（task_dcdae4a69b4f，branch `WayJ/s5-t3-index`）。任务定义 = implementation-breakdown §2.4 S5-T3 行。基点 sprint/S5 @ d4da9d2（含 T1 完成态）；任务中 T2 并入 sprint/S5（62ce16f）——**写面零相交**（T2：web/history + docs/contracts/api.md + 两 sprint plan；本任务：server/src/search/ + 迁移 append + app.ts 接线 + server/test 新文件），合并无冲突面，未 rebase（集成归 master）。语义唯一来源（只读）：架构 §3.1/§9（派生数据、索引延迟可观测、写入完成不以索引成功为唯一依据）、sprint D5/D7、storage-model §2（派生不入权威 schema）。本文记实现裁决与移交。

## decisions

- **表结构（迁移 0009，S5-T3 独占 append）**：`search_index`（逐库逐路径一行：vault/path/commit_oid/title/tags(JSON 文本)/summary/indexed_at，PK(vault_id,path)）+ `search_index_state`（逐库一行：head_commit/triggered_by/triggered_at/indexed_at/duration_ms/lag_ms/updates/consecutive_failures/last_error/last_error_at）。**无外键**：派生行不得阻塞权威侧删库（deleteVault 的 vaults 行删除不被陈旧索引 FK 卡住）；孤儿行由启动对账清理。契约 @schema 无此表（storage-model §2 明示派生不入权威 schema）→ D11 模式：实现 + 建议稿 `docs/s1/search-index-amendments.md`（C1/C2），docs/contracts/ 零变更。
- **触发面统一 = 审计尾随（audit tail），不是发布路径通知**：push（T6 post-receive settle）与网页发布（管线 settle 步）都置 succeeded 审计行，索引器在服务器进程内尾随该行触发（默认 250ms 轮询，NOTEGIT_SEARCH_POLL_MS 可配；app 注入缝 searchIndex.pollMs 供测试）。发布组件与 hook **零改动**——D7 解耦是结构性的。被否：发布路径直接通知（接线散 + hook 子进程跨进程通知复杂 + 通知丢失需兜底——而启动对账本就是兜底）。
- **启动对账（reconcile）= 崩溃/旁路兜底 + T5 重建原语**：逐库比对 state.head_commit vs 默认分支实际头（rev-parse），漂移即重索引；同时清已删库的孤儿行。「无审计行的直接 push」与「崩溃丢触发」都收敛到这一个面。T5 全量重建可复用（逐库强制重索引同原语）。
- **水位线不越在途 pending 行（实现期发现的关键正确性点）**：发布审计是「预记 pending → settle 原位置终态」生命周期（行 id 不变）。按 id 单调推进的水位线会在发布事务中途扫到 pending 行并越过它——settle 后永不再扫（E2E 复现：publish 中途一 tick 即漏）。修正：扫描上界 = min(max(id), min(pending id) − 1)；稳态不变式 watermark < 任何 pending 行 id。崩溃启动越过 pending 的残留漂移由启动对账兜底（honest-gap）。
- **并发形态**：逐库 promise 链串行（同库合并触发、重索引总取当前头——幂等收敛）；`pollOnce` 重入防护；定时器 unref（不独自维持事件循环——未关停的测试 app 不会挂死 node --test）；`stop()` 排空在途链与启动对账；app.close() 经 onClose 关停（不留后台未决写）。
- **失败语义（D7）**：单库派生/写表失败不上抛、不阻断发布——告警日志（`[notegit search]` 前缀，含 vault 与原因）+ state 失败字段（consecutive_failures 递增、last_error/last_error_at，成功清零）；旧索引行原样保留（stale 在管理端点 up_to_date=false 可见）。state 也写不进（极端）时日志是唯一告警面（有测试）。
- **派生面（derive.ts）**：rev-parse 默认分支头 → ls-tree -r 头快照 → 逐 .md blob cat-file（与头一致的一致性快照）。frontmatter 切块消费 notegit-validation 的 `extractFrontmatter`（三入口同一解析面）；title/tags 行式保守解析（块式/流式序列、引号标量全覆盖）；摘要 = 正文首段（段内换行合并空格，截断 500 字符）。README 等 frontmatter 豁免文件 title=NULL（不用文件名伪造）；非 .md 不入索引。
- **可观测端点**：`GET /api/v1/admin/search-index`（实例管理员，只读，无审计行）：逐库 indexed_at/lag_ms/duration_ms/updates + 失败告警字段 + 实时新鲜度（up_to_date：state 头 vs 实际头）。api.md 未入册——D11 建议稿 C2。
- **app.ts 接线**：dataDir 注入时创建并 start 索引器（AppDeps.searchIndex 可调项：pollMs/derive/now/log——失败注入测试缝）；路由恒注册（无 dataDir 形态报 running:false）。main.ts 零改动。

## honest-gaps（如实标注，不虚构）

- **折叠多行标量等罕见合法 frontmatter 形态退化为 title=NULL/tags=[]**：已发布内容先过 E-FM 校验（title 必为标量、tags 必为字符串序列），块式/流式序列与引号标量已全覆盖；YAML 折叠标量（`>`/`|` 块标量）保守放弃（行仍入索引，path/commit/摘要仍在）。完整 YAML 解析需引 yaml 依赖（server 未声明）——不在本任务加依赖；如需收口走契约修订 + 依赖决策。
- **lag_ms 语义**：indexed_at − 触发审计行 occurred_at（预记时刻，非 settle 完成时刻）——「发布→已索引」口径略偏保守（多算 settle 前的窗口），不会少报。
- **崩溃启动越过 pending 行的触发可能丢失**（构造时水位线 = 当前 max(id)，在途 push 的 pending 行被越过）——该漂移由下一次启动对账收敛（不是永久丢失）；稳态无此形态。
- **rejected/unresolved 不触发**：rejected=发布未成立（正确不触发）；unresolved 若后被 S8 对账翻成 succeeded，仅重启对账收敛（不尾随）——S8 恢复对账任务的消费点，本任务不扩。
- **非默认分支推送不触发**（join 过滤 ref_name = refs/heads/<default_branch>）：索引只反映默认分支（架构 §9「基于已发布分支」）——by design。
- **大库派生耗时**：逐 blob cat-file 串行；当前容量无碍（E2E 实测毫秒级），T8/S8 负载测试后可换批量读面；duration_ms 指标可监控劣化。
- **updates 计数含对账触发**：启动对账的追平也计 updates（触发源字段可区分）——「发布次数」不是该字段的语义。

## evidence

- TDD（superpowers RED-first，全部新测试先失败后实现）：迁移 4 项先 RED（表不存在）后 GREEN；派生 6 项先 RED（ERR_MODULE_NOT_FOUND）后 GREEN；索引器 8 项先 RED 后 GREEN（期间两个真 bug 由测试抓出：①同库触发竞态下 pollOnce 返回不定态——重构为逐库 promise 链 + stop 排空；②水位线越 pending——E2E 复现修正）；路由 4 项先 RED（404/500）后 GREEN（500 由 status 查询列名遮蔽 bug——LEFT JOIN 双 vault_id 列，测试抓出后显式别名）；E2E 4 项（见下）。
- 三条完成标准断言（implementation-breakdown §2.4 S5-T3 行）：
  1. **push/网页发布后索引最终一致（轮询断言含延迟上界记录）**：search-e2e.test.ts——真实 HTTP push（T6 settle 钩子链）与真实 publishWebSubmit 各自轮询至 state.head_commit = 新头；**观测延迟留档：网页发布 78ms、push 51ms（50ms 测试轮询节奏），断言上界 5000ms**；行内容（title/tags/summary/commit_oid）与发布内容一致；全量替换保留未变路径。
  2. **索引失败不阻断发布但告警可见**：search-indexer.test.ts D7 用例（真实 publishWebSubmit 在失败派生注入下仍 published；consecutive_failures/last_error 落 state；告警日志恰一条含原因）；search-routes.test.ts 失败注入经端点可见。
  3. **延迟指标可查**：search-routes.test.ts（indexed_at/duration_ms/lag_ms/up_to_date/rows 经管理端点）；search-indexer.test.ts（lag_ms = 1500ms 确定性断言，now 注入）。
- npm test：**server 635 + validation 106 + cli 193 全绿**（基线 609+106+193，本任务 +26；worktree 亲测三连跑稳定）。gates 复跑：contracts 82/82、route-b 7/7、storage 14/14、product（=npm test）exit 0。
- 边界核对：`git diff <基点> --stat` 仅 server/src/search/（新 3 文件）、server/src/db/migrations.ts（append v9）、server/src/app.ts（+31 接线）、server/test/（新 5 文件 + migration-0008 版本清单扩至 9）、docs/s1/search-index-amendments.md（新）、本 notes；**docs/contracts/、cli/、web/、publish/、githttp/、main.ts 零变更**；与 sprint/S5 新进的 T2 面（web/history 等）零文件相交。
