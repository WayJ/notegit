# API 契约（api）

| 项目 | 内容 |
|---|---|
| 契约版本 | v0.1（S1 草案，供 S2 实现） |
| 日期 / 产出 | 2026-10-12 / S1-T5 |
| 架构依据 | [architecture.md](../../architecture.md) §4、§5.4、§6、§8.2、§9；DOD-02/03/05/07/11 |
| 配套契约 | [validation.md](validation.md)（内容校验规则与错误码唯一来源）、[identity-credentials.md](identity-credentials.md)（凭据/会话语义唯一来源）、[storage-model.md](storage-model.md)（表结构与运行时检查查询）、[backup-recovery.md](backup-recovery.md)（维护模式） |
| 实现语境 | Node 24 + TypeScript + Fastify v5 + git http-backend CGI 包装（epic D10；[selection.md](../s1/selection.md)） |
| 自检门禁 | `node --test docs/contracts/tools/ddl_smoke.test.mjs`（含 api.md lint：注册表内聚、前缀与 T2 不相交、rulesVersion 引用一致，见 §2.4） |

## 0. 范围

本契约定稿 identity-credentials.md 移交 T5 的项目：CSRF 具体机制（其 §4）、Bearer 形式（§9）、审计查询 API、维护模式错误码（backup-recovery.md §3/§10 待定项）；并给出身份 / 库管理 / 发布 / 审计四域的端点草案与 Fastify 组织建议。

不在范围：CLI 命令契约（S6）、搜索 API（§8.2 未列入第一版必需能力，后续 sprint）、Web UI 页面结构（本契约只定其调用的 API）、内容校验规则本身（T2）。

## 1. 通用约定

- **基础路径** `/api/v1`；请求/响应体 `application/json; charset=utf-8`（blob 端点除外，按扩展名给 Content-Type）。
- **认证载体**（同一员工权限，架构 §8.2「API 和 Git 共用同一员工权限」）：
  | 载体 | 入口 | 形式 | 依据 |
  |---|---|---|---|
  | Web 会话 | 浏览器（Web UI 同源调用） | Cookie `ngt_sid`（HttpOnly; Secure; SameSite=Lax） | identity §4 |
  | 访问凭据 | CLI / 程序化 API | `Authorization: Bearer ngt_<43 字符>` | identity §3.1（本条即其 §9 移交的 Bearer 形式定稿） |
  | 访问凭据 | Git Smart HTTP | HTTP Basic（用户名任意/员工名 + token 作口令） | identity §3.1 |
- **认证与授权实时查库、无缓存**：每请求执行 [storage-model §4](storage-model.md) 的 `authn.token` / `authn.session` / `authz.role` 规范查询（identity §5.1/D-IC-05）。
- **CSRF 机制**（identity §4 移交定稿）：在 SameSite=Lax 之上，凡**会话 Cookie 认证的状态改变请求**（非 GET/HEAD/OPTIONS）校验同源头：`Origin`（缺失时回退 `Referer`）与请求目标同源，否则 403 E-AUTH-006。`Bearer` 认证的请求不依赖环境凭据，豁免该校验。
- **维护模式**：实例级全局写闸门（backup-recovery §3，进程内标志，传播上界 0）。开启后：一切写操作（本契约标注「写」的端点）→ 503 E-MAINT-001（`maintenance: true`）；登录与一切读放行。Git receive-pack → 403「维护中」（§8.4）；候选校验（§8.2 `validations`）为只读推导，放行。
- **通用 401**：凡标注「需认证」语义的端点共享 401 映射：E-AUTH-001（无/无效凭据或会话）、E-AUTH-002/003/004（过期/撤销/停用，identity §5.2）；下文端点错误列不再逐条重复 401。
- **404 语义**：无成员关系的库（含撤权后）与不存在的库同响应 404 E-RES-001，不泄露存在性（identity §5.2/D-IC-06）；**有成员关系但角色不足**用 403 E-AUTHZ-001（主体已知库存在，404 反而失真）。
- **分页**：列表类端点统一 `limit`（默认 50，上限 200）+ `cursor`（不透明，响应体 `next_cursor`，null 表示结束）。
- **重试幂等性（DOD-11）**：发布请求携带 `base_commit` 预期旧 commit——重复/超时重放的提交会因 HEAD 已前进得到 409 E-RES-003，不会静默重复发布（架构 §5.4）；审计先预记录后核对（storage-model §6），超时不确定结果以 `unresolved` 呈现而非虚假成功。

## 2. 错误模型

### 2.1 信封

```json
{
  "error": {
    "code": "E-RES-003",
    "message": "分支已前进：base_commit 与当前 HEAD 不一致",
    "details": { "base_commit": "…", "current_head": "…" }
  }
}
```

