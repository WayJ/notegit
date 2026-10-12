# S1-T1 技术选型与部署规格

- 日期：2026-10-12
- 作者：S1-T1 worker（Orca dispatch `ctx_af2e0c8e6d59`，branch `WayJ/s1-t1-selection`）
- 状态：**DRAFT，待 master 归档为 ADR D10+**
- 硬约束来源：用户决策 D6（Node/TypeScript 生态 + Linux/Docker 单容器），架构 v0.2 §3.2/§4/§5.4/§9/§10
- 证据日期声明：本文所有实测证据采集于 2026-10-12（Apple M4/16GB、macOS、Docker 29.5.2、Node v24.21.0、git 2.50.1）。选型依据架构 v0.2（本仓库 `architecture.md`）；后续架构修订需复核本文结论。

## 1. 范围与硬约束

在用户划定边界（D6）与架构 v0.2 条文内选型：

| 约束 | 来源 | 对选型的影响 |
|---|---|---|
| Node/TypeScript 生态 | D6 | 语言与运行时固定为 Node + TS；CLI 与服务端同栈 |
| Linux + Docker 单容器 + 持久卷 | D6、架构 §10 | 数据库必须在单容器内可用（或纯文件）；不引入第二容器/进程编排 |
| 自带 Git 服务，不依赖外部平台 | 架构 §1.1、Sprint S1 | Git HTTPS 接入必须自建（库 vs 包装 git http-backend 两路线） |
| 引用发现即鉴权、稳定 ID→仓库映射 | 架构 §3.2 | Git 路线必须支持在 ref 广告/收包阶段执行认证与逐 ref 授权 |
| 主分支快进发布、禁 force/delete | 架构 §4.3 | 必须真实拒绝非快进 push 与受保护 ref 删除（不许只靠客户端约束） |
| 逐提交校验、先写后删必须拦截 | 架构 §5.4 | 接收端必须能遍历推送范围内每个新提交的每个文件 |
| 单实例、每库一个 bare 仓库 | 架构 §9 | DB 按单实例场景评估，不考虑分布式 |
| 维护模式一致备份 | 架构 §10 | 备份方案必须能在停写后得到 DB + 全部 Git 仓库的一致副本 |

所有对比项每格证据为三类之一：**[实测]**（spike 输出文件，可复跑，附录 A）、**[文档]**（权威链接）、**[推断]**（由前两者推导，注明推理链）。

## 2. Git HTTPS 接入路线

候选：**路线 B：Node 包装 `git http-backend`（CGI 子进程）** vs **路线 A：isomorphic-git 纯 JS 库自研协议**。两条路线均以 TDD 写出**同一组 7 项行为测试**（clone、FF push、未认证 401、非快进拒绝+服务端 ref 不变、逐 ref 授权（含主分支删除保护）、先写坏后删拦截、多 ref 原子拒绝），全部通过后对比实现代价与运行特征。

