# Acceptance record — sprint S10, 2026-10-14

验收人：master 会话。环境：sprint/S10 @ a883f96（demo 服务器 127.0.0.1:3210 运行同码 + npm ci fresh）。前置：Wave 1（T1∥T2）+ Wave 2（T3）逐任务结算（worktree 亲测 + 合并态亲测，台账在 plan）。

## Verdict

**pass** — 六场景全绿；DOD-E2-01~04 逐条达标（证据如下）；DOD-E2-10 回归面全绿（安全不变量零弱化——TDD 回归锁定 + demo 复验 + e2e 21/21）；契约演进走 draft-first（T3 建议稿 → master D 批：A1 采纳逐字、A2 撤、A3 记录）；无未偿漂移。

## Scenario Results

| id | command | expected | actual | pass |
|---|---|---|---|---|
| S1 | demo（alice）四类页面编辑入口 + 跟链 | view/browse/history/version 任一 .md ≤1 跳到 edit | 四页均有入口；view→edit 链接跟链 200 | yes |
| S2 | demo（alice）新建闭环：edit/new → HEAD 探测 → submissions → view | 浏览器内闭环 + 防误覆盖 | 表单 200；新路径 HEAD 404；提交 a48fd2d；view 200；既有路径提示态 ×2 命中 | yes |
| S3 | demo（bob）走查 + POST 语义 | 无死按钮；POST 仍 403 | browse/upload/rename/delete/edit/new 全 0 渲染；只读徽章+11 disabled；rename/submissions POST 均 403 | yes |
| S4 | 两库历史页 href 全扫（库级+路径级） | 零 404 | 18+19+15+16=68 链接，dead=0（对比 F-4 现状全死） | yes |
| S5 | research §2.2 表逐行 + e2e-final-regression | 全绿 | 302/同体 404/无 Origin 403/恶 Origin 403/stale base 409（details 含 current_head）/垃圾 base 400；21/21（探针首测 422 系探针自身假 frontmatter——校验先于 CAS，次序正确） | yes |
| S6 | 四 gates + DESIGN 抽检 | 全 exit 0；token 语义 | 82/82、7/7、14/14、909+106+369；新增 UI 零内联 hex，token 类 22 处 | yes |

## DoD Checklist

- [x] **DOD-E2-01 编辑可达性** — S1（四页面族入口 + ≤1 跳实测）；T1 8 测试
- [x] **DOD-E2-02 站内新建** — S2（闭环 + 防误覆盖三道）；T3 11 测试；api.md §13 行已落契
- [x] **DOD-E2-03 权限感知呈现** — S3（读者零死按钮；POST 403 回归锁定）；T2 16 测试
- [x] **DOD-E2-04 历史链接健康** — S4（68 链接零 404，含 T1 顺带修复的第二处死链）
- [x] **DOD-E2-10 质量与安全回归** — S5+S6（不变量表全绿 + e2e 21/21 + 四 gates）
- 其余 DOD-E2（05~09）未到期（S11/S12 范围）

## Obstacles (verbatim)

- 2026-10-14 — 验收脚本原拟经 §6 commits API 取 base_commit，发现 §6（tree/blob/commits）整组「已契约未实现」——在册缺口（docs/s9/next-epics.md），非本 sprint 回归；改用编辑页嵌入 base_commit（S4-T7 约定）验收通过。不新增处置（既有候选项）。
- 2026-10-14 — master 一次 merge 误落 main（T2 结算时），即时 reset 回 4430556 重落 sprint 分支，main 历史无污染（推送前纠正）。

## Doc-Drift Audit

| map row | matched | doc state | detail |
|---|---|---|---|
| 产品要求/知识格式/权限/发布部署架构 → architecture.md + epic ADR | 无架构级变化（呈现层 + 既有端点消费） | current | D17 呈现层边界在册 |
| roadmap 范围/依赖/验收 → epic 修订 | 匹配（S10 完成注记） | master 收尾 | 随本验收执行 stub 状态同步 |
| api.md §13 页面行 | 匹配（edit/new 行 + D 批记录） | current | A1 落契 a883f96 前一提交；contracts gate 82/82 |
