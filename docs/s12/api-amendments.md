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

**现状**：编辑页族（`GET /vaults/{slug}/edit/{path}` 六字段页、README 豁免页、`GET /vaults/{slug}/edit/new` 新建页）新增三项编辑体验（页面呈现层描述；均零新判定面——安全判定单一来源不变）：

**建议 api.md §13 既有 `GET /vaults/{slug}/edit/{path}` 行 append 文本**：

```markdown
；S12-T1 编辑体验补记：① 双栏预览——正文 textarea 左/预览栏右（DESIGN.md token 双栏布局；窄屏折叠为编辑/预览切换），正文变化防抖调 POST /edit-preview/{slug}/{path} 片段端点交换预览栏（预览=发布后 view 同一渲染管线，见 B1 行；只读成员态不携带预览接线）；② 草稿自动保存——页内定时器（默认 30s，页面顶部可调常量）+ 失焦触发，调既有 §7 drafts PUT（body 含 content+base_commit，与手动保存同一组装面；仅内容有变化时落库；状态行如实呈现「已自动保存 HH:MM」/「自动保存失败——下个间隔重试」非阻断；提交成功后停自动保存——草稿清理语义不变）；README 豁免页与 edit/new 新建页同样支持（新建页路径未定形时不落库）；③ 附件粘贴/拖拽——正文 textarea paste/drop 取文件 → 既有 POST /vaults/{slug}/upload/{文档所在目录}/{原文件名}（octet-stream，S4-T4 端点全量判定——编辑器不预判类型白名单，端点拒即如实呈现 error.code+hint）→ 成功按类型回插引用（image/* → `![](url)`；其余 → `[name](url)`，光标处插入不覆盖既有正文；重名覆盖由端点 upsert 语义判定并如实呈现）；上传中/失败状态行提示；只读成员态不携带全部三项接线（页面无写操作形态延续）
```

**同步建议**：§13 尾注「维护模式 web 写缝」段落可补一句「`POST /edit-preview/*` 为只读推导端点，位于 `/vaults/` 写缝前缀之外——维护模式放行（读路径族）」，避免后续读者按前缀规则误判其维护行为。
