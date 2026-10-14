# api.md §13 补录修订建议（S10-T3 站内新建笔记）

- **状态**：S10-T3 起草（2026-10-14）；**2026-10-14 master 已裁决落契**：A1 逐字采纳（api.md §13 新增 edit/new 行）；A2 撤——A1 行自足（browse 入口 editor+ 可见已含），避免双记漂移；A3 知悉在案（upsert 语义不变、HEAD 探测依赖记录——未来 view 缺失路径形态变化时需同步，已记入 E2 cross-cutting 关注）。
- **范围**：S10-T3 交付的站内新建页面（`GET /vaults/{slug}/edit/new`）+ browse 目录页「新建笔记」入口呈现 + 一笔形状差异如实记录（A3，无需契约变更）。
- **来源**：E2 research §2.3 F-5/P0-2（现状：新建须本地造好 .md 再上传）；sprint S10 D5 裁决（站内新建 = browse 入口 → edit/new 模板表单 → 既有 submissions 端点，不新建平行写通道）；S10-T3 实现与测试（`server/test/web-edit-new.test.ts` 11 测试）。
- **约定**：每条给「现状 → 建议 api.md 文本（逐字可用）→ 理由 → 待 master 裁决点」。建议文本中的行文为建议值，master 可改置。

## A1 站内新建笔记页（已实现、未入契约）

**现状**：S10-T3 已实现 `GET /vaults/{slug}/edit/new[?dir=][&path=]`（`server/src/web/edit/routes.ts` 静态段路由，优先于既有 `edit/*` 通配）：browse「新建笔记」入口的落点，服务端直出复用编辑表单模板族（`edit/pages.ts` `newNotePage`）的「新建模式」——路径输入（预填 `?dir=` 目录前缀）、title 必填（required + 服务端 E-FM-003 兜底）、正文空、base_commit=打开时默认分支 HEAD 嵌入（编辑页既有逻辑）；提交走既有 §8.2 `POST /api/v1/vaults/{slug}/submissions`（**不新建端点**），成功后页内脚本跳转新文档 view 页（编辑页既有 `location.href` 约定复用）。页面门槛=read 成员（D-IC-06 无权=不存在 404 同页；reader 只读态与 S10-T2 edit GET 同形——字段禁用+只读徽章、无提交控件，D4）；写权限由提交时发布组件判定。

**建议 api.md 文本**（§13 表新增一行，置于 `GET /vaults/{slug}/edit/{path}` 行之后）：

```markdown
| GET /vaults/{slug}/edit/new[?dir=&path=] | 站内新建笔记页（S10-T3，S10 D5）：browse「新建笔记」入口（editor+ 可见，canWriteVault 门控——与 S10-T2 写入口同形；目录上下文 `?dir=`=当前 browse 目录）落点；复用编辑表单模板族呈现「新建模式」——路径输入（预填目录前缀）、title 必填（E-FM-003 映射既有兜底）、正文空、base commit=打开时默认分支 HEAD（编辑页既有嵌入逻辑）；提交=§8.2 submissions 端点（不新建端点），成功后跳转新文档 view 页（编辑页既有跳转约定）；**防误覆盖**（submissions 对 upsert 语义是覆盖同名）：`?path=` 指向既有条目 → 服务端直出提示态（不呈现创建表单，引导编辑既有文件/换路径），不存在 → 确认态（预填完整路径+「将创建新文件」标注，可回填本人现行草稿），表单脚本提交前对候选路径 HEAD view URL 探测存在性、200 即阻断（呈现层防护——D17，POST 端点行为不变）；非 `.md` `?path=` 404（与 edit 族同判）、畸形 `dir`/`path` 404 反存在性；静态段 `new` 优先于 `edit/{path}` 通配（既有 edit 路由行为零变化——文件名恰为 `new.md` 等实路径仍走通配编辑页）；页面门槛=read 成员（reader 只读态与 edit GET 同形，D4；写权限由提交时发布组件判定） | S10-T3 |
```

