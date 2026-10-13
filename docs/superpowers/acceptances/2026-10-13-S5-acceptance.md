# Acceptance record — sprint S5, 2026-10-13

验收人：master 会话。环境：sprint/S5 @ fbbf60b（/tmp/s5a，npm ci fresh）。

## Verdict

**pass** — 六场景全绿；epic S5 完成标准全部满足；**M3（Harness 闭环）随 S5+S7 双达成正式完备**；写面零越界（cli/ 零变更——与 S7 并行隔离实证）；契约变更均授权渠道（§13 表行 + C1–C4 建议稿待 D13 统一落）；无未偿漂移。DOD-08 的 S5 份额已实证（历史/diff/还原/索引可重建/鉴权过滤/延迟可观测）。

## Scenario Results

| id | command | expected | actual | pass |
|---|---|---|---|---|
| S1 | `node --test server/test/web-history-consistency.test.ts` | 历史/diff 与 git 一致 | 6/6 pass（脚本比对） | yes |
| S2 | `node --test server/test/web-history-restore.test.ts` | 还原不删历史、审计成链、diff 正确 | 11/11 pass | yes |
| S3 | `node --test server/test/search-e2e.test.ts` | 发布后索引最终一致、延迟可观测 | 4/4 pass（实测 78/51ms vs 5s 上界） | yes |
| S4 | `node --test server/test/search-authz-e2e.test.ts` | 陷阱用例不泄露、撤权下一查询消失、对账一致 | 3/3 pass | yes |
| S5 | `node --test server/test/search-rebuild-e2e.test.ts` | R9 对账一致、降级不泄露 | 2/2 pass | yes |
| S6 | 四 gates + `git diff main..sprint/S5 -- cli/` | 全绿；cli 零变更 | 82/82、7/7、14/14、345/345；cli/ 零变更 | yes |

## DoD Checklist

- [ ] DOD-08 历史与查找 — S5 份额已实证（含「索引可重建并能观察延迟」全要素）；S9 统一验收
- [ ] 其余 DOD — 未到期（S8/S9 范围）

## Obstacles (verbatim)

- 2026-10-13 — D13 契约落点（C1 storage-model DDL/C2-C4 api.md 端点与页面行）作为挂起项随本验收记录在案：实现已按建议稿形状落地并全绿，契约正文由 master 在 S8 启动前统一落（含 audit-tail 选型的 ADR 形式化）。
- 无测试失败阻塞。

## Doc-Drift Audit

| map row | matched | doc state | detail |
|---|---|---|---|
| 产品要求/知识格式/权限/发布部署架构 → architecture.md + epic ADR | 匹配（索引派生模型与查询面） | current-with-pending | 实现层完整；契约正文 D13 挂起（本记录 Obstacles 节），S8 启动前清偿 |
| roadmap 范围/依赖/验收 → epic 修订 | 无匹配 | n/a | 范围未变 |
