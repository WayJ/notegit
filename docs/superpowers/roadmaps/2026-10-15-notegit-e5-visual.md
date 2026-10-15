# Notegit E5 视觉体系切换 Roadmap

---
epic: E5
created: 2026-10-15
basis: 用户裁决（2026-10-15）：「不好看，样式也按照你发给的静态原型页面做」——撤销 E4 期「DESIGN 还是用现有样式」约束，产品 Web 视觉整体切换到参照稿体系（功能设计 E4 已落地，DOM/类名结构保留，换视觉语言）
predecessor: [E4](2026-10-15-notegit-e4-workbench.md)（S14/S15 merged，10/10 DoD，功能与壳结构在位）
---

## 背景与定位

E4 交付了参照稿的全部**功能设计**但保留 v1 视觉（米色/珊瑚/衬线）。用户实测 demo 后
裁决：视觉也切到参照稿。DESIGN.md 已先行重写为 v2（AGENTS.md「先改文档再改代码」
规约——token 全量转录自原型，唯一权威在 DESIGN.md v2，原型文件不入仓）。

本 epic 是**纯呈现层切换**：DOM 结构与类名体系（E4 资产）保留，styles.css token 与
组件样式整体换轨，模板仅动字号/字族/图标片等呈现细节；零行为变化、零路由变化、
零安全语义变化。

## Deliverables

| id | deliverable |
|---|---|
| V01 | DESIGN.md v2（先行——已完成随本 roadmap 同批提交） |
| V02 | styles.css token 换轨 + 壳（顶栏/侧栏/页脚）与基础排版落 v2 |
| V03 | 组件族落 v2：按钮/输入/统计卡/库卡/文档表/chips/状态点/登录卡/diff 深色面中性化 |
| V04 | 测试同步：web-ui-style token 断言换 v2 契约；既有结构/行为断言保持绿 |

## Definition of Done

- [ ] **DOD-E5-01 token 换轨**：styles.css `:root` 全量 v2 token（DESIGN.md §1 逐值）；
  v1 token（--primary/--surface-card/--hairline 族/Cormorant 等）零残留。
- [ ] **DOD-E5-02 壳与排版**：顶栏 56px/侧栏 224px/浅色页脚/Inter 全站/h1 21px 等按
  DESIGN.md §2/§4 落位；登录页 canvas 底白卡。
- [ ] **DOD-E5-03 组件族**：§5 组件表逐行落位（主按钮胶囊 accent、统计卡图标片、
  库卡四色图标片、表头 inset、chips、状态点、diff 深色面中性化）。
- [ ] **DOD-E5-04 行为零变化**：全部既有测试绿（结构/行为/安全断言零豁免——只许改
  锁定 v1 token 字面值的断言为 v2 值，且该类改动逐处注释「DESIGN v2 修订」）。
- [ ] **DOD-E5-05 回归与基线**：四 gates 全绿；22 路由 × 3 角色链接基线零缺失零漂移；
  断点 1020/680/767 行为保持。

## Sprint Breakdown

| sprint | state | note |
|---|---|---|
| S16 | planned | 单 sprint 收口：styles.css 单文件写面——单任务串行（并行必冲突） |

## Decisions (ADR)

| id | decision | rationale | date / evidence |
|---|---|---|---|
| D31 | DESIGN.md 重写为 v2（原型体系整体取代 v1；v1 全文以 git history 保存）；AGENTS.md「DESIGN.md 唯一视觉契约」条款不变——变的是契约内容 | 用户裁决 2026-10-15；AGENTS.md 修订与契约同权条款（先文档后代码） | 2026-10-15；用户裁决、DESIGN.md v2 头注 |
| D32 | 品牌身份适配：保留 Notegit 字标与 spike-mark 字形，容器换原型 brand-mark 形态（26px 渐变方片）——不采信原型的「蓝/小蓝 CoWork」品牌字样 | 采信视觉语言不等于采信他牌身份；品牌字样属非视觉的标识内容 | 2026-10-15；DESIGN.md v2 §1 品牌标记 |
| D33 | marketing 站（site/，gh-pages）本 epic 不切换，维持 v1 视觉；是否跟随切换由用户另行裁决（站与产品是两套 CSS，互不阻塞） | 用户指令指向产品前端 demo；站的重皮肤是独立工作量且发布面独立 | 2026-10-15；本行 |
| D34 | diff/代码深色面保留但中性化（#23272e），增删行语义色沿用——深色代码面是功能面非调色板冲突 | 原型无 diff 面；废止深色面会伤可读性 | 2026-10-15；DESIGN.md v2 §1 |

## Cross-cutting

| concern | note | date |
|---|---|---|
| 先文档后代码 | DESIGN.md v2 与本 roadmap 同批提交，先于任何样式代码 | 2026-10-15 |
| 测试字面值修订纪律 | 锁 v1 token 字面值的断言改 v2 值须逐处注释；结构/行为断言不许动 | 2026-10-15 |
| 单写面 | styles.css 全程单任务持有 | 2026-10-15 |

## 文档维护记录

| date | change | evidence |
|---|---|---|
| 2026-10-15 | E5 立项：DESIGN.md v2 先行重写 + V01–V04 + D31–D34 | 用户裁决 2026-10-15；本文件 |
