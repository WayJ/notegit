# S12 编辑体验契约补正建议（§13 页面路由）

- **状态**：S12-T1 起草（2026-10-14），draft-first——待 master 评审。评审通过后由 master 落契约原文（§13 表）并在 epic 的 Decisions (ADR) 记录；按仓库约束，本文件不改契约正文。先例：metrics-face-amendments.md（S8-T2）、docs/s11/api-amendments.md（S11 D-batch）。
- **范围**：S12-T1 落地的契约外事实面——编辑预览片段端点（新行）+ 编辑页行为补记（自动保存/粘贴拖拽回插/双栏预览呈现）。自动保存与粘贴编排均**零新端点**（复用 §7 drafts PUT 与 §13 既有 upload POST——本建议稿只补呈现描述）。
- **实现状态**：全部已实现并测试（预览端点 `server/src/web/edit/preview.ts`，注册点 `edit/routes.ts`；页面接线 `edit/pages.ts`；测试 `server/test/web-edit-preview.test.ts` 6 项 + `web-edit-autosave.test.ts` 4 项 + `web-edit-paste.test.ts` 3 项，先红后绿；npm test 全绿）。

## B1 编辑预览片段端点（api.md §13 新增行）

**现状**：S12-T1 已实现 `POST /edit-preview/{slug}/{path}`（`server/src/web/edit/preview.ts`）：请求体 `{content}`（编辑器组装全文，含 frontmatter），成功 200 `text/html` **片段**（非整页）——与 `GET /vaults/{slug}/view/{path}` 正文（`article#doc` 内层）**逐字一致**：同一渲染管线（`web/view/render.ts` 只读 import——服务端清理唯一通道不变量延续：原始 HTML 剥离、URL 协议白名单、脚本/事件属性/危险协议不可达）、frontmatter 同规则剥离、仓库相对图片同一两遍法解析为鉴权附件通道 URL。

**建议 api.md §13 表新增行**：

```markdown
| POST /edit-preview/{slug}/{path} | 编辑预览片段端点（S12-T1，sprint D2）：请求体 `{content}`（编辑器组装全文）→ 服务端安全渲染返回 HTML **片段**（与 view 正文同一渲染管线与清理通道——render.ts 唯一通道不变量延续：script/事件属性/危险协议不可达；frontmatter 同规则剥离；仓库相对图片两遍法解析为鉴权附件 URL，{path} 为引用解析基准，不要求存在——渲染对象是请求体内容，无存在性 oracle）；与 view 页正文逐字一致（预览=发布后渲染，测试锁定）；门槛=read 成员（与 edit GET 同判：reader 200、无权/不存在/畸形路径 404 同页同体 D-IC-06、未认证 302 /login）；成功 200 text/html 片段、请求形态错误 400 E-RES-004、超渲染上限（1 MiB，与 view 同值同因）413 如实拒渲染；**维护模式放行**（只读推导——零写面（不落库、不产 Git 版本、不记审计），§2「候选校验（§8.2 validations）为只读推导，放行」同款先例；路径在维护写缝前缀（/vaults/ 非安全方法）之外，两道闸门（/api/v1、/vaults/）均不适用——见下「路径裁决注」）；会话 Cookie 载体受 CSRF 同源校验（identity §4）；JSON 传输护栏插件作用域随生效 maxDocumentBytes 只升不降（drafts/submissions 同形态） | S12-T1 |
```

**路径裁决注（供 master 评审）**：sprint 计划示例路径为 `POST /vaults/{slug}/preview`；实现落在 `/edit-preview/{slug}/{path}`。原因：§13 尾注的 web 维护写缝按前缀判定（凡 `/vaults/` 下非安全方法维护模式 503——upload/rename/delete/restore 写端点自动覆盖面），示例路径会被该前缀规则拦为 503，与「维护模式放行（只读推导）」要求冲突；豁免需改 `web/write-gate.ts`（共享守卫文件，不在 S12-T1 任务写面）。裁决=路径注册在前缀之外（语义等价：两道维护闸门前缀均不触及，维护中天然放行，写端点行为零变化）。master 如倾向 `/vaults/{slug}/preview` 形态，可在 write-gate 增设只读推导豁免清单后迁移路径（端点逻辑不变，§13 行与页面 PREVIEW_URL 常量随迁）。

## B2 编辑页行为补记（§13 既有 edit 行 append）

