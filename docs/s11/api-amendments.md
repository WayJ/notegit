# S11 API 契约补正建议（draft-first）

- **状态**：S11 各任务起草（2026-10-14），待 master 评审；评审通过后由 master 落契约原文并在 epic 的 Decisions (ADR) 记录——按仓库约束，本文件不改契约正文。先例：docs/s1/api-md-amendments.md（S4-T1）、docs/s1/search-index-amendments.md（S5，C3 即本节 §3.6 建议稿的前身）。
- **条目归属**：本文件为 S11 共用建议稿——A1 = S11-T1（全文检索 v1）；S11-T2（最近变更流）的 §13 activity 页行建议请以新条目（A2 起）追加，不改他人条目。
- **实现状态（A1）**：已实现并测试（迁移 0010 + `server/src/search/` path/body 命中面 + matched 扩展；S11-T1 新增测试先红后绿，npm test 全绿）。

## A1 api.md §3.6 行更新：命中面扩文件名+正文、matched 标注集扩展（S11-T1，D20）

**现状**：§3.6（2026-10-13 ADR D13 补录）定义命中面为「标题/标签/摘要」三字段，matched 取值隐含 `{title, tags, summary}`。实测缺口（research §2.3 F-3）：q=roadmap 0 命中而 docs/roadmap.md 存在——文件名与正文不参与匹配。

**建议**：§3.6 首行更新为以下文本（仅命中面与 matched 两处变化；鉴权过滤、LIKE 语义、排序、截断、错误码逐字保留）：

> - **GET /api/v1/search?q=<关键词>**（读）：按标题/标签/摘要/**文件名（path）/正文（body）**关键词查找**本人有权库**的已发布内容。匹配=SQL LIKE 子串（`%`/`_`/`\` 字面化；ASCII 大小写不敏感，其他文字精确子串；五字段同一语义；不引全文引擎——容量选型）。body=派生正文列（frontmatter 剥离后的 .md 全文，README 等豁免文件为文件全文；截断上界与 `validation.limits.maxDocumentBytes` 同源；空串=迁移前行/无正文语义，不参与命中）。鉴权过滤=实时 JOIN 当前成员关系（identity §5.1 同一无缓存判定面，撤权下一查询即消失）+ token scope 交集（§3.4）。成功 200 `{q, truncated, results:[{vault_slug, vault_name, path, commit_oid, title, tags, summary, matched}]}`（title=null=frontmatter 豁免文件如实记录；**matched ∈ {title, tags, summary, path, body}，顺序 title→tags→summary→path→body，至少一项**；正文片段不随响应回传——正文经 view 页呈现；确定性排序 vault→path；上限 100 行超出 truncated:true，不承诺分页）。错误：401；400 E-RES-004（缺/空 q）；422 E-RES-007（q 超 200 字符）。只读不记审计；索引滞后语义见 §3.5。（2026-10-13 ADR D13 补录；**2026-10-14 S11-T1/D20 命中面扩 path+body**。）

**要点说明**：

1. **命中面**：`title`/`tags`/`summary` 语义不变；新增 `path`（库内路径原样，含文件名）与 `body`（迁移 0010 派生列——见 docs/s11/storage-amendments.md S1）。五字段同一 LIKE 子串语义（ASCII ci、其他精确子串、通配符字面化）。
2. **matched 标注集**：`{title, tags, summary}` → `{title, tags, summary, path, body}`；固定顺序在既有三字段后追加 path、body——既有消费方（检索页 matched 标签呈现）按「既有形态」继续渲染（未知值原样呈现的兜底通道），无破坏性变更。
3. **响应形状不变**：不新增 body 字段回传（正文可近 1MiB，检索响应保持元数据+摘要片段形态；全文经 view 页/§3.5 引用呈现）。
4. **可见性与截断语义不变**：逐请求 JOIN 成员关系（撤权下一查询消失）、token scope 交集、100 行上限 + truncated 如实标注、确定性排序 vault→path 均逐字保留（DOD-E2-05 验收面）。
