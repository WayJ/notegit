# Acceptance record — sprint S16, 2026-10-15

验收人：master 会话。环境：sprint/S16 @ 2f755dd（DESIGN.md v2 先行 bb67174 → T1 cd7959e 合并 2f755dd）；demo 127.0.0.1:3210 同码。前置：用户裁决撤销 v1 样式约束；D31 先文档后代码规约履行（DESIGN.md v2 与 E5 roadmap 同批先行提交）。

## Verdict

**pass** — S1–S5 全绿；四 gates 全绿（82/82、7/7、14/14、1032+106+369——计数与 S15 基线零变化＝零行为变化的测试级证明）；**E5 全部 5 条 DoD 达标、epic 关闭**。T1 两处披露追认（⌘K 角标/MD 图标片未加 DOM 节点——CSS 承载或留待后续；阅读档位推导值——S5 抽检裁量通过）。

## Scenario Results

| id | command | expected | actual | pass |
|---|---|---|---|---|
| S1 | token 契约 | v2 逐值在位、v1 零残留 | 15 抽样 token 逐字在位；v1 残留（--primary/--surface-card/--hairline/Cormorant/#cc785c/#faf9f5/#efe9de/#181715）grep 零命中；品牌渐变与 #23272e 在位 | yes |
| S2 | 壳与首页 | v2 形态 | 品牌渐变方片+白 spike+Notegit 字标；顶栏 56/侧栏 224/浅色页脚（测试锁） | yes |
| S3 | 行为零变化 | 全量绿、仅字面值断言修订 | 1032+106+369 计数零变化；断言修订逐处注释（web-ui-style 53 行/web-shell-sidebar 14 行 diff 复核）；红→绿实证（断言先行 22/24 红） | yes |
| S4 | 基线 | 链接零缺失零漂移 | 22 路由 × 3 角色：零缺失·零状态漂移 | yes |
| S5 | DESIGN 一致性 | 单 accent/图标片纪律/无 v1 形态 | 单 --accent 纪律（侧栏/卡片零第二强调色）；图标片四色仅图标底；v1 形态（衬线/珊瑚/米色）零残留；两披露裁量通过（⌘K 角标与 MD 图标片为增益非缺陷，阅读档位推导合理） | yes |

## Gates

contracts 82/82 · spike 7/7 · storage 14/14 · product 1032/106/369（npm ci 全新安装 + 全量）。

## DoD Checklist（S16 = E5 全部）

- [x] **DOD-E5-01 token 换轨** — S1（v2 逐值＋v1 零残留）
- [x] **DOD-E5-02 壳与排版** — S2（56/224/浅页脚/Inter 全站/紧凑节奏）
- [x] **DOD-E5-03 组件族** — §5 逐行落位（统计卡图标片 CSS ::before 承载——D2 换皮不换骨的合规解法）
- [x] **DOD-E5-04 行为零变化** — S3（计数零变化＋断言修订逐处注释）
- [x] **DOD-E5-05 回归与基线** — 四 gates＋S4＋断点三档保持（767 兜底/1020/680 测试锁）
- **E5 汇总：DOD-E5-01~05 全部达标（单 sprint 单任务收口）**

## Obstacles (verbatim)

- 2026-10-15 — 视觉方向反转：用户「不好看，样式也按照你发给的静态原型页面做」撤销 E4 期「DESIGN 还是用现有样式」约束——D24「样式不采信」条款废止、D31 入册；DESIGN.md 整体重写（v1 以 git history 保存，未做迁移说明之外的删改）。
- 2026-10-15 — T1 披露两处追认：⌘K 角标小片与文档表 MD 文件图标片未加 DOM 节点（任务书 E 清单未列、D 清单按 CSS 解读——增益项非缺陷，留后续打磨）；文档阅读标题档位（21/15/13.5/12.5px）为 v2 §2 未覆盖区推导值（S5 裁量通过）。
- 2026-10-15 — marketing 站（site/）维持 v1 视觉未切换（D33）——站与产品两套 CSS，待用户裁决是否跟随。

## Doc-Drift Audit

| map row | matched | doc state | detail |
|---|---|---|---|
| 产品要求/UI 契约 → DESIGN.md 先行修订 | 匹配（D31 先文档后代码：v2 与 roadmap 同批先于代码提交） | current | DESIGN.md v2、E5 roadmap |
| roadmap 范围/依赖/验收 → epic 修订 | 匹配（S16 merged + E5 关闭记账） | master 收尾 | 随本验收执行 |
