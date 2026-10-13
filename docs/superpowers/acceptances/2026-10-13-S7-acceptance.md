# Acceptance record — sprint S7, 2026-10-13

验收人：master 会话。环境：sprint/S7 @ 616ecfc（/tmp/s7a，npm ci fresh）。

## Verdict

**pass** — 六场景全绿（cli 包 345/345 覆盖全部 sync 套件）；epic S7 完成标准全部满足；**M3（Harness 闭环）达成**（S5+S7 齐备——S5 于同日验收）；写面零越界（server/ 与 docs/contracts/ 零变更）；无未偿漂移。DOD-10 的 S7 份额已实证（六态策略/不覆盖红线/逐项报告/状态锁/撤权/断网/隔离/负载数据点）。

## Scenario Results

| id | command | expected | actual | pass |
|---|---|---|---|---|
| S1 | `cd cli && npm test`（sync+sync-unit 套件） | 六态策略表逐类行为 | 345/345 内全绿（六态 e2e 走真实 http-backend 链路） | yes |
| S2 | 同上（noclobber 套件） | 八态前后指纹逐字节不变 | 全绿（+D7 静态扫描变异验证） | yes |
| S3 | 同上（report 套件） | 逐项准确/汇总一致/退出码 iff 失败 | 全绿（混合世界 e2e） | yes |
| S4 | 同上（state 套件） | 删状态无损重建/并发互斥 | 全绿（双进程真实并发证据） | yes |
| S5 | 同上（revoked/clean 套件） | 404→标记/清理遇改动拒/恢复复常 | 全绿 | yes |
| S6 | 四 gates + `git diff main..sprint/S7 -- server/ docs/contracts/` | 全绿；零变更 | 82/82、7/7、14/14、593+106+345 exit 0；server/ 与 contracts 零变更（S7 写面=cli/+docs/harness/ 实证） | yes |

## DoD Checklist

- [ ] DOD-10 Harness 与同步 — S7 份额已实证（脏/领先/分叉/他分支/断网五态保留改动并逐库报告；托管目录凭据按员工隔离——双进程双 root 证据）；S9 统一验收
- [ ] 其余 DOD — 未到期（S5 收尾/S8/S9 范围）

## Obstacles (verbatim)

- 2026-10-13 — T5/T6/T8 三次并行合并冲突均由 master 解算（判定面/变更面/报告条目；README 样例拼接损伤由 T8 发现、master 修复）。
- 2026-10-13 — master 验证方法错误一次：直接 node --test 裸跑 cli 测试超时（依赖 build 产物）；纠正为包 npm test（S6 验收同款教训）。
- 负载数据点发现服务端 RSS 基线 232MB（vs selection 114.7MB）——非阻塞，S8-T8 容量复核的重要输入（notes 在案）。

## Doc-Drift Audit

| map row | matched | doc state | detail |
|---|---|---|---|
| 产品要求/知识格式/权限/发布部署架构 → architecture.md + epic ADR | 无匹配 | n/a | S7 全部落架构 §7 既有框架；docs/harness/ 为新增用户文档（DOD-15 面，非契约） |
| roadmap 范围/依赖/验收 → epic 修订 | 无匹配 | n/a | 范围未变 |
