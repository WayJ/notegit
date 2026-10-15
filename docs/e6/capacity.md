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

## 瓶颈清单（如实，未优化）

1. 单 Node 进程无 cluster——CPU 饱和即上界；多实例横向扩容未验证（SQLite 单文件
   写者是约束，读副本/只读克隆属未来架构议题）。
2. tree/docs 每请求 spawn git 进程（正确性优先的设计：无缓存、实时树）——读路径
   的主要 CPU 成本；如未来需要，候选优化=树缓存随 commit OID 失效（ETag 语义已备）。
3. 写路径 162ms 中含索引派生（同步段）＋审计＋Git 对象写；索引异步段滞后秒级。
4. ETag 304 的节省未单独测量（本轮全 200）——agent 正确携带 If-None-Match 时
   带宽收益是确定的，未量化。

## 复跑方法

```bash
# 种子+基准（脚本归档 .agents/notes/2026-10-16-S20-bench/）
NOTEGIT_DATA_DIR=/tmp/notegit-bench PORT=3211 node server/src/main.ts &
node bench-seed2.mjs && node bench-run.mjs && node bench-run2.mjs
```