**理由**：P0-2 验收面（浏览器内 新建→提交→view 闭环）成为页面族正式 URL；不落契约则入口 URL 与 `?dir=`/`?path=` 语义无词汇表，S10 验收（DOD-E2-02）与后续 sprint 消费时无统一参照。行为已实现并有 11 测试锁定（三角色矩阵、闭环、防误覆盖提示态、E-FM-003 复用、草稿联动、HEAD 探测契约）。

**待裁决**：(a) `?path=` 确认态是否值得入契约（也可只记 `?dir=` 形态，把确认态视为实现细节——本建议保留，因其承担「服务端直出对已存在路径返回提示态」的防误覆盖语义）；(b) 文件名恰为 `new`（无扩展名）的既有文件经编辑族不可达的边界（既有 `edit/*` 对非 .md 本就 404，实际行为无变化——建议在行内保留一句说明，如上）。

## A2 browse 目录页行补记（入口呈现，建议微改既有行）

**现状**：S10-T3 在 browse 目录页头为写者（canWriteVault 实算）新增「新建笔记」主操作位按钮（`btn btn-primary`——DESIGN.md 珊瑚主 CTA 语义，coral 仅主 CTA），链接 `GET /vaults/{slug}/edit/new?dir=<当前目录>`（库根不带 `?dir=`）；reader 不渲染（与 S10-T2 上传/编辑/重命名/删除写入口同形，只读徽章同位）。

**建议**：§13 既有 `GET /vaults/{slug}/browse[/{path}]` 行（S4-T1）的页面描述**追加一句**（具体措辞 master 定）：

```markdown
；目录头写入口（S10-T2：上传/编辑/重命名/删除按 canWriteVault 渲染）之外，S10-T3 增「新建笔记」主按钮（editor+ 可见，目录上下文=当前目录，指向 /vaults/{slug}/edit/new?dir=<目录>；reader 不渲染）
```

**理由**：browse 行是目录页行为的契约锚点；入口可见性语义（reader 不见）已被验收场景 S3（bob 走查）消费，宜随行入册。

**待裁决**：追加为一句话（本建议，最小改动）还是在 A1 行内自足（browse 行不动——A1 行已含「browse 入口 editor+ 可见」描述，双记有漂移风险；若 master 取后者，本条撤）。

## A3 形状差异记录：表单侧防误覆盖与 HEAD view 探测（无需契约变更）

submissions §8.2 的 upsert（覆盖同名）语义**不因本任务改变**（D17：呈现层改动不替代端点语义；reader POST 403 等鉴权面由 S10-T2 测试锁定）。新建模式的防误覆盖全部在表单侧：(1) 服务端直出对 `?path=` 既有路径返回提示态（A1 行已含）；(2) 表单脚本提交前对候选路径发 **HEAD 请求到 view 页 URL**（`GET /vaults/{slug}/view/{path}` 的自动 HEAD 形态——Fastify GET 路由默认暴露）判定存在性，200 即阻断。这使 view 页的状态码成为页面脚本的行为依赖，已由 `web-edit-new.test.ts` 以 HEAD 探测契约测试锁定（既有 .md 200 / 缺失 404）。**不建议本次改 §8.2 或 view 行为**；记录在案供 master 知悉：若未来 view 页对缺失路径改形态（如 302），新建表单的存在性探测需同步。

## 落点汇总

| id | 契约文件 | 落点 | 性质 | 实现状态 |
|---|---|---|---|---|
| A1 | api.md | §13 表新增 edit/new 行 | 页面路由入册 | 已实现（S10-T3） |
| A2 | api.md | §13 browse 行追加一句 | 入口呈现补记 | 已实现（S10-T3） |
| A3 | —（本文件记录） | — | 形状差异（upsert 语义不变 + HEAD 探测依赖） | — |
