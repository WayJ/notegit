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
| TS 生产执行策略 | **留给 S8 打包定稿**（镜像内编译 vs 运行时 stripping 均可行，机制不受影响）；本任务不引入构建步骤。 |
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
