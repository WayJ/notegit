# E7 界面修缮——demo 截图审计（2026-10-16）

审计人：master 会话。方法：playwright 无头 Chrome 对 demo（127.0.0.1:3210，main
@ aba98c5 合并态）逐页全页截图（桌面 1440×900 ×13 页 + 移动 390×844 ×5 页 +
bob 只读视角），逐屏目检 + 代码根因定位。截图脚本归档
`.agents/notes/2026-10-16-S21-audit/shoot.mjs`（可复跑）。

**审计前提（如实）**：蓝色 accent 为 DESIGN.md v2 契约色（§1 `--accent
oklch(0.626 0.205 254.947)`），配色本身合规；安全面实测无恙（bob 越权过滤、
404 同形态、未认证 302 全部保持）。问题集中在**结构与细节层**。

## A 类：破损级（须修）

| # | 症状 | 根因（file:line） |
|---|---|---|
| A1 | 库页顶栏徽章「admin admin」双槽同名；首页为「实例管理员 admin」——两代形态并存 | PageNav.displayName 仅首页/凭据创建页接线（pages.ts:618）；browse/edit/upload/activity/drafts/admin/credentials 等 10 处调用点缺传（pages.ts:81 注释自认「渐进接线」未完成） |
| A2 | 编辑页空橙色警示条常驻 | `.form-warn` 无 `:empty` 守卫（styles.css:419）；`<p id="form-warn">`（edit/pages.ts:410）空也画橙底橙边 |
| A3 | admin 邀请/重置与凭据创建三根巨型黑色空 token 条常驻 | `<pre class="token-view">`（pages.ts:656,690,922）空内容照常渲染深底块（styles.css:328）；说明文案同常驻——应为「生成后才显示」 |
| A4 | 每页 console favicon 404 | 无路由、无 `<link rel="icon">`，全仓零引用 |
| A5 | 移动端（390px）admin 员工表挤碎：行高暴涨、操作按钮溢出视口 | 表格无移动端策略（无横滚包裹/卡片化） |
| A6 | 移动端首页三张 stat 卡文字逐字竖排 | 卡内换行策略缺失 |
| A7 | admin「成员与角色管理」未加载时裸表头 + 黑 token 条常驻 | 空态未处理 |
| A8 | 编辑页「额外字段」label 折行成断裂灰条 | label 文案过长含 `<code>` 片段与括号说明（edit/pages.ts:399） |

## B 类：结构与一致性（选定修复面）

| # | 症状 | 备注 |
|---|---|---|
| B1 | 侧栏无「文库」项——主目的地 /vaults 仅靠顶栏右侧「知识库」胶囊可达；browse 页侧栏 active 也不落位 | IA 缺口（PageNav.active='vaults' 枚举已有、导航项缺失） |
| B2 | 登录态页脚仍渲染匿名导航三项（SITE_FOOTER 静态，pages.ts:208） | 与侧栏重复，违背 B-plan「侧栏=登录态唯一桌面导航」 |
| B3 | 「当前登录：admin · 返回首页」page-meta 裸文本行遍布旧页（browse/pages.ts:53 等） | 与工作台新壳两代并存；顶栏已有身份，该行应去冗余 |
| B4 | 文档页 h1=文件名而非文档标题；元数据条仅「文件·大小：335 字节」——负责人/状态/标签/来源全未展示 | 产品捕获的元数据在阅读面浪费 |
| B5 | 搜索页表单 label 居中漂移、列错位；「命中字段」暴露内部字段名 path；标题列不可点（路径/库反而可点） | 表单网格 + 链接目标 + 字段名中文映射 |
| B6 | 历史页单行塞 oid+message+作者+「（Git 元数据）」+ISO 时间戳+diff 链接；ISO 与全站相对时间不一致 | 两段式行 + 相对时间 |
| B7 | 首页「跨库最近文档」同一文档连续重复行，且**已删除文档仍作为现存文档展示**（C1 复核实证：d29-close/d29-verify/accept-probe 三文件 S19 已删——view 404、HEAD 树无——但 home 表仍按历史发布事件渲染其为首页文档） | 显示层两处修正：按 path 去重（保留最新 + 次数标注）＋与 HEAD 树求交（已删路径出局）；数据面/排序语义（D25/D30）不变 |
| B8 | 库卡「管理员/读者」角色渲染成通栏灰条（似骨架屏） | DESIGN.md §5 徽章=胶囊 chip——此为**偏离契约**，改回 chip |
| B9 | 侧栏底部用户卡 admin 时「实例管理员/实例管理员」两行同文 | displayName===role 文案碰撞，去重 |
| B10 | 维护模式无当前状态指示、双按钮常驻；文案泄漏内部引用（「identity §3.1」「docs/credentials-ops.md」「DOD-03」） | 状态指示 + 文案去内部行话 |

## C 类：demo 数据卫生

| # | 症状 | 处置 |
|---|---|---|
| C1 | ~~team-handbook 内三探针文件残留~~ **复核实证：S19 时已经正式 delete 流程清除**（HEAD 树无此三文件、view 404）——残留感来自 B7（home 表按历史事件渲染已删文档） | 无数据操作需要；显示面并入 B7 修复 |

## 修复组织

- **S21-T1（worker）**：A1–A8 + B2/B8/B9（壳与组件破损修复；styles.css + pages.ts
  簇为主，含 favicon、移动端表格/stat 卡策略、token 显隐、:empty 守卫、徽章 chip、
  displayName 接线、页脚登录态简化、label 精简）。
- **S21-T2（worker，T1 合并后串行）**：B1/B3–B7/B10（页面级一致性：侧栏文库项、
  page-meta 统一、文档页 h1=标题+元数据条、搜索表单修正、历史行两段式、最近文档
  去重、维护模式状态；DESIGN.md 先行修订——文档页头/历史行/搜索表单组件形态、
  页脚简化、侧栏文库项）。
- **master 直做**：C1 demo 清理 + 验收复验（截图脚本复跑比对）。