| 维度 | 路线 B：CGI 包装 git-http-backend | 路线 A：isomorphic-git 纯 JS | 证据 |
|---|---|---|---|
| 行为测试 7/7（含非快进拒绝、逐 ref 授权） | ✔ 通过 | ✔ 通过 | [实测] B: `spikes/git-http-backend/evidence/route-b-tests.txt`；A: `spikes/isomorphic-git/evidence/route-a-tests.txt` |
| 非快进拒绝的实现方式 | 原生 `receive.denyNonFastForwards` 配置（B3） | 手写 old-oid 匹配 + `isDescendent()`（A3） | 同上 |
| 逐 ref 授权的实现方式 | pre-receive hook 读入全部 ref 命令，按 `REMOTE_USER` 判权；拒绝即整包回滚（B4/B6） | 收包后解析 pkt-line 命令，进程内 policy（A4/A6） | 同上 |
| 逐提交校验（§5.4 先写后删） | hook 内 `git rev-list` + `git diff-tree` 逐提交逐文件（B5） | `readCommit` + 手写递归 tree diff（A5；`readTree` 单层，需 flattenTree 助手） | 同上 + A 能力报告第 3 条 |
| 协议实现量 | 77 行 CGI env 组装 + 流转发（server.mjs）+ 60 行 pre-receive hook = 137 行 | 254 行手写 pkt-line/广告/收包/report-status（server.mjs） | [实测] `wc -l` 两 spike 源码 |
| 协议正确性风险 | 协议由 git 官方实现维护（含 quarantine、thin pack、v2 协商） | 9 项尖锐边角已记录：caps 漏告即客户端本地中止、delete 简写静默丢弃、indexPack 路径语义未文档化崩溃等 | [实测] `route-a-capability.txt` 第 1–8 条；git 官方文档 https://git-scm.com/docs/git-http-backend |
| 隔离性（quarantine） | 原生：收包先入隔离目录，pre-receive 全过才迁移，并发读者看不到半写状态 | DIY：手工命名隔离 pack，无原子迁移 | [实测] A 能力报告第 8 条；B 依赖 git receive-pack 原生行为 |
| clone 性能（501 文件 ~4.1MB，中位） | **197 ms** | 604 ms（3.1×） | [实测] `route-b-perf.txt` / `route-a-perf.txt` |
| 小 push / fetch（中位） | 162 / 75 ms | 105 / 66 ms（A 略快，但无增量协商，历史增长会劣化） | 同上 + A 报告 NOTE |
| 服务进程 RSS（同等负载后） | **114.7 MB** | 318.4 MB（2.8×） | 同上 |
| 进程模型 | 每个 Git 请求 spawn 一个 git 子进程（Linux 容器内 fork+exec 代价低） | 全进程内，无子进程 | [推断] 部署规格按 B 的 RSS 推导（§5） |
| 维护面 | 跟随系统 git 升级；CGI env 契约稳定 | 需持续跟踪 isomorphic-git API 演进与 git 协议演进（v2、side-band 等） | [文档] https://git-scm.com/docs/gitprotocol-pack ；https://isomorphic-git.org/docs/en/ |

**结论（Git 接入）：路线 B。** 非快进拒绝与逐 ref 授权在两条路线都可达（实测 7/7），判据在实现代价与长期风险：B 用 137 行（server+hook）拿到 git 原生 receive-pack 的全部语义（denyNonFastForwards、pre-receive 原子性、quarantine），而 A 用 254 行换回 9 个已记录的尖锐边角 + 3.1× clone 延迟 + 2.8× 内存，且协议演进负担自担。B 的 `REMOTE_USER` 环境变量从 CGI 层透传进 hook（实测 B4），使"Git 授权复用 Web 身份"（架构 §3.2、§4.2）有直接的实现路径。

已知代价与对策：
- 每请求一个子进程 → 并发受容器 fd/进程限制，部署规格（§5）预留；S1-T4 spike 在选定栈上复验。
- 需要容器内有 `git` 与 `git-http-backend` 可执行文件 → 镜像规格见 §5（Alpine 需 `git-daemon` 包，见下）。
- 集成注意（spike 实录，进 T4 实现 checklist）：Node 中对自家 HTTP 服务发起的 git 子命令**必须异步 spawn**（`execFileSync` 阻塞事件循环造成自死锁，本 spike 已两次踩中并复现根因）。

## 3. Web 框架

候选：Fastify v5 / Express v5 / NestJS 12。三项均满足"能托管 Git 流式路由"这一硬前提（Fastify 经 content-type 透传 + `reply.hijack()`、Express v5 默认原始流，均实测 clone+push 通过；NestJS 本质上运行于前两者的适配器之上）。

