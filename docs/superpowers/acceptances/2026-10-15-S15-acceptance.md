# Acceptance record — sprint S15, 2026-10-15

验收人：master 会话。环境：sprint/S15 @ e61f90f（T1 1953a18 ∥ T2 c6f54f7 先后合并 + master 契约 D 批 e61f90f）；demo 127.0.0.1:3210 同码（/tmp/notegit-demo 既有种子）。前置：S14 merged 同日；S15 两任务并行交付（写面零重叠——search 域 vs 工作台域）。

## Verdict

**pass** — S1–S6 全绿；四 gates 全绿（82/82、7/7、14/14、1032+106+369）；DOD-E4-05/06/08 达标，09/10 S15 份额达标——**E4 全部 10 条 DoD 结清、epic 关闭**。T1/T2 共四处 worker 披露全部追认；契约 D 批三笔（/search 行 C3 两稿并入落契、GET / 工作台行补记 S14 欠账、布局壳段更新）。

## Scenario Results

| id | command | expected | actual | pass |
|---|---|---|---|---|
| S1 | 筛选鉴权（bob） | 无权库零出现 | 下拉无 product-notes、有 team-handbook；直传无权 vs 不存在**逐字节同体**、slug 零回显（D-IC-06）；测试另锁撤权实时性 | yes |
| S2 | 组合检索 | 既有语义子集收窄 | alice `q=roadmap`：全部=1 / product-notes=1 / team-handbook=0；截断注记与 select 控件在位 | yes |
| S3 | ⌘K | 页内增强接线 | metaKey/ctrlKey+focus 在唯一内联 script；无 JS GET 表单路径在位（测试锁） | yes |
| S4 | 索引状态三态 | 如实零示意值 | demo 实景=健康态「索引已更新 · 29 分钟前」（真实 search_index_state 数据）；失败/无行态由 14 例测试 fixture 锁定（master 复核绿） | yes |
| S5 | 视图开关与声明 | 两态+声明 | view=grid 渲染 vault-grid 卡网格；默认 list；view=list 回链；可见性声明在位（草稿仅创建者可见+成员权限） | yes |
| S6 | 回归 | 零弱化 | 未认证 302；无权 vs 不存在 404 同页；§2.2 语义与 e2e-final-regression 在全量内绿 | yes |

## Gates

contracts 82/82 · spike 7/7 · storage 14/14 · product `npm ci && npm test` 1032/106/369（server 1007→1032 = T1 +11、T2 +14，先红后绿实证）。

## DoD Checklist（S15 份额 = E4 收尾）

- [x] **DOD-E4-05 检索筛选** — T1（下拉与命中同判定面、直传同形态零泄露、⌘K 渐进增强；契约 §13 行落契）
- [x] **DOD-E4-06 索引新鲜度** — T2（三态如实、真实数据源 search_index_state、零示意值）
- [x] **DOD-E4-08 视图开关与可见性声明** — T2（零 JS querystring 开关+声明固定位）
- [x] **DOD-E4-09 质量与安全回归（epic 级结清）** — S14+S15 两轮四 gates + §2.2 实景抽查全绿
- [x] **DOD-E4-10 DESIGN.md 一致性（epic 级结清）** — 两轮视觉抽检（新区块零内联 hex、coral 纪律、警示态语义 token）
- **E4 汇总：DOD-E4-01~10 全部达标**（01–04/07=S14、05/06/08=S15、09/10=S14+S15 两轮）

## Obstacles (verbatim)

- 2026-10-15 — S14 契约欠账在本 sprint 补记：S14 工作台首页未走 api.md §13 建议稿渠道（S14 任务书未要求——master 疏漏），本验收 D 批由 master 起草 GET / 行补上（内容=已交付事实，非新承诺）。
- 2026-10-15 — T1 披露两处追认：测试夹具中 alice 本就是 product-notes 管理员（其下拉含该库为如实呈现，无权排除断言由 bob 视角承担）；UI 验证在 HTML 结构层（项目无浏览器面——与既有形态测试同规）。
- 2026-10-15 — T2 披露两处追认：S14 占位注释以「S15-T2 已接线」文本演进（前缀保留使既有断言零改动）；测试夹具为 carol 显式补 bravo 成员行（addVault fixture 不写成员行，生产建库者自动入库——夹具现实性说明）。
- 2026-10-15 — styles.css 双任务先后合并无冲突（T1 仅补一条 flex 尺寸规则——写面隔离裁决 D2 有效）。

## Doc-Drift Audit

| map row | matched | doc state | detail |
|---|---|---|---|
| 产品要求 → architecture.md + epic ADR | 匹配（呈现层与检索筛选页参数；D24–D30 在册） | current | 契约 D 批三笔随本验收落契 |
| roadmap 范围/依赖/验收 → epic 修订 | 匹配（S15 merged + E4 关闭记账） | master 收尾 | 随本验收执行 |
