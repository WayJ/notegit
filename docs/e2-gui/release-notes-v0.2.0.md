# Notegit v0.2.0 发布说明

| 项 | 值 |
|---|---|
| 日期 | 2026-10-14 |
| tag | `v0.2.0`（tag-release.mjs --apply 打注解 tag 并推送；**2026-10-14 同日重定位至热修提交**——原 tag 漏升跨包依赖声明（server dep/cli devDep notegit-validation 仍 0.1.0）致全新安装 404，修复后删旧tag重打，tag 当日无消费者） |
| 版本清单 | 四包 0.2.0（server / cli / packages/validation / monorepo 根）；CLI `VERSION` 常量随行；rulesVersion 1.0.0-draft.2（未变）；schema 迁移 10 条（顶版 0010——search_index.body 列） |
| 基线 | main @ 发布提交（E2 关闭态：DOD-E2 10/10） |
| 前版 | v0.1.0（E1 发布；docs/s9/release-notes-v0.1.md） |

## 本版主题：GUI 可用性（Epic E2）

v0.1 的安全内核（git 唯一真源、三入口一致授权、统一校验、备份恢复）之上，v0.2 把「内容生产与发现的表层」收口——立项依据为 6 竞品实测调研（docs/e2-gui/research.md、feature-matrix.md）。

### 新能力（DOD-E2-01~10）

- **编辑可达性**：view/browse/history/version 全页面族「编辑此页」入口——任一文档 ≤1 跳到编辑表单（v0.1 全站 0 链接）
- **站内新建笔记**：browse「新建笔记」→ 预填模板表单 → 既有提交端点 → 新文档预览，浏览器内闭环；三道防误覆盖（既有路径提示态/新建确认态/提交前探测阻断）
- **权限感知呈现**：读者只读态（写入口不渲染/表单禁用+只读徽章）；写操作安全判定不变（POST 侧全量鉴权原样，回归测试锁定）
- **全文检索 v1**：命中面从元数据扩为 标题/标签/摘要/**文件名/正文** 五面（CJK 2 字可查；可见性过滤逐请求；matched 五值有序）
- **最近变更流**：首页跨库区块（成员关系过滤）+ 库内 activity 页（审计派生，零新存储）
- **目录浏览增强**：README 安全渲染为 Markdown（frontmatter 不外露）；目录行最后提交作者/相对时间
- **编辑体验**：双栏预览（与发布后渲染同一管线，注入不可达）、草稿自动保存（30s+失焦）、「我的草稿」跨库汇总页、编辑器粘贴/拖拽图片自动上传回插
- **全站顶栏账户菜单**：凭据/管理（角色可见）/登出全域可用（v0.1 登出仅首页）
- **前端路线 A 落地**（ADR D19）：纯 SSR + 共享脚本抽取（`/assets/app.js`，window.ngt）——零构建链/零外部依赖保持

### 修复

- 库级历史页 diff 链接全 404（F-4）；路径级历史「返回目录」错指文件；v0.1 检索按文件名搜文件 0 命中（F-3）

### 兼容与升级

- schema 迁移 0010（append-only，既有数据不动）；**存量库升级后需一次索引重建**回填正文列（`POST /api/v1/admin/search-index/rebuild`，或等价重建入口）
- API 兼容：无破坏性变更（检索命中面扩展为严格增量；matched 追加两值）
- 页面域新增端点：`POST /edit-preview/{slug}/{path}`（只读推导，维护模式放行）、`GET /drafts`、`GET /vaults/{slug}/activity`（api.md §13 入册）

### 质量

- 测试 978（server）+106（validation）+369（cli）；四 gates 全绿；安全不变量交叉验证（302/同 404/Origin CSRF/CAS 409/reader 403）每 sprint 复验全绿；e2e 回归 21/21
- UI 全量遵循 DESIGN.md token 契约（AGENTS.md 强制条款）

### 已知边界与后续候选

见 docs/known-limitations.md 与 docs/s9/next-epics.md（E2 收口追记：§6 内容读取 API、edit 域共享块抽取候选、错误信封统一等）。企业试用（E1 DOD-14）仍待试用方落实。