| 维度 | Fastify v5 | Express v5 | NestJS 12 | 证据 |
|---|---|---|---|---|
| 请求生命周期/中间件模型 | 生命周期 hooks（onRequest…onSend）+ 插件封装作用域 + TypeScript 模块扩充（官方文档示例即为 `authenticatedUser` 请求属性） | 扁平中间件链（官方："An Express application is essentially a series of middleware function calls"）；全局有序，无封装作用域 | Guard/Interceptor/Provider + DI，运行于 platform-express（默认）或 platform-fastify 适配器 | [文档] https://fastify.dev/docs/latest/Reference/Hooks/ ；https://expressjs.com/en/guide/using-middleware.html ；[实测] npm registry：@nestjs/core 12.1.3 运行时依赖无 HTTP 服务（uid/tslib/iterare/path-to-regexp/fast-safe-stringify） |
| 认证集成 | hooks + 类型化 request decorator + 官方 @fastify/auth | Passport/express-session 中间件（事实标准） | Guards + Passport 集成 | [文档] 同上 + https://docs.nestjs.com/guards （页面为 JS 渲染 SPA，抓取不到正文——按注册表可验证事实 + 文档 URL 引用） |
| 测试生态 | **内置 `inject()`**（light-my-request 随框架分发，本地验证 node_modules/light-my-request@6.8.0 为 fastify 直接依赖）——无 socket 即可测路由 | 无内置；supertest（真实监听 socket） | @nestjs/testing Test Module | [实测+文档] https://fastify.dev/docs/latest/Reference/Testing/ ；https://github.com/ladjs/supertest |
| 托管 Git 流式路由 | ✔ 实测（content-type parser 透传 + hijack） | ✔ 实测（v5 默认不解析 body，req 原始流） | 未直接测试（等价于其适配器之下的一列） | [实测] `spikes/frameworks/evidence/frameworks-streaming.txt`（2/2） |
| 路由开销 | 官方基准 97,595 rps；本机 hello-world 52,400 rps ≈ node:http 基线 | 官方基准 59,651 rps；本机 37,061 rps（1.4×慢于基线） | = 其适配器（express 默认） | [文档+实测] https://fastify.dev/benchmarks/ （页标注 2026-09-02，自评、标注 illustrative）；`spikes/frameworks/evidence/frameworks-bench.txt`（指示性） |
| 生态规模（周下载） | 15.4M | 145M | 16.5M | [实测] registry.npmjs.org，2026-10-12 |
| 对本项目的额外复杂度 | 低 | 低 | 中：DI/装饰器/适配器抽象层，单容器小服务用不上其模块化收益 | [推断] |

**结论（Web 框架）：Fastify v5。** Git 路由吞吐由 git 子进程主导（clone ~197 ms/次），框架路由开销在两档基准中都不是瓶颈，判据落在工程面：流式路由实测通过、`inject()` 免 socket 测试、类型化请求装饰契合"以认证主体为准"的授权模型（架构 §4.4）、封装作用域让 Git 路由与 Web API 各自隔离。Express v5 为可接受备选（生态最大、模型最简）；NestJS 不选：为单体小服务引入 DI 抽象层，且其文档站为 SPA 无法离线引用（对审计不友好）。

## 4. 数据库（单实例场景）

候选：SQLite（`node:sqlite`，Node 24 内置，官方状态 **Release candidate**（v25.7.0 起；v23.4.0 起免 flag）—— https://nodejs.org/api/sqlite.json ）vs PostgreSQL 17（postgres:17-alpine 容器）。备选库层：better-sqlite3 13.0.3（原生模块，附 prebuilds 含 linuxmusl）。

| 维度 | SQLite（node:sqlite） | PostgreSQL 17 | 证据 |
|---|---|---|---|
| 并发写行为 | 单写者；**默认无 busy_timeout 时并发写立即 SQLITE_BUSY（实测 S1）**；WAL + `busy_timeout=5000` 后多进程写全部成功（实测 S2）。知识库写频低（§9 单实例），够用 | MVCC 多写者；不同行并发 UPDATE 无阻塞（实测 P1） | [实测] `spikes/db/evidence/db-sqlite-tests.txt`（3/3）、`db-postgres-tests.txt`（2/2） |
| 备份一致性（§10、DOD-12） | `VACUUM INTO` 在并发写下得到一致快照，恢复副本 integrity_check=ok 且可读（实测 S3/S4）；维护模式下亦可直接停写复制文件 | `pg_dump` 并发写下一致快照，恢复副本计数与提交数据核对通过（实测 P2） | 同上 |
| 运维负担 | **零额外进程**：DB 即文件，随应用同容器；备份=文件；升级随应用 schema 迁移 | 第二容器（破坏 D6 单容器）或同容器内多进程（需进程监管、独立升级路径 pg_upgrade/dump-restore）；版本匹配（客户端/服务器） | [实测+推断] `spikes/db/evidence/db-ops-notes.md`；镜像 386MB / 空载 RSS 45MB |
| 写吞吐（指示性） | 单事务 1000 行 0.4 ms；autocommit 200 行 1.3 ms（本地文件） | 单事务 1000 行 207 ms（经 Docker Desktop 端口转发，Linux 同机将显著更快；标注为指示性） | [实测] `spikes/db/evidence/db-perf.txt`（含 caveat） |
| 已知陷阱 | busy_timeout 必须显式配置（S1）；WAL 模式须开启；RC 状态（非 Stable）——锁定 Node 版本即锁定行为 | pg_dump 需与服务器版本兼容；macOS 开发环境 Docker 端口转发延迟高（本地实测踩坑记录） | 同上 |
| 库层备选 | better-sqlite3 13.0.3：prebuilds 覆盖 linux-x64/arm64 + musl（181 ms 温装实测），依赖 node-addon-api，~30MB node_modules | pg（纯 JS 驱动，成熟） | [实测] `db-ops-notes.md` |

