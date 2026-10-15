# api.md 修订建议稿（S18）

> S18 各并行任务各持一节（二级标题隔离；只追加自己的节，不动他人内容）。draft-first——本文件不改动 docs/contracts/ 下任何文件；master 裁决落契后归位（先例：docs/s1/search-index-amendments.md C2/C3/C4、docs/s11/api-amendments.md）。本 sprint 是机器面（E6 读协议 v1）：新端点全部为资源型 GET JSON，错误信封沿用既有 `{error:{code,message}}`（§1），认证沿用统一缝（§2 双载体四状态）。

## T2 目录树与文档读取（S18-T2，E6 R01/D36/D37/D38；S18 D2/D3/D4）

- **状态**：S18-T2 起草（2026-10-16）；待 master 裁决。
- **范围**：api.md 新增 §3.9「知识读取（agent 读协议 v1，任意 read 成员）」两行；§1 错误码注册表新增一行 E-RES-009。实现自本任务（`server/src/api-read/{tree,docs}.ts`；测试 `server/test/api-read-{tree,docs}.test.ts` 21 例）。
- **共同语义**（两端点一致，与 §3.6 检索端点同一判定面）：认证=统一缝双载体（匿名 401 E-AUTH-001..004）；门槛=authorize read（reader 即满足，token 载体按 scope 交集收窄 identity §3.4——越范围与无权同 404）；无权/不存在/未知 OID/未知路径一律 404 E-RES-001 同信封（D-IC-06 API 面——反存在性，零存在性泄露）；GET 免 CSRF；只读不记审计行；写通道零变更。缓存=协商缓存（2026-10-15 热修同构）：`ETag: "<commit_oid>"` + `Cache-Control: no-cache`，`If-None-Match` 命中回 304（空体）——内容即 commit 锚定，HEAD 缺省随提交前进即时失效、锚定 ref 的 ETag 恒定。

### B1 GET /api/v1/vaults/{slug}/tree[?ref=<commit OID>]（逐字可用建议文本）

```markdown
- **GET /api/v1/vaults/{slug}/tree[?ref=<commit OID>]**（读；E6 读协议 v1，S18-T2/D4/D38）：库默认分支或指定提交的**全树扁平清单**（agent 自行构树，不预设层级形态）。成功 200 `{vault, ref, commit_oid, entries: [{path, type, size}], truncated}`——`ref`=请求回显（缺省回显默认分支名），`commit_oid`=解析后全 SHA（缺省=默认分支 HEAD）；`entries`=扁平路径数组（`ls-tree -r -t` 全树递归，树序=深度优先字节序；type ∈ tree|blob，blob 的 size=字节数、tree 的 size=null；子模块不属 v1 契约、如实不出现）；上限 1000 条超出 `truncated:true` 如实标注（不承诺分页——Q-E6-1 v1 形态，与检索 100 截断同哲学）。`ref` 语义（D38）：只收 commit OID（hex 缩写/全 SHA，与 version 页同判）；缺省=默认分支 HEAD（空库 unborn → 404 E-RES-001 如实）；分支名等 rev 形态 **400 E-RES-004** 如实拒（分支会漂移、commit 不会——引用锚定优先）；hex 形态但未知/非提交 → 404 E-RES-001 反存在性。错误：401（§1 通用）；400/404/403 同上通用语义；503 无码信封（仓库存储未挂接/读取失败——仅故障形态）。
```

### B2 GET /api/v1/vaults/{slug}/docs/{path}[?ref=<commit OID>]（逐字可用建议文本）

```markdown
- **GET /api/v1/vaults/{slug}/docs/{path}[?ref=<commit OID>]**（读；E6 读协议 v1，S18-T2/D3/D38）：单文档读取（原始 Markdown＋元数据双给全，不预设消费方渲染栈）。成功 200 `{vault, path, ref, commit_oid, frontmatter, body, body_raw, size_bytes, fetched_at}`——`ref`/`commit_oid` 语义同 tree 行；`body_raw`=该提交的文件原文；`body`=frontmatter 剥离后正文（闭合 `---` 之后原文——与 view/version 页、检索 body 派生同一切面）；`size_bytes`=原始字节数；`fetched_at`=服务端响应时刻 ISO 8601（**不可信为内容时间**——内容时间锚=commit_oid）。`frontmatter` 三态如实：闭合块且保守行式解析成功 → 对象（title/tags/status 等标量与字符串列表；与 validation §3 六字段契约对应）；无块（README 等豁免/无 frontmatter）、块未闭合、或块解析失败（畸形）→ **null 且 body=原文全量**（读取面不做发布校验——畸形不阻断读取）。仅 `.md`（与页面族同判）：其余类型 **415 E-RES-009** 如实拒（v1 不提供）；目录路径/不存在路径 → 404 E-RES-001。历史 blob 走 version 页同一读取面（同一棵树——D38 历史 blob 鉴权同源）。错误：401；400 E-RES-004（ref 非 OID 形态）；404 E-RES-001（同上反存在性）；415 E-RES-009；503 无码信封。
```

### B3 §1 错误码注册表新增一行

| 码 | HTTP | 语义 | 依据 |
|---|---|---|---|
| E-RES-009 | 415 | 类型不支持：读协议 v1 仅提供 .md 知识文档（docs 端点） | S18-T2/D3；建议稿（本节），master 裁决落 §1 |

### 理由

1. **ref=OID 与 version 页同一棵树**（D38）：历史读取复用 `readEntryAtCommit`（S5-T2 读取面）而非第三套 ls-tree 解析——「锚定引用」是底座核心承诺，同一实现消除两处语义漂移的可能；分支名 400 如实拒而非静默当 HEAD（避免分支漂移锚）。
2. **frontmatter 三态而非校验复读**（D36）：读取面消费 `extractFrontmatter` 单一切块语义（三入口同一解析面先例），字段解析保守行式（search 派生面同哲学——不引 YAML 依赖）；畸形降级为 null+原文全量而非 4xx——agent 拿原始事实自行判断，读取面不执行发布校验。
3. **truncated 而非分页**（Q-E6-1 v1）：与检索 100 截断同哲学；单库超 1000 条实测出现前不预设分页参数形态（避免契约半成品）。
4. **E-RES-009 独立新码**：415 语义在 §1 无既有码可承载；沿用「沿用既有风格或建议新码」通道进建议稿（D12 先例），不静默复用语义不符的 404/400。

### 待裁决

(a) `ref` 缺省回显默认分支名（本节立场——agent 可知「读到的是哪个分支的头」）还是回显 null（更纯的 echo 语义）；
(b) `frontmatter` 保守解析的边界形态（块标量 `|`/`>`、嵌套映射 → null 降级）是否需要逐形态入契约文，还是保持「解析失败→null」一句承载；
(c) E-RES-009 码名与落 §1 注册表时机（与 B1/B2 同批落契）。

### 落点汇总

| id | 契约文件 | 落点 | 性质 | 实现状态 |
|---|---|---|---|---|
| B1 | api.md | 新增 §3.9 GET /vaults/{slug}/tree 行 | 读协议 v1 端点入册 | 已实现（S18-T2，9 测试） |
| B2 | api.md | 新增 §3.9 GET /vaults/{slug}/docs/{path} 行 | 读协议 v1 端点入册 | 已实现（S18-T2，12 测试） |
| B3 | api.md | §1 注册表新增 E-RES-009 行 | 错误码入册 | 已实现（415 断言锁定） |
