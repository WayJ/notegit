# api.md 修订建议稿（S11）

> S11 各并行任务各持一节（二级标题隔离；只追加自己的节，不动他人内容——T1 检索 / T2 最近变更流）。master 裁决落契后按节归档。

## §13 activity 页行（S11-T2 最近变更流——G06/DOD-E2-06）

- **状态**：S11-T2 起草（2026-10-14）；待 master 裁决。
- **范围**：新页面 `GET /vaults/{slug}/activity`（库内最近变更）+ 首页 `GET /` 追加「最近变更」区块呈现（建议既有行补记，见 A2）。
- **来源**：sprint S11 D3（数据源=审计事件，不新增存储）；research P1-3（竞品全员具备 activity/recents）；实现 `server/src/web/activity/`（query/pages/routes）+ `web/pages.ts` 首页区块 + `web/shell.ts` 接线（coordinator 2026-10-14 批准的最小数据接线）；测试 `server/test/web-activity-home.test.ts` / `web-activity-routes.test.ts`（12 例）。
- **约定**：给「现状 → 建议 api.md 文本（逐字可用）→ 理由 → 待裁决点」。

### A1 库内最近变更页（已实现、未入契约）

**现状**：S11-T2 已实现 `GET /vaults/{slug}/activity`（`server/src/web/activity/routes.ts`，组装点 append 一行注册）：库内最近变更列表——数据源=该库审计发布事件成功行（`vault.push` / `vault.web_submit` 且 `status='succeeded'`，sprint S11 D3「派生即审计、零新表」；只读审计，不写 audit 行）；条目=作者（审计主体=认证员工，显示名+用户名）/相对时间（一分钟内=刚刚，分钟/小时/天，超一周回绝对日期）/分支/入口动作（站内编辑=web_submit、git 推送=push）/commit 短码（7 位，链接既有 `GET /vaults/{slug}/history` 库级历史页）；`detail` 携带路径（`paths[]`/`path`）则生成 view 链接（当前发布面不写路径——条件呈现）；排序新→旧（`occurred_at DESC, id DESC`），上限 20 条（`ACTIVITY_LIMIT`，超出行不呈现，如实标注「最近 N 条」，不承诺分页）；页面门槛=read 成员（authorize 实时查库；非成员/库不存在 404 同页同体 D-IC-06；未认证 302 /login）；GET 免 CSRF、无写操作。

**建议 api.md 文本**（§13 表新增一行，置于 `GET /vaults/{slug}/history[?page=N]` 行族之后）：

```markdown
| GET /vaults/{slug}/activity | 库内最近变更页（S11-T2，S11 D3）：该库最近发布事件列表——数据源=审计发布事件成功行（vault.push / vault.web_submit 且 status='succeeded'；只读审计、不新增存储）；条目=作者（审计主体=认证员工，DOD-03——不信 Git 提交元数据）/相对时间/分支/入口动作（站内编辑/git 推送）/commit 短码（链接库级 history 既有页）；detail 携带路径则链 view；排序新→旧（occurred_at DESC, id DESC）、上限 20 条（不承诺分页）；页面门槛=read 成员（D-IC-06 无权=不存在 404 同页同体；未认证 302 /login）；GET 免 CSRF、无写操作 | S11-T2 |
```

**理由**：「不知道变了什么」抱怨的库内面（G06/DOD-E2-06）成为页面族正式 URL；不落契约则数据源语义（审计成功行、非 Git 实时读）与门槛/上限无词汇表，验收与后续消费无统一参照。行为已实现并有 12 测试锁定（三角色矩阵、两事件类型、排序/上限、detail 路径条件链接、空态）。

**待裁决**：(a) 上限常量 20 与「不承诺分页」是否入契约（也可只记「有上限」留实现余地——本建议保留具体值，与测试锁定一致）；(b) `detail` 路径字段名（`paths[]`/`path`）是否升格为契约字段（当前无发布面写入，属前向兼容呈现——若 master 认为过早，可从行文删去该句，呈现逻辑无害保留）。

### A2 首页行补记（最近变更区块，建议微改既有行）

**现状**：S11-T2 在首页 `GET /`（S2-T8 入口页）既有身份卡+入口卡网格之下追加「最近变更」区块（`web/pages.ts` `indexPage` 第二参数；`web/shell.ts` GET / 接线一行——coordinator 批准的最小数据接线）：跨库最近发布，按当前员工成员关系过滤（查询 SQL 实时 JOIN `vault_members`——与检索 `search/query.ts` 同一判定面、无缓存；撤权=DELETE 行，下一渲染即消失）；条目形态与 A1 页共用同一渲染件（`activityEntryRow`——同形态保证）+库 slug 链接（browse 入口）；空态如实呈现；区块纯服务端渲染（页面仍唯一 `<script>`，无新增脚本）。

**建议**：§13 既有 `GET /` 行的页面描述**追加一句**（措辞 master 定）：

```markdown
；S11-T2 追加「最近变更」区块（跨库最近发布事件，按当前员工成员关系实时过滤——与检索同一判定面；条目形态与 /vaults/{slug}/activity 页共用；上限 20 条）
```

**理由**：首页区块是 G06 的跨库面主入口（验收场景 S3 首页 alice/bob 各自视角）；GET / 行是入口页行为的契约锚点，宜随行入册。

**待裁决**：追加一句（本建议）还是视为 A1 行的内含描述（双记漂移风险——若 master 取后者，本条撤）。

### A3 形状差异记录（无需契约变更）

1. **审计 schema 无 commit message**（identity §8：commit author/committer 为客户端可填内容元数据，不入审计；`detail` 亦不写 message）：条目「主题」呈现=分支+入口动作+commit 短码链接，按实际 schema 如实取材——DOD-E2-06 的呈现要求（作者/时间/路径或 commit 链接）已满足。若未来要呈现提交主题，需先扩审计/派生面（契约变更），不在本任务面。
2. **`web/shell.ts` 最小接线**（coordinator 2026-10-14 批准）：GET / handler 调 `web/activity/query.ts` 导出的 `recentChangesForEmployee` 并传给 `indexPage`——接线行不含鉴权/判定逻辑（成员过滤在查询函数内，实时 JOIN 语义不变）；shell 其余路由零变化。
3. **事件覆盖面**：两入口发布（web_submit=站内编辑、push=git 推送）都记审计，activity 两面都呈现；仅成功终态行呈现（rejected/pending/unresolved 不出现——在途与待核对不虚报为已发生）。

### 落点汇总

| id | 契约文件 | 落点 | 性质 | 实现状态 |
|---|---|---|---|---|
| A1 | api.md | §13 表新增 activity 行 | 页面路由入册 | 已实现（S11-T2） |
| A2 | api.md | §13 GET / 行追加一句 | 首页区块补记 | 已实现（S11-T2） |
| A3 | —（本文件记录） | — | 形状差异（无 message 字段 + shell 接线批准记录） | — |