**结论（DB）：SQLite（`node:sqlite`，WAL + busy_timeout=5000）。** 备份一致性与并发写在两方都有实测证据；差异在运维面：单容器 + 持久卷（D6、§10）与文件型 DB 天然契合，维护模式一致备份（§10）路径最短。PostgreSQL 列为容量/多实例演进路径（架构 §11、D7"运维与规模增强"），不进首发；better-sqlite3 作为 node:sqlite RC 状态的兜底备选（如需其同步 API 或回避 RC 标签，切换成本低——两者 SQL 层同源）。

## 5. 最低部署规格（Linux + Docker 单容器）

依据：架构 §9/§10（单实例、每库 bare 仓库、可配置限制）、§1.1（企业内部署）+ 本任务实测。**假设（需 S7/S8 容量验证复核，DOD-13）**：≤100 员工、≤200 库、每库工作副本 ≤500MB（Markdown+小附件）、日推送 ≤10⁴ 次。

| 项 | 最低规格 | 推荐规格 | 推导依据 |
|---|---|---|---|
| CPU | 1 vCPU | 2 vCPU | Git 请求为子进程+短 CPU 脉冲（clone 197ms/4MB 仓库，实测）；1 vCPU 可运行，2 vCPU 让 Web/Git/校验互不排队 [实测+推断] |
| 内存 | 512 MB | 1 GB | 服务进程 RSS 实测 114.7MB（路线 B 负载后）+ git 子进程（每并发 clone 一个，峰值 ~30–80MB/进程）+ 页缓存受益；512MB 为地板，1GB 给并发 clone 余量 [实测 route-b-perf.txt] |
| 磁盘（数据卷） | 2 GB | 20 GB | 镜像外数据 = bare 仓库（4.1MB/501 文件实测样本）× 库数 + SQLite 文件（KB–MB 级）+ 备份空间（×2）+ WAL；20GB 覆盖假设容量并留备份窗口 [实测+推断] |
| 镜像 | `node:24-alpine`（234MB 实测本地）+ `apk add git git-daemon`（git 包 6833 KiB 实测；**git-http-backend 在 Alpine 归属 `git-daemon` 包而非 `git`——容器实测 + pkgs.alpinelinux.org v3.21/v3.22 双验证**）+ better-sqlite3 仅在弃用 node:sqlite 时需要 | 同左 | [实测] db-ops-notes.md；https://pkgs.alpinelinux.org/contents?branch=v3.22&file=git-http-backend |
| 网络 | 单端口 HTTPS（反向代理终结 TLS 或容器内 TLS，S2 决定） | 同左 | 架构 §10 |
| 健康检查 | `/healthz`（liveness）+ 磁盘水位指标 | 同左 | 架构 §10 运维最低清单 |
| 备份窗口 | 维护模式停写 → `VACUUM INTO` + 仓库目录 rsync/tar；完整备份含库映射、权限、配置、密钥（T3 backup-recovery 契约 R 清单） | 同左 | 架构 §10；T3 契约 docs/contracts/backup-recovery.md（已并入 main @08b7a29，本分支切点早于该合并） |

注：若未来改选路线 A（isomorphic-git），内存地板须升至 2GB（RSS 318MB 实测）——再次支持路线 B。

## 6. 首发平台