- `details` 可选，键随码定；`Retry-After` 头仅用于 429。
- **内容校验失败不是信封**：校验失败的提交/推送请求返回 422，body 直接是 T2 [validation-report.schema.json](schemas/validation-report.schema.json) 报告（`scope` 按入口填 `web-submit`），顶层含 `rulesVersion`——错误码即 T2 注册表（E-FM-*、E-PATH-*、E-LIMIT-* 等），不在本文件重复定义。规则版本唯一机器来源：[rules-version.json](rules-version.json)，当前 **1.0.0-draft.1**。

### 2.2 两层关系声明（coordinator 2026-10-12 批复边界）

1. **内容校验错误**一律引用 T2 注册表（validation.md §6.2）并携带 `rulesVersion`（rules-version.json）；
2. **凭据生命周期语义**（过期/撤销/账号停用/成员撤权的判定与 401/404 呈现、`ngt_` 形态、HMAC 存储）一律遵 identity-credentials.md；
3. 本表仅覆盖**认证 / 授权 / 维护模式 / 资源存在性等传输层错误**；区域前缀 AUTH/AUTHZ/MAINT/RES 与 T2 已占区域（FM/PATH/LIMIT/RUN/LINK/UPGRADE）不相交；码结构沿用 `^(E|W|N)-[A-Z]+-\d{3}$`，severity 语义同 T2（E=error 阻断、W=warning、N=info）。

### 2.3 API 错误码注册表（T5 API 层）

| code | HTTP | 触发场景 | 来源 |
|---|---|---|---|
| E-AUTH-001 | 401 | 未认证：无/无效会话或 token；登录口令错误（统一「用户名或口令错误」文案）；bootstrap token 无效/过期 | identity §2/§5.2/§7.1 |
| E-AUTH-002 | 401 | 凭据已过期（`reason: expired`；不可续期，须新建） | identity §5.2 |
| E-AUTH-003 | 401 | 凭据已撤销（`reason: revoked`） | identity §5.2 |
| E-AUTH-004 | 401 | 账号已停用（`reason: account_disabled`；该账号全部会话与 token） | identity §5.2 |
| E-AUTH-005 | 429 | 登录限速：账号+来源 IP 指数退避窗口内（带 Retry-After） | identity §2 |
| E-AUTH-006 | 403 | CSRF 同源校验失败（Cookie 认证的写请求） | identity §4（本文件 §1 定稿） |
| E-AUTH-007 | 503 | 实例未初始化：业务入口不可用，仅 bootstrap 端点开放 | identity §7.1 |
| E-AUTH-008 | 422 | 口令策略不满足（长度 12–64 可配，无组合规则） | identity §2 |
| E-AUTHZ-001 | 403 | 已认证、已知资源存在，但角色/身份不足（reader 写库、非库管理员改设置、非实例管理员用管理端点） | 架构 §4.2 |
| E-MAINT-001 | 503 | 维护模式拒绝写入（`maintenance: true`；backup-recovery §3 待定项在此定稿） | backup-recovery §3 |
| E-RES-001 | 404 | 资源不存在或无权访问（库/文档/凭据/成员等，统一 404 不泄露存在性） | identity §5.2/D-IC-06 |
| E-RES-002 | 409 | 资源标识已占用（username、vault slug） | 架构 §7.2；identity §2 |
| E-RES-003 | 409 | base commit 冲突：分支已前进（预期旧 commit 不匹配；草稿保留） | 架构 §5.4/§6 |
| E-RES-004 | 400 | 请求形态错误（非法 JSON、缺必填项、路径参数非法） | T5 建议 |
| E-RES-005 | 409 | 凭据数量超上限（默认 20 条/员工，可配） | identity §3.5 |
| E-RES-006 | 410 | 端点永久不可用（bootstrap 在初始化完成后） | identity §7.1 |
| E-RES-007 | 422 | 参数语义/策略不符（expires_at 超实例上限 90 天、scope/role 非法取值等） | identity §3.3/§3.4 |

### 2.4 文档 lint（自检门禁的一部分）

`node --test docs/contracts/tools/ddl_smoke.test.mjs` 除 DDL 冒烟外校验本文件：正文使用的 API 码均在 §2.3 注册表内；注册表区域前缀与 T2 注册表不相交；rules-version.json 的 `rulesVersion` 字符串与文件路径在本文件出现（sprint 场景 S3 核对点：与 T1/T4 spike 引用同一文件、同一版本标识）。

## 3. 身份与账号

认证失败的具体码（E-AUTH-002/003/004）仅用于已提交凭据的判别；对**未认证**请求一律 E-AUTH-001。所有端点在维护模式下遵循 §1（登录放行）。

