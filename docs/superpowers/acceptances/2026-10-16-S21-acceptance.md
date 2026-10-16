# Acceptance record — sprint S21, 2026-10-16

验收人：master 会话。环境：scratch 复验实例 127.0.0.1:3212（sprint/S21 合并态
d05c7b8 = T1 91f6c18 + T2 eea19bd；demo 数据副本 dataDir /tmp/notegit-s21check）；
主仓 sprint/S21。复验方法：审计截图脚本参数化复跑（shoot2.mjs，BASE/OUTDIR 环境变量；
桌面 1440×900 ×14 页 + 移动 390×844 ×5 页 + bob 只读视角 1 页，共 20 全页截图），
逐屏与审计基线比对；另以 curl 探针组核实安全基线。截图归档 /tmp/notegit-shots/s21/。

## Verdict

**pass** — A 类破损 8 项全部清零并被测试锁定（14 断言）；B 类结构一致性 10 项按
epic ADR D39–D47 落地（DESIGN.md 先行 c8a271e → 代码 eea19bd，另 11 断言）；
C1 更正后无需数据操作、显示面随 B7 修复闭环；**E7 全部 4 条 DoD 结清、epic 关闭**。
零安全语义变更（呈现层 only）经探针组实证零漂移。

## Scenario Results

| id | scenario | expected | actual | pass |
|---|---|---|---|---|
| S1 | admin 全站遍历 | 徽章单形态；无空态色块；favicon 200 | 顶栏徽章全站单形态「实例管理员 admin」（displayName 10 调用点接线，双槽同名单渲染）；空橙条/黑 token 条/裸表头全消失（`:empty` 守卫 + token 容器默认隐藏）；console favicon 404 清零（路由 200 image/x-icon） | yes |
| S2 | 390px 移动端 | stat 卡正常；表格横滚不溢出 | stat 卡横向换行不再逐字竖排（A6）；admin 表 .table-scroll 容器内横滚、页面零横向溢出（A5，m5-admin.png 实证） | yes |
| S3 | 一致性面 | 侧栏文库项+active；页脚无导航；文档页 h1=标题 | 侧栏「文库」项在位、browse 族 active 落位（B1）；登录态页脚仅品牌+fine print（B2）；文档页 h1=「产品路线图」+元数据条（状态/维护者/时间/大小，B4）；历史行两段式+相对时间（B6）；搜索表单网格对齐、标题可点、命中字段中文映射（B5）；最近文档 path 去重+HEAD 求交已删出局（B7，02-home.png 实证） | yes |
| S4 | 回归 | 四 gates 只增不减；安全基线零漂移 | 四 gates 验收时点实跑绿（见下）；探针组：anon / → 302 /login，anon vault → 302，anon API → 401，bob 越权 product-notes → 404 且与不存在库 404 逐字节一致（cmp IDENTICAL，D-IC-06），favicon 200，协商缓存 no-cache+ETag 在位 | yes |

## Gates

contracts 82/82 · spike 7/7 · storage 14/14 · product 1591/1591（三套件 1116+106+369，
0 失败）。基线 1091/106/369（S20）→ T1 +14（1105）→ T2 +11（1116），**只增不减**；
全部于 d05c7b8（sprint/S21 合并态）实跑。

## DoD Checklist

- [x] **DOD-E7-01 破损清零** — A1–A8 全修：displayName 接线、`:empty` 守卫、token 显隐、
      favicon、表格横滚、stat 卡、空态表头、label 精简；web-s21-polish.test.ts 14 断言锁定
- [x] **DOD-E7-02 结构一致性** — B1–B10 按 D41–D47 落地；DESIGN.md 修订随 T2 但**先文档
      节后代码**（独立提交 c8a271e 在 eea19bd 之前）；web-s21-t2-consistency.test.ts 11 断言
- [x] **DOD-E7-03 demo 数据卫生** — C1 更正（见 Obstacles）：探针文件 S19 已正式删除，
      HEAD 树无、view 404；残留感根因是 B7（历史事件照渲染），显示层修复后首页不再出现
      已删文档（复验 02-home.png）——无需数据操作
- [x] **DOD-E7-04 截图复验** — 审计脚本复跑 20 全页截图逐屏比对；A/B 破损相归零；
      截图与脚本归档在案（.agents/notes/2026-10-16-S21-audit/shoot.mjs + /tmp 归档说明）

## Obstacles (verbatim)

- 2026-10-16 — C1 处置走偏即纠：按原计划对 demo 探针文件走 delete 流程，全部 404；
  调查实证 S19 已删（view 404、HEAD 树无此三文件）——审计记录已更正（C1 划销），
  问题实质归并 B7 并将修复从「去重」扩展为「去重＋HEAD 树求交」（D45 扩展）。
  教训：审计面（历史事件表）与文件面（HEAD 树）是两个真相，呈现层合并两者前须明示语义。
- 2026-10-16 — 审计发现清单合并时遗漏一项（browse「新建笔记 (上传)」裸括号），复验时
  目检发现；未入 A/B 正式清单故未派工——记 R2 残留下轮清偿。

## Residuals（记入后续，不阻塞验收）

- R1 — admin 员工表「创建时间」仍 ISO 时间戳（B6 相对时间范围只含历史行）；同法一条 CSS/渲染即可。
- R2 — browse 页「新建笔记 (上传)」裸括号英文文案（清单合并遗漏）。

## Doc-Drift Audit

| map row | matched | doc state | detail |
|---|---|---|---|
| 产品要求/发布架构 → architecture.md | 不触发（零产品要求与架构变更——纯呈现层） | current | epic ADR D39–D47 在册 |
| UI 视觉契约 → DESIGN.md | 匹配且**先行**（c8a271e 先于代码 eea19bd）——断点策略/组件形态补记 | current | 符合 AGENTS.md「先改文档再改代码」 |
| roadmap → epic 修订 | 匹配（S21 状态 + DoD 记账） | master 收尾 | 随本验收执行 |
