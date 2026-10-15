# Acceptance record — sprint S19, 2026-10-16

验收人：master 会话。环境：sprint/S19 @ 9435f04 合并态；demo 127.0.0.1:3210 同码。前置：S19 范围重定（D29 四语义已实现验证＋真实缺口=§9 读侧）；单任务交付。

## Verdict

**pass** — S1–S4 全绿；四 gates 全绿（82/82、7/7、14/14、1091+106+369——+21 只增不减）；**DOD-E6-02 五语义闭环**（D29 验证收口）。E6 剩 S20 容量验证。

## Scenario Results

| id | command | expected | actual | pass |
|---|---|---|---|---|
| S1 | D29⑤ credential_ref 读侧可见 | 审计行区分载体 | scoped 凭据提交后审计行 `credential:5`；对照 session 行 `session:4`——**人/agent 行动可区分**（entry=web 为端点族语义，载体区分=credential_ref 职责，identity §8 一致）；四语义见 .agents/notes/2026-10-16-D29-verification.md | yes |
| S2 | §9 契约形状 | 过滤/游标/形状 | 响应逐字段（§9 不增不减，测试锁定）；keyset 游标 p1=3→p2=3 无重叠；limit 50/200 与 422 测试锁定 | yes |
| S3 | 越权 | §9 门槛 | bob：成员非管理员 403、非成员与不存在 404 同体、admin 面 403、匿名 401 | yes |
| S4 | 回归 | 只增不减 | 1091+106+369；contracts 82/82、storage 14/14、spike 7/7 | yes |

## Gates

contracts 82/82 · spike 7/7 · storage 14/14 · product 1091/106/369。

## DoD Checklist

- [x] **DOD-E6-02 凭据委托（收口）** — 五语义全绿（四项 S1/S3 期已实现＋读侧可见本 sprint 闭环）；验证记录在档
- [x] **DOD-E6-05 安全回归（份额）** — S3 + 四 gates；epic 级随 S20 复验

## Obstacles (verbatim)

- 2026-10-16 — 范围重定披露：原 S19「凭据委托落契」为 E4 立项时未核实存量的误判（作用域凭据/三入口收窄/审计写侧 credential_ref 均 S1/S3 已建）；真实缺口=§9 契约在册无实现——重定后单任务收口。
- 2026-10-16 — T1 六处契约空白处的实现解释（actor=展示名、实例管理员非成员可读、admin 未知 slug 200 空态、keyset 游标形态、limit 50/200、detail 解析对象）均合理且测试锁定——master 全部追认（契约未定死处以测试为准，后续如需收紧走契约修订）。

## Doc-Drift Audit

| map row | matched | doc state | detail |
|---|---|---|---|
| 产品要求 → architecture.md + epic ADR | 匹配（§9 落码=契约对齐，无新决策） | current | D29 验证记录在档 |
| roadmap → epic 修订 | 匹配（S19 验收记账） | master 收尾 | 随本验收执行 |
