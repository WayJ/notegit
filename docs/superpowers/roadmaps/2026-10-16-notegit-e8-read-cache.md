# Epic E8 — 读缓存与吞吐（Read Cache & Throughput）

立项：2026-10-16。来源：[E6 关闭候选](2026-10-16-notegit-e6-agent-foundation.md) +
[S20 容量实测](../../e6/capacity.md)瓶颈清单第 2 条——「tree/docs 每请求 spawn git
进程（正确性优先的设计：无缓存、实时树）」。E6 agent 读协议让读面变热（agent 爬取
型扇出：场景三 84 请求/1.01s；并发读 c100 p95≈1.4s、饱和 ~200–220 rps 单进程
上界），树族读的 spawn 成本是当前最可测的吞吐杠杆。本 epic 只动**读路径缓存**：
写路径语义（D25/D30 审计时钟与索引行数）、ETag/304 行为、安全面零变更。

## Rationale

- 每次 tree/docs/browse 读都 spawn git（ls-tree/status 族），CPU 与延迟随并发线性恶化
  （capacity.md 场景一梯度实测）。
- HEAD 树在两次写之间不变——跨请求缓存命中率在真实使用（连续浏览/agent 爬取）下天然高。
- E4–E7 已把工作台读面铺开（首页跨库文档表 HEAD 求交、browse 树、agent tree/docs），
  同一缓存层可全体受益。

## Decisions (ADR)

| id | decision | rationale |
|---|---|---|
| D48 | 缓存有效性=**失效钩子优先 + 短 TTL 兜底 + fail-closed**：web publish 与 git push（post-receive 族）两写路径必须触发失效；TTL 仅作兜底（秒级）；git 调用失败不缓存错误（与现行为一致地失败） | 正确性优先的仓文化——缓存错比慢更不可接受；两写路径都有既有钩子落点 |
| D49 | 验收测试策略=**对拍**：缓存路径与无缓存直读路径对同一 (库, HEAD) 输出逐字节一致；失效两路径各有「写后首读见新内容」行为测试 | 形态断言防不了时序 bug，对拍+失效测试才锁行为 |
| D50 | 收益一律**复测入档**：S20 基准脚本复跑（场景一并发读梯度 + 场景三扇出），before/after 数字追加 capacity.md——不预估、不宣称生产承诺（D3 口径延续） | 如实纪律；304 未量化一并补测 |
| D51 | 组织：T1（worker，缓存实现+对拍/失效测试）→ T2（master，基准复跑+验收）串行 | 单写面纪律（D39 先例） |

## Sprint Breakdown

| sprint | scope | state |
|---|---|---|
| S24 | T1 跨请求 HEAD 树缓存（browse/agent tree/docs/工作台 HEAD 求交共用层）+ 对拍与失效测试 · T2 S20 基准复跑对比 + 验收 | ready（2026-10-16 物化） |

## Definition of Done

- [ ] **DOD-E8-01 缓存落地且行为锁定** — 跨请求缓存生效；web publish 与 git push 两路径失效各有行为测试；对拍逐字节一致；git 错误不缓存（fail-closed）；四 gates 绿
- [ ] **DOD-E8-02 收益复测入档** — 场景一梯度 + 场景三扇出 before/after 数字追加 capacity.md（含 304 节省补测）；瓶颈清单如实更新
- [ ] **DOD-E8-03 安全面零漂移** — 四 gates + 探针组（302/401/404 同体/越权过滤）复验绿
