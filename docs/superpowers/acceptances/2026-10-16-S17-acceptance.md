# Acceptance record — sprint S17, 2026-10-16

验收人：master 会话。环境：sprint/S17 @ e610f1d 合并态；demo 127.0.0.1:3210 同码。前置：用户对 v2 换轨后整体样式 review，要求逐项对比静态原型——master 九处差距审计 → S17 立项（E5 关闭后追加修订）→ 单任务交付。

## Verdict

**pass** — S1–S4 全绿；四 gates 全绿（82/82、7/7、14/14、1043+106+369——+10 只增不减）；九处差距 8 落地 1 披露（面包屑按 D2 跳过）。一处 worker 偏离追认：维护者头像原型 hex（#eef1f5/#636c78）与「样式全走 v2 token」冲突——worker 映射最近 token（--inset/--ink2）并披露，**追认**（DESIGN v2 §6 纪律优先于 spec 字面 hex；如需逐值还原须先修 DESIGN.md）。

## Scenario Results

| id | command | expected | actual | pass |
|---|---|---|---|---|
| S1 | 九处逐项（master 实景复核，修正探针类名猜测后） | 8 落地 1 披露 | 顶栏分隔线+工作区名 ✓；侧栏用户卡（side-foot：首字圆章/姓名/身份行）✓；页头分排（page-head-split：h1+副标+右置 head-meta 索引位，绿点=index-status::before）✓；首页搜索工具条（GET /search 表单+⌘K）✓；统计卡图标片三变奏 ✓；区块头动作链接 ✓；文档表 MD 片（doc-file-chip）+头像圆章（doc-author-avatar+如实 title）+状态点（status-dot+已发布）✓；表尾查看全部文档 ✓；面包屑披露 ✓ | yes |
| S2 | 工具条鉴权 | 无权库不入选项 | bob 工具条 select 无 product-notes、有 team-handbook（选项面=vaultCards 同源） | yes |
| S3 | 行为与基线 | 零变化 | 1043+106+369（+10 断言）；22 路由 × 3 角色基线零缺失；每页恰一内联 script 保持 | yes |
| S4 | DESIGN v2 纪律 | 零内联 hex/单 accent | 新样式段内联 hex 0；图标片色仅图标底 | yes |

## Gates

contracts 82/82 · spike 7/7 · storage 14/14 · product 1043/106/369（合并态全量实跑）。

## DoD Checklist

- [x] **DOD-S17-01 九处对齐** — 8 落地 1 披露；数字全来自查询面零示意值
- [x] **DOD-S17-02 行为零变化** — 计数只增不减；基线零漂移
- [x] **DOD-S17-03 回归** — 四 gates + DESIGN 纪律抽检

## Obstacles (verbatim)

- 2026-10-16 — master 验收探针三处类名猜测与实现不符（sidebar-foot/head-meta/file-icon）初判 ✗——实查标记全部在位（side-foot/page-head-split/doc-file-chip），为探针问题非交付缺陷；绿点经 CSS 复核（index-status::before 6px 圆点）。
- 2026-10-16 — worker 偏离披露追认：头像 hex→token 映射（DESIGN v2 §6「不引入表外表面色」优先于 spec 中抄录的原型字面值——纪律正确的选择）。

## Doc-Drift Audit

| map row | matched | doc state | detail |
|---|---|---|---|
| 产品要求/UI 契约 → DESIGN.md | 匹配（头像映射遵守 §6；无需修订 DESIGN.md） | current | v2 在册 |
| roadmap → epic 修订 | 匹配（S17 验收记账） | master 收尾 | 随本验收执行 |