**现状**：编辑页族新增三项编辑体验（页面呈现层描述；均零新判定面——安全判定单一来源不变）。**作用域**：① 双栏预览与 ③ 粘贴/拖拽仅六字段编辑页（`GET /vaults/{slug}/edit/{path}`——任务 D2/D3/D4 条款以「编辑页」为面）；② 草稿自动保存覆盖三页（六字段页 + README 豁免页 + `edit/new` 新建页）：

**建议 api.md §13 既有 `GET /vaults/{slug}/edit/{path}` 行 append 文本**：

```markdown
；S12-T1 编辑体验补记：① 双栏预览（六字段页）——正文 textarea 左/预览栏右（DESIGN.md token 双栏布局；窄屏折叠为编辑/预览切换），正文变化防抖调 POST /edit-preview/{slug}/{path} 片段端点交换预览栏（预览=发布后 view 同一渲染管线，见 B1 行；只读成员态不携带预览接线）；② 草稿自动保存（六字段页/README 豁免页/edit-new 新建页）——页内定时器（默认 30s，页面顶部可调常量）+ 失焦触发，调既有 §7 drafts PUT（body 含 content+base_commit，与手动保存同一组装面；仅内容有变化时落库；状态行如实呈现「已自动保存 HH:MM」/「自动保存失败——下个间隔重试」非阻断；提交成功后停自动保存——草稿清理语义不变；新建页路径未定形时不落库）；③ 附件粘贴/拖拽（六字段页）——正文 textarea paste/drop 取文件 → 既有 POST /vaults/{slug}/upload/{文档所在目录}/{原文件名}（octet-stream，S4-T4 端点全量判定——编辑器不预判类型白名单，端点拒即如实呈现 error.code+hint）→ 成功按类型回插引用（image/* → `![](url)`；其余 → `[name](url)`，光标处插入不覆盖既有正文；重名覆盖由端点 upsert 语义判定并如实呈现）；上传中/失败状态行提示；只读成员态不携带全部三项接线（页面无写操作形态延续）
```

**同步建议**：§13 尾注「维护模式 web 写缝」段落可补一句「`POST /edit-preview/*` 为只读推导端点，位于 `/vaults/` 写缝前缀之外——维护模式放行（读路径族）」，避免后续读者按前缀规则误判其维护行为。

---

## §13 我的草稿页行 + 共享布局顶栏账户菜单（S12-T2——G08/G09）

- **状态**：S12-T2 起草（2026-10-14）；待 master 裁决。
- **范围**：新页面 `GET /drafts`（跨库本人现行草稿列表）+ 共享布局 `layout()` 顶栏账户菜单（全站登录态页面右上用户下拉）+ 首页 `GET /` 微调（原独立退出按钮移除，顶栏取代）+ 顶栏「我的草稿」入口。
- **来源**：sprint S12 D3（复用 §7 既有 drafts 存储，零新 API）；research §2.3 F-9（登出仅首页）/ P1-2（草稿只能逐路径撞见）/ P1-7（竞品通用顶栏形态）；实现 `server/src/web/drafts/`（query/pages/routes 新模块）+ `web/pages.ts`（layout/topNav/indexPage）+ `web/routes.ts`（组装点 append 一行）+ coordinator 2026-10-14 批准的呈现层扩展（cite 族三页与 history/upload/rename 域状态页/diff/历史版本页可选 viewer 接线）；测试 `server/test/web-drafts-routes.test.ts`（6 例）+ `web-topbar-account.test.ts`（9 例）——先红后绿。
- **约定**：给「现状 → 建议 api.md 文本（逐字可用）→ 理由 → 待裁决点」。

### A1 我的草稿页（已实现、未入契约）

**现状**：S12-T2 已实现 `GET /drafts`（`server/src/web/drafts/routes.ts`，组装点 append 一行注册）：跨库列出当前员工本人现行草稿——数据源=drafts 表既有按作者私有存储（§7 写入面不变，本页只读，零写入）；现行语义=status='active'（committed 终态行不列，与 `DraftsService.list` 一致）；条目=库 slug（browse 入口链接）/路径/更新时间（相对时间——与最近变更条目同形态件 `formatRelativeTime`）/「继续编辑」链接（既有 edit 页 URL 同构、逐段编码）；按当前员工库成员关系实时过滤（查询 SQL JOIN `vault_members`——与检索/最近变更同一判定面、无缓存）；排序更新时间新→旧（同刻库 slug/路径稳定序），无上限截断（本页是本人现行草稿的唯一汇总入口——截断即不可达；行数受库内路径数天然约束）；空态如实呈现；页面门槛=任意认证员工（未认证 302 /login）；GET 免 CSRF、无写操作。

