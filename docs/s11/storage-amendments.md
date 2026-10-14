# S11 存储模型契约补正建议（draft-first）

- **状态**：S11 各任务起草（2026-10-14），待 master 评审；评审通过后由 master 落 docs/contracts/storage-model.md 原文并在 epic 的 Decisions (ADR) 记录——按仓库约束，本文件不改契约正文。先例：docs/s1/search-index-amendments.md（S5-T3，C1 建议 storage-model 增设「派生数据表」一节——本文件 S1 是该建议块的列级增量）。
- **条目归属**：本文件为 S11 共用建议稿——S1 = S11-T1（search_index body 列）；后续任务以新条目（S2 起）追加，不改他人条目。
- **实现状态（S1）**：已实现并测试（迁移 0010 `ALTER TABLE search_index ADD COLUMN body TEXT NOT NULL DEFAULT ''`；派生面 `server/src/search/derive.ts`；重入/重建一致性测试随 S11-T1 落）。

## S1 storage-model §2（派生数据表节）search_index 注记 body 列（S11-T1，D20）

**现状**：search_index 属派生表（storage-model §2 明示「派生（不在本 schema）」；DDL 事实面在迁移 0009，docs/s1/search-index-amendments.md C1 建议以「派生数据表（非权威面）」节登记）。S5 版 DDL 无正文列——内容检索只覆盖 title/tags/summary 元数据（F-3 实测缺口：q=roadmap 0 命中而 docs/roadmap.md 存在）。

**建议**：C1 建议的 search_index DDL 块追加 `body` 列（置于 `summary` 与 `indexed_at` 之间），注释行同步：

```sql
CREATE TABLE search_index (
  vault_id   INTEGER NOT NULL,             -- 来源库（vaults.id，应用层维护；无 FK——见上）
  path       TEXT    NOT NULL,             -- 库内路径（Git tree 条目原样）
  commit_oid TEXT    NOT NULL,             -- 索引行来源的已发布默认分支 commit
  title      TEXT,                         -- frontmatter title；README 等 frontmatter 豁免文件为 NULL（如实记录无 title）
  tags       TEXT    NOT NULL,             -- JSON 数组文本（frontmatter tags；缺失/不可解析 = '[]'）
  summary    TEXT    NOT NULL,             -- 正文首段摘要片段（截断存储，长度上界 500 字符）
  body       TEXT    NOT NULL DEFAULT '',  -- S11-T1/D20：frontmatter 剥离后的 .md 正文全文（README 等豁免文件 = 文件全文；非 .md 条目不进本表，空串 = 迁移前行形态，不参与正文命中）；字节上界与 validation.limits.maxDocumentBytes 同源（1MiB——不引入第二套常量）
  indexed_at TEXT    NOT NULL,             -- 行写入时间（服务端时钟）
  PRIMARY KEY (vault_id, path)             -- 一库一路径一行（全量替换；旧路径删除即消失）
) STRICT;
```

**存量库迁移**（迁移 0010，append 于 0009 之后；版本清单断言「包含且有序」不硬编码）：

```sql
ALTER TABLE search_index ADD COLUMN body TEXT NOT NULL DEFAULT '';
```

**要点说明**：

1. **派生可重建**（架构 §3.1/D20）：body 与 title/tags/summary 同一派生写面（发布审计尾随 → 重派生 → 单事务全量替换；T5 重建入口同源），重建后逐字一致（S11-T1 测试断言）。删列重建等价于截断到空再回填。
2. **截断上界同源**：与 `validation.limits.maxDocumentBytes`（validation-defaults.json，默认 1MiB）同一常量——已发布文档本就经 E-LIMIT-001 ≤ 该界，此界是防御面（如管理员事后收紧上限时的存量内容），截断落在 UTF-8 完整字符边界。
3. **STRICT/主键不变**：迁移仅 ADD COLUMN，既有行自动得 `body=''`（如实「无正文」，不参与命中）；`server/src/db/migrations.ts` 只 append 不改既有行（共享热点文件约束）。
4. **查询面语义**：body/path 与既有字段同一 LIKE 子串语义（api.md §3.6 行更新建议见 docs/s11/api-amendments.md B1）；不建全文索引（FTS5 因 2 字 CJK 检索致命被否——D20 rejected alternatives）。
