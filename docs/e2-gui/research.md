# E2 GUI 竞品调研与现状审计报告

| 项 | 值 |
|---|---|
| 日期 | 2026-10-14 |
| 性质 | research（无产品代码变更；本文件与 feature-matrix.md 为唯一产出） |
| 服务端代码基线 | worktree 分支 `WayJ/e2-gui-research-2` @ `afb7ee1` |
| 现状审计方法 | demo 服务器 `http://127.0.0.1:3210` curl 实测（三账号：admin=实例管理员、alice=两库编辑者、bob=team-handbook 读者且无 product-notes 权限）+ `server/src/web/` 源码走查；每条结论标注证据（[实测] 带 URL/状态码，[源码] 带 file:line） |
| 竞品调研方法 | WebSearch/WebFetch 一手来源（官方文档、官网功能页、GitHub README/文档源）；关键 URL 经二次抽查核实（见 §1.8） |
| 姊妹文档 | [feature-matrix.md](feature-matrix.md)（竞品功能矩阵，表格版） |

---

## 1. 竞品调研（6 个产品）

每个产品按统一维度记录：核心交互模型（浏览/编辑/搜索/历史/协作）、信息架构、编辑体验、权限模型呈现、git 集成形态、最值得借鉴的 3 个设计点。标注「未能确认」处为官方文档未明确、且无可靠一手来源佐证的项，宁缺毋滥。

### 1.1 Outline

开源（BSL 1.1）团队知识库，React + Node + Postgres + Redis，Docker 自托管（<https://github.com/outline/outline> README，证明技术栈与许可证）。

