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

- **workspaces 声明**：`["server", "packages/*"]`。`packages/*` 现在匹配为空（npm 对空 glob 静默容忍）；`cli/` 建目录时显式加入列表（npm 对「已列出但不存在」的显式路径报错，故不提前列出）。不预建空壳包目录——S3/S6 各自带最小可测包落地。
- **命名约定**：内部包一律 `notegit-*`（notegit-server、notegit-validation…）；**裸名 `notegit` 保留给 S6 发布的 CLI**，根包名用 `notegit-monorepo` 避免占用。
- **被否决备选**：根目录单一扁平包（CLI 要独立 npm 分发、validation 要被三端引用，扁平包做不到单一来源）；pnpm/yarn（任务约束 npm）；nx/turborepo（4 个以内小包，YAGNI）。
- §1.3 假设中 `server/ packages/validation/ cli/ docs/` 四界全部保留，未改边界；breakdown §3 文件面相交结论无需复核。

## 2. 工具链决策

| 决策 | 内容与理由 |
|---|---|
| 测试框架 | **`node --test` + `node:assert/strict`，零测试依赖**。Node 24 原生 TS type stripping 直接发现并运行 `.ts` 测试（2026-10-12 本仓 v24.21.0 实测）。Fastify 路由测试用框架内置 `inject()`（light-my-request 随 fastify 分发，免 socket）。 |
| TS 语法边界 | 仅限**可擦除语法**（无 enum/namespace/构造器参数属性）——type stripping 的硬约束；相对导入必须带 `.ts` 扩展名。tsconfig 以 `allowImportingTsExtensions` + `verbatimModuleSyntax` + `isolatedModules` 钉住。 |
| 类型检查 | `tsc --noEmit` 串在 server `npm test` 前（`tsc --noEmit && node --test`），根 `npm test`（= `npm test --workspaces --if-present`）一条命令全绿 = 类型 + 测试双过。 |
| 依赖锁定 | 全部 `--save-exact` 精确版本 + 根 package-lock.json 提交：fastify 5.12.5、typescript 7.0.2、@types/node 24.19.2（对齐 Node 24 运行时面，不用 26.x 前瞻类型）。运行时依赖仅 fastify；`node:sqlite` 为 Node 内置。 |
| TS 生产执行策略 | **留给 S8 打包定稿**（镜像内编译 vs 运行时 stripping 均可行，机制不受影响）；本任务不引入构建步骤。 |
| engines | server: `>=24 <25`（D10 锁 Node 24；node:sqlite RC 状态靠锁版本锁定行为）。 |

## 3. 数据层决策（server/src/db/）

- **连接层** `openDatabase(path)`（connection.ts）：打开即执行 `journal_mode=WAL`、`busy_timeout=5000`、`foreign_keys=ON`。前两项是 selection §4 实测结论（默认无 busy_timeout 并发写立即 SQLITE_BUSY）；`foreign_keys` 虽是 node:sqlite 当前默认，仍显式钉住——RC API 不承诺默认值不变。注意 `:memory:` 库 journal 恒为 memory，WAL 无意义。
- **迁移机制** `migrate(db, migrations)`（migrate.ts）：守卫版本严格递增；`schema_version` 引导表由 runner 持有（`CREATE TABLE IF NOT EXISTS`，形状 = [storage-model §3.1](../contracts/storage-model.md)，append-only 触发器随契约 DDL 落地）；每迁移单事务、失败回滚该迁移。
- **出厂基线**（migrations.ts）：仅 v1 空基线。**10 表 DDL 内容的唯一来源是 storage-model.md 的 `-- @schema` 块**（D6），随 S2-T2…T7 各任务落地。落地时二选一（留给 T2+ 与 master 评审）：(a) pre-release 期把 v1 直接长成完整契约 DDL（当前无生产库，重定义安全；发布时与契约「版本 1 = 本契约 DDL」对齐）；(b) 保持 v1 为基线、DDL 从 v2 起按任务递增。两案机制均直接支持（可重入 + 按序补齐）。
- **应用接线**：`buildApp()`（app.ts）当前 DB-free；S2-T2+ 落地启动流程 `open → pragmas → migrate → listen`（backup §9「随新版本启动自动执行」）。

## 4. 交接备忘（Wave 2+ worker）

1. 产品代码进 `server/src/<域>/`，测试进 `server/test/*.test.ts`（node --test 自动发现）；`npm test`（根，无参数）必须全绿后才算完成。
2. TDD 强制（sprint 计划 D1）：先写失败测试再实现；pragma/迁移/inject 先例见 server/test/。
3. `docs/contracts/` 只读；业务表 DDL 从 storage-model.md @schema 块取，落地方式见 §3。
4. 新增依赖：`npm install -w server --save-exact <pkg>`，保持精确版本纪律。
5. 布局/工具链决策变更：修订本文件并说明依据。
