# 架构与布局决策记录（S2-T1 定稿）

日期：2026-10-12（S2-T1）。本文件是工程布局与工具链决策的登记处；按 [AGENTS.md doc_sync_map](../../AGENTS.md)，涉及产品要求/部署架构的变更另须同步 architecture.md 与 epic ADR。模块边界初始假设来源：[implementation-breakdown §1.3](../s1/implementation-breakdown.md)（S2 计划 D6：由本任务定稿）。

## 1. Monorepo 布局（定稿）

```text
/                       # npm workspaces 根（notegit-monorepo，私有）
├── server/             # Fastify v5 应用：身份、库管理、Git 接入、Web、审计、索引（本次落地）
├── packages/validation/ # 共享校验器（S3 落地；docs/contracts/ 的代码化身，三端单一来源）
├── cli/                # npm 分发的 notegit CLI（S6 落地；发布名占用裸名 "notegit"）
└── docs/               # 契约与文档（只读，D6；修改走契约修订/epic ADR）
```

- **workspaces 声明**：`["server", "packages/*"]`。空 glob 静默容忍；`cli/` 建目录时显式加入。注意（npm 11.19.0 实测）：**已列出但不存在的显式 workspace 路径同样静默容忍**（install exit 0 无警告）——工作区列表没有拼写防护，增删条目时需人工核对目录名。不预建空壳包目录——S3/S6 各自带最小可测包落地。
- **命名约定**：内部包一律 `notegit-*`（notegit-server、notegit-validation…）；**裸名 `notegit` 保留给 S6 发布的 CLI**，根包名用 `notegit-monorepo` 避免占用。
- **被否决备选**：根目录单一扁平包（CLI 要独立 npm 分发、validation 要被三端引用，扁平包做不到单一来源）；pnpm/yarn（任务约束 npm）；nx/turborepo（4 个以内小包，YAGNI）。
- §1.3 假设中 `server/ packages/validation/ cli/ docs/` 四界全部保留，未改边界；breakdown §3 文件面相交结论无需复核。

## 2. 工具链决策