**撤权呈现形态（裁决记录）**：撤权库的草稿行**不呈现**（呈现层过滤，非删除——草稿数据保留，重新获权后恢复可见，页面标注过滤口径）。依据：其「继续编辑」链接对非成员将 404（D-IC-06 反存在性同判）——呈现不可达入口不如如实隐藏；且与检索/最近变更的成员过滤同一判定面（identity §5.1 第 2 层实时查表）。测试锁定（撤权后该库行消失、未撤权库不受影响、数据行保留 3 断言）。

**建议 api.md 文本**（§13 表新增一行，置于页面族行后）：

```markdown
| GET /drafts | 我的草稿页（S12-T2，S12 D3）：跨库列出当前员工本人现行草稿（status='active'；committed 终态不列）——数据源=drafts 表既有按作者私有存储（§7 写入面不变，本页只读）；条目=库 slug（browse 入口链接）/路径/更新时间（相对时间）/「继续编辑」链接（既有 edit 页）；按当前员工库成员关系实时过滤（JOIN vault_members——与检索/最近变更同一判定面；撤权库草稿行不呈现，数据保留、重新获权后恢复可见）；排序更新时间新→旧（同刻库 slug/路径稳定序），无上限截断（本人现行草稿唯一汇总入口）；页面门槛=任意认证员工（未认证 302 /login）；GET 免 CSRF、无写操作 | S12-T2 |
```

**理由**：「草稿只能逐路径撞见」（research P1-2）的汇总面成为页面族正式 URL；不落契约则成员过滤语义（与检索同一判定面）、现行草稿口径（active-only）、撤权呈现形态无词汇表，验收与后续消费无统一参照。行为已实现并有 6 测试锁定（三态门槛、跨库排序、作者私有零混入、撤权形态、committed 不列）。

**待裁决**：(a)「无上限截断」是否入契约（也可只记「有排序无分页」留实现余地——本建议保留明示，与测试锁定一致）；(b) 撤权呈现形态是否同时在 §7 草稿端点节补一句（本页与 §7 API 列表面共用该语义——§7 的按库列表经 authorize 先行 404，天然不呈现；跨库页才显式过滤，若 master 认为无需双记，仅保留 §13 行）。

### A2 共享布局顶栏账户菜单（建议 §13 layout 壳补记）

**现状**：S12-T2 起 `layout()`（`web/pages.ts`，全站共享壳）登录态页面右上呈现账户菜单：`<details class="nav-account">` 零 JS 下拉（原生开合——无脚本依赖，渐进增强）——摘要=display_name 徽章（DESIGN.md badge-pill 既有 token；displayName 缺省如实回落用户名）+ 用户名（.nav-user，小屏沿既有折叠）；下拉=「我的凭据」（/credentials）/「管理」（/admin，仅实例管理员——呈现层沿用 `PageNav.user.isAdmin` 既有判定源，S2-T8「普通成员全页无 /admin」断言不变）/「退出登录」（id="logout"——顶栏全域承担；页内脚本调既有 `POST /api/v1/auth/logout` 后跳 /login，端点幂等语义不变；脚本并入页面唯一 `<script>` 块——每页恰一脚本的既有断言保持）。首页原独立退出按钮与提示位移除（登出入口不重复）；顶栏主菜单新增「我的草稿」入口（/drafts，认证全员可见——匿名壳不呈现）。账户位覆盖面：模板传 viewer 的页面族全量 + coordinator 批准扩展（cite 族三页、history/upload/rename 域状态页、diff/历史版本页——可选 viewer 参数，缺省兼容旧调用形态）；edit/ 域状态页本次未接（见 A3 待办）。

**建议**：§13 既有共享布局（layout 壳）描述**追加一句**（措辞 master 定）：

```markdown
；S12-T2 起登录态页面右上账户菜单（零 JS 下拉：display_name 徽章+用户名；我的凭据/管理（仅实例管理员）/退出登录——调既有 POST /api/v1/auth/logout 后跳 /login，端点语义不变；首页原独立退出按钮移除）+ 主菜单「我的草稿」入口（认证全员）
```

**理由**：登出从「仅首页」（research F-9）转为布局级全域可用是 G09 的验收面（S12 场景 S5「登出全域可用」）；GET / 行的原退出按钮移除需契约锚点，避免后续任务误判为回归。