#### POST /api/v1/auth/bootstrap（初始化，一次性）
- 前置：实例处于初始化态（employees 表空，identity §7.1）；否则 410 E-RES-006。
- 请求：`{bootstrap_token, username, display_name, password}`（token 读自 `/data/config/admin-bootstrap.token`，identity §7.1）。
- 成功：201 `{employee_id, username}`；bootstrap token 单次失效并由应用删除文件；审计 `account.bootstrap`（actor_kind=bootstrap）。不自动登录（随后走 §3 login）。
- 错误：401 E-AUTH-001（token 无效/过期/已用）；409 E-RES-002（username 占用）；422 E-AUTH-008（口令策略）；400 E-RES-004。

#### POST /api/v1/auth/login（写：创建会话）
- 请求：`{username, password}`。
- 成功：200 `{username, display_name, is_instance_admin}` + `Set-Cookie ngt_sid=<新 ID>`（登录成功重发新 ID，会话固定防护，identity §4）。
- 错误：401 E-AUTH-001（统一「用户名或口令错误」，不区分用户名是否存在）；429 E-AUTH-005；503 E-AUTH-007（未初始化）。

#### POST /api/v1/auth/logout（写）
- 成功：204（DELETE 会话行；**不撤销 token**，identity §1）。错误：401 E-AUTH-001。

#### GET /api/v1/me
- 成功：200 `{username, display_name, is_instance_admin, active}`。错误：401 E-AUTH-001/002/003/004（按凭据状态）。

#### POST /api/v1/me/password（写）
- 请求：`{current_password, new_password}`。
- 成功：204；**副作用：该账号全部 Web 会话失效**（identity §2；访问凭据不自动撤销，响应 `details.tokens_unaffected: true` 提示一并处理）。
- 错误：401 E-AUTH-001（current 错误，统一文案）；422 E-AUTH-008；400 E-RES-004。

### 3.1 实例管理员：员工管理（均需实例管理员，否则 403 E-AUTHZ-001）

#### GET /api/v1/admin/employees
- 成功：200 `{employees: [{username, display_name, active, is_instance_admin, created_at}], next_cursor}`。
- 错误：403 E-AUTHZ-001（非实例管理员）。

#### POST /api/v1/admin/employees（写：邀请创建）
- 请求：`{username, display_name}`。第一版无自助注册（identity §2）。
- 成功：201 + **一次性口令重置令牌明文仅此一次** `{username, password_reset_token}`（K5，短时效单次；经企业内渠道交付，identity §7.2）；员工以该令牌走 §3.2 重置流程设初始口令后激活使用；审计 `employee.create`。
- 错误：409 E-RES-002；400 E-RES-004；422 E-RES-007。

#### PATCH /api/v1/admin/employees/{username}（写：停用/启用）
- 请求：`{active: true|false}`（可选 `is_instance_admin`）。
- 成功：204；停用副作用见 identity §5.2（该账号全部会话与 token 下一请求 401）；审计 `employee.deactivate` / `employee.activate`。
- 错误：404 E-RES-001；400 E-RES-004。

#### POST /api/v1/admin/employees/{username}/password-reset（写）
- 成功：200 `{password_reset_token}`（明文仅此一次，K5）；重置完成后该账号会话全部失效（identity §7.2）；审计 `employee.password_reset`。
- 错误：404 E-RES-001。

#### （非 HTTP）`notegit admin recover`
管理员全员锁死的主机侧恢复经容器 CLI（`docker exec`），**不暴露 HTTP 端点**（identity §7.2；命令名 S2 定稿）；产生审计 `admin.host_recovery`。

### 3.2 口令重置凭据消费端点（公开，K5 令牌）
#### POST /api/v1/auth/password-reset
- 请求：`{reset_token, new_password}`。
- 成功：204（令牌单次失效；该账号会话全部失效）；审计 `employee.password_reset`（detail 记来源）。
- 错误：401 E-AUTH-001（令牌无效/过期/已用）；422 E-AUTH-008。


### 3.3 维护模式生命周期（实例管理员；backup-recovery §3）

- **POST /api/v1/admin/maintenance**（写；运行态写入——闸门 allowlist 放行自身）：开启维护模式。成功 **204**；幂等（已开启仍 204，不重复记审计）；状态迁移发生时记 `maintenance.enable` 审计行（storage-model §5：运行态写入，不入备份一致性集合）。
- **DELETE /api/v1/admin/maintenance**（写；运行态写入）：关闭。成功 **204**（同幂等与审计语义；维护期间可关闭）；记 `maintenance.disable`。
- **GET /api/v1/admin/maintenance**：200 `{maintenance: true|false}`（当前状态查询；只读）。
- 错误：401（§1 通用）；403 E-AUTHZ-001（非实例管理员）。
- 开启后的全局效果（写端点 503 E-MAINT-001、receive-pack 403、读与登录放行）见 §1，本节不重复。（2026-10-13 ADR D12 补录；实现自 S2-T7。）


