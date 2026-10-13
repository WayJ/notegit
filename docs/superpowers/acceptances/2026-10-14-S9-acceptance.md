# Acceptance record — sprint S9, 2026-10-14

验收人：master 会话。环境：sprint/S9 @ 73e34a9（/tmp/s9a，npm ci fresh）。

## Verdict

**pass（含如实缺口分支）** — 六场景全绿；可执行的六任务（T1/T2/T5/T6/T7/T8）完成且证据齐；T3/T4（企业试用组织/执行）因外部试用方未落实按 epic 规则如实记录为缺口（场景 S4 的「如实缺口」分支）；**E1 关闭核对结论：14/15 DoD 终判达标（每勾附证据链接），DOD-14 为唯一阻塞，E1 保持 open**——不降级、不静默。发布物 v0.1.0 冻结就绪（tag/push 留 master --apply 裁决）。

## Scenario Results

| id | command | expected | actual | pass |
|---|---|---|---|---|
| S1 | docs/s9/dod-evidence.md 核对 | 15 条覆盖 | 15/15（证据/分级缺口） | yes |
| S2 | `node --test server/test/e2e-final-regression.test.ts` | 绕过/越权/并发/审计全拒 | 21/21 pass（零产品缺陷） | yes |
| S3 | docs/s9/harness-{local,hosted}-closeout.md + 127/127 摘录 | 两环境闭环+五态复验 | 在案（20 步演练留档） | yes |
| S4 | docs/s9/e1-closure-check.md §3 | 试用证据或如实缺口 | DOD-14 缺口正式记录（试用方未落实/解锁链明确）——如实分支 | yes |
| S5 | init-drill ×4（T7 档案）+ pack/image 证据 | 从零可装 | 在案（notegit-0.1.0.tgz 48 文件；镜像构建绿） | yes |
| S6 | 四 gates + 文档抽检 | 全 exit 0 | 82/82、7/7、14/14、871+106+369；delivery-docs-consistency 13/13 | yes |

## DoD Checklist

**E1 级终判（T8 产出，此处引用）**：DOD-01~13、DOD-15 共 14 条达标（证据见 docs/s9/e1-closure-check.md）；DOD-14 不达标（缺口在册）。本记录不重复勾选明细。

## Obstacles (verbatim)

- 2026-10-14 — T3/T4 外部依赖：试用团队未落实（用户决策中）。处置：缺口正式记录（e1-closure-check §3），E1 保持 open，T3/T4 待指定后可追跑——非静默降级。
- 2026-10-14 — T7 发现 known-limitations stale 行（768MB 已落 D14）→ T8 修复。

## Doc-Drift Audit

| map row | matched | doc state | detail |
|---|---|---|---|
| 产品要求/知识格式/权限/发布部署架构 → architecture.md + epic ADR | 无新增匹配（D14 已清偿前序） | current | v0.1 冻结与发布材料属交付物（DOD-15 面） |
| roadmap 范围/依赖/验收 → epic 修订 | 匹配（S9 完成/E1 open 注记） | master 收尾 | 随本验收执行 stub/epic 状态同步（下述 master 动作） |