**待裁决**：追加一句（本建议）还是在 A1 行内含描述（双记漂移风险——若 master 取后者，本条撤）。

### A3 形状差异与待办记录（无需契约变更）

1. **edit/ 域状态页未接 viewer**（coordinator 2026-10-14 裁决）：T1 并行持有 edit/ 域，本任务不碰；`editStatePage` 的顶栏账户位接线留给 Wave 2 T3 共享抽取时统一收口（T3 机械改造全部页面）。
2. **display_name 徽章渐进接线**：`PageNav.user.displayName` 为可选字段——首页与 /drafts 已接（路由实时查库，与 shell GET / 同形态）；其余页面模块 viewer 暂不携带 display_name（徽章如实回落用户名，结构同形）；T3 收口时统一补传。
3. **restorePage（还原确认页）未接 viewer**：不在本次批准清单（coordinator 批准面=cite 族/状态页/diff/version）；T3 收口候选。
4. **账户菜单样式**：零 JS 形态优先（任务约束——assets/ 为 T3 写面，本任务零改）；复用既有 token 类（badge/nav-user/nav-side/commits/commit/state-note），`nav-account`/`account-menu`/`draft-item` 为结构钩子（原生 details 行为可用）；视觉精修（下拉定位/间距）随 T3 assets 域统一。
5. **移动端**：小屏沿既有折叠策略（.nav-menu/.nav-user 隐藏，账户徽章+CTA 保留——登出移动端可达）；汉堡折叠按钮为既有后置项，不在本任务面。

### 落点汇总

| id | 契约文件 | 落点 | 性质 | 实现状态 |
|---|---|---|---|---|
| A1 | api.md | §13 表新增 /drafts 行 | 页面路由入册 | 已实现（S12-T2） |
| A2 | api.md | §13 共享布局（layout 壳）补记一句 | 顶栏账户菜单入册 | 已实现（S12-T2） |
| A3 | —（本文件记录） | — | 形状差异与待办（edit/ 域状态页、display_name 接线、restorePage、样式与移动端随 T3） | — |

---

## C. edit 域状态页 viewer 补记（S12-T3——T2 建议稿 A3-1 待办收口）

- **状态**：S12-T3 起草（2026-10-14）；已实现（实现即收口记录，无需 master 裁决即可闭环——A2 的 layout 壳账户位语义已覆盖本形态）。
- **现状**：`editStatePage`（`server/src/web/edit/pages.ts`）接入可选 `viewer` 参数（缺省兼容旧调用形态——不虚构登录态，与 T2 批准扩展同形）；`edit/routes.ts` 全部 6 处调用点（`edit/<路径>` 与 `edit/new` 两族：存储未挂接 ×2、仓库目录缺失 ×2、文件过大 ×1、正文读取失败 ×1）传入 viewer——**顶栏账户位覆盖缺口闭合**（T2 建议稿 A3-1 待办）。路由判定/门槛/重定向/状态码零变化（纯呈现层传参——禁止条款「不改 edit/routes.ts 行为」遵守；T2 在 upload/rename/history routes 的批准先例同形）。
- **契约影响**：无需 §13 行变更——状态页是 `GET /vaults/{slug}/edit/{path}` 与 `edit/new` 既有行的呈现分支，账户位语义由 A2 的 layout 壳补记覆盖；本节为 A3-1 待办闭环记录。
- **测试**：`server/test/web-topbar-account.test.ts`「edit 域状态页（存储未挂接形态）」用例**先红**（改造前无账户位）**后绿**；同测含无 viewer 兼容形态与普通成员无管理链接断言；状态页零交互脚本（唯一 `<script>`）断言保持。

## D. 共享脚本注册面（S12-T3——D19-A 第一步 / G10 / DOD-E2-09）

