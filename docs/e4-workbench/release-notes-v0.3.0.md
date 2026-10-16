# Notegit v0.3.0 发布说明

| 项 | 值 |
|---|---|
| 日期 | 2026-10-16 |
| tag | `v0.3.0`（deploy/scripts/tag-release.mjs --apply 打注解 tag 并推送） |
| 版本清单 | 四包 0.3.0（server / cli / packages/validation / monorepo 根）；CLI `VERSION` 常量随行；跨包依赖随动（server dep + cli devDep notegit-validation 0.3.0——v0.2.0 同日热修教训固化）；rulesVersion 1.0.0-draft.2（未变）；schema 迁移 10 条（顶版 0010——**较 v0.2.0 零新增迁移**） |
| 基线 | main @ 发布提交（E3–E7 全部关闭态：E4 10/10、E5 5/5、E6 5/5、E7 4/4 DoD） |
| 前版 | v0.2.0（E2 GUI 可用性；docs/e2-gui/release-notes-v0.2.0.md） |

## 本版主题：工作台化与 agent 底座（E3–E7）

v0.2 把「内容生产与发现的表层」收口之后，v0.3 覆盖两个方向：**人侧的工作台化**
（应用壳、视觉系统 v2、界面修缮）与**机侧的 agent 底座**（读协议、审计查询、容量
实测），外加产品站点（E3）。

### 新能力

- **产品站点（E3，S13）**：`site/` landing + docs 预渲染管线（build-site.mjs 复用
  服务端 render.ts 只读面；gh-pages 上线）
- **工作台壳与首页（E4，S14–S15）**：应用壳三段化+两档断点（B 方案：登录态侧栏=
  唯一桌面导航）；工作台首页（概览三卡/库网格/跨库最近文档表/事件流次级区块）；
  `/search` 库筛选+⌘K；索引状态位+视图开关；D25/D30 审计时钟与索引行数语义入册
- **视觉系统 v2（E5，S16–S17）**：DESIGN.md v2 token 契约（oklch）全站换轨，
  零行为变化；S17 原型九处对齐收口
- **agent 读协议 v1（E6，S18–S20）**：`GET /api/v1/vaults`（doc_count）、
  `index-status`、`tree`、`docs` 四读端点 + 契约 D 批次修订；§9 审计查询两端点
  （21/21 测试）；凭据委托五语义收口（D29——credential_ref 读侧可见）；容量实测
  （docs/e6/capacity.md：并发读饱和 ~200–220 rps 单进程上界、突发写 p50≈162ms、
  CAS 409=设计内背压、写后索引 lag≈8s 如实——**实测底线非生产承诺**）
- **界面修缮（E7，S21）**：破损清零（displayName 10 调用点接线、空态 `:empty`
  守卫、token 明文「生成后才显示」、favicon、移动端表格横滚/stat 卡策略）+结构
  一致性（侧栏文库项、文档页 h1=标题+元数据条、历史行两段式相对时间、最近文档
  path 去重＋HEAD 树求交——已删文档不再展示、维护模式状态指示、内部行话出文案）；
  20 全页截图复验归零（docs/e7/ux-audit.md）
- **技术债清偿（S22）**：admin 员工表创建时间相对化（ngt.relTime）、browse 上传
  入口文案修正；docs/tech-debt-tracker.md 首建

### 修复

- S17 原型对齐九处（红 2/10→绿 10/10）；S21 A1–A8 破损相八项（双徽章/空橙条/
  黑 token 条/favicon 404/移动端表格挤碎等）；S22 TD-1/TD-2

### 兼容与升级

- **schema 零新增迁移**——v0.2.0 存量升级后的一次索引重建若已执行，本次无升级步进
- API 兼容：无破坏性变更（全部为严格增量——新读端点与 `/search` 筛选参数；
  契约修订见 docs/contracts/amendments）
- 页面域新增：工作台壳/首页/库筛选/索引状态/视图开关；维护模式状态指示（文案去
  内部行话）

### 质量

- 测试 1119（server）+106（validation）+369（cli）= **1594**；四 gates 全绿
  （contracts 82/82 · spike 7/7 · storage 14/14 · product 1594/1594）
- 安全面零语义变更声明覆盖 E7/S22（呈现层 only）：未认证 302、无权=不存在 404
  同体、POST 同源 Origin CSRF、base_commit CAS 409、reader 403 每 sprint 探针复验
- UI 全量遵循 DESIGN.md v2 token 契约（AGENTS.md 强制条款；S21 修订先行于代码）

### 已知边界与后续候选

- 容量：单进程上界、git spawn 成本、写含索引派生、304 未量化——见
  docs/e6/capacity.md（实测底线，瓶颈四条如实）
- 企业试用（E1 DOD-14）仍待试用方落实
- 候选未立项：树缓存优化、CLI 只读命令、多实例水平扩展
