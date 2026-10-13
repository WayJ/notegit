# api.md 补录修订建议（D6 欠账集中清偿）

- **状态**：S4-T1 起草（2026-10-13），待 master 评审。评审通过后由 master 落 `docs/contracts/api.md`（涉及 kind 注册的同步落 `storage-model.md` §5）并在 ADR 记录——按仓库约束，本文件不改契约原文。
- **范围**：S4 plan D6 列定的四笔欠账（维护端点、vault-delete、config-audit kind、本 sprint web 路由族）+ 一笔形状差异如实记录（A5，无需契约变更）。
- **来源**：S3-close 欠账累计（`.agents/notes/2026-10-13-S3-close.md`）、S3-T8 limits note open 项、S2-T7/S2-T8/T1 实现注释与 S4-T1 本任务落地。
- **约定**：每条给「现状 → 建议 api.md 文本（逐字可用）→ 理由 → 待 master 裁决点」。建议文本中的节号为建议值，master 可改置。

## A1 维护模式生命周期端点（已实现、未入契约）

**现状**：S2-T7 已实现 `POST/DELETE /api/v1/admin/maintenance`（`server/src/maintenance/routes.ts`）：实例管理员门槛、幂等（无状态迁移不记审计）、`maintenance.enable/disable` 审计行（storage-model §5 已注册该两 kind）、维护期间自身放行。api.md 只有 §1 的全局语义（写 503 E-MAINT-001）与错误码表条目，**无端点定义**；形状经协调人批复记录于 architecture-notes §8。

**建议 api.md 文本**（§3 新增小节，编号建议 §3.3）：

```markdown
### 3.3 维护模式生命周期（实例管理员；backup-recovery §3）

- **POST /api/v1/admin/maintenance**（写；运行态写入——闸门 allowlist 放行自身）：开启维护模式。成功 **204**；幂等（已开启仍 204，不重复记审计）；状态迁移发生时记 `maintenance.enable` 审计行（storage-model §5：运行态写入，不入备份一致性集合）。
- **DELETE /api/v1/admin/maintenance**（写；运行态写入）：关闭。成功 **204**（同幂等与审计语义；维护期间可关闭）；记 `maintenance.disable`。
- 错误：401（§1 通用）；403 E-AUTHZ-001（非实例管理员）。
- 开启后的全局效果（写端点 503 E-MAINT-001、receive-pack 403、读与登录放行）见 §1，本节不重复。
```

**理由**：端点已运行三个 sprint；契约缺口在实现注释、S2-T8/S3 close note 中三次挂账。补录后 §1 的 E-MAINT-001 与本节构成完整闭环（效果 + 生命周期）。

**待裁决**：是否补 `GET /api/v1/admin/maintenance`（当前状态查询，200 `{maintenance: true|false}`）——S2-T8 管理页曾因无此端点不显示当前状态（shape-diff 记录在案）；建议随本次一并定稿（实现量极小），也可以留后续。

## A2 删除库端点与 `vault.delete` 审计 kind（服务面就绪、端点与 kind 未注册）

**现状**：S3-T1 已落地 `VaultService.deleteVault`：行侧同事务（历史审计行保留、`vault_id` 解除挂靠——storage-model §7「v1 不清理」；成员行删；映射行删），提交后删 bare 目录；目录删除失败错误放大，孤儿经 `verifyVaultStoreConsistency` 可观测、`reconcileOrphanRepos` 处置（backup-recovery §5 不变量 3）。**HTTP 端点未挂**、**`vault.delete` kind 未注册**（storage-model §5 注册表为唯一源，不得自行发明——实现注释明示等契约）。

**建议 api.md 文本**（§5 追加）：