- **状态**：S12-T3 起草（2026-10-14）；待 master 裁决（裁点见下）。
- **现状**：新增纯资产端点 **`GET /assets/app.js`**（`server/src/web/assets.ts`——与 styles.css 同构注册：模块加载期一次读入（无打包层）、公开访问（脚本不含实例数据）、GET 免 CSRF、`application/javascript; charset=utf-8`、短缓存 `public, max-age=3600`（文件名无内容哈希，部署重启即生效窗口））。内容=各页重复内联 api() fetch 封装的最小公共抽取，普通 script 全局命名空间 **`window.ngt`**（不引模块化/打包器——零构建链约束）：
  - `ngt.api`（edit 族——原 `edit/pages.ts` 内联语义逐字：message 取向 `error.message || status`，`err.status`/`err.data` 携带（422 报告渲染与 409 冲突 tip 分支所依））；
  - `ngt.apiEnvelope`（pages.ts 族——原 login/admin/credentials 内联 FETCH_HELPER 语义逐字：message 取向 `"code: message"` 可读信封）；
  - `ngt.show`（`el.textContent = text`——无 innerHTML）。
  - 共有请求语义：同源 fetch（浏览器对非安全方法自动带 Origin——**不显式设头**）、无 body 不带 content-type、204 短路 null、JSON 解析容错回落 `{}`、非 2xx 抛 Error。**不新增能力**：无 401 跳登录、无显式 Origin 头（原内联均无——形态断言锁定，`web-assets.test.ts`）。
- **四页机械改造**（行为零变化）：login/admin/credentials（`web/pages.ts`）+ edit 域三页（六字段/README 豁免/`edit/new`——`web/edit/pages.ts`）写者形态在内联块前置恰一个 `<script src="/assets/app.js">` 引用（经典 script 按文档序执行保证 `ngt` 先就位），内联块顶部一行别名取用（`const api = ngt.apiEnvelope, show = ngt.show;` / `const api = ngt.api;`——页面特有逻辑调用面零改写）；每页仍恰一个内联 `<script>` 块。只读态 edit 页（无交互脚本）不引共享脚本（零脚本行为不变）。结构断言随新形态更新：改造页 `<script` 计数=2（src 引用+内联块），未改造页=1（`web-ui-style` / `web-topbar-account` / `web-edit-routes` 三处计数断言；XSS 防逃逸精神保持——用户内容不得多出第三处 script）。
- **抽取效果量化**（六页面渲染内联 `<script>` 块字节，同输入对比）：login 935B→437B（-53.3%）、admin 9174B→8676B、credentials 3218B→2720B、edit 六字段 11845B→11386B、edit README 4498B→4051B、edit new 9432B→8973B；**合计 39102B→36243B（-2859B）**，共享面另由浏览器缓存复用（每会话一次取 `/assets/app.js`）。
- **建议**：styles.css 先例=纯资产端点不入 §13 表（页面行）。但 D19-A 路线第一步值得一句锚点，建议 §13 尾注段（「S4-T2 起各任务在本表 append 各自页面行」句前或后）追加：

```markdown
共享静态资产（UI-RESTYLE / S12-T3）：`GET /assets/styles.css`（全站唯一共享 CSS——DESIGN.md token 契约落地）与 `GET /assets/app.js`（S12-T3 共享页脚本——各页重复内联 api() fetch 封装的最小公共抽取，普通 script 全局命名空间 `window.ngt`，行为零变化——形态断言锁定）均为纯资产端点（公开访问、GET 免 CSRF、短缓存 `public, max-age=3600`、部署重启生效窗口），不入本表页面行；引用页内联块前置恰一个 `<script src>` 引用，每页仍恰一个内联 `<script>` 块。
```

- **理由**：DOD-E2-09（A 路线第一步：共享脚本抽取+四页改造，行为零变化，测试锁定）需要契约锚点——避免后续任务把 `<script src>` 引用误判为 XSS 回归、或把共享脚本当新增能力面（如顺手加 401 跳登录）；缓存语义与 styles.css 同构可一并定夺。
- **待裁决**：(a) 尾注一句（本建议）还是并入 A2 layout 壳补记句（双记漂移风险——若取后者，本条撤）；(b) 两族错误信封（`ngt.api`/`ngt.apiEnvelope`）保留双语义为**行为零变化所依**（两族错误 message 构造不同、消费方不同）——未来若统一须单列任务，不在抽取步顺手改；(c) edit 域特有共享块（composeDoc/renderReport/自动保存——`edit/pages.ts` 内 TS 常量单源、B2 契约锚定「页内可调常量」）本步未迁共享脚本（域内单源非跨页重复；迁移即行为面外溢），是否列为后续抽取候选由 master 定。

### 落点汇总（S12-T3 追加）

| id | 契约文件 | 落点 | 性质 | 实现状态 |
|---|---|---|---|---|
| C | —（A3-1 闭环记录） | — | edit 域状态页 viewer 收口（呈现层） | 已实现（S12-T3） |
| D | api.md | §13 尾注一句（共享静态资产——styles.css + app.js） | 共享脚本注册面入册 | 已实现（S12-T3），文本待裁决 |