### 3.4 实例配置（app_settings；实例管理员）

配置键全集与值域以 [validation-defaults.json](validation-defaults.json) 为唯一源（validation.md §5.1）；变更**热生效**（下一校验请求即用新值）。缺行 = 契约默认值。

- **GET /api/v1/admin/config**：200 `{settings: [{key, value, updated_at}]}`（全部已写行；不含默认值展开）。
- **PUT /api/v1/admin/config/{key}**（写）：请求 `{value}`（数值键=安全正整数；清单键=字符串数组，空清单合法收紧）。成功 200 `{key, value, updated_at}`；upsert 语义；审计 `config.update`（detail 记 `{key, old, new}`）。
- 错误：403 E-AUTHZ-001；404 E-RES-001（键不在注册表）；400/422 E-RES-004/007（值域校验失败）；503 E-MAINT-001。（2026-10-13 ADR D12 定稿；HTTP 挂接待后续任务，写入面已实现自 S3-T8。）


## 4. 访问凭据（ngt_ token）

自助与管理员代管并存（identity §3.5）。明文只在创建响应出现一次；此后任何端点不回显明文，仅 `ngt_` 前缀与末 4 位（identity §3.1）。

#### GET /api/v1/credentials
- 成功：200 `{credentials: [{id, name, display_hint, scope_access, scope_vaults, created_at, expires_at, revoked_at, last_used_at}]}`（`display_hint` 形如 `ngt_ab…wxyz`）。
- 错误：401（通用，§1）。

#### POST /api/v1/credentials（写）
- 请求：`{name, expires_at, scope: {access: "read"|"read_write", vaults: [<slug 清单>]}}`（scope 可省 = read_write + 全部有权库；只能收窄，identity §3.4）。
- 成功：201 `{token: "ngt_<43 字符>", …同上字段}`（**明文仅此一次**）；审计 `credential.create`。
- 错误：409 E-RES-005（超上限）；422 E-RES-007（expires_at 超实例上限 90 天/scope 非法）；400 E-RES-004。

#### DELETE /api/v1/credentials/{id}（写：撤销）
- 成功：204（即时生效，下一请求 401，identity §5.2）；审计 `credential.revoke`。
- 错误：404 E-RES-001（他人凭据不可见，同 404 语义）。

#### GET /api/v1/admin/employees/{username}/credentials ／ DELETE …/credentials/{id}（写）
- 管理员代管（identity §3.5）：响应/错误同上；DELETE 审计 `credential.revoke`（detail 记代管）。需实例管理员，否则 403 E-AUTHZ-001。

## 5. 库与成员

建库权限：**任意 active 员工**可建库，创建者自动成为该库管理员（架构 §4.2；coordinator 2026-10-12 批复）。实例级「限制建库」策略留作后续配置项，不在本契约展开。新库默认私有（不显式授权不可见，架构 §4.2）。

#### POST /api/v1/vaults（写）
- 请求：`{name, slug}`（slug 格式校验在应用层，字符集对齐 validation.md §4.1 精神：小写字母/数字/`-`，长度 1–64）。
- 成功：201 `{id, slug, name, default_branch: "main", main_admin_only: false, role: "admin"}`；创建 `vaults` 行 + 创建者 `vault_members(admin)` 行 + bare 仓库 `/data/git/<id>.git`；审计 `vault.create`。
- 错误：409 E-RES-002（slug 占用）；400/422 E-RES-004/007（slug 非法）。

#### GET /api/v1/vaults
- 成功：200：**仅**当前员工有成员关系的库（`{slug, name, role, default_branch, main_admin_only}`，未授权库不进列表，架构 §4.2）。
- 错误：401（通用，§1）；列表本身不产生 404（无权库不出现而非报错）。

#### GET /api/v1/vaults/{slug}
- 成功：200（同上单库）。错误：404 E-RES-001（无成员关系或不存在）。

#### PATCH /api/v1/vaults/{slug}（写；库管理员）
- 请求：`{name?, slug?, main_admin_only?}` 任一。
- 成功：200；**slug 可改名、内部 id 与仓库路径不变**（架构 §7.2，CLI 提示映射变化）；审计 `vault.update`。
- 错误：403 E-AUTHZ-001（成员但非管理员）；404 E-RES-001（非成员）；409 E-RES-002（新 slug 占用）。

