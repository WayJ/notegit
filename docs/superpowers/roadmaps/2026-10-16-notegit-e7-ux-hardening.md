# Epic E7 — 界面修缮（UX Hardening）

立项：2026-10-16。来源：master 对 demo 的全页截图审计
（[docs/e7/ux-audit.md](../../e7/ux-audit.md)——桌面 13 页 + 移动 5 页 + 只读视角）。
E4–E6 交付了工作台外壳、视觉系统与 agent 地基；本 epic 清偿**结构与细节层**的
界面债：破损级 8 项、结构一致性 10 项、demo 数据卫生 1 项。安全面与配色经审计
无恙（DESIGN.md v2 契约色合规），本 epic 零安全语义变更、零新能力——只修呈现层。

## Rationale

- 工作台新壳（E4）与旧页面头（S4/S5 时代 page-meta 裸行）两代并存，观感割裂。
- 壳组件接线未收口（displayName「渐进接线」停在首页）；空态元素（警示条/token 条/
  表头）无显隐守卫，呈现为「破损相」。
- 移动端断点（E4）对表格与 stat 卡两类组件无策略，390px 下挤出屏幕。
- demo 数据含验收探针残留（S18/S19），展示面被测试垃圾污染。

## Decisions (ADR)

| id | decision | rationale |
|---|---|---|
| D39 | 修复组织：T1（壳与组件破损 A1–A8+B2/B8/B9）→ T2（结构一致性 B1/B3–B7/B10）**串行**——两任务同写 styles.css/pages.ts 簇，串行避免同文件冲突 | 单写面纪律 |
| D40 | token 明文条改为「生成后才显示」：容器默认隐藏，JS 写入 token 时展开；`​:empty` 守卫为通用兜底（.form-warn/.notice/.op-error/.error-block/.token-view） | 空态元素不得呈现色块——呈现层纪律 |
| D41 | 顶栏徽章 displayName 全量接线（10 处调用点补传；双槽同名只渲染单槽）；侧栏底部用户卡同文去重 | 身份呈现单形态 |
| D42 | 库卡角色徽章回归 DESIGN.md §5 胶囊 chip（通栏灰条为偏离契约） | 契约一致性 |
| D43 | 移动端策略：数据表统一横滚包裹（不卡片化——保持信息密度，Iteration Guide 推导）；stat 卡禁止逐字竖排（min-width + 换行语义） | DESIGN.md 断点节补记（先文档后代码，随 T1 提交） |
| D44 | 文档阅读页 h1=文档标题（无标题回落文件名）；元数据条展示 负责人/状态/标签/来源＋维护者·更新时间 | 产品捕获的元数据须在阅读面可见（随 T2，DESIGN.md 先行） |
| D45 | 首页「跨库最近文档」显示层按 path 去重（保留最新事件 + 「n 次发布」微标注）**并与 HEAD 树求交——已删除文档不再作为现存文档展示**（审计复核实证：S19 探针文件已删但 home 表仍渲染）；数据面/排序语义（D25/D30）不变 | 视觉去 bug 相，不动判定面 |
| D46 | 内部行话不进 UI 文案：契约编号（identity §3.1）、仓库路径（docs/credentials-ops.md）、验收编号（DOD-03）改为通俗表述 | 面向员工的界面不泄漏内部文档坐标 |
| D47 | 页脚登录态简化为品牌+fine print（导航功能已由侧栏承担）；侧栏增「文库」项（/vaults），browse 族 active 落位 | B-plan 导航模型收口 |

## Sprint Breakdown

| sprint | scope | state |
|---|---|---|
| S21 | T1 壳与组件破损修复 + T2 结构一致性 + master demo 清理 + 截图复验 | ready（2026-10-16 物化） |

## Definition of Done

- [ ] **DOD-E7-01 破损清零** — A1–A8 全部修复并被测试锁定；四 gates 绿
- [ ] **DOD-E7-02 结构一致性** — B1–B10 按本 epic ADR 落地；DESIGN.md 同步修订在码前
- [ ] **DOD-E7-03 demo 数据卫生** — 探针残留清除；首页最近文档表不再出现测试文件
- [ ] **DOD-E7-04 截图复验** — 审计脚本复跑全页比对，破损相归零（记录在验收）