| 平台 | 决定 | 依据 |
|---|---|---|
| 服务端 | Linux x86_64/arm64 Docker 单容器（node:24-alpine 基础镜像） | D6；§5 规格；spike 容器均在此形态验证 |
| CLI | npm 分发，支持 macOS + Linux（Node ≥22.13，如用 node:sqlite 则对齐服务端 Node 24） | 架构 §1.1（员工电脑 + 企业服务器两种 Harness）；依赖纯 JS（路线 B 选型不要求 CLI 携带 git 子进程依赖；CLI 需要用户侧 git，与 DOD-09/10 一致） |
| Windows | 不在首发承诺内（CLI 如经 npm 安装可运行但未验证） | E1 边界：先收敛 macOS/Linux |

## 7. DRAFT ADR（建议编号 D10，由 master 归档进 epic）

> **D10（DRAFT）：Notegit 首发技术栈 = Node 24 + TypeScript + Fastify v5 + git http-backend CGI 包装（路线 B）+ SQLite（node:sqlite，WAL + busy_timeout）于 node:24-alpine 单容器；CLI 经 npm 分发（macOS/Linux）。**
>
> - **依据**：同栈同语言（D6）；四组两两对比均有可复跑实测证据（本文件 §2–§4，证据目录 `docs/s1/spikes/`）。关键判据：Git 接入的安全语义（非快进拒绝、逐 ref 授权、逐提交校验、多 ref 原子性）两条路线均实测达成，但路线 B 以 ~90 行获得原生 receive-pack 全部语义（含 quarantine），路线 A 需 ~250 行手写协议并有 9 项已记录尖锐边角、3.1× clone 延迟、2.8× 内存；数据库在备份一致性与并发写上双方均有实测证据，SQLite 胜在单容器运维面（零额外进程、文件即备份）。
> - **被否决的备选**：
>   - isomorphic-git 纯 JS 服务（路线 A）：协议负担与性能/内存劣势（`route-a-capability.txt` 9 项）；保留为"去子进程化"假设的未来重评项。
>   - Express v5：可接受备选，路由开销 1.4×、无内置注入测试；不阻断未来迁移（Fastify/Express 生态可平移）。
>   - NestJS 12：抽象层收益不匹配单体服务；文档站 SPA 不可离线引用。
>   - PostgreSQL 17：第二容器违反 D6 单容器；列为容量/多实例演进路径（架构 §11），触发条件 = 实测容量逼近单机上限（DOD-13 指标）。
>   - better-sqlite3：作为 node:sqlite RC 状态的兜底（prebuilds 已实测覆盖 musl）。
> - **风险与回看**：node:sqlite RC（锁定 Node 24 LTS 版本规避行为漂移）；Alpine git-daemon 包提供 git-http-backend（写入 Dockerfile 注释防回归）；每请求子进程的并发上限在 S1-T4 与 S7 负载测试中量化；部署规格假设（≤100 人/≤200 库）在 S7/S8 复核。
> - **不宣称**：E1 DoD 任何条目因本选型而完成；DoD 验证在对应 sprint。

## 附录 A：复跑命令（证据生成环境：Apple M4/16GB、macOS、Node v24.21.0、git 2.50.1、Docker 29.5.2）

```bash
# 路线 B（git http-backend CGI 包装）— 7 项行为测试 + 指示性性能
cd docs/s1/spikes/git-http-backend && npm install
node --test test/route-b.test.mjs     # → 7/7（evidence/route-b-tests.txt）
node perf.mjs                         # → evidence/route-b-perf.txt

# 路线 A（isomorphic-git 纯 JS）— 同一组 7 项测试 + 性能 + 能力差距清单
cd docs/s1/spikes/isomorphic-git && npm install
node --test test/route-a.test.mjs     # → 7/7（evidence/route-a-tests.txt）
node perf.mjs                         # → evidence/route-a-perf.txt

# Web 框架 — 流式托管 + 指示性基准
cd docs/s1/spikes/frameworks && npm install
node --test test/streaming.test.mjs   # → 2/2（evidence/frameworks-streaming.txt）
node bench.mjs                        # → evidence/frameworks-bench.txt

# 数据库 — SQLite 行为 + Postgres 行为 + 指示性吞吐
cd docs/s1/spikes/db && npm install
node --test test/sqlite.test.mjs      # → 3/3（evidence/db-sqlite-tests.txt）
./pg.sh start && node --test test/postgres.test.mjs && ./pg.sh stop  # → 2/2
node perf.mjs                         # → evidence/db-perf.txt
```

所有 spike 目录顶部与 README 均标注 **THROWAWAY（选型证据，非产品代码）**。