#### GET /api/v1/vaults/{slug}/members（库管理员）
- 成功：200 `{members: [{username, display_name, role, granted_at}]}`。错误：403 E-AUTHZ-001 / 404 E-RES-001。

#### PUT /api/v1/vaults/{slug}/members/{username}（写；库管理员）
- 请求：`{role: "reader"|"editor"|"admin"}`。
- 成功：200（upsert：授权或改角色）；审计 `member.grant`。错误：404 E-RES-001（库或目标员工不存在）；422 E-RES-007；403 E-AUTHZ-001。

#### DELETE /api/v1/vaults/{slug}/members/{username}（写；库管理员）
- 成功：204；**撤权下一请求生效**（该员工此库访问 → 404；在途 push 在执行点复查被拒并记审计，identity §5.2/§5.3）；审计 `member.revoke`。
- 错误：403 E-AUTHZ-001 / 404 E-RES-001。


#### DELETE /api/v1/vaults/{slug}（写；库管理员）
- 成功：**204**。行侧同灭（vaults 行 + 全部成员行；历史审计行保留、`vault_id` 解除挂靠——storage-model §7「v1 不清理」）；随后删除 bare 仓库目录（幂等）。目录删除失败时行已灭、错误放大；孤儿目录经一致性核对可观测并由 reconcile 处置（backup-recovery §5 不变量 3）。审计 `vault.delete`。slug 随行删除释放，**可复用**（v1 无墓碑）。
- 错误：403 E-AUTHZ-001（成员但非库管理员）；404 E-RES-001（非成员或不存在）；503 E-MAINT-001。（2026-10-13 ADR D12 定稿；HTTP 挂接待后续任务，服务面已实现自 S3-T1。）


## 6. 内容读取（自 Git 派生，不落库）

角色：reader 及以上。`ref` 可省（默认分支）；显式其他分支时响应标注 `branch`（架构 §2）。commit 的 author/committer 字段是**客户端可填的内容元数据**，仅展示，不作身份判断（identity §8）。

#### GET /api/v1/vaults/{slug}/tree?ref=&path=
- 成功：200 `{branch, path, entries: [{type: "tree"|"blob", name, path, size?}]}`。错误：404 E-RES-001（库无权/路径或 ref 不存在）。

#### GET /api/v1/vaults/{slug}/blob?ref=&path=
- 成功：200 文件内容（`.md`/文本给 `text/markdown` 或 `text/plain`；附件按扩展名二进制流，经鉴权读取，架构 §6）。错误：404 E-RES-001。

#### GET /api/v1/vaults/{slug}/commits?ref=&path=&limit=&cursor=
- 成功：200 `{branch, commits: [{oid, author: {name, email, date}, message, parents}], next_cursor}`。错误：404 E-RES-001。

## 7. 草稿（写：权威管理数据）

草稿存数据库、按作者私有（架构 §3.1/§6；表见 [storage-model §3.7](storage-model.md)）。访问时再次检查库权限（identity §5.1 第 2 层）。

- **GET /api/v1/vaults/{slug}/drafts**（成员）：200 `{drafts: [{path, base_commit, updated_at}]}`；404 E-RES-001。
- **PUT /api/v1/vaults/{slug}/drafts/{path}**（editor+；写）：请求 `{content, base_commit}`；upsert 每作者每路径一份；成功 200 `{updated_at}`。错误：403 E-AUTHZ-001（reader）；404 E-RES-001；422（路径非法——T2 报告，`E-PATH-001` 等，提前反馈不阻断保存的变体见 §11 开放项）；503 E-MAINT-001。
- **GET /api/v1/vaults/{slug}/drafts/{path}**（成员）：200 `{content, base_commit, updated_at}`；404 E-RES-001。
- **DELETE /api/v1/vaults/{slug}/drafts/{path}**（editor+；写）：204；404 E-RES-001；503 E-MAINT-001。

## 8. 发布：Web 与 Git 两条入口共用检查点序列

**共用发布组件（publish）**是唯一允许更新库引用的代码路径（架构 §5.4「网页不能通过直接 update-ref 绕过接收规则」）。两条入口：

- **Web submit**：`POST /api/v1/vaults/{slug}/submissions`——服务端从 `base_commit` + `changes` 构造**单个候选提交**（隔离 tree/临时目录，架构 §9），走完整序列后 update-ref。
- **Git receive**：`/git/<slug>.git` Smart HTTP（D10 路线 B，git http-backend CGI）——pre-receive hook 调用同一组件，对**推送范围内全部新提交**逐个校验，全部 ref 通过后才允许更新（全有或全无）。

### 8.1 共享检查点（顺序固定，对齐架构 §5.4 + identity §5.1 + backup-recovery §3）