```markdown
#### DELETE /api/v1/vaults/{slug}（写；库管理员）
- 成功：**204**。行侧同灭（vaults 行 + 全部成员行；历史审计行保留、`vault_id` 解除挂靠——storage-model §7「v1 不清理」）；随后删除 bare 仓库目录（幂等）。目录删除失败时行已灭、错误放大；孤儿目录经一致性核对可观测并由 reconcile 处置（backup-recovery §5 不变量 3）。审计 `vault.delete`。
- 错误：403 E-AUTHZ-001（成员但非库管理员）；404 E-RES-001（非成员或不存在）；503 E-MAINT-001。
```

**建议 storage-model §5 注册表追加行**：

```markdown
| `vault.delete` | 直接终态 | 是（库行删除后历史行解除挂靠） | 架构 §4.2；backup-recovery §5 不变量 3 |
```

**理由**：服务面与补偿/核对链已实现且测试覆盖；缺端点使删库只能走内部调用，与「v1 不清理审计历史」的既有决策不一致地悬空。契约先行定稿后，HTTP 挂接（一处路由 + authorize + 审计行）可由后续任一 sprint 小任务完成。

**待裁决**：(a) 权限取**库管理员**（与成员管理同级，本建议）还是要求实例管理员复核；(b) 是否要求确认性请求体（如 `{confirm: "<slug>"}`）防误删——建议 v1 不做（Git 侧历史仍在备份恢复面内），如做请定稿字段；(c) 删除后 slug 是否可复用（当前表无墓碑、UNINUE 约束随行删除释放——建议明示「可复用」）。

## A3 app_settings 管理端点与 `config.update` 审计 kind（写入面就绪、端点与 kind 未注册）

**现状**：S3-T8 已落地 `setAppSetting`（`server/src/limits/engine.ts`）：键域=validation-defaults.json 键集、值域双侧校验、`updated_by` 归因、热生效（每请求实时读取）。storage-model §3.10 明示「变更走管理端点并记审计（api.md）」——**端点与 `config.*` kind 均未落**，当前管理员只能 SQL/ops 直写。键集（10 键）与 env 覆盖通道见 `server/src/limits/keys.ts`。

**建议 api.md 文本**（§3 新增小节，编号建议 §3.4）：

```markdown
### 3.4 实例配置（app_settings；实例管理员）

配置键全集与值域以 [validation-defaults.json](validation-defaults.json) 为唯一源（validation.md §5.1）；变更**热生效**（下一校验请求即用新值）。缺行 = 契约默认值。

- **GET /api/v1/admin/config**：200 `{settings: [{key, value, updated_at}]}`（全部已写行；不含默认值展开）。
- **PUT /api/v1/admin/config/{key}**（写）：请求 `{value}`（数值键=安全正整数；清单键=字符串数组，空清单合法收紧）。成功 200 `{key, value, updated_at}`；upsert 语义；审计 `config.update`（detail 记 `{key, old, new}`）。
- 错误：403 E-AUTHZ-001；404 E-RES-001（键不在注册表）；400/422 E-RES-004/007（值域校验失败）；503 E-MAINT-001。
```

**建议 storage-model §5 注册表追加行**：

```markdown
| `config.update` | 直接终态 | 否 | storage-model §3.10（变更走管理端点并记审计）；validation §5.1 |
```

**理由**：与 A2 同构的「服务面已就绪、等契约」挂账；不落端点则 §3.10 的「走管理端点」承诺长期空转，配置变更无审计归因。

**待裁决**：(a) 单键 PUT（本建议，与 setAppSetting upsert 对齐）还是批量 PATCH 对象；(b) 是否提供 DELETE 单键恢复默认（建议 v1 不提供——写回默认值即等效，少一条语义路径）；(c) 未知键 404 E-RES-001 还是 422 E-RES-007（本建议 404：键即资源）。

## A4 Web 页面路由族（本 sprint 起入册）

**现状**：页面自 S2-T8 存在（/login、/、/admin、/credentials）、S4-T1 起扩为浏览族（/vaults 系列），全部在 /api/v1 之外，api.md 无页面路由记载——URL 族成为无契约事实面，后续任务（S4-T2–T8）与 S5 历史页消费时无统一词汇表。