- **交互模型**：左侧栏列全部 Collection，管理员可拖放排序，全局命令菜单直达文档与操作（[Collections 指南](https://docs.getoutline.com/s/guide/doc/collections-l9o3LD22sV)）；编辑无显式保存按钮语义，修订随编辑自动记录——"At minimum, a version is recorded for every 5 minutes of editing"（[Revision history](https://docs.getoutline.com/s/guide/doc/revision-history-AiL6p22Ssq)，已核实原文）；全工作区即时搜索 "instant search across your whole workspace"（[官网](https://www.getoutline.com/)，过滤器细节未展开）；历史三入口（时间戳/菜单/命令面板），点版本看 diff，恢复为非破坏性——"restoring a version will create another version and not rollback history"（同 Revision history 页，已核实）；实时协作与评论串、公开链接分享、无权限文档可请求访问（[官网](https://www.getoutline.com/)、[changelog](https://www.getoutline.com/changelog)）。
- **信息架构**：Workspace → Collection（顶层主题容器）→ 文档，文档可嵌套子文档（[Documents 指南](https://docs.getoutline.com/s/guide/doc/documents-UiH1h0aQFQ)）；Collection 内字母序或手动排序；嵌套深度上限官方未明确。
- **编辑体验**：WYSIWYG 块编辑器 + Markdown 快捷输入 + 斜杠命令（官网措辞 "editor with markdown support + slash commands"）；块能力含表格、代码块（行号/Mermaid）、嵌入（视频/PDF/Tldraw/Draw.io）、附件、toggle、任务列表（[changelog](https://www.getoutline.com/changelog) 逐项有据）。
- **权限呈现**：Collection 为权限主阵地，角色表 View / View+Edit / Admin + Workspace Admin；Default access + 组 + 单用户并存、取高者；文档级权限 2024-02 起支持（changelog）；管理面 Settings → Security/Users/Export（Collections 指南、[Export data](https://docs.getoutline.com/s/guide/doc/export-data-Da6C7HqL8M)）。
- **git 集成**：**无 git 存储后端**。README 技术栈无 git 组件；changelog 中 git 相关条目仅为 GitHub/GitLab issue/MR 嵌入集成；数据出口是导出（Collection/Workspace 级 Markdown、HTML、JSON；2026-09 新增 Open Knowledge Format——含 YAML frontmatter 的 markdown 目录包）。
- **最值得借鉴**：① 修订历史的用户语义：自动版本化 + diff + 非破坏性恢复，把 git 历史翻译成普通用户语言；② Open Knowledge Format：YAML frontmatter Markdown + 每篇 index.md 的目录包——正是 git 后端所需的磁盘序列化格式范本；③ Collection 双职责：信息架构根节点与权限边界合一（角色表 + 默认访问 + 组）。

### 1.2 Wiki.js

AGPL-3.0 开源 wiki（Node.js）。2.x 稳定版在 [github.com/requarks/wiki-v2](https://github.com/requarks/wiki-v2)，主仓库 [github.com/requarks/wiki](https://github.com/requarks/wiki) 现为 3.0 Beta（NOT FOR PRODUCTION）。注意：docs.requarks.io 为 JS 渲染站，WebFetch 直抓仅见标题，故本文引用其文档的 GitHub 原文镜像（raw.githubusercontent.com/requarks/wiki-docs），关键条目已逐条核实。

- **交互模型**：面包屑由路径自动生成，导航有站点树（各层标题取自页面标题）与自定义导航两种，另有标签浏览（[structure 文档](https://docs.requarks.io/guide/structure) / [原文镜像](https://raw.githubusercontent.com/requarks/wiki-docs/master/guide/structure.md)）；4 种编辑器（Markdown、Visual WYSIWYG、Code、AsciiDoc）可经 Page Actions 互转（有损，[editors 文档](https://docs.requarks.io/editors)）；Markdown 编辑器为双栏实时预览 "live side-by-side preview"（[js.wiki 官网](https://js.wiki/)）；内建数据库搜索，可选 Algolia/Azure Search/Elasticsearch（js.wiki）；全版本跟踪 + 可视化 Compare Versions + 一键 revert + 恢复已删页（js.wiki）；**无实时协作**（功能页通篇未提及）；评论为可选模块且默认关闭（[comments 文档](https://docs.requarks.io/comments)）。
- **信息架构**：无传统文件夹——virtual folders：`/universe/planets/earth` 中间层级自动推断，路径即层级；新建页面三途径：New Page 按钮、点击指向不存在页面的链接、复制现有页（[pages 文档](https://docs.requarks.io/guide/pages)）。
- **编辑体验**：主推 Markdown 双栏（实时预览+工具栏+快捷键）；支持 draw.io 图、tabset；附件经 assets 体系（组权限 `write:assets`）。
- **权限呈现**：以组为中心，两层规则（[groups 文档](https://docs.requarks.io/groups)）：全局权限（`read:pages` 等）是 master switch 恒优先；Page Rules = Allow/Deny + 路径匹配，精确度排序（Starts With < Ends With < Regex < Exactly，精确者胜，同级 Deny 胜，默认拒绝）。没有挂在单页上的权限 UI，全部声明在组规则里。
- **git 集成**：**有，且为核心卖点**（[Git 存储文档](https://docs.requarks.io/storage/git) / [原文镜像](https://raw.githubusercontent.com/requarks/wiki-docs/master/storage/git.md)，以下均核实）：双向同步任意 git 远程；SSH/Basic/OAuth/Token 认证；**保存不即时同步**——"For performance reasons, new commits are only synced on a regular interval (every 5 minutes by default)"；手动操作含增量补送/全量导入/强制同步；硬约束 "A Git repository must be dedicated to Wiki.js"（不能是子目录/submodule）。定位：git 是同步/备份目标，主存储仍是数据库。
- **最值得借鉴**：① git 同步的完整工程语义：调度间隔 + 三种显式手动操作 + 专库专用约束 + FAQ 讲清「为何不即时」——直接回答 git-backed GUI 最难的边界问题；② 路径即信息架构：层级由路径推断、面包屑与站点树全部从路径派生，与 git 工作树天然同构；③ 声明式 Page Rules：路径匹配规则替代逐页权限点选——权限可随内容一起版本化。

### 1.3 BookStack

MIT 开源（PHP/Laravel）， Books/Chapters/Pages 三层文档系统（[bookstackapp.com](https://www.bookstackapp.com/)，[GitHub](https://github.com/BookStackApp/BookStack)）。

- **交互模型**：书籍左侧栏完整层级 + 上一页/下一页 + 面包屑，首页有 Recent Activity、最近更新、个人收藏（[getting-around](https://www.bookstackapp.com/docs/user/getting-around/)）；默认 WYSIWYG 编辑器，`Ctrl+S` 存草稿、`Ctrl+Enter` 保存并继续，草稿点正式 Save 前仅自己可见（[WYSIWYG 文档](https://www.bookstackapp.com/docs/user/wysiwyg-editor/)）；页头全局搜索（即时预览）+ 书/章节内局部搜索，支持精确短语、标签 `[name=value]`（含 `=`/`!=`/`<`/`>`/`<=`/`>=`/`like`）与约 20 种过滤器如 `{updated_after:2026-01-01}`、`{created_by:me}`、`{in_name}`、`{in_body}`、`{type:page}`，`-` 取反（[searching 文档](https://www.bookstackapp.com/docs/user/searching/)，已逐条核实，另注明每次搜索项数限额）；页面右侧菜单 Revisions 入口：查看/对比/恢复旧版本，草稿与修订同系统（getting-around；v26.05 起修订访问独立为角色级权限——[发布说明](https://www.bookstackapp.com/blog/bookstack-release-v26-05) 出现于搜索结果）；无实时协同，有页面评论（v25.05 重构为评论侧栏+正文气泡，v25.11 进 REST API，v25.12 支持 @ 提及——各发布说明出现于搜索结果）。
- **信息架构**：四层固定：Bookshelves → Books → Chapters（可选）→ Pages；书与书架多对多；页面是唯一叶子，无更深嵌套；官方建议「从平铺开始自然生长、多了再分层」（[content-overview](https://www.bookstackapp.com/docs/user/content-overview/)）。
- **编辑体验**：双编辑器可选（可按权限切换）：默认 WYSIWYG（类 Word）或 Markdown 编辑器（CommonMark 兼容 + 实时预览，见[用户文档目录](https://www.bookstackapp.com/docs/user/)两页）；内置 diagrams.net 画板（保存为内嵌 PNG）；附件/图片管理。
- **权限呈现**：角色级系统权限（含 Own 变体）+ 内容级覆盖（书架/书/章节/页面四层）；继承规则明确：书/章节自动级联子内容，三级优先级（角色 → Everyone Else → 特定角色覆盖），最具体者胜（[roles-and-permissions](https://www.bookstackapp.com/docs/user/roles-and-permissions/)）；认证支持 OIDC/SAML2/LDAP + 按角色强制 MFA（官网首页）。
- **git 集成**：**无任何 git 集成**。官方明确 database-driven（页面 HTML 存 `pages.html` 列、原始 Markdown 存 `pages.markdown` 列，[content-storage](https://www.bookstackapp.com/docs/admin/content-storage/)）；导出 HTML/PDF/txt/Markdown/ZIP 但导入仅自家 ZIP 且"not intended for backup or restore"（[export-import](https://www.bookstackapp.com/docs/user/export-import/)）；「git 存储后端」自 2018 年起仍是开放功能请求（[GitHub Issue #776](https://github.com/BookStackApp/BookStack/issues/776) 出现于搜索结果）。
- **最值得借鉴**：① 搜索过滤器语法：`{filter:value}` + 标签比较符 + 取反，可直接映射为 frontmatter/元数据查询；② Revisions 面板 = diff/restore 的现成 UI 隐喻：右侧入口 + 版本对比 + 一键恢复 + 草稿同系统，几乎就是 `git log/diff/checkout` 的产品化；③ 双真源列 + 克制 HTML 子集（原始 Markdown 与受限 HTML 并存、限制自定义类/内联样式保可移植）——附件改名与动态 include 被官方自认迁移痛点，是反面教材。

### 1.4 Notion

SaaS 协作工作台（[notion.com/help](https://www.notion.com/help) 官方帮助文档）。

- **交互模型**：左侧栏多标签（Home/Inbox/Search 等），Home 聚合 Upcoming/Recents/Favorites/Teamspaces 区块可增删排序，页面树切换箭头展开、拖拽页面即嵌套/移出（[navigate-with-the-sidebar](https://www.notion.com/help/navigate-with-the-sidebar)）；点击页面即入所见即所得编辑、无独立编辑态；`Cmd/Ctrl+K` 全局搜索是最主要入口（同侧栏文档）；历史走页面 `••• → History` 按日期浏览快照并 Restore/Copy，桌面端约每 10 秒存一版，保留期按套餐 7 天~1 年（[page-history](https://www.notion.com/help/page-history) 出现于搜索结果并附保留期表；该 URL 直抓 404，**此条置信度中等**）；实时多人均编为默认形态，块级评论、@ 提及进 Inbox 通知（[comments-mentions-and-reminders](https://www.notion.com/help/comments-mentions-and-reminders) 出现于搜索结果）；无权限者可经 Share 菜单申请访问（[sharing-and-permissions](https://www.notion.com/help/sharing-and-permissions)）。
- **信息架构**：Workspace → Teamspace → Page（**无限嵌套**子页面，官方原话 "nest pages inside other pages with no limit"，侧栏文档）→ Block；数据库（database）是特殊页面可多视图；子页面创建：页内 `/page` 或侧栏 `+`（[create-a-subpage](https://www.notion.com/help/create-a-subpage) 出现于搜索结果）。
- **编辑体验**：块式所见即所得："所有内容都是块"，`⋮⋮` 拖拽重排、Turn into 转换类型（[what-is-a-block](https://www.notion.com/help/what-is-a-block)）；`/` 斜杠菜单覆盖文本/表格/待办/Toggle/引用/Callout/目录/代码块（多语言高亮）/五种数据库视图/公式/500+ embed；同时保留 Markdown 快捷输入（`**粗体**`、`#` 标题、`[]` 待办，[writing-and-editing-basics](https://www.notion.com/help/writing-and-editing-basics)）——双轨输入兼顾小白与键盘党。
- **权限呈现**：页面级为主、子页自动继承父页权限；Share 菜单单一门面：General access 三档（仅受邀/全工作区/任何有链接者，链接可设过期）；权限六档（Full access/Can edit/Can edit content/Can create/Can comment/Can view）；**最宽权限原则**（从任何渠道获得的最宽权限生效）（[sharing-and-permissions](https://www.notion.com/help/sharing-and-permissions)，已核实）。
- **git 集成**：**无官方 git 集成**。导出仅 PDF/HTML（含评论与子页 zip）/Markdown & CSV，全工作区导出走邮件链接，且"无法通过重新上传导出内容还原工作区"（[export-your-content](https://www.notion.com/help/export-your-content)）；开发者平台为 REST API + webhooks（[developers.notion.com](https://developers.notion.com/docs/getting-started)），无版本控制能力；社区 git 同步工具均为第三方。
- **最值得借鉴**：① 块 = 最小操作单元 + 双轨输入（斜杠命令与 Markdown 快捷并存）——git 库 GUI 可把 Markdown 行/节当块操作；② 高频快照的历史模型：~10s 一存、按日聚合浏览、Restore 与 Copy 分离——对应 git 自动 commit/stash 节奏；③ 权限呈现的极简门面 + 明确语义：一个 Share 菜单三档通用访问 + 六档能力 + 继承与最宽原则写进帮助文档。

### 1.5 GitLab 内置 Wiki

GitLab 每个项目附带的 wiki（[docs.gitlab.com/ee/user/project/wiki/](https://docs.gitlab.com/ee/user/project/wiki/)，关键句已核实）。

- **交互模型**：默认侧边栏是按字母排序的嵌套页面树，可按标题过滤，超 5000 条目显示 View All Pages；Web UI 直接创建/编辑页面，保存前可附 commit message，另提供 WYSIWYG 富文本编辑器（表格/清单/代码块/Mermaid/PlantUML 预览）；wiki 内独立全文搜索官方文档未明确（主文档页通篇未提，标注存疑）；页面历史显示各版本作者/提交信息/版本间 diff，GitLab 18.6 起支持恢复到历史版本且保留完整历史（以上均出自主文档页）；协作以页面评论 + emoji 回应（19.1+）+ 订阅通知呈现；实时多人同编官方未明确。
- **信息架构**：标题自动转 slug（空格→连字符），标题含 `/` 即建子目录；front matter `title:` 解耦显示标题与路径；首页路径必须为 `home`；侧栏定制 = 创建名为 `_sidebar` 的 wiki 页面**完全替换**默认导航树（官方原话 "This process creates a wiki page named `_sidebar` that fully replaces the default sidebar navigation"，已核实；`.gitlab/` 目录下实际是改名自动重定向表 redirects.yml）。
- **编辑体验**：Markdown（完整 GitLab Flavored）+ RDoc/AsciiDoc/Org；wiki 专属链接语法：`[[slug]]` 双链（页面不存在提示创建）、跨项目链接、`./`/`../`/`/` 相对链接（[wiki markdown 文档](https://docs.gitlab.com/ee/user/project/wiki/markdown/)）。
- **权限呈现**：wiki 权限完全跟随项目成员角色（创建/编辑/删除/移动/恢复/建模板要求 Developer 及以上）；项目管理员可在项目设置整体开关 wiki。
- **git 集成**：**每个 project wiki 就是一个独立 git 仓库**——官方原话 "Each wiki is a separate Git repository"，经 Wiki actions → Clone repository 可像普通仓库一样克隆、本地提交、推送回（已核实原文）。Web 编辑器只是 git 之上的一层皮，每次保存是一个带 message 的 commit。
- **最值得借鉴**：① 「wiki 即 git 仓库」的完全等价性：任何 Web 操作都可用 `git clone` 拿到等价物——与 Notegit「git 为唯一真源」定位最直接的架构范本；② slug/标题解耦 + 改名自动写 redirects.yml 重定向——链接不腐；③ 侧栏与模板（templates/）本身是仓库内文件：导航结构的修改同样有历史可回溯。

### 1.6 Obsidian Publish

本地优先笔记应用 Obsidian 的官方托管发布服务（[obsidian.md/publish](https://obsidian.md/publish)、[help.obsidian.md](https://help.obsidian.md)）。

- **交互模型**：发布站点支持悬停预览（Wikipedia 式弹窗）、graph view 图谱、stacked pages 横向堆叠、backlinks 反向链接列表（[publish 产品页](https://obsidian.md/publish)）；编辑全部在本地应用完成，Publish 端只读；发布走 Publish changes 对话框，勾选 "NEW" 未发布笔记再点 Publish——发布是刻意动作（[setup](https://obsidian.md/help/publish/setup)）；发布站点是否带搜索框官方文档未提及（**未能确认**）；Publish 端版本历史/回滚官方未明确——唯一官方版本历史页属 Sync 服务而非 Publish（[sync/version-history](https://obsidian.md/help/sync/version-history)，证明归属）；可邀请多人共同维护站点（publish 产品页 / [help/publish](https://obsidian.md/help/publish)）。
- **信息架构**：vault = 本地文件系统文件夹（[vault 文档](https://obsidian.md/help/vault)）；发布站点导航默认沿袭 vault 文件夹结构，可拖拽重排/右键 Hide in navigation，但「文件夹内导航结构必须保持」不能跨文件夹移动（[customize](https://obsidian.md/help/publish/customize)）；支持 permalinks 固定链接与逐页 SEO 元数据。
- **编辑体验**：本地编辑器三模式——Live Preview（默认，光标进入时才显语法）、Source mode、Reading view，Ctrl/Cmd+E 切换（[edit-and-read](https://obsidian.md/help/edit-and-read)）；Publish 端为只读渲染站点，样式经根目录 `publish.css`/`publish.js` 特殊文件定制（JS 需自定义域名）。
- **权限呈现**：站点级密码（可多个、各带昵称，便于发不同人）；官方明确「已发布笔记的单独密码保护目前不支持」，删密码后整站公开（[security](https://obsidian.md/help/publish/security)）；可禁止搜索引擎索引整站。
- **git 集成**：vault 是本地文件夹，git 支持不是官方内置而是社区插件 Obsidian Git（自动 commit/pull/push，[community.obsidian.md/plugins/obsidian-git](https://community.obsidian.md/plugins/obsidian-git)）；Publish 是托管只读快照站点，「只有你选择发布的笔记会发送到 Obsidian 服务器」（security 页）。
- **最值得借鉴**：① 编辑态与发布态彻底分离：本地全功能编辑 + 显式勾选发布 + 只读快照——「保存 ≠ 公开」的清晰心智；② 导航层与文件结构解耦但受约束：可拖拽重排/隐藏而不动文件，同时强制保持文件夹层级；③ 双链网络作为一级浏览界面：backlinks/悬停预览/graph 让「从链接抵达」与「从树抵达」并存。

### 1.7 六产品定位速览

| 产品 | 形态 | git 关系 | 编辑模型 | 对 Notegit 最独特的相关性 |
|---|---|---|---|---|
| Outline | 自托管/云团队 wiki | 无 git 后端（导出 Markdown 包） | WYSIWYG 块编辑 | 修订历史用户语义；frontmatter 目录包格式 |
| Wiki.js | 自托管 wiki | **git 双向同步模块**（5min 批量） | Markdown 双栏 / WYSIWYG / Code | git 同步工程语义；路径即信息架构；声明式权限规则 |
| BookStack | 自托管文档系统 | 无（数据库双真源列） | WYSIWYG / Markdown 双栏 | 搜索过滤器语法；Revisions 面板隐喻 |
| Notion | SaaS 协作工作台 | 无（REST API + 导出） | 块式 WYSIWYG + 双轨输入 | 块操作；高频快照；Share 菜单权限门面 |
| GitLab Wiki | 项目内建 wiki | **wiki 即独立 git 仓库**（可 clone） | Markdown 表单 + WYSIWYG | 与 Notegit 架构同构：Web 是 git 的皮 |
| Obsidian Publish | 本地应用 + 托管只读站 | 社区 git 插件（非官方） | 本地 Live Preview 三模式 | 编辑/发布分离；双链浏览界面 |

### 1.8 来源核实说明

以下 URL 由本报告作者在 2026-10-14 用 WebFetch 二次抽查，内容与上述引用相符：

- <https://www.bookstackapp.com/docs/user/searching/>（过滤器/操作符全集逐条核实）
- <https://docs.gitlab.com/ee/user/project/wiki/>（"Each wiki is a separate Git repository"、`_sidebar`、历史与 18.6 恢复）
- <https://docs.getoutline.com/s/guide/doc/revision-history-AiL6p22Ssq>（5 分钟修订、非破坏性恢复）
- <https://raw.githubusercontent.com/requarks/wiki-docs/master/storage/git.md>（5 分钟批量同步、专库专用、SSH 认证）

另：docs.gitea.com 某文档页直抓 404，故未引入 Gitea 作为第 7 竞品（宁缺毋滥）。requarks.io 官网为 JS 渲染站，WebFetch 直抓仅见标题，Wiki.js 条目一律以 GitHub 文档源镜像为准。

---

## 2. Notegit GUI 现状审计（全页面走查）

### 2.0 审计环境与方法

- 服务器：demo `http://127.0.0.1:3210`（数据已种子），2026-10-14 实测。
- 账号：`admin`（实例管理员，两库角色=管理员）、`alice`（两库=编辑者）、`bob`（team-handbook=读者，无 product-notes 权限）。
- 种子数据：product-notes（1 commit，tip `33864ed`，docs/roadmap.md、docs/meetings/2026-10-13.md）、team-handbook（2 commit，tip `6cf8b66`、父 `93ca686`，docs/{README,code-review,onboarding,travel}.md）。
- 方法：curl 带 cookie jar（`-b xxx.jar`，POST 一律 `-H Origin:http://127.0.0.1:3210`）逐页抓取 + `server/src/web/` 源码对照。全部抓取物留存于审计机 `/tmp/e2-audit/`。
- 页面体量实测（含内联 JS）：404 页 1.7KB ~ admin 13.4KB；全站唯一外部资源 `styles.css` 27,609B（[实测] GET /assets/styles.css；[源码] server/src/web/routes.ts:51 注释「全站唯一共享样式」）；无任何外部 JS/CSS 依赖、无构建链。

### 2.1 页面族逐页走查

| # | 页面 | 功能（实测） | 可用性短板（证据） |
|---|---|---|---|
| 1 | `/login` | SSR 登录页；表单经内联 JS fetch `POST /api/v1/auth/login`，成功跳 `/`，错误行内展示（[实测] GET /login → 200，2954B） | **无 JS 完全无法登录**：表单无 action，纯 JS 提交（[源码] 登录页内联脚本；[实测] 页面源码 `<form id="login-form">` 无 method/action） |
| 2 | `/`（首页） | 当前登录身份卡 + 三张功能卡（知识库/凭据/管理）+ 退出登录按钮（JS）（[实测] 200，2994B；admin 显示三卡） | 无任何内容动态（无最近变更、无快捷入口到最近编辑的库）；登出是页内 JS 按钮 |
| 3 | `/vaults` | 有权库卡片列表（名称/slug/角色徽章）（[实测] admin 2 卡=管理员，alice 2 卡=编辑者，bob 1 卡=读者） | 无库描述/元信息、无排序搜索、无最近活动；角色徽章是唯一权限呈现 |
| 4 | `/vaults/:slug/browse[/*]` | 逐层目录列表（每请求实时 `git ls-tree`，无缓存）；面包屑；目录级「上传」入口；文件级 view/重命名/删除链接；README 卡片 | ① **README 卡片是纯文本 `<pre>` 且暴露 frontmatter 原文**（[实测] team-handbook docs 页 readme-card 含 `---\ntitle: 团队手册首页\n---` 原文；[源码] browse/pages.ts:96,120）；② 无最后提交时间/作者列、无排序过滤、无树形折叠——大目录不可用；③ 写入口（上传/重命名/删除）**对所有角色一律渲染**（[源码] browse/pages.ts:115,126-127 注释「GET 页面无写操作；写权限在 POST 判定」） |
| 5 | `/vaults/:slug/view/*` | 安全渲染的 Markdown 预览（frontmatter 剥离）、类型/大小徽章、面包屑（[实测] view docs/roadmap.md → 200 渲染正常） | **页面无任何动作入口**：无「编辑」、无「历史」、无「上传附件」（[源码] view/pages.ts:41 仅 meta 徽章；[实测] 全页 grep 无 edit/history 链接）——阅读是死胡同 |
| 6 | `/vaults/:slug/edit/*` | 元数据表单（title 必填/owner/description/tags/status 封闭下拉/source/额外 YAML）+ 正文纯文本 textarea（18 行）+ 提交说明 + 「保存草稿/提交」；base commit 展示；草稿回填横幅；422 校验报告按字段定位渲染；409 冲突提示含当前 tip 与重提指引（[实测] 200，9903B；[源码] edit/pages.ts:77-83 草稿横幅、内联脚本 composeDoc/submit） | ① **全站没有任何页面链接到 edit**（[实测] browse/view/history/version 四类页面 grep `href="…/edit/"` 均 0 命中）——只能手改 URL；② 纯 textarea：无预览、无自动保存（草稿手动）、无工具栏、无快捷键；③ 与附件割裂：仅一个「上传附件」外链，编辑中不能粘贴/拖拽图片；④ 无 JS 无法提交（表单无 action） |
| 7 | `/vaults/:slug/history` 与 `…/history/*` | 库级/路径级提交列表（短 OID/主题/作者/日期）+ 分页器；路径级每条附 diff/版本预览/还原链接 + 可复制引用码 `库 / 路径 @ oid`；作者旁诚实标注「Git 元数据…以服务端审计为准」（[实测] 两页均 200） | ① **库级历史页的 diff 链接全部 404**（[实测] GET /vaults/team-handbook/diff/6cf8b66…/ → 404、product-notes 同；[源码] history/pages.ts:82 以空 treePath 生成链接，log.ts:126 对空 filePath 一律 not-found）——两库 3 条提交的库级 diff 链接实测全死；② 无作者/日期过滤，无搜索 |
| 8 | `/vaults/:slug/diff/:oid/*` | 逐文件 diff：git 原文逐行转义进 `<pre>`，行类标 data-kind（add/del/ctx/meta）（[实测] 带路径 200） | 仅 unified 单栏原文；无并排、无行内高亮、无空格开关；必须带路径才能打开（见 #7 死链） |
| 9 | `/vaults/:slug/version/:oid/*` | 历史版本只读预览（渲染 Markdown/图片内联/超大降级态），链接回历史/diff/还原（[实测] 200，3218B） | 无「与当前版本比较」入口（仅父↔目标 diff） |
| 10 | `/vaults/:slug/restore/:oid/*` | GET 确认页语义清晰（还原=新提交、历史不删）+ 纯 POST 表单（**无 JS 可用**）（[实测] 200） | —（此页是好范例） |
| 11 | `/vaults/:slug/upload[/*]` | JS 上传表单（fetch octet-stream 直发）：文件 + 相对路径（选文件自动预填）；规则内联说明（扩展名/容量限制 E-LIMIT-002/003；.md 须含合法 frontmatter，README 豁免）（[实测] 200，5313B；[源码] upload/routes.ts:222-225） | ① **站内无法「新建笔记」**：必须先在本地造好 .md 文件再上传；② 无 JS 不可用；③ 无拖拽/多文件 |
| 12 | `/vaults/:slug/rename|delete/*` | 纯 POST 表单 + 规则说明（改 .md 须合法 frontmatter；删除不做元数据校验、历史保留）（[实测] 均为 200，均无 JS 可用） | 删除确认页无「输入文件名确认」等防误触（轻量风险） |
| 13 | `/search?q=` | **元数据检索**：仅 title/tags/summary（[源码] search/routes.ts:12、search/pages.ts:15 MATCH_LABELS）；GET 表单无 JS 可用；结果表（库/路径/标题/标签/摘要片段/命中字段）带 view 链接；可见性过滤（bob 搜「路线图」=0 命中，admin 命中同词）；100 条截断提示（[实测] q=路线图 → 1 命中，bob 同词 → 0） | **文件名与正文不参与检索**：[实测] q=roadmap → 0 命中，而 docs/roadmap.md 存在（其 title=产品路线图）——「按文件名找文件」失败；无正文片段、无操作符、无按库过滤 UI |
| 14 | `/cite` | 引用解析：`库 / 路径 @ commit` → 302 跳版本预览页（[实测] /cite?c=team-handbook / docs/code-review.md @ 6cf8b66… → 302 Location=version 页）；GET 表单无 JS 可用 | 格式说明靠 placeholder 与提示文字，无示例点击填充 |
| 15 | `/credentials` | SSR 外壳 + JS fetch 填表：创建（名称/到期/读写/库范围）/撤销/列表（脱敏）（[实测] 200，5950B） | **无 JS = 空表格 + 死表单**（[实测] tbody 为空，全部逻辑在内联脚本） |
| 16 | `/admin` | 五区：员工管理/邀请创建（一次性令牌）/建库/成员与角色管理（我任管理员的库）/维护模式开关；全部 JS fetch 驱动（[实测] 200，13404B，内联 JS 8842B） | **无 JS = 全部死区**；非管理员 403 兜底页正常（[实测] alice GET /admin → 403）；表格无搜索分页提示弱 |

### 2.2 交叉行为验证（安全与一致性不变量）

| 不变量 | 结果 | 证据 |
|---|---|---|
| 未认证 → 302 /login | ✅ | [实测] 无 cookie GET /vaults → 302 Location=/login |
| 无权库 = 不存在（同 404 页） | ✅ | [实测] bob GET product-notes 全页面族（browse/view/edit/history/upload）均 404，与 nonexistent 库 404 **页面内容一致**（diff 仅数字）；[源码] page-kit.ts:17、routes.ts:28-29（D-IC-06） |
| CSRF：POST 须同源 Origin | ✅ | [实测] admin POST delete：无 Origin → 403；`Origin:http://evil.example` → 403 |
| 乐观并发（CAS）：base_commit 过期 → 409 | ✅ | [实测] 以父提交 `93ca686` 为 base POST submissions → 409 E-RES-003，details.current_head=`6cf8b66`（无写入发生） |
| 非法 base_commit → 400 | ✅ | [实测] 全零 SHA → 400 E-RES-004 |
| reader 写操作 POST 拦截 | ✅（但见 F-2） | [实测] bob POST rename → 403；bob PUT draft → 403 |
| 维护模式写 503 | 未实测（避免扰乱 demo） | [源码] write-gate.ts:9-13（/vaults/ 下非安全方法 503 同页提示） |
| 真源实时读、无页内缓存 | — | [源码] routes.ts:29、browse/tree.ts:5-6（每请求 spawn git plumbing） |

### 2.3 横向发现汇总（按严重度）

- **F-1 编辑不可达（阻断级）**：全站 0 个链接指向 `/vaults/:slug/edit/*`（browse/view/history/version 实测均 0 命中）；编辑功能事实上只能手改 URL 使用。同因：view 页无任何动作区（view/pages.ts:41）。
- **F-2 权限盲 UI（信任级）**：读写不分的入口渲染——bob（读者）看到完整 上传/重命名/删除 链接与全套编辑表单（GET edit 200），写操作在 POST 才 403（browse/pages.ts:115,126；实测 bob 走查）。对读者是满屏死按钮，产品呈现为「坏掉」。
- **F-3 检索缺口（采用级）**：仅元数据检索，文件名/正文不参与（search/routes.ts:12）；实测「按文件名搜文件名」0 命中。六个竞品全部具备全文检索（BookStack 还带过滤器语法）。
- **F-4 库级历史 diff 死链（bug）**：history/pages.ts:82 空 treePath 生成 diff 链接 × log.ts:126 空 filePath 一律 not-found → 两库全部 3 条提交的库级 diff 链接 404（实测）。
- **F-5 无站内新建**：Web 端无法从零创建笔记（upload 须本地文件且 .md 须已含合法 frontmatter）；六个竞品均有站内一键新建。
- **F-6 无 JS 断层**：登录/管理/凭据/编辑提交/上传/登出全部依赖 JS（表单无 action、表格 JS 填充）；纯表单页（search/cite/rename/delete/restore）反而无 JS 可用——体验不一致。
- **F-7 编辑器原始**：纯 textarea，无预览/自动保存/工具栏/快捷键/附件粘贴；上传与编辑割裂。
- **F-8 导航静态**：无最近变更/活动流（竞品全员具备：BookStack Recent Activity、Outline Home、Notion Recents）；目录列表无提交元数据列、无折叠树；README 卡片不渲染且裸露 frontmatter。
- **F-9 杂项**：登出仅在首页（pages.ts:177，顶栏无账户菜单）；历史无过滤；diff 单栏原文；404 页与 DESIGN.md 一致性良好（正面）。
- **正面基线（公平记录）**：安全不变量扎实（§2.2 全绿）；409/422 的用户指引质量高（冲突提示含当前 tip 与重提步骤；422 按字段定位）；restore 语义文案是范本；引用码（`库 / 路径 @ commit`）与 /cite 是竞品没有的差异化能力（Agent 报告引用 ↔ Web 历史对应）；全站零构建链、页面 1.7–13.4KB 轻量。

### 2.4 与竞品的差距总览

逐能力对比见 [feature-matrix.md](feature-matrix.md)。一句话概括：**Notegit 的安全内核与 git 语义呈现（历史/diff/还原/引用）已达到或超过竞品水准，差距集中在「内容生产与发现的表层」——编辑可达性、站内新建、全文检索、权限感知呈现、最近变更。**

---

## 3. 功能提案（P0 / P1 / P2 分级）

分级定义：P0 = 没有就没人用；P1 = 显著更好用；P2 = 锦上添花。每条注明来源竞品与依据。

### P0（没有就没人用）

| 编号 | 提案 | 内容与验收要点 | 来源与依据 |
|---|---|---|---|
| P0-1 | 编辑入口闭环 | view/browse/history/version 页提供「编辑此页」链接；任一文档 ≤1 跳到达编辑表单 | 现状 F-1（实测 0 链接）；六竞品编辑入口均在页面主操作位（Outline/Notion 点击即编、GitLab wiki 页面 Edit 按钮、BookStack Edit） |
| P0-2 | 站内新建笔记 | browse 提供「新建笔记」：服务端直出预填 frontmatter 模板的编辑表单（title 必填），提交走既有 `/api/v1/vaults/{slug}/submissions`；验收 = 不离开浏览器完成 新建→提交→view 闭环 | 现状 F-5；GitLab wiki（New page + 点击不存在页链接创建）、Wiki.js（New Page 三途径）、Notion（/page 与侧栏 +）、Outline、BookStack |
| P0-3 | 全文检索 v1（文件名+正文） | 文件名与正文关键词命中（实现面：服务端扫描或轻索引，另行选型）；保留既有可见性过滤与 100 截断语义 | 现状 F-3（实测 q=roadmap 0 命中而文件存在）；BookStack `{in_name}`/`{in_body}`（searching 文档，已核实）、Outline "instant search across your whole workspace"、Notion Cmd+K |
| P0-4 | 权限感知 UI | 按成员角色渲染写入口：读者隐藏或置灰 上传/重命名/删除/编辑 并标注只读；GET 表单页对无写权角色直接只读态 | 现状 F-2（bob 实测满屏死按钮）；GitLab wiki（操作随项目角色）、BookStack（角色权限矩阵）、Outline（Collection 角色表） |
| P0-5 | 修复库级历史 diff 死链 | 库级历史页 diff 链接改为该提交涉及文件列表（或逐文件 diff 入口）；验收 = 历史页所有链接 200 | 现状 F-4（两库 3 条提交实测 404；history/pages.ts:82 + log.ts:126） |

### P1（显著更好用）

| 编号 | 提案 | 内容 | 来源与依据 |
|---|---|---|---|
| P1-1 | 编辑预览 | 编辑页渲染预览（切换或双栏），可含提交前 diff 摘要 | Wiki.js "live side-by-side preview"（js.wiki）、BookStack Markdown 编辑器实时预览、Obsidian Live Preview、GitLab wiki 预览 |
| P1-2 | 草稿自动保存 + 「我的草稿」列表 | 定时/失焦自动存草稿（既有 drafts API）；新增跨库「我的草稿」页（现状草稿只能逐路径撞见） | BookStack Ctrl+S 草稿系统、Notion ~10s 快照、Outline 5 分钟自动修订（均已核实/佐证） |
| P1-3 | 最近变更流 | 首页与库页 recent changes（跨库提交/更新列表，含作者/时间/路径链接） | BookStack Recent Activity（getting-around）、Outline Home/命令菜单、Notion Recents |
| P1-4 | 目录浏览增强 | README 卡片渲染为 Markdown（剥离 frontmatter）；目录行附最后提交时间/作者；树形折叠 | 现状 F-8（README `<pre>` 裸奔实测）；GitLab wiki 侧栏树（可过滤）、GitHub/GitLab 仓库树惯例 |
| P1-5 | 历史与 diff 增强 | 作者/日期/路径过滤；行内高亮、并排 diff | BookStack Revisions 对比、GitLab wiki 版本 diff |
| P1-6 | 编辑器附件粘贴/拖拽 | 编辑中粘贴/拖拽图片 → 自动走 upload 端点并插入引用（现状须另开上传页） | BookStack 附件管理、Notion 粘贴图片 |
| P1-7 | 顶栏账户菜单与登出 | 登出进顶栏（现状仅首页 pages.ts:177）；用户名下拉含凭据/管理入口 | 六竞品通用形态 |

### P2（锦上添花）

| 编号 | 提案 | 内容 | 来源与依据 |
|---|---|---|---|
| P2-1 | 双链与反向链接 | `[[路径]]` 双链语法 + 页尾 backlinks 列表（存疑渲染为「创建」入口） | Obsidian（backlinks/graph/悬停预览，publish 页）、GitLab wiki `[[slug]]`（markdown 文档） |
| P2-2 | 页面模板 | 库内 templates/ 目录，新建笔记时可选模板 | GitLab wiki templates/、BookStack `{is_template}` |
| P2-3 | 公开分享/只读链接 | 单页或整库只读分享链接（带过期/撤销） | Obsidian Publish 站点分享、Outline 公开链接、Notion anyone-with-link |
| P2-4 | 评论与 @ 提及 | 页面级评论串 + 提及通知 | GitLab wiki 评论/emoji、BookStack 评论侧栏、Notion 评论/Inbox |
| P2-5 | 命令面板 | Cmd/Ctrl+K 全局直达（页面/操作/搜索） | Notion Cmd+K、Outline command menu |
| P2-6 | 无 JS 降级 | 登录/管理/凭据至少只读可用（渐进增强）；或明确宣布 JS 必需并给出 noscript 提示 | 现状 F-6（实测断层清单） |
| P2-7 | 导出 | 单页/库导出 Markdown/HTML/ZIP（PDF 可后置） | BookStack 五格式、Outline Markdown/HTML/JSON、Notion 导出、GitLab wiki 即 git clone |
| P2-8 | 图谱/悬停预览 | 双链图谱视图、链接悬停预览 | Obsidian Publish（graph/悬停预览） |

---

## 4. 前端框架决策素材（三方案权衡矩阵）

**只列利弊，不做决定。** 决策权在用户/维护者；本节提供可验证的现状数据与三方案逐维对比。

### 4.1 现状基线（实测，2026-10-14）

- 全站唯一外部资源：`/assets/styles.css`（27,609B）；零外部 JS/CSS；无构建链、无 npm 前端依赖。
- 交互逻辑为每页内联 vanilla JS，实测体积：admin 8842B、edit 5339B、credentials 2886B、upload 2370B、login 955B、index 830B（合计 ~21KB，其中 fetch 封装 `api()` 在 login/admin/edit 等页近似重复实现）。
- 服务端模板为字符串拼接 + escapeHtml 唯一插值通道（routes.ts:28 安全不变量）。

### 4.2 权衡矩阵

| 维度 | A. 维持纯 SSR + 内联 JS（现状路线） | B. 轻框架渐进增强（htmx / Alpine） | C. SPA（React / Vue / Svelte） |
|---|---|---|---|
| 包体积 | ★ 最优：现状 0 JS 依赖，页面 1.7–13.4KB；新增交互只增内联 KB 级 | 单 script 引入、无构建产物：htmx 官方自称 "a dependency-free, browser-oriented javascript library"；Alpine 官方形态 "Plop in a script tag and get going"。两官网均未标注具体 KB 数（本次实测抓取确认），量级以发布物为准 | 框架运行时数十 KB gz 起步 + 路由/状态/请求库；首屏 payload 显著高于现状（可 code splitting 缓解） |
| 构建链复杂度 | ★ 零构建（styles.css 直接服务，产品门禁不含前端 install） | 可为零：下载单文件放 assets/ 与 styles.css 同构；亦可纳入 npm 但非必需 | 需要 npm 前端工程（打包器、TS 配置、依赖升级链）；当前产品门禁 `npm ci && npm test`（tsc + node --test）需新增前端构建/产物校验面 |
| 与 Fastify SSR 共存 | ★ 原生：模板函数即全部 UI 层 | htmx 需服务端按约定返回 HTML 片段——新增「局部渲染」路由形态，但可复用既有模板函数；Alpine 不要求服务端改动，只增强既有 DOM；两者均需与「数据页实时渲染、无页内缓存」约定（routes.ts:29）对齐 | Fastify 退为 JSON API（/api/v1 已存在是优势）；但页面域不变量需在 SPA 层重建：无权=不存在 404、维护 503、Origin CSRF、302 登录语义；可选 SSR/同构但复杂度更高 |
| 团队维护成本 | 交互复杂度上升时手写 JS 线性增长，`api()` 已出现跨页重复；无组件抽象，编辑器级功能（预览/拖拽/自动保存）手写成本高 | 学习曲线低、声明式属性替代手写 DOM 代码；admin/credentials 表格页与局部刷新受益最大；复杂客户端状态（编辑器）仍需另写 JS | 组件化长期可维护性最好、生态最大；但要求前端工程能力与依赖治理；渲染层安全从「服务端插值唯一通道」变为「客户端渲染 + API 鉴权」，escapeHtml 不变量不再覆盖 UI 层 |
| 离线/弱网 | 无缓存策略，弱网=整页刷新（页面小、无框架运行时，低端设备解析成本低）；无离线能力 | htmx 按需请求片段，弱网流量小于整页刷新；仍无离线能力 | 唯一可自然演进到离线的路线（SW 缓存、本地编辑+队列提交）；首屏后无整页刷新，弱网体验最好（配合乐观更新） |
| 对现有安全/测试面的冲击（附加维度） | ★ 无冲击（既有 web-pages/web-e2e 测试形态直接沿用） | 小：新增局部端点需沿用 GET 免 CSRF / POST Origin 约定；模板插值仍走 escapeHtml | 大：页面域测试需重写为前端测试栈 + API 测试；DESIGN.md token 需组件化重建；D-IC-06/维护闸门/CSRF 需要在客户端重新落位并补测试 |

### 4.3 事实核对备注

- htmx 引文出自 <https://htmx.org/docs/>（2026-10-14 抓取）：原文为 "a dependency-free, browser-oriented javascript library" 与 "There is no need for a build system to use it"。
- Alpine 引文出自 <https://alpinejs.dev/>（2026-10-14 抓取）。
- 两官方站点当前均未标注包体积数字，故本矩阵不引用具体 KB；SPA 各框架体积随版本变化，同样不硬编码数字——需要精确数时以发布物/bundlephobia 实测为准。

---

## 5. Sprint 拆分草案（3 个，粗粒度）

> 按完成标准结束 sprint、不承诺日历工期；每条任务含验收来源（本报告 §）。框架选择（§4）不阻塞 Sprint A/B（两案下 A/B 的任务面不变）；Sprint C 依赖框架裁决。

### Sprint A「可达性与权限」（对应 F-1/F-2/F-4/F-5）

- A1. view/browse/history/version 加「编辑此页」入口（P0-1；验收：任一文档 ≤1 跳到编辑表单）
- A2. browse「新建笔记」→ 预填模板编辑表单 → 既有 submissions 提交（P0-2；验收：浏览器内闭环）
- A3. 按角色渲染写入口，reader 只读态（P0-4；验收：bob 走查无死按钮，写操作语义不变）
- A4. 修复库级历史 diff 死链（P0-5；验收：历史页链接全 200）
- 完成标准：新用户不读文档即可完成「找→读→改→建」；读者视角无误导入口。

### Sprint B「检索与动态」（对应 F-3/F-8）

- B1. 全文检索 v1：文件名+正文命中、可见性过滤与截断语义不变（P0-3；验收：q=roadmap 命中 docs/roadmap.md）
- B2. 最近变更流：首页/库页 recent changes（P1-3）
- B3. 目录浏览增强：README 渲染 + 最后提交列（P1-4 主体）
- 完成标准：「找不到内容」与「不知道变了什么」两类抱怨消除。

### Sprint C「编辑体验」（对应 F-7/F-6 部分；前置：框架裁决 §4）

- C0. 框架决策落地第一步（若维持 A：抽公共 `api()`/组件片段；若选 B：引入并改造 admin/credentials/edit 三页；若选 C：搭前端工程与门禁面）
- C1. 编辑预览（P1-1）
- C2. 草稿自动保存 + 「我的草稿」列表（P1-2）
- C3. 编辑器附件粘贴/拖拽（P1-6）
- C4. 顶栏账户菜单与登出（P1-7）
- 完成标准：编辑-保存-找回 心流连贯；P0/P1 主张全部有对应验收证据。

---

## 附：本报告的证据与复核方式

- 实测记录：审计机 `/tmp/e2-audit/`（每页 HTML 原样留存：login/index/vaults/browse/view/edit/history*/search*/cite/credentials/admin/upload/rename/delete/version/restore/diff、bob 与 alice 视角各页、404 对照页）。
- 源码引用均带 `server/src/web/` 相对路径与行号（对 `afb7ee1`）。
- 竞品 URL 二次抽查清单见 §1.8；标注「出现于搜索结果」「未能确认」「置信度中等」处均未当作确定事实使用。