| # | 检查点 | 规则（单一来源） | Web submit 行为 | Git receive 行为 |
|---|---|---|---|---|
| 0 | 维护模式闸门 | backup-recovery §3 | 503 E-MAINT-001，草稿保留 | receive-pack 403「维护中」；refs 广告与读不变 |
| 1 | 认证 | identity §5.1 第 1 层（`authn.token`/`authn.session`，实时无缓存） | 会话失效 → 401（E-AUTH-001；停用 E-AUTH-004 并登出） | Basic+ngt_：无效 E-AUTH-001 / 过期 E-AUTH-002 / 撤销 E-AUTH-003 / 停用 E-AUTH-004；**refs 发现阶段即鉴权**（架构 §3.2） |
| 2 | 授权 | identity §5.1 第 2 层（`authz.role` 实时查表，读写一致）+ 凭据 scope 取交集（§3.4） | 非成员 → 404 E-RES-001；reader → 403 E-AUTHZ-001 | 同左（对库的 refs 发现、对象读写、push 一律 404，identity §5.2） |
| 3 | base commit / 非快进 | 预期旧 commit（架构 §5.4/§6）；分支规则（§4.3） | `base_commit` ≠ 当前 HEAD → 409 E-RES-003（草稿保留，提示刷新，不静默覆盖）；v1 仅默认分支（§8.3） | old-oid 不匹配或非快进 → 拒绝（denyNonFastForwards）；删默认分支、force、写 tag/其他命名空间 → 拒绝；**所有 ref 先统一检查再更新** |
| 4 | 逐提交校验 | T2 契约 + rulesVersion（服务端权威；客户端过期附 N-UPGRADE-001） | 候选提交（单提交，含全部变更文件）→ 失败 422 + T2 报告（scope=web-submit），不发布、草稿保留 | 每个新提交相对父提交的新增/修改文件；合并提交按父比较、根提交查全部；push 级限额（E-LIMIT-004/005）；失败拒绝**整次** push（全有或全无） |
| 5 | 执行点复查 + 审计 | identity §5.1 第 3 层（update-ref 前复查权限与维护）；架构 §4.4 预记录→核对 | 复查通过 → 预记录 `vault.web_submit`(pending) → update-ref → 核对置终态 | 复查通过 → 预记录 `vault.push`(pending，每 ref 一行) → quarantine 迁移 → 核对置终态；异常 → `unresolved` 待恢复对账（storage-model §6） |

### 8.2 Web 端点

#### POST /api/v1/vaults/{slug}/submissions（写；editor+，`main_admin_only` 时默认分支需 admin）
- 请求：
  ```json
  {
    "base_commit": "<oid>",
    "message": "提交说明",
    "changes": [
      {"path": "docs/a.md", "content": "---\ntitle: 示例\n---\n…"},
      {"path": "docs/b.png", "content_base64": "…"},
      {"path": "docs/old.md", "delete": true}
    ]
  }
  ```
  `changes` 至少一项；文件级规则（路径/类型/容量/frontmatter）由检查点 4 按 T2 判定。
- 成功：201 `{commit, branch, report}`——`report` 为 T2 validation-report（scope=web-submit，`result: pass` 可含 warning，含 `rulesVersion`）；发布成功后草稿按架构 §6 清理或标记。
- 错误：409 E-RES-003；**422 = T2 报告**（草稿保留）；403 E-AUTHZ-001 / 404 E-RES-001 / 503 E-MAINT-001 / 400 E-RES-004；执行点复查失败（撤权/停用发生在检查后）→ 403 E-AUTHZ-001 或 404 E-RES-001，审计记 `rejected`。

#### POST /api/v1/vaults/{slug}/validations（只读推导；editor+）
- 请求同上；成功：200 `{report}`（仅校验候选提交，不发布、不记审计、维护模式放行——不写权威数据）。
- 错误：403 E-AUTHZ-001 / 404 E-RES-001 / 409 E-RES-003（base 不匹配时仍可校验，报告标注 stale——实现可选；缺省行为：不校验 HEAD，仅对 base 构造）/ 400 E-RES-004。

### 8.3 分支规则（架构 §4.3，服务端固定执行）

- 默认分支：编辑者快进推送/提交允许；禁 force、禁删除；`main_admin_only` 开启后仅库管理员可写。
- 非默认分支：编辑者可创建、快进更新、删除。**Web 提交 v1 仅支持默认分支**（架构 §6 能力清单最小集；非默认分支经 Git 途径，开放项 §11）。
- 无 tag 写入、无其他 ref 命名空间（架构 §4.3/§5.4）。

### 8.4 Git Smart HTTP 入口（D10 路由 B）

