# Acceptance record — sprint S20, 2026-10-16

验收人：master 会话。环境：scratch 实例 127.0.0.1:3211（独立 dataDir /tmp/notegit-bench；种子 bench-big 500 文档/50 提交 + 扇出 A/B/C 各 40 文档）；主仓 sprint/S20。执行形态：**master 直接执行**（S13-T3 先例——测量/分析型）。

## Verdict

**pass** — 三场景实测完成、数字与瓶颈如实入档（docs/e6/capacity.md；脚本与原始 JSON 归档 .agents/notes/2026-10-16-S20-bench/ 可复跑）；**DOD-E6-03 达标；E6 全部 5 条 DoD 结清、epic 关闭**。

## Scenario Results

| id | scenario | expected | actual | pass |
|---|---|---|---|---|
| S1 | 并发读 | 数字+零崩 | c10/50/100：p50 2/71/129ms，p95 145ms/0.7s/1.4s；**错误全 0**；饱和 ~200–220 rps（单进程上界） | yes |
| S2 | 突发写 | CAS 行为+吞吐 | 顺序 ×30：p50=162ms（≈6 wps）零失败；并发冲突 ×8：**精确 1×201+7×409**（CAS=设计内背压）；写后索引 lag≈7.9s 如实可见 | yes |
| S3 | 跨库扇出 | agent 爬取墙钟 | 84 请求（4 全量树+80 文档）墙钟 1.01s | yes |
| S4 | 归档可复现 | 脚本+原始数据在档 | seed/run/run2 三脚本+results.json 归档 notes；复跑命令入 capacity.md | yes |

## Gates

contracts 82/82 · spike 7/7 · storage 14/14 · product 1091/106/369（S20 零产品代码变更——纯测量与文档；主仓全量复跑绿）。

## DoD Checklist

- [x] **DOD-E6-03 容量验证** — capacity.md（三场景数字/agent 底线建议/瓶颈四条如实：单进程上界、git spawn 成本、写含索引派生、304 未量化）
- [x] **DOD-E6-05 安全回归（epic 级结清）** — S18/S19/S20 三轮四 gates；侧信道三面（读/审计/工作台）同判定面锁定

## Obstacles (verbatim)

- 2026-10-16 — 基准脚本四轮自纠（探针类）：种子口令长度不足 E-AUTH-008 → bootstrap 后 token 文件已删（契约行为）→ alice 重置令牌漏 {} 体 400 → 种子脚本一行误清 cookie jar——全部为 master 测量脚手架问题，产品零缺陷（每次形态错误均被服务端如实拒绝，反证校验面工作正常）。
- 2026-10-16 — 实测中撞停 demo 服务器一次（TaskStop 误伤 :3210——bencher 为 nohup 进程）；已随收尾重启恢复。

## Doc-Drift Audit

| map row | matched | doc state | detail |
|---|---|---|---|
| 产品要求 → architecture.md + epic ADR | 匹配（容量约束 §3.6/§9 不变——capacity.md 只给实测底线不给生产承诺） | current | E6 终态入册 |
| roadmap → epic 修订 | 匹配（S20 + E6 关闭记账） | master 收尾 | 随本验收执行 |
