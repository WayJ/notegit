# S24 验收记录 — 读缓存（E8）

- sprint: S24 · epic: [E8 读缓存与吞吐](../roadmaps/2026-10-16-notegit-e8-read-cache.md)
- 日期：2026-10-16 · 验收人：master（WayJ）· 代码态：sprint/S24 合并态 @ 3b42f8f
- 执行形态：T1 worker（ctx_5decf18e7c4e / s24-t1-tree-cache @ bbd528e → 合并 3b42f8f
  --no-ff）+ T2 master 直做（基准复跑+探针+验收，D51）

## Evidence

- **缓存层**：`server/src/readcache/tree-cache.ts`（单源，S24 D1/E8 D48）——
  `readTreeCached` 与 execGit 同签同义；白名单 {ls-tree, rev-parse} 且无 stdin/env
  注入才入缓存，其余直通；TTL 5s 兜底（TREE_CACHE_TTL_MS）；fail-closed（git 失败
  上抛绝不缓存）；在途合并（burst 去重）＋失效竞界守卫（inflight 登记被失效清除后
  不回填）。四读面接线：api-read/tree.ts（注入 runGit 缺省值=缓存面，测试注入仍直读
  透传）、web/browse/tree.ts、web/history/version.ts、web/workbench/display.ts
  （S21 per-request Map 由共享层取代）。
- **失效两路径**（E8 D48）：① web publish——publish/pipeline.ts update-ref 成功后
  直调 invalidateVaultTreeCache（发布返回即生效）；② git push——githttp post-receive
  settle 审计行 → search/indexer.ts pollOnce 尾随（与索引派生同触发点），settle 行
  先失效再派生。失效=前缀扫 store+inflight 清该仓库全部键。
- **行为测试**：server/test/s24-tree-cache.test.ts 8 例——对拍（缓存 vs 直读逐字节
  一致 ×3 消费面）、web publish 后首读见新内容、git push 后首读见新内容、fail-closed、
  TTL 上界、仓库隔离。
- **基准复跑**（T2，E8 D50）：S20 脚本同口径（同五路径/同请求总量/同扇出形态，S24
  D4），fresh scratch :3211（dataDir /tmp/notegit-bench24，种子同 S20 形态：bench-big
  500 文档/20 提交 + a/b/c 各 40）。① 并发读：c10 p50 3ms/p95 32ms/**1148.8 rps**；
  c50 20/97/**1353.2**；c100 24/414/**1034.1**（before 218/217/199 rps，p95 145/
  701/1400ms——饱和 ~5–6 倍，零错误保持）；③ 扇出 84 请求墙钟 **1.01s→417ms**
  （p50 184→71ms）；④ 304 补测：ETag 在位，50× If-None-Match **50/50→304**，
  p95≈1ms。数字与瓶颈清单已入档 [capacity.md §5](../../e6/capacity.md)；脚本与
  原始 JSON 归档 `.agents/notes/2026-10-16-S24-bench/`。
- **探针组**（T2）：同 S21 组零漂移 + 缓存热窗专项——P1 anon / →302 /login、P2 anon
  库页 302、P3 anon API 401、P4 越权 404 与不存在 404 **逐字节同体**（D-IC-06）、
  P5 favicon 200、P6 ETag+no-cache 在位、P7 缓存热时 anon 401/无授权 404——
  **7/7 PASS**（probe-s24.mjs/json 归档同档）。

## Verdict

**pass** — 单源缓存层落地且行为锁定（对拍+两失效路径+fail-closed 8 断言）；收益
复测入档（饱和 ~200–220→~1000–1350 rps、扇出亚秒化、304 补测清偿遗留项）；四 gates
绿；探针组 7/7 零漂移。**E8 全部 3 条 DoD 结清、epic 关闭**。

## Scenario Results

| id | scenario | expected | actual | pass |
|---|---|---|---|---|
| S1 | 缓存行为 | 重复读命中缓存可观测；对拍逐字节一致 | 对拍 3 面逐字节一致（测试锁定）；可观测面 treeCacheStats（spawns/hits 计数）在案；宏观实证=c10–c100 延迟与吞吐 5–6 倍改善、零错误 | yes |
| S2 | 失效 | publish/push 后首读见新内容，两例锁定 | web publish 提交点失效（发布返回即生效）+ git push 审计尾随失效（settle 行先失效再派生），两例行为测试绿；TTL 5s 兜底与在途竞界守卫一并锁定 | yes |
| S3 | 回归 | 四 gates 只增不减；探针组零漂移；容量对比入档 | gates 验收时点实跑绿（下）；探针 7/7；capacity.md §5 before/after 入档、瓶颈清单 2/4 如实改写 | yes |

## Gates

contracts 82/82 · spike 7/7 · storage 14/14 · product 1602/1602（三套件
1127+106+369，0 失败）。基线 1594（S22）→ S24-T1 +8（s24-tree-cache 行为测试），
**只增不减**；于 sprint/S24 工作树（代码=3b42f8f 合并态）实跑。

## DoD Checklist

- [x] **DOD-E8-01 缓存落地且行为锁定** — 单源缓存层 readcache/tree-cache.ts 四读面
      共用；publish/push 两路径失效各有行为测试；对拍逐字节一致 ×3；fail-closed
      （错误上抛不缓存）；四 gates 绿
- [x] **DOD-E8-02 收益复测入档** — 场景一梯度 + 场景三扇出 before/after 追加
      capacity.md §5；304 补测 50/50→304 p95≈1ms；瓶颈清单 1/2/4 如实更新
- [x] **DOD-E8-03 安全面零漂移** — 四 gates + 探针组 7/7（302/401/404 同体/
      越权过滤 + 缓存热窗专项 P7）复验绿

## Obstacles (verbatim)

- 2026-10-16 — S20 归档种子脚本复跑全 401：session cookie 带 Secure 属性，curl 在
  http://127.0.0.1 写出空 jar（旧脚手架环境假设失效）。重写 fix-seed.mjs 全 fetch
  登录+手写 netscape jar 幂等补种——脚手架问题，产品零缺陷（每次 401 均为正确拒绝）。
  探针组同因走 fetch（probe-s24.mjs）。

## Residuals（记入后续，不阻塞验收）

- R1 — blob 正文（cat-file）与 log 族仍每请求 spawn——读路径剩余成本（capacity.md
  瓶颈清单 2 如实保留）；后续候选，未立项。
- R2 — 单 Node 进程上界仍在（无 cluster/多实例）——未立项，架构议题见 capacity.md
  瓶颈清单 1。

## Doc-Drift Audit

| map row | matched | doc state | detail |
|---|---|---|---|
| 产品要求/架构 → architecture.md | 不触发（零契约/权限/发布部署变更——读端点响应零变化，缓存为内部服务方式） | current | architecture.md 无读路径 spawn 描述需改写；epic ADR D48–D51 在册 |
| roadmap → epic 修订 | 匹配（S24 状态 + DoD 记账 + epic 关闭） | master 收尾 | 随本验收执行 |