- Clone URL：`https://<host>/git/<slug>.git`；端点 `info/refs?service=git-(upload|receive)-pack`、`git-upload-pack`、`git-receive-pack` 由 Fastify 路由组装 CGI 环境转发 `git http-backend`（流式：`reply.hijack()` + content-type 透传，selection.md §3 实测）。
- **REMOTE_USER 透传**：CGI 层把认证员工标识（+ 凭据 id）注入 `REMOTE_USER`，pre-receive hook 据此取得认证主体（selection.md §2 实测 B4；审计主体不信任 commit author，架构 §4.4）。
- 认证：401 + `WWW-Authenticate: Basic`；无权/未知库 404（D-IC-06）。读（upload-pack/refs 广告）需 reader+。
- 拒绝呈现：pre-receive 以 pkt-line 输出首个错误的 `路径:错误码:摘要`（含 `rulesVersion`）到 sideband，report-status 返回 ng；完整报告由客户端 `notegit lint`（本地同规则）获得。维护模式：receive-pack 403。
- 实现注意：Node 内对自家 HTTP 服务的 git 子命令**必须异步 spawn**（`execFileSync` 阻塞事件循环自死锁，T1 spike 两次踩中实录，selection.md §2）。

### 8.5 两入口差异点（其余全部共享）

| 维度 | Web submit | Git receive |
|---|---|---|
| 认证载体 | 会话 Cookie | HTTP Basic + ngt_ token |
| 提交构造方 | 服务端从 base_commit+changes 构造候选提交（隔离 tree/临时目录，架构 §9） | 客户端已构造（服务端只验不造） |
| 校验单位 | 单个候选提交 | 推送范围内全部新提交（含合并、根提交） |
| 原子性范围 | 单 ref（默认分支） | 一次 push 的全部 ref（全有或全无） |
| 失败呈现 | HTTP 422 + T2 报告 JSON（rulesVersion） | 整次 push 拒绝（report-status ng + 错误摘要） |
| 隔离机制 | 候选 tree / 隔离临时目录 | receive-pack 原生 quarantine（路线 B） |
| 草稿联动 | 失败保留草稿（架构 §6） | 无草稿（本地工作副本即工作区） |
| 审计入口字段 | `entry: web` | `entry: git`，event_kind `vault.push` |

## 9. 审计查询

审计以认证主体记录（架构 §4.4；表结构 [storage-model §3.8](storage-model.md)）。响应行不含任何 token 材料（`credential_ref` 仅凭据/会话标识）。

#### GET /api/v1/vaults/{slug}/audit?actor=&event_kind=&status=&since=&until=&limit=&cursor=（库管理员或实例管理员）
- 成功：200 `{events: [{occurred_at, actor_kind, actor, credential_ref, entry, event_kind, ref_name, old_commit, new_commit, status, detail}], next_cursor}`。
- 错误：403 E-AUTHZ-001（成员但非管理员）；404 E-RES-001（非成员）。

#### GET /api/v1/admin/audit?vault=&actor=&event_kind=&status=&since=&until=&limit=&cursor=（实例管理员）
- 成功：200 同上（含实例级事件：凭据域、密钥轮换、维护、备份、恢复对账，storage-model §5）；错误：403 E-AUTHZ-001。

## 10. Fastify 路由与模块组织建议（对齐 selection.md）

```text
src/
  server.ts                # 组装：maintenance → auth → csrf → 路由（注册顺序即检查点 0–2 的落地）
  plugins/
    maintenance.ts         # 全局写闸门（onRequest，进程内标志，传播上界 0——backup-recovery §3）
    auth.ts                # session/Bearer/Basic 三载体解析 → request.authenticatedUser（类型化装饰器，
                           #   官方模块扩充模式，selection.md §3）；失败按 §2.3 映射 401/404
    csrf.ts                # Cookie 认证写请求的同源头校验（本契约 §1）
  routes/                  # 按域一文件：auth / credentials / admin / vaults / members /
                           #   content / drafts / submissions / validations / audit
  git/
    http-backend.ts        # /git/* 路由：CGI env 组装 + 异步 spawn git http-backend + 双向流转发
                           #   （reply.hijack + content-type 透传——selection.md §3 实测 2/2）
    pre-receive.ts         # hook：读 REMOTE_USER → 调 domain/publish（与 Web 同一组件，§8）
  domain/
    db.ts                  # node:sqlite：WAL、busy_timeout=5000、foreign_keys=ON、BEGIN IMMEDIATE 封装
    identity.ts            # storage-model §4 规范查询的唯一调用面（禁止缓存，D-IC-05）
    publish.ts             # 共用发布组件：§8.1 检查点 0–5 顺序实现 + 审计预记录/终态
    validation/            # T2 规则引擎：构建期取 docs/contracts/（schema + rules-version.json + defaults）
                           #   单一来源（validation.md §7.3）
    audit.ts               # 事件写入、排空计数、恢复对账（backup-recovery §7 步骤 7）
  test/                    # fastify inject() 免 socket 测试（selection.md §3）
```

