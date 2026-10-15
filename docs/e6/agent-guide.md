# Notegit Agent 消费指南（E6 R04 骨架）

> 状态：**骨架**（S18-T2 起草，2026-10-16；DOD-E6-04 T2 份额）。面向以 HTTP 消费 Notegit 知识库的程序化 agent。读协议 v1 端点行文以 [docs/s18/api-amendments.md](../s18/api-amendments.md) 建议稿为基线，master 落契后以 api.md 为准。本指南三章（认证 / 锚定引用 / 变更感知）随端点落地持续充实；礼貌轮询节奏等容量结论待 S20 实测后补。

## 1. 认证

Agent 用**既有访问凭据**（identity §3，非交互形态=Bearer token；与人用浏览器同一账号体系，审计主体=签发凭据的员工）。

- **获取**：由员工经 `POST /api/v1/credentials` 自助签发（或管理员代管），明文 `ngt_<43 字符>` **仅创建响应出现一次**；此后任何端点不回显，仅 `ngt_ab…wxyz` 形式提示。
- **携带**：`Authorization: Bearer ngt_…`。Authorization 头在场即优先（显式凭据）；省略头时服务端回退浏览器会话 Cookie（agent 场景不适用）。
- **作用域**：凭据创建时可选 `{access: "read"|"read_write", vaults: [<slug 清单>]}`（只能收窄）。读协议端点门槛=read；read 范围凭据即可消费全部读面。**越出 scope 清单的库与不存在的库同 404**（identity §3.4/D-IC-06——不可枚举探测）。
- **失败形态**：401 `{error:{code:E-AUTH-001..004, message, details:{reason}}}`——001 未认证/过期、002 凭据过期、003 凭据撤销、004 账号停用。凭据撤销**即时生效**（下一请求 401，identity §5.2，无缓存）。

## 2. 锚定引用

引用三要素 = **库 / 路径 @ commit**（与站内 `/cite?c=<slug>/<path>@<commit>` 解析格式对齐——分支会漂移，commit 不会，D38）。

- **发现库**：`GET /api/v1/vaults` → 当前凭据可见库清单（S18-T1 端点）。
- **发现路径**：`GET /api/v1/vaults/{slug}/tree[?ref=<commit OID>]` → 扁平路径数组 `{entries:[{path,type,size}], truncated, commit_oid}`（type ∈ tree|blob；上限 1000 条 + truncated 如实标注）。
- **读取文档**：`GET /api/v1/vaults/{slug}/docs/{path}[?ref=<commit OID>]` → `{frontmatter, body, body_raw, size_bytes, commit_oid, …}`。仅 `.md`（其余类型 415 如实拒）；`frontmatter` 畸形/豁免时为 null 且 `body`=原文全量。
- **ref 纪律（D38）**：只收 commit OID；**省略 ref = 默认分支 HEAD（会漂移）**。做持久引用时，以响应中的 `commit_oid` 锚定再读（`?ref=<commit_oid>`）——历史内容永久可复取且 `ETag` 恒定；分支名不支持（400 如实）。
- **协商缓存**：两读取端点均回 `ETag: "<commit_oid>"` + `Cache-Control: no-cache`；携带 `If-None-Match` 重验证命中即 304（零传输）。锚定 ref 的内容不可变，ETag 永久命中。
- 引用落款建议（与 /cite 同构）：`<slug>/<path>@<commit_oid 前 12 位以上>`——可经站内 `/cite` 深链到对应历史版本页人机互查。

## 3. 变更感知

判断「库内容是否变化 / 我的读取是否过期」的两条判据：

- **主判据 = 索引状态端点（S18-T1，届时已在）**：`GET /api/v1/vaults/{slug}/index-status` → `{head_commit, indexed_at, lag_ms, consecutive_failures, …}`。轮询比较 `head_commit` 是否前进即知默认分支是否有新提交；`lag_ms`/`consecutive_failures` 如实反映派生索引延迟与失败态（失败不阻断发布，只在此可见——架构 §9）。响应形态以该端点落契文本为准。
- **轻量判据 = ETag 重验证**：对 tree/docs 端点带 `If-None-Match: "<上次 commit_oid>"` 重发——304 即无变化（零内容传输），200 即 HEAD 已前进（响应携带新 commit_oid 与新 ETag）。适合作轮询探针：一次请求同时完成「变更发现」与「内容获取」。
- **礼貌轮询**：读面无推送；建议以分钟级间隔轮询 index-status、以事件驱动节奏消费（容量底线与建议节奏待 S20 实测入档 docs/e6/capacity.md 后补）。

## 端点一览（读协议 v1）

| 端点 | 形态 | 持有 |
|---|---|---|
| `GET /api/v1/vaults` | 可见库清单 | S18-T1 |
| `GET /api/v1/vaults/{slug}/index-status` | 索引状态（变更感知） | S18-T1 |
| `GET /api/v1/vaults/{slug}/tree[?ref=OID]` | 全树扁平清单 | S18-T2 |
| `GET /api/v1/vaults/{slug}/docs/{path}[?ref=OID]` | 单文档（frontmatter+正文双形态） | S18-T2 |

## 写入与并发（S20 容量实测建议，2026-10-16）

- 并发写同一分支必然冲突：`base_commit` CAS 使同 base 并发提交**恰一个 201、
  其余 409**（实测 8 并发=1×201+7×409）。正确模式＝收到 409 后**取新 head 重试**
  （409 信封含当前 tip）。
- 单分支顺序写上限 ≈6 次/秒（含提交与索引派生）；大批量变更放进**一次提交的
  changes 数组**（500 文档单提交实测正常），不要逐条提交。
- 读并发 ≤10–20 时 p95 <200ms；超过 ~200 rps 后排队延迟线性上升（不报错）。
  agent 轮询请用 `index-status` 而非高频全量拉取。
