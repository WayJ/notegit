# Acceptance record — sprint S11, 2026-10-14

验收人：master 会话。环境：sprint/S11 @ 当前 tip（demo 127.0.0.1:3210 同码运行 + npm ci fresh）。前置：T1∥T2∥T3 三任务并行结算（台账在 plan；T1 合并含 amendments add/add 冲突 union——A/B 编号分置）。

## Verdict

**pass** — 六场景全绿；DOD-E2-05/06/07/10 逐条达标；契约演进两笔 D 批落契（检索 §3.6 五面命中 + §13 activity/GET / 行 + storage §3.11 body 列；gates 82/82 复验）；无未偿漂移。

## Scenario Results

| id | command | expected | actual | pass |
|---|---|---|---|---|
| S1 | demo：q=roadmap（文件名）/ q=高铁二等座（正文独有词） | 均命中、matched 标注正确 | roadmap→`['path']`；高铁→`['body']`（重建回填后）；差旅→`['title','summary']` | yes |
| S2 | bob 搜 product-notes 独有词 vs alice | bob 0 命中、alice 命中 | 路线图：bob 0 / alice 1 | yes |
| S3 | 首页区块（alice/bob）+ activity 页三态 | 成员过滤 + 门槛正确 | alice 见两库（12+4）/bob 仅 team-handbook（12）；activity 200/无权 404 同体/匿名 302；条目含作者/动作/commit 链接 | yes |
| S4 | browse README 渲染 + 最后提交列 | frontmatter 不外露、HTML 渲染、作者/相对时间 | 外露 0；h/ul/li 8 元素；entry-meta「alice · 1 小时前」（title 绝对时间）；activity 链接在位；reader 同见 | yes |
| S5 | §2.2 表 + e2e + 检索鉴权回归 | 全绿 | 302/同体 404/403/409/403；e2e 21/21；search-authz+rebuild 5/5 | yes |
| S6 | 四 gates + DESIGN 抽检 | 全 0；零内联 hex | 82/82、7/7、14/14、945/106/369；inline hex/style=0 | yes |

## DoD Checklist

- [x] **DOD-E2-05 全文检索 v1** — S1/S2（文件名+正文命中、matched 五值、可见性过滤、截断语义）
- [x] **DOD-E2-06 最近变更流** — S3（首页跨库过滤 + activity 页；审计派生零新表）
- [x] **DOD-E2-07 目录浏览增强** — S4（README 安全渲染 + 最后提交列）
- [x] **DOD-E2-10 质量与安全回归** — S5/S6
- 其余 DOD-E2（08/09）未到期（S12 范围）

## Obstacles (verbatim)

- 2026-10-14 — 存量库迁移 0010 后 body 列为空串（迁移只加列不回填——派生面按需重建语义）；验收时经管理端点触发全量重建（202 返回、2 库完成）后正文命中即生效。**升级注记**：既有实例升级后需一次 `POST /api/v1/admin/search-index/rebuild`（或等效重建入口）回填 body——已属 backup §7 步骤 9 既有语义，upgrade-drill 可后续补一行提示（非阻塞，S12 顺带或留 next-epics）。
- 2026-10-14 — T1/T2 同时创建 docs/s11/api-amendments.md（add/add 冲突）：master union 合并、编号分置（T2=A 系/T1=B 系）；首版 union 脚本一次失败但 commit 已带标记落库，即时发现重写并 amend（无推送、无后果）。
- 2026-10-14 — T3 worktree 一次瞬态 fail（1/919），复跑全绿（E1 并发抖动同型先例）。

## Doc-Drift Audit

| map row | matched | doc state | detail |
|---|---|---|---|
| 产品要求/知识格式/权限 → architecture.md + epic ADR | 匹配（检索命中面扩展=能力面变化） | current | D20 入册；api.md §3.6/§13、storage §3.11 落契；gates 82/82 |
| roadmap 范围/依赖/验收 → epic 修订 | 匹配（S11 完成注记） | master 收尾 | 随本验收执行 stub 同步 |
