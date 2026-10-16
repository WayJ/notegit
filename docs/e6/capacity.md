# E6 容量验证记录（S20，2026-10-16）

环境：MacBook 本机、单 Node 进程（无 cluster）、node:sqlite WAL、scratch 实例
（独立 dataDir，种子：bench-big 500 文档/50 提交 + 扇出 A/B/C 各 40 文档；4 库；
alice editor）。基准脚本与原始 JSON 归档 `.agents/notes/2026-10-16-S20-bench/`
（可复跑：node bench-run.mjs / bench-run2.mjs——种子脚本同档）。

**结论性质**：本档只给「实测底线」不给「生产承诺」——容量约束（api.md §3.6 /
架构 §9）不变；数字是笔记本级单实例基线，供容量规划下界参考与回归对照。

## ① 并发读（五读端点混合：vaults / tree / docs / index-status / search）

| 并发 | p50 | p95 | p99 | max | 错误 | 吞吐 |
|---|---|---|---|---|---|---|
| 10 | 2ms | 145ms | 162ms | 180ms | **0** | 218 rps |
| 50 | 71ms | 701ms | 801ms | 1.5s | **0** | 217 rps |
| 100 | 129ms | 1.4s | 2.0s | 4.4s | **0** | 199 rps |

- **饱和吞吐 ~200–220 rps**（单进程 CPU 上界；tree/docs 每请求 spawn git）。
- 零错误零 5xx：过载表现为排队延迟线性抬升，不崩、不拒——符合「不承诺 SLA、
  但不失败」的单实例定位。
- **给 agent 的底线**：客户端并发 ≤10–20 时 p95 <200ms；并发 100 时 p95 秒级。

## ② 突发写（submissions 端点）

| 形态 | 结果 |
|---|---|
| CAS 链式顺序写 ×30 | p50=162ms/次（≈6 写/秒，含 git 提交+派生索引）；30 连发无失败 |
| 同 base 并发冲突写 ×8 | **201×1 ＋ 409×7**（精确——CAS 语义即背压：不排队、不丢更新、败者拿 409 重试） |
| 持续写后索引延迟 | lag_ms≈7.9s（异步派生滞后，index-status 如实可见——契约行为非缺陷） |

- **给 agent 的底线**：单分支写 ≈6 wps（顺序语义内含 CAS 链）；并发写同一分支
  必然 409——**409 后取新 head 重试**是正确的 agent 写模式（agent-guide 已载）。

## ③ 跨库扇出（agent 爬取型：vaults → tree×4 → docs×20）

84 请求（4 全量树含 500 条目大库 + 80 文档）墙钟 **1.01s**（p50=184ms）——
「列库→拉树→读文档」的典型 agent 工作流在单实例上亚秒级完成。

## 瓶颈清单（如实；2026-10-16 S24 复测更新）

1. 单 Node 进程无 cluster——CPU 饱和即上界；多实例横向扩容未验证（SQLite 单文件
   写者是约束，读副本/只读克隆属未来架构议题）。树缓存后饱和 ~200–220 → **~1000–1350 rps**
   （S24 复测，见 §5），单进程上界仍存（blob/log/检索面未缓存）。
2. ~~tree/docs 每请求 spawn git 进程~~ **已优化（S24-T1，E8）**：ls-tree/rev-parse 族经
   跨请求树缓存（失效钩子+TTL 5s 兜底+fail-closed，docs/e6→readcache）；blob 正文
   （cat-file）与 log 族仍每请求 spawn——读路径剩余成本在此。
3. 写路径 162ms 中含索引派生（同步段）＋审计＋Git 对象写；索引异步段滞后秒级（未变）。
4. ~~ETag 304 的节省未单独测量~~ **已补测（S24，§5 ④）**：缓存热窗内 If-None-Match
   50/50 → 304，p95≈1ms——带宽与 CPU 收益实证。

## §5 S24 复测（2026-10-16，S24-T1 跨请求 HEAD 树缓存后）

方法与 §①–③ 逐字同口径（S24 D4）：同五路径、同请求总量（每梯度 2000）、同
扇出形态；fresh scratch 实例（dataDir /tmp/notegit-bench24、独立种子——bench-big
500 文档/20 提交 + a/b/c 各 40，4 库）；before 数字直接引用上表不重测。脚本与
原始 JSON 归档 `.agents/notes/2026-10-16-S24-bench/`。代码态：sprint/S24 合并态
（S24-T1 树缓存，Node v24.21.0）。

**① 并发读（before → after）**

| 并发 | p50 | p95 | p99 | max | 错误 | 吞吐 |
|---|---|---|---|---|---|---|
| 10 | 2 → **3**ms | 145 → **32**ms | 162 → 64ms | 180 → 79ms | 0 → **0** | 218 → **1148.8** rps |
| 50 | 71 → **20**ms | 701 → **97**ms | 801 → 206ms | 1.5s → 457ms | 0 → **0** | 217 → **1353.2** rps |
| 100 | 129 → **24**ms | 1.4s → **414**ms | 2.0s → 977ms | 4.4s → 1.27s | 0 → **0** | 199 → **1034.1** rps |

- **饱和吞吐 ~200–220 → ~1000–1350 rps（约 5–6 倍）**；零错误保持——过载仍表现为
  排队延迟抬升，不崩不拒。
- **给 agent 的底线更新**：并发 ≤100 时 p95 <0.5s（此前并发 100 p95 秒级）；
  热窗内重复读（同 HEAD）不再付 spawn 成本。

**③ 跨库扇出**：84 请求墙钟 **1.01s → 417ms**（p50 184 → 71ms）——爬取型工作流
进一步亚秒化（blob 正文仍未缓存，此为剩余项）。

**④ 304 补测（本轮新增，清偿 §瓶颈 4）**：tree 端点首取收 ETag 后 50×
If-None-Match 复取——**50/50 → 304**，p50≈0ms / p95≈1ms（CPU+带宽节省实证；
agent 侧正确携带条件头的收益量化入档）。

## 复跑方法

```bash
# S20 基线：种子+基准（脚本归档 .agents/notes/2026-10-16-S20-bench/）
NOTEGIT_DATA_DIR=/tmp/notegit-bench PORT=3211 node server/src/main.ts &
node bench-seed2.mjs && node bench-run.mjs && node bench-run2.mjs

# S24 复测：同口径（脚本+结果归档 .agents/notes/2026-10-16-S24-bench/）
NOTEGIT_DATA_DIR=/tmp/notegit-bench24 PORT=3211 node server/src/main.ts &
node fix-seed.mjs && node bench-s24.mjs   # 登录走 fetch（Secure cookie 下 curl 不可用）
```
