# Acceptance record — sprint S14, 2026-10-15

验收人：master 会话。环境：sprint/S14 @ 3ee5453（T1 0833f06 ∥ T2 9d5c7b5 → master 微调 2e947f1 → T3 3ee5453）；demo 127.0.0.1:3210 同码（/tmp/notegit-demo 既有种子数据）。前置：用户指令「这两个 worker 做完后先暂停」→ T1/T2 交付后暂停待放行 → 用户「继续」放行后完成 T3 派工与全 sprint 验收。

## Verdict

**pass** — S1–S7 全绿；四 gates 全绿（82/82、7/7、14/14、1007+106+369）；DOD-E4-01/02/03/04/07 达标（S14 份额），DOD-E4-09/10 本 sprint 份额达标（epic 级随 S15 复验）；E4 保持 open（S15 检索筛选/索引指示/视图开关待做）。T1/T3 共四处 worker 自主披露全部追认（D30 + 台账）；T2 顶栏菜单处置因 reply 通道关闭由 master 裁决 B 方案并直接执行微调。

## Scenario Results

| id | command | expected | actual | pass |
|---|---|---|---|---|
| S1 | 三角色遍历 22 路由 + 壳形态抽查 | 三段壳/侧栏高亮/账户菜单/匿名壳无侧栏 | 侧栏在位、登录态无横向菜单、账户菜单在位；登录页匿名壳保留原菜单（6 链接不变）；测试锁 10 例 | yes |
| S2 | 基线对照（.agents/notes/2026-10-15-S14-shell-baseline.json，22 路由 × 3 角色） | 链接零缺失、状态零漂移 | **零缺失·零漂移**（含首页三入口卡退役——侧栏+聚合卡+CTA 等价承载全部链接） | yes |
| S3 | alice/bob 首页数据一致性 | 概览三卡=查询面实算 | alice：2 库/6 篇/相对时间（与 git 及审计逐项对得上）；bob：1 库视角、零写入口 | yes |
| S4 | 聚合面侧信道 | 无权库零出现 | bob 首页无 product-notes slug/名称/文档行；统计不含其文档数（与 /search 同一判定面——T1 测试另有锁定） | yes |
| S5 | 路径级文档流对账 | 表行路径=事件触及路径 | 7 行 = 4 事件（1+1+3+2）触及路径逐一对应；维护者列 title 如实标注「Git 提交者元数据，非认证身份」；时间列=服务端审计时钟（D30） | yes |
| S6 | 安全不变量实景抽查 | §2.2 交叉验证表语义 | 未认证 / → 302 /login；bob→product-notes 404 与不存在库 404 **逐字节同页**；reader POST 403；无 Origin POST 403；CAS：正确 base 201 / 旧 base 409（含 null-base-on-nonempty 409）；e2e-final-regression 在全量内绿 | yes |
| S7 | DESIGN 一致性 + 响应式 | 零内联 hex/无第四表面色/coral 纪律/两档断点 | S14 新区块（app-shell/side-nav/stat-card/doc-row/section-head/tag-chips）零 hex、全 var(--token)；侧栏+卡网格零 --primary；1020/680 断点在位、<768 兜底保留；token 区外仅 2 hex=既有 diff 视图 S5/S9 资产（非本次引入） | yes |

## Gates

contracts 82/82 · spike 7/7 · storage 14/14 · product `npm ci && npm test` 1007/106/369（server 987→1007 = T1 +10、B 方案 +1、T3 +9，先红后绿实证；tsc --noEmit 在套件内）。

## DoD Checklist（S14 份额）

- [x] **DOD-E4-01 应用壳** — T2 + master B 微调（登录态唯一桌面导航=侧栏、匿名壳保留原菜单）；S1/S2 证据
- [x] **DOD-E4-02 工作台首页** — T3（三卡/库网格含聚合卡/跨库文档表/事件流次级区块）；S2/S3 证据
- [x] **DOD-E4-03 工作台查询面** — T1（聚合面侧信道由独立测试锁定：无权库零出现、计数不计入、撤权即消失）；S4 证据
- [x] **DOD-E4-04 路径级文档流** — T1 recentDocuments（D25 排序=审计时间；作者列如实标注）+ T3 呈现；S5 证据
- [x] **DOD-E4-07 响应式** — T2 两档断点 + T3 表格列类沿用（col-secondary/col-tertiary）；S7 证据
- [x] **DOD-E4-09 质量与安全回归（S14 份额）** — 四 gates + S6；epic 级随 S15 复验
- [x] **DOD-E4-10 DESIGN.md 一致性（S14 份额）** — S7；epic 级随 S15 复验

## Obstacles (verbatim)

- 2026-10-15 — T1/T2 完成 ask 的 reply 通道均因 dispatch inactive 不可达（worker 会话随完成结束——S12-T3 先例同形）：T1 两项自主选择 master 事后追认入 D30；T2 顶栏菜单处置 master 裁决 B 方案（登录态移入侧栏、匿名壳保留顶栏菜单——基线零差异）并直接执行微调（2e947f1，含 web-ui-style.test.ts S9 结构断言分形态修订，如实标注）。
- 2026-10-15 — 用户暂停条款（「这两个 worker 做完后先暂停」）：T1/T2 交付后暂停于未合并态，用户「继续」放行后才合并与派 T3——sprint plan clauses 字段全程在册。
- 2026-10-15 — T3 两处披露 master 追认：空库时「全部文库」聚合卡仍渲染（保 /vaults 导航零缺失）；dataDir 缺省（S2 测试形态）时文档流如实空态（同 browse 空态形态）。
- 2026-10-15 — master CAS 探针首版误用 null-base 于非空库（409 为正确 CAS 语义非缺陷）并以探针提交污染 demo 一文档——补正探针（正确 base 201/旧 base 409）后经正规删除提交通道清理（201）；history 页 head 提取正则不匹配系页面标记形态变化，非产品缺陷。

## Doc-Drift Audit

| map row | matched | doc state | detail |
|---|---|---|---|
| 产品要求 → architecture.md + epic ADR | 匹配（呈现层演进；D28/D29/D30 在册——D30 修订 Asset Disposition tree.ts 行随 T1 追认落档） | current | D24–D30 在册 |
| roadmap 范围/依赖/验收 → epic 修订 | 匹配（S14 merged + DoD 01–04/07 记账） | master 收尾 | 随本验收执行 |