| 决策 | 内容与理由 |
|---|---|
| 测试框架 | **`node --test` + `node:assert/strict`，零测试依赖**。Node 24 原生 TS type stripping 直接发现并运行 `.ts` 测试（2026-10-12 本仓 v24.21.0 实测）。Fastify 路由测试用框架内置 `inject()`（light-my-request 随 fastify 分发，免 socket）。 |
| TS 语法边界 | 仅限**可擦除语法**（无 enum/namespace/构造器参数属性）——type stripping 的硬约束；相对导入必须带 `.ts` 扩展名。tsconfig 以 `allowImportingTsExtensions` + `verbatimModuleSyntax` + `isolatedModules` 钉住。 |
| 类型检查 | `tsc --noEmit` 串在 server `npm test` 前（`tsc --noEmit && node --test`），根 `npm test`（= `npm test --workspaces --if-present`）一条命令全绿 = 类型 + 测试双过。 |
| 依赖锁定 | 全部 `--save-exact` 精确版本 + 根 package-lock.json 提交：fastify 5.12.5、@node-rs/argon2 2.2.2、typescript 7.0.2、@types/node 24.19.2（对齐 Node 24 运行时面，不用 26.x 前瞻类型）。运行时依赖仅 fastify 与 @node-rs/argon2；`node:sqlite` 为 Node 内置。typescript 取 7.0.2（当前最新稳定版；计划行写的 5.x 早于 registry 查证，`tsc --noEmit` 在本仓配置下全绿；如 T2+ 遇 TS7 配置漂移，降 5.9.x 为一行改动）。 |
| 口令哈希绑定 | **@node-rs/argon2 2.2.2**（S2-T2 经协调人 2026-10-12 批复先行落地，S2-T3 复用该模块并做验证性评审，不再另选库）：Argon2id m=19456 KiB/t=2/p=1（identity §2/D-IC-02），实现 `server/src/auth/password.ts`。选型理由：napi-rs 预编译二进制含 linux-musl（node:24-alpine 部署关键、免 node-gyp）；PHC modular 格式与实现解耦，换库不影响已存哈希。坑：其 `Algorithm` 为 ambient const enum，与 verbatimModuleSyntax 不兼容——类型导入 + 字面量 `2 as Algorithm` 钉住；verify 对畸形串抛 InvalidArg，包装为 fail-closed 返回 false。被拒备选：hash-wasm（纯 WASM 免原生二进制，但无预编译性能优势）；argon2（node-gyp 原生编译，alpine 需构建链）。 |
| TS 生产执行策略 | **已定稿（S8-T1，2026-10-13）**：运行时 type-stripping——`node src/main.ts` 直跑（镜像 CMD），无构建步骤、无 tsx；依据与被否决备选见 [§10](#10-s8-t1-决策记录容器发行包--ts-生产执行策略定稿)与 [deploy/README.md](../../deploy/README.md)。 |
| engines | server: `>=24 <25`（D10 锁 Node 24；node:sqlite RC 状态靠锁版本锁定行为）。 |

## 3. 数据层决策（server/src/db/）

- **连接层** `openDatabase(path)`（connection.ts）：打开即执行 `journal_mode=WAL`、`busy_timeout=5000`、`foreign_keys=ON`。前两项是 selection §4 实测结论（默认无 busy_timeout 并发写立即 SQLITE_BUSY）；`foreign_keys` 虽是 node:sqlite 当前默认，仍显式钉住——RC API 不承诺默认值不变。注意 `:memory:` 库 journal 恒为 memory，WAL 无意义。
- **迁移机制** `migrate(db, migrations)`（migrate.ts）：守卫版本严格递增；`schema_version` 引导表由 runner 持有（`CREATE TABLE IF NOT EXISTS`，形状 = [storage-model §3.1](../contracts/storage-model.md)，append-only 触发器随契约 DDL 落地）；每迁移单事务、失败回滚该迁移。
- **出厂基线**（migrations.ts）：v1 保持空基线，**DDL 从 v2 起按任务递增**（上列二选一中的 (b)，随 S2-T2 任务定义落地：0002 = employees + one_time_tokens + schema_version append-only 触发器 IF NOT EXISTS 形态；等价性测试 `server/test/migration-0002.test.ts` 以契约 @schema 块的 table_info 对比防漂移）。其余 8 表仍以 storage-model.md 的 `-- @schema` 块为唯一来源（D6），随 S2-T3…T7 落地。**T3+ 组装各自迁移时注意**：runner 执行任何迁移前总是先 `CREATE TABLE IF NOT EXISTS schema_version` 引导表，契约 §3.1 块是裸 `CREATE TABLE`——迁移内容不得携带该建表行（必撞 already exists）；对照 @schema 块取业务表 DDL，触发器用 `IF NOT EXISTS` 形态。
- **应用接线**（S2-T2 已落地）：`startApp()`（main.ts）按 open → pragmas → migrate →（首启：pepper K1 自动生成 + 空库 bootstrap token 落盘）→ listen 顺序启动（backup §9）；数据目录默认 `/data`，`NOTEGIT_DATA_DIR` 可覆盖（backup §2 布局）。`buildApp(deps?)` 无 deps 仍为 S2-T1 骨架形态（仅 /healthz）。
- **认证/哈希注入缝**（S2-T2）：`buildApp` 的 `resolveSubject` 默认 fail-closed（恒 null → 401）——T3/T5 落真实载体解析（ngt_sid Cookie / Bearer ngt_，api.md §1）时替换；`hashPassword` 默认已接 `auth/password.ts`（Argon2id）。CSRF 同源校验仅适用 Cookie 认证写请求，随真实载体一并落地。
- **pepper（K1）**（S2-T2）：生成与 HMAC 工具在 `server/src/bootstrap/pepper.ts`（K1「首次初始化自动生成」挂 bootstrap 启动；文件为 identity §6.2 版本化列表格式 `{active, retired[]}`，retired 消费与轮换随 S2-T4）；已初始化实例启动时 pepper 缺失会大声失败（防静默重生成废掉全部已存哈希）。

## 4. 交接备忘（Wave 2+ worker）

1. 产品代码进 `server/src/<域>/`，测试进 `server/test/*.test.ts`（node --test 自动发现）；`npm test`（根，无参数）必须全绿后才算完成。
2. TDD 强制（sprint 计划 D1）：先写失败测试再实现；pragma/迁移/inject 先例见 server/test/。
3. `docs/contracts/` 只读；业务表 DDL 从 storage-model.md @schema 块取，落地方式见 §3。
4. 新增依赖：`npm install -w server --save-exact <pkg>`，保持精确版本纪律。
5. 布局/工具链决策变更：修订本文件并说明依据。

## 5. 已知遗留（S2-T1 终审，0 Critical/Important，以下 3 项 Minor 顺延）

整分支独立评审（2026-10-12）通过：14/14 绿、Review Focus 5 项全覆盖、所有权干净。三项 Minor 按当前单进程模型**不可达**，触发条件出现时必须处理：

1. `connection.ts` pragma 顺序为 WAL→busy_timeout：并发开库时败者以 timeout=0 执行取锁语句（实测竞态 10/10 触发 `database is locked`）。单进程内不可达（node:sqlite 全同步）；**任何第二进程/线程访问数据库的需求出现时**，改为 busy_timeout 先行 + 失败关闭句柄。
2. `migrate.ts` 跳过检查只看成员不看边界：库 {1,3} 遇列表 [1,2,3] 会在已记录边界之下静默补跑 v2。仅手工构造库状态或未来重排版本号可触发；可加 `version > max(applied)` 守卫。
3. 严格递增守卫放过 `NaN`：经 node:sqlite 绑定为 NULL 后由 rowid 别名落成 version=1，且报告 applied=[NaN] 破坏该列表重入。类型化 API 不可达（须显式传入 NaN）；加 `Number.isSafeInteger` 即堵。

## 6. S2-T3 决策记录（账号登录、口令与停用）

日期：2026-10-12（S2-T3，Orca dispatch `ctx_18e037d99cd1`）。本节登记该任务的选型与参数定稿；只追加，不改写上文。

### 6.1 Argon2id 绑定库：消费 S2-T2 共享模块（选型子项被协调裁决覆盖）

- **结论**：不另选库、无第二实现。`server/src/auth/password.ts`（S2-T2 落地，`@node-rs/argon2` 2.2.2）为唯一口令哈希模块；S2-T3 以**逐字复用**（本分支副本与 T2 工作区字节一致）+ 补充件 `password-policy.ts`（口令策略 / 登录等时防枚举）方式消费，对共享模块零改动以保合并零冲突。
- **背景**：任务定义原要求 S2-T3 在 `@node-rs/argon2` vs `hash-wasm` 间定稿（判据：无编译依赖 / 测试覆盖）；实现期间协调人裁定 T2 先行落地共享模块（本终端 task_47d88253d766 收到 status 消息）。S2-T3 曾按原任务定义完成 hash-wasm 4.12.0 选型与实现（纯 WASM 零编译依赖、PHC 'encoded' 输出、本机实测单次哈希 ~21ms），收到裁决后撤销并切换，此处留档备查；两案在契约参数上等价，裁决（预构建含 linux-musl、PHC 与实现解耦）成立。
- **验证性评审结论（PASS，无缺陷，未触发 ask）**：
  1. 参数与契约一致——`auth-password.test.ts` 直接断言哈希串 PHC 参数 `$argon2id$v=19$m=19456,t=2,p=1`（identity §2 / D-IC-02 的机器核对，非仅读源码）；
  2. PHC 格式标准且跨实现互操作——独立实现（hash-wasm 4.12.0）按契约参数生成的冻结向量能被共享模块校验（正/负口令各一），证明已存哈希不绑定生成实现；
  3. fail-closed——哨兵（`INVITED_PASSWORD_SENTINEL`）与畸形串校验一律 false 不抛异常（受邀未设口令账号不可被任何口令登录）；
  4. 盐每次哈希随机（同口令两次哈希盐不同）。
- 观察项（非缺陷）：共享模块参数内联于 `hashPassword`，未导出常量；契约面是 PHC 串而非 API，测试已在串级断言，不要求改动。

### 6.2 登录退避默认值（identity §2「阈值可配，默认值 S2 实现定」）

`server/src/auth/backoff.ts`，进程内计数（storage-model §2：登录限速计数为运行态，不落库）：键 = `username + 来源IP`；`maxFails=3`（免延迟失败次数）、`baseDelayMs=1000`、`maxDelayMs=30000`（窗口封顶）、`windowMs=15min`（静置衰减重计）。锁定中 429 `E-AUTH-005` + `Retry-After`，**不校验口令、不计失败**（防时序探测）；成功登录清零；无永久锁定（封顶锁过期即放行，正确口令可登录）。可经 `AuthPluginOptions.backoff` 覆盖；`app_settings` 持久化配置随后续配置任务接线。

### 6.3 `notegit admin recover` 命令名定稿（identity §7.2「待 T1」遗留项；D-IC-08）

**定稿：`notegit admin recover`**（容器 CLI：`docker exec <container> notegit admin recover`）。理由：api.md §3.1 与 identity §7.2 两处契约引用已用此名（契约只读，定稿即消除「待定」标注，零契约变更）；`admin` 命名空间收拢主机侧管理动作；动宾结构直指「管理员锁死恢复」。被拒备选：`notegit admin-recover`（顶层扁平化，弃 admin 分组）、`notegit recover`（语义过宽，易误解为数据恢复）、`notegit admin password-reset`（与 HTTP 端点 `/admin/employees/{u}/password-reset` 的 K5 令牌流程混淆——本命令是主机侧兜底，产生 `admin.host_recovery` 审计）。**命令本体实现按任务定义留 S2-T8 或运维任务。**

### 6.4 迁移 0003 形态（rebase 后定稿）

实现期间 T2 的 0002（employees + one_time_tokens + schema_version append-only 触发器）先合入 sprint/S2（f98938c），本分支随即 rebase：**0003 定稿为仅 sessions**（storage-model §3.3 @schema 块 + idx_sessions_employee 索引；schema_version 引导块按本文件 §3 剔除）——employees 基础表已由 0002 按同一契约 §3.2 块整表落地（含全部口令/状态列），无需 ALTER 补列，预合并期「谁先落谁建表」的重复建表面在 rebase 中消除（无生产库，安全）。

### 6.5 会话 pepper 与 SubjectResolver 缝（rebase 后并入 T2 启动接线）

- sessions.sid_hash = `HMAC-SHA256(pepper, sid)`（identity §4 / D-IC-03，键与 token K1 同源）。T2 的 pepper 文件（`loadOrCreatePepper`，版本化列表 K1）rebase 后已在本分支：`buildApp(deps)` 取 `deps.pepper.active.key` 同时喂 SubjectResolver 与 `registerAuth` 插件——会话与 token 键同源自该处成立；`hmacv1$` 前缀串与 §6.2 轮换消费仍属 S2-T4/T5。
- **SubjectResolver 缝由本任务填实**（T2 注释「真实载体解析随 S2-T3 落地」的落点）：默认实现 = `auth/subject.ts` 的 ngt_sid 会话解析（替换 fail-closed 恒 null），T2 的 bootstrap/invites 管理路由与 T3 认证路由共用同一会话存储与判定；注入覆盖保留（测试桩）。缝的返回类型 `Subject | null` 不区分停用原因——T2 路由对停用账号给 401 E-AUTH-001 而非 E-AUTH-004，四状态细分随 S2-T5 统一（该任务本就是四状态×双入口语义）。
- `buildApp(deps)` 现挂载本域路由（login/logout/me/password/PATCH）；Bearer ngt_ 载体解析随 S2-T4/T5 并入同一缝。

### 6.6 范围裁剪与移交

1. 审计事件（`employee.password_reset` / `employee.deactivate` / `employee.activate`、登录失败计数指标——identity §8 失败不逐条入审计）挂接待审计基座 S2-T7（audit_events 表未落地，代码内已留注释锚点）。
2. CSRF 同源校验（api.md §1 `E-AUTH-006`）为全局插件，未随本任务实现；本任务写端点（login/logout/me/password/PATCH）此前依赖 SameSite=Lax 缓解，建议 T5/T7 落全局 onRequest 钩子。
3. ~~本插件未接入 `buildApp()`~~（T2 的启动接线 rebase 后已在：`buildApp(deps)` 挂载本域路由并填实 SubjectResolver 默认实现，见 §6.5）。
4. `PATCH /api/v1/admin/employees/{username}` 已实现 `active` 与 `is_instance_admin` 两字段；未加「最后管理员」保护——api.md 该端点错误列未含此路径，管理员全员锁死以 identity §7.2 主机侧恢复为设计兜底。

## 7. S2-T5 决策记录（四状态×双入口生效语义 + 集成收尾）

日期：2026-10-13（S2-T5，Orca dispatch `ctx_eb813c256cc1`）。本节登记生命周期统一模块（`server/src/auth/lifecycle.ts`）的定稿语义；identity §5 是唯一语义源，本节只记录契约未逐字规定、由本任务定稿的实现语义（任务 brief 授权「实现以你为准，T7 审计基座消费」）。只追加，不改写上文。

### 7.1 载体并存优先级（Cookie + Bearer 同请求）

**定稿：`Authorization` 头在场即优先；否则用 ngt_sid 会话 Cookie。**

- 显式头凭据是调用方的明确选择，Cookie 是浏览器环境凭据——并存时以显式者为准，主体归因与 CSRF 豁免面由同一判定导出（见 §7.2/§7.3），不出现「认证用一个载体、豁免按另一个载体」的错配。
- `Authorization` 在场但 scheme 非 Bearer → 401 E-AUTH-001，**不回退 Cookie**（防载体混淆：调用方已声明头凭据时静默改用环境 Cookie 意味着主体与调用方意图不一致）。
- Bearer 失败（过期/撤销/停用）同样不回退 Cookie——四状态阻断对「该凭据」生效，换载体重试是调用方的新请求。
- 会话载体独立凭据原则（identity §1）不变：token 过期/撤销不影响会话（§5.2 前两行 Web 列）。

### 7.2 四状态 → 401 映射（api.md §2.3 的实现定稿）

| 状态 | 载体 | code | reason |
|---|---|---|---|
| 未提交/未知凭据 | 任意 | E-AUTH-001 | unauthenticated |
| 会话自身过期/无效 | session | E-AUTH-001 | unauthenticated（会话是独立凭据，identity §4；token 的 002/003 不适用于会话入口） |
| 凭据过期 | token | E-AUTH-002 | expired |
| 凭据撤销 | token | E-AUTH-003 | revoked |
| 账号停用 | session 或 token | E-AUTH-004 | account_disabled |

- 映射唯一实现点：`auth/lifecycle.ts`（`createRequestAuthenticator` / `rejectAuth`）；路由不得自判（T2 invites 路由的 E-AUTH-001 误报即旧缝丢失原因所致，本任务修复）。
- 会话载体失败统一清 ngt_sid Cookie（「被登出」呈现，identity §5.2 停用行）；停用不删会话行（零延迟来自逐请求查 active）。
- `/api/v1/me` 与 `/api/v1/me/password` 接受双载体（api.md §3 错误列 001–004）；`logout` 是会话载体操作（删除的是会话行，Bearer 请求无会话可删 → E-AUTH-001）。

### 7.3 CSRF 同源校验（identity §4 + api.md §1 移交项的落地）

`server/src/auth/csrf.ts`（全局 onRequest，挂初始化闸门之后）：非安全方法（GET/HEAD/OPTIONS 之外）且携带 ngt_sid 且无 `Authorization` 头 → 校验同源。回退链定稿：**Origin 在场即以 Origin 判定；缺失回退 Referer 的 origin 部分；两者皆缺失 → 403 E-AUTH-006**（同源浏览器对非安全方法必带 Origin/Referer，皆缺失无法确立同源；程序化客户端用 Bearer——天然豁免）。默认端口归一（http:80/https:443 ≡ 省略）。判定依据是 **Cookie 呈现**而非会话有效性：跨站请求带的是受害者有效 Cookie，校验独立于且先于认证层。

### 7.4 审计入口归因（entry=web/api/git；identity §8）

- **会话载体 → `entry='web'`；token 载体（CLI/程序化 API 的 Bearer）→ `entry='api'`；Git Smart HTTP Basic → `entry='git'`（S3 落地，api.md §8.5）**。
- 载体标识 `carrierRef`：`session:<会话行 id>` / `credential:<凭据 id>`（不含任何凭据材料）；主体 = `subject.employee_id`（认证员工，不信任 commit author）。
- `AuthSuccess.carrier / carrierRef / entry` 为 T7 审计基座的消费面；凭据域先行落地（创建/撤销审计行按载体写 entry），其余域随 T7 挂接。

### 7.5 授权层接口与移交（T6/S3/T7）

- `MembershipSource.lookup(slug, employeeId)`：identity §5.1 第 2 层的接口化；**S2-T6 以 vaults/vault_members 真实表实现**（storage-model §4 `authz.role` 规范查询 + slug→id 映射），三入口（Web/API/Git）共用。撤权/无权/不存在/越出 scope 清单 → not_found（404，D-IC-06）；成员而角色或范围不足写 → forbidden（403 E-AUTHZ-001）。
- `reauthorizeAtExecutionPoint()`：写路径执行点复查钩子（identity §5.1 第 3 层）——**S3 在 pre-receive / Web 发布组件 update-ref 前挂接**（分支规则复查同点叠加）；维护模式标志复查位随 S2-T7。
- 在途语义（identity §5.3）：一般操作按起点授权放行完成；**push 是例外**——撤权发生在检查后、执行点前，执行点复查拒绝并记审计 `rejected`（T7/S3 消费）。

### 7.6 本任务收尾记录（master 集成裁决并入）

1. **收尾 a**：one_time_tokens 哈希前缀 `hmac1$` → `hmacv1$`（`bootstrap/pepper.ts` 的 `hmacTokenHash`；与凭据域 `hashToken` 及 identity §3.2 契约拼写统一）。发布前无生产库，无存量哈希迁移问题。
2. **收尾 b**：`SubjectResolver`（返回 `Subject | null`，丢失失败原因）→ `RequestAuthenticator`（返回 `AuthOutcome`，四状态精确区分）；T2 invites 路由停用账号由 E-AUTH-001 修正为 E-AUTH-004。
3. **收尾 c**：CSRF 同源校验钩子落地（§7.3）；受影响存量测试补同源 Origin 头。
4. **基线收敛**：master 的 D11 ADR 同步（97ab349）只改了契约侧 display_hint 注释，迁移 0004 文本滞后致基线 1 例失败；本任务将迁移注释逐字对齐契约，防漂移测试收紧为逐行等价断言。
5. §6.6-2 的 CSRF 遗留项随收尾 c 关闭。

## 8. S2-T7 决策记录（维护模式写闸门 + 审计主体基座）

日期：2026-10-13（S2-T7，Orca dispatch `ctx_645c17b8b35d`，branch `WayJ/s2-t7-maintenance`）。backup-recovery §3（矩阵唯一语义源）、identity §8、storage-model §3.8/§5 为契约依据；本节只记录契约未逐字规定、由本任务定稿（或经协调人批复）的实现语义。只追加，不改写上文。

### 8.1 login/logout 不入审计（协调人 2026-10-13 批复）

storage-model §5 event_kind 注册表是事件清单唯一源（D6 只读），其中无 session.login/logout；identity §8 亦明确认证类事件不逐条入审计（防噪音）。session 生命周期由 sessions 表承载足够；未来若需要会话审计事件，走契约修订（epic ADR），不破例。任务 brief 中列出的 login/logout 挂接据此裁剪。

### 8.2 维护模式生命周期端点（协调人 2026-10-13 批复形状）

- `POST /api/v1/admin/maintenance`（开启）/ `DELETE /api/v1/admin/maintenance`（关闭）；均需实例管理员（403 E-AUTHZ-001），未认证 401 经统一缝。
- 幂等：已处于目标态返回 204 且**不重复记审计**（仅状态迁移记行）。
- 维护期间自身放行（backup §3 写分类：维护生命周期属运行态写入）——闸门 allowlist 显式列入，否则开启后无法关闭。
- api.md 尚无此端点定义（§1 只定 E-MAINT-001 与放行规则）；补录欠账挂 coordinator 台账，随下次契约修订（S3 会再动 api.md）落地。

### 8.3 闸门放行清单与拒绝对象（backup §3 矩阵的实现定稿）

- 全局 onRequest 第一位（api.md §10 组装序），先于路由解析：api.md 标注「写」的未来端点（vaults/成员/草稿/提交）无需各自挂接即被覆盖（矩阵测试以契约路径直证）。
- 放行的非安全方法 = 运行态写入三入口：`/api/v1/auth/login`（矩阵明列）、`/api/v1/auth/logout`（会话删除与创建同属会话运行态——backup §3「登录会话属运行态写入」的对偶面；api.md §1 的「一切写端点 503」按矩阵唯一语义源裁剪）、`/api/v1/admin/maintenance`（§8.2）。
- 拒绝响应：503 E-MAINT-001，`details.maintenance: true`；无 Retry-After（api.md §2.1：仅 429 使用）。
- `/healthz` 与（未来的）/git/* 不在闸门层：Git receive-pack 的 403「维护中」由 S3 的 /git 入口落地（api.md §8.4）。
- bootstrap 端点未单列：开启维护需已认证实例管理员（预初始化态不可能），已初始化后 bootstrap 恒 410——组合不可达，闸门按通用规则覆盖。

### 8.4 审计基座（server/src/audit/）消费面与守卫

- `recordAuditEvent`：主体字段唯一来源 = 认证缝 AuthSuccess（employee_id + carrierRef + entry；载体优先级按 §7.1 由缝定稿，基座不另行挑选）。commit author/committer 只可能进 detail，永不进主体字段（identity §8；伪造 author 测试两层覆盖：基座单元 + 流程级）。
- 脱敏守卫 fail-closed：detail 含 `ngt_` 明文（≥20 连续 token 字符；掩码形态 `ngt_ab…wxyz` 不误伤）或口令/密钥类键名（password/passphrase/secret/authorization，任意深度）、carrierRef 非 `credential:<id>`/`session:<id>` 限定形态 → AuditMaskingError，行不落库。
- employee 主体两种归因形态：`subject`（有凭据载体：会话/token）或 `employeeId`（无载体：K5 一次性令牌消费——K5 不属 identity §8 的凭据载体，credential_ref NULL）；互斥，actor_kind ≠ employee 不得携带主体（DDL 注释一致性由写入口径保证）。
- `settleAuditEvent`（pending → 终态，供 S3 发布链）与 `drainCount`（audit.drain_count 规范 SQL 逐字，backup §4 步骤 2 排空）。
- 凭据域（T4 已落地）的 credential.create/revoke 行维持原样：其 credential_ref 记**被操作凭据**（`credential:<id>`，合并时已评审的语义），非认证载体；detail 键（name/managed_for）过守卫无冲突，未改走基座以避免对已并入行为的无谓翻动。

### 8.5 挂接点小改清单

- bootstrap/routes.ts：account.bootstrap（actor_kind=bootstrap ⇒ employee_id NULL，创建的管理员记 detail；entry=api——HTTP 初始化无凭据载体）。
- invites/routes.ts：employee.create（主体=邀请管理员）；employee.password_reset（主体=K5 归属目标员工，credential_ref NULL，entry=api）。invite.ts 的 consumePasswordReset 返回值 void → employee_id（向后兼容）。
- auth/routes.ts PATCH admin employees：employee.activate/deactivate（按请求最终态；is_instance_admin 变更无注册表 kind，不记）。

### 8.6 与 S2-T6 的并行缝（vaults 父表）

迁移 0006 的 audit_events.vault_id 外键在 `PRAGMA foreign_keys=ON` 下要求 vaults 父表**在场**（即使插入 NULL）——0005（vaults/vault_members，S2-T6 独占）未并入前，任何审计写入都会失败。处置：复用 S2-T4 的测试夹具模式（credentials-fixtures 的 FIXTURE_DDL 导出，IF NOT EXISTS 契约等价 DDL），凡触发审计写入的 app 级测试先应用夹具；0005 并入后夹具成 no-op。迁移注册表双方各自 append（本任务 6、T6 的 5），集成侧按序交错为 [1..6]。

### 8.7 移交与欠账

1. api.md 补录维护端点（§8.2）——coordinator 台账挂账，随 S3 的 api.md 修订闭环。
2. S3 消费面：pre-receive / Web 发布组件经 `recordAuditEvent(pending)` → update-ref → `settleAuditEvent`；执行点复查叠加维护标志（§7.5 预留位）；audit.chain 查询随恢复对账（backup §7 步骤 7）。
3. `employee.password_reset` 的管理员触发端点（api.md §3.1 POST …/password-reset）尚未实现（非本任务面）；落地时按 §8.4 形态挂接。

## 9. S3-T3 决策记录（共享校验器 packages/validation）

日期：2026-10-13（S3-T3，Orca dispatch `ctx_f8b5c8acfe64`）。本节登记共享校验器包的选型与实现语义；契约语义唯一来源仍是 docs/contracts/validation.md（只读消费），此处只记录契约未逐字规定、由本任务定稿的部分。测试基线：packages/validation 92 用例（含 7 份契约示例逐份复现）+ server 3 用例构建断言，根 npm test 337 全绿。

### 9.1 选型

| 决策 | 内容与理由 |
|---|---|
| rulesVersion 来源 | **运行时读取** docs/contracts/rules-version.json（任务二选一：运行时读取 vs 构建期内联+断言）。理由：本仓无构建步骤（tsc --noEmit + Node 24 type stripping 直跑 .ts），「构建期」不存在；运行时读文件保持 manifest 为唯一机器来源，一致性由测试对同一文件运行时比对保证（D6：无硬编码版本号）。~~部署期打包（S8）需将 contracts 目录随包分发或改内联，留 S8 定稿~~（S8-T1 定稿：随镜像分发只读副本，见 [§10.2](#102-契约文件随镜像分发91-rulesversion-行销账)）。 |
| YAML 解析 | **`yaml` 2.9.1（唯一新增运行时依赖，--save-exact）**。安全子集以 AST 层实现：`parseDocument` + 自走查（uniqueKeys:false）检测重复键/锚点/别名/合并键/自定义 tag（core tag 白名单外 URI 与 `!short` 形态均拒）；不用 uniqueKeys:true 是因为需要重复键的字段名与行号（库报错不含）。资源常量在走查中同程计量：块 ≤64KiB、节点 ≤1000（pair/键/值/集合每节点计数）、深度 ≤8（集合层数，根=1）。 |
| 测试零依赖 | 沿用 S2-T1「零测试依赖」：**不引 ajv**，测试内嵌 JSON Schema 子集校验器（test/helpers/schema-check.ts，覆盖本 schema 用到的 type/required/properties/enum/const/pattern/minLength/minimum/items/allOf/if-then/$ref）；先对 6 份契约示例自证再校验实现产出。 |
| glob | 自实现最小匹配器（`*` 单段、`?` 单字符、`**` 跨段）。无 `/` 的模式按**文件名**匹配任意目录（.gitignore 式——`docs/.gitattributes` 需命中默认清单）；模式匹配大小写**敏感**（契约仅规定 README 与扩展名匹配不敏感）。 |
| 包接线 | exports `.` → `src/index.ts`；Node 24 经 node_modules 符号链接加载 .ts（spike 实测可行，tsc 7.0.2 接受）；server 显式声明依赖 `notegit-validation@0.0.0`（workspace 解析），构建断言测试即 server 侧 import + rulesVersion 比对（sprint D7）。CLI 入口 bin/notegit-validation.ts：stdin 读 ValidateInput JSON → stdout 报告 JSON → 按报告 exitCode 退出。 |

### 9.2 判定语义定稿（契约未逐字规定处）

1. **短路链**（单文件）：危险 tree 条目（symlink/gitlink/非法 mode/.git 系）→ 整条拒绝，不做路径/类型/内容判定（示例 3：evil-link 无扩展名但只报 E-PATH-002）；路径形状违规 → 仅 E-PATH-001；文档超限 → 仅 E-LIMIT-001 且不解析内容（资源防护）；缺 frontmatter 块（E-FM-001）→ 不再产生链接 warning（示例 6 warningCount=0）。
2. **E-FM-002 覆盖面**：YAML 语法错误、未闭合块、**顶层非映射**（合法 YAML 但形状不符）、内容非有效 UTF-8（注册表无编码专属码，取最近语义；TextDecoder fatal 探测）。
3. **`<<` 合并键**：任何值为 `<<` 的映射键即拒（含引号形态——严于 YAML 规范的 plain-only 语义，防规避）。
4. **E-FM-003 行号**：title 缺失=块内首个内容行（空块=第 2 行）；空白 title=title 键所在行。E-FM-004/005/009=违规字段键行；E-FM-006=重复键行；E-FM-007=首个不安全构造（单条 issue，防多构造刷屏）。
5. **E-PATH-004 范围**：同一提交的**变更路径集**内比对（契约「同一提交内」字面）；跨存量 tree 的大小写冲突基线检查留 T4 扩展（当前 API 未接收逐提交全 tree 列表）。pre-commit/web-submit 在 files 集合内比对。
6. **E-LIMIT-004/005 落位**：顶层 `issues[]`、每受影响 ref 一条（schema issue.ref 字段即为此设计）；pushBytes/vaultCurrentBytes 由消费方计量传入（口径=打包对象字节，T4/T6 落地时确认，契约 §9 开放项）。
7. **special 文件无容量规则**：契约只定义文档（E-LIMIT-001）与附件（E-LIMIT-003）限额，specialFilePatterns 命中者两者皆不适用——留 T8 容量任务复核（若需限额属 B1 变更走契约修订）。
8. **运行时限制**：超时=阶段边界协作检查（可注入 clock；骨架检查点产出的 E-RUN-001 定位首个 ref，复现示例 5）；内存=入口 RSS 对 maxValidationMemoryMb（近似上界——进程 RSS 含 Node 基线，默认 256MiB 不误伤）；并发=createValidator 实例级信号量、超限立即 E-RUN-001（validate() 单发入口不带并发——并发是实例运行态）；运行错误报告 files 恒为 []（不做部分判定，与示例 5 一致）。
9. **frontmatter 提取**：首行/闭合行 trimEnd 容忍 CRLF 与尾随空白；UTF-8 BOM 剥离；行号一律折算为文档内 1 起始行号（链接行 +closeLine 偏移）。
10. **W-LINK-101 提取**：正则级 Markdown 链接（inline/image/reference 定义，含 `<>` 空格形态）；外部 scheme/协议相对/纯锚点跳过；`/` 起始按库根解析；目录链接以「其下存在文件」判存在。漏检只影响 warning（不阻断），可接受——不引 CommonMark 解析器。
11. **消息文案**：代码渲染注册表 §6.2 模板（与契约表逐字一致，测试对 validation.md 运行时解析交叉核对）；契约示例的消息为人工润色（含上下文建议），复现对比剥离 message、全等比较其余字段（定位字段/actual/expected/limit/limitKey/summary/refs/outcome/exempt）。

### 9.3 移交与欠账

1. T4（pre-receive）：refs/commits 输入由 git 遍历组装（合并提交按父展开、根提交全检）；E-PATH-004 全 tree 基线、tag ref 处置（契约 §1「第一版不提供 tag 写入」）属 T4/T5 面。
2. T7（发布组件）：web-submit scope 已可用（候选提交条目 + commit/vaultId 透传）；「保留草稿」是调用方（Web 层）消费 fail 报告的行为。
3. T8（容量）：validation-defaults 全键已可经 config 覆盖（withOverrides，E-LIMIT 测试含收紧/放宽用例）；Q7 建议值校正后走契约 changelog（B1/B2）。
4. CLI stdin 挂起（无管道输入时不退出）留 S6 hook 集成时定稿（hook 恒管道输入）。

## 10. S8-T1 决策记录（容器发行包 + TS 生产执行策略定稿）

日期：2026-10-13（S8-T1，Orca dispatch `ctx_0603dfb14291`）。销账两笔：§2 工具链表「TS 生产执行策略」行（S2-T1 挂账「留给 S8 打包定稿」）与 §9.1 rulesVersion 行「部署期打包」空位。交付物：`deploy/`（Dockerfile、docker-compose.yml、README.md、scripts/init-drill.mjs）+ 静态契约测试 `server/test/deploy-image-static.test.ts`。任务定义：[implementation-breakdown §2.7 S8-T1](../s1/implementation-breakdown.md)；依据 D10、[selection §5](../s1/selection.md)、[backup §2](../contracts/backup-recovery.md)。

### 10.1 TS 生产执行策略：运行时 type-stripping（`node src/main.ts`）

| 备选 | 裁决与依据 |
|---|---|
| **运行时 type-stripping（采纳）** | 镜像 CMD `["node", "src/main.ts"]`（WORKDIR /app/server）。零构建步骤、零新增依赖；运行与测试同一代码路径（`node --test` 发现并直跑 .ts 即此形态）；类型安全由 `tsc --noEmit`（gates product）承担。前提已由本仓钉死：仅可擦除语法 + `.ts` 扩展名相对导入（§2「TS 语法边界」行）。 |
| 镜像内 `tsc` build → `node dist` | 否决：引入构建步骤与 emit 配置漂移面（`allowImportingTsExtensions` 需配套 `rewriteRelativeImportExtensions` 改写产物导入）；源/产物双形态加大升级回退（S8-T7）与 githttp hook shim 绝对路径（hooks.ts 指向 `src/*.ts`）的核对面；类型检查收益与既有 `tsc --noEmit` 重复。 |
| tsx 运行时 | 否决：新增运行时依赖，违反 --save-exact 最小依赖纪律（运行时依赖仅 fastify/@node-rs/argon2/notegit-validation），供给面扩大，收益仅省启动期类型擦除（无感）。 |

镜像佐证：`npm ci --omit=dev`（typescript 不进镜像）+ Dockerfile 构建期自检——以生产依赖树真实 `import` validation 包并读取两份运行时契约文件，缺件即构建失败。

### 10.2 契约文件随镜像分发（§9.1 rulesVersion 行销账）

validation 包运行时读取 `docs/contracts/rules-version.json` 与 `docs/contracts/validation-defaults.json`（`contract.ts` 相对 `import.meta.url` 定位）。定稿：**随镜像分发只读副本**——Dockerfile `COPY` 两份 JSON 至 `/app/docs/contracts/`（路径布局与仓库一致，包内相对定位不变），不改内联：manifest 单一机器来源纪律（D6）不动。镜像内副本与仓库同源由构建期自检（`rulesVersion()` + `defaultConfig()` 真实加载）兜底；`.dockerignore` 以 `dir/*` + `!` 例外链只放行这两份文件进构建上下文。

### 10.3 发行包其余定稿（操作面详见 [deploy/README.md](../../deploy/README.md)）

- 基础镜像 `node:24-alpine`（`ARG NODE_IMAGE` 供生产 pin 补丁版——node:sqlite RC 行为漂移靠锁版本规避）；`apk add git git-daemon`——**git-http-backend 归属 git-daemon 包而非 git 包**（N3：注释防回归 + 构建期 `test -x` 断言 + 运行态演练复检，三层）。
- 非 root 运行（notegit uid/gid 10001）；`/data` 四分域镜像内预建并归属运行用户（backup §2）；`HEALTHCHECK` 探测 `/healthz`。
- HTTPS 接入选型：**反向代理终结 TLS，容器保持 HTTP**（identity §6.1 K3——证书部署方管控、实例外流程；容器内 TLS 否决：证书生命周期不进容器面）。此为 selection §5 网络行「反代或容器内 TLS，S2 决定」空位的落定；架构 §10「HTTPS 接入」表述不变，如 master 认定需升 ADR/architecture.md 同步，随评审归档。
- 首次初始化演练：`deploy/scripts/init-drill.mjs`（D5 演练即测试：全新容器→健康→bootstrap 管理员（含 token 用后即删断言）→邀请员工→建库→Git/网页双通道冒烟→重启→账号/权限/历史/知识四项仍在 + bootstrap 永久 410；断言化可复跑，输出留档即 DOD-01 场景前置证据形态）。

### 10.4 移交

1. T2（指标/R14）、T4/T5（备份/恢复工具与演练）、T7（升级回退演练）、T8（容量收口——**512MB 地板按 S7-T8 RSS 232MB 基线复核**，sprint D6）按波次接手；deploy/README「已知边界」已列。
2. `notegit admin recover`（identity §7.2，§6.3 已定名）命令本体仍未实现——运维锁死恢复当前无主机侧兜底，属运维工具化欠账（credentials-ops §5.3 同域），随 T2/运维任务排期。