要点：Git 路由与 Web API 用 Fastify 封装作用域各自隔离（selection.md §3 判据之一）；权限判断只经 `domain/identity.ts`，路由内不得自行查表或缓存；每请求 git 子进程的并发上限按部署规格限制（selection.md §5）；镜像须含 `git-daemon` 包（Alpine 的 git-http-backend 归属，selection.md §5）。

## 11. 开放项（S2/S6 实现期定稿）

- 登录限速阈值/窗口默认值（identity §2 移交 S2 实测定稿）。
- username 大小写策略（storage-model §7 同款开放项）。
- Web 非默认分支提交（当前 v1 限默认分支，§8.3）。
- 草稿保存是否对路径/内容做非阻断 warning 校验（当前仅路径 422 硬校验）。
- 审计查询的保留期/导出格式（S6 CLI 对接时定）。
- `validations` 对 stale base 的缺省行为（当前不校验 HEAD）。
- API 版本演进策略（/api/v1 内的兼容承诺级别，S2 定）。

## 12. 与其他任务/契约的关系

| 关联方 | 内容 |
|---|---|
| S2（实现） | 本契约直接实现者；开放项定稿处 |
| T2（validation） | §8 检查点 4 的规则与错误码唯一来源；rulesVersion 同源（场景 S3） |
| T3（identity/backup） | §1–§4 认证/凭据/维护语义的唯一来源；本文件仅定稿其移交项（CSRF、Bearer 形式、审计查询、maintenance 码） |
| T6（gates） | `node --test docs/contracts/tools/ddl_smoke.test.mjs`（含本文档 lint）建议登记为 contracts gate（D5 附日期） |
| S3（发布实现） | §8 共用发布组件为其实施蓝本 |
| T1/T4 spike | §8.4 引用 docs/s1/spikes/git-http-backend/ 同一规则来源与版本标识（场景 S3 核对） |

## 13. Web 页面路由（非 /api/v1；S4 plan D5 极简形态；2026-10-13 ADR D12 入册）

页面 = 服务端渲染 GET（无前端框架；服务端插值唯一通道 HTML 转义；页面无写操作，全部安全判定在 API 侧端点）。认证：会话 Cookie 经统一缝（identity §5.1）；未认证 302 /login。无权库与不存在一律 404 同页（D-IC-06 页面形态）。GET 免 CSRF。页面 URL 不进 /api/v1 版本化承诺（随产品演进）。

| 路由 | 页面 | 来源 |
|---|---|---|
| GET /login | 登录页（提交走 §3 login 端点） | S2-T8 |
| GET / | 入口页（管理入口仅实例管理员可见） | S2-T8 |
| GET /admin | 管理页外壳（未认证 302；非实例管理员 403） | S2-T8 |
| GET /credentials | 员工自助凭据页（数据走 §4） | S2-T8 |
| GET /vaults | 有权库列表（实时成员关系，与 §5 GET /vaults 同判定面） | S4-T1 |
| GET /vaults/{slug} | 库根：成员 302 → `/vaults/{slug}/browse`；无权/不存在 404 | S4-T1 |
| GET /vaults/{slug}/browse[/{path}] | 目录浏览：默认分支实时读 Git tree（每请求无缓存）；条目渲染与 `git ls-tree` 同集同序；面包屑；README.md（大小写不敏感）渲染为目录导航并标注 frontmatter 豁免（架构 §5.2） | S4-T1 |
| GET /vaults/{slug}/view/{path} | 文件预览占位（元信息 + 如实标注；安全渲染 S4-T2 落地）；目录路径 302 → browse | S4-T1 |
| GET /vaults/{slug}/view/{path} | 文件预览（S4-T2 落地，接管上行占位）：`.md` 服务端安全渲染（清理唯一通道：原始 HTML 剥离、URL 协议白名单 http/https/相对/锚点、脚本/事件属性不可达；代码块/行内码不二次渲染；frontmatter 不入正文；剥离如实标注）；非 Markdown 与超上限（1 MiB）仅元信息 + 如实标注；仓库相对图片经鉴权附件通道（S4-T4 落地，接口 `server/src/web/view/attachments.ts` 先行定形，未接入出占位标注）；目录路径 302 → browse | S4-T2 |

S4-T2 起各任务在本表 append 各自页面行；模块注册单点见 `server/src/web/routes.ts`。