**建议 api.md 文本**（新增末节，编号建议 §13）：

```markdown
## 13. Web 页面路由（非 /api/v1；S4 plan D5 极简形态）

页面 = 服务端渲染 GET（无前端框架；服务端插值唯一通道 HTML 转义；页面无写操作，全部安全判定在 API 侧端点）。认证：会话 Cookie 经统一缝（identity §5.1）；未认证 302 /login。无权库与不存在一律 404 同页（D-IC-06 页面形态）。GET 免 CSRF。页面 URL 不进 /api/v1 版本化承诺（§11 开放项的页面侧答案：随产品演进）。

| 路由 | 页面 | 来源 |
|---|---|---|
| GET /login | 登录页（提交走 §3 login 端点） | S2-T8 |
| GET / | 入口页（管理入口仅实例管理员可见） | S2-T8 |
| GET /admin | 管理页外壳（未认证 302；非实例管理员 403） | S2-T8 |
| GET /credentials | 员工自助凭据页（数据走 §4） | S2-T8 |
| GET /vaults | 有权库列表（实时成员关系，与 §5 GET /vaults 同判定面） | S4-T1 |
| GET /vaults/{slug} | 库根：成员 302 → `/vaults/{slug}/browse`；无权/不存在 404 | S4-T1 |
| GET /vaults/{slug}/browse[/{path}] | 目录浏览：默认分支实时读 Git tree（每请求无缓存）；条目渲染与 `git ls-tree` 同集同序；面包屑；README.md（大小写不敏感）渲染为目录导航并标注 frontmatter 豁免（无 frontmatter 不报错，架构 §5.2） | S4-T1 |
| GET /vaults/{slug}/view/{path} | 文件预览占位（元信息 + 如实标注；安全渲染 S4-T2 落地）；目录路径 302 → browse | S4-T1 |

S4-T2 起各任务在本表 append 各自页面行；模块注册单点见 `server/src/web/routes.ts`（D5 骨架裁决）。
```

**理由**：D6 明列「web 路由族」为欠账；URL 族被验收测试、notes 与 S5 下游消费，入册即固定词汇、防漂移。表内行为均已实现并有测试断言（本任务三份测试文件）。

**待裁决**：(a) 落点取 api.md 末节（本建议——api.md 是 URL 面唯一契约）还是 architecture.md §6（产品能力视角）；(b) 页面「无版本化承诺」一句是否保留（若希望页面 URL 亦稳定，请改写）。

## A5 形状差异记录：§6 内容读取端点与 S4-T1 页面直读（无需契约变更）

S4-T1 页面族读取 bare 仓库走服务端直读（每请求 `git ls-tree`/`git cat-file`，无缓存），不经 api.md §6 的 `tree`/`blob` 端点——该组端点仍为**已契约、未实现**状态（属后续 sprint 的 API 消费面，如 CLI）。两侧语义同源（默认分支、路径不存在即 404/缺、D-IC-06 授权），不互替代：§6 服务机器消费（JSON、token scope），页面直读服务人类会话（HTML、无 scope）。**不建议本次改 §6**；记录在案供 master 知悉两个读面并存的事实。

## 落点汇总

| id | 契约文件 | 落点 | 性质 | 实现状态 |
|---|---|---|---|---|
| A1 | api.md | §3.3（建议） | 补录已实现端点 | 已实现（S2-T7） |
| A2 | api.md + storage-model §5 | §5 端点 + kind 注册行 | 契约定稿待实现 | 服务面已实现、HTTP 未挂（后续任务） |
| A3 | api.md + storage-model §5 | §3.4（建议）+ kind 注册行 | 契约定稿待实现 | 写入面已实现、HTTP 未挂（后续任务） |
| A4 | api.md | §13（建议） | 页面路由族入册 | 已实现（S2-T8 + S4-T1） |
| A5 | —（本文件记录） | — | 形状差异 | — |
