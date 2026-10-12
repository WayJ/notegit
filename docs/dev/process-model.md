# 进程模型（S2-T1 记录）

日期：2026-10-12（S2-T1）。依据：D10（[selection.md §2/§7](../s1/selection.md)）、[backup-recovery §3/§4](../contracts/backup-recovery.md)、[architecture.md §9/§10](../../architecture.md)。本文件记录**当前定稿的运行形态**；形态变更时必须同步修订本文件并按 backup §3 重新定义维护闸门传播上界。

## 1. 定稿：容器内单应用进程

- 每个容器运行**一个 Node 应用进程**（Fastify v5 服务，D10）。容器内无内部进程监管器——进程生命周期由容器运行时（restart policy）负责。
- 管理数据库为嵌入式 `node:sqlite`（WAL + busy_timeout=5000，selection §4），**无独立数据库进程**：DB 即 `/data/` 下文件，随应用同容器。

## 2. Git 请求 = 每请求一个子进程

- 每个 Git HTTP 请求由应用进程 **spawn 一个 `git http-backend` CGI 子进程**（路线 B，D10）。子进程链（http-backend → upload-pack/receive-pack）是短生命周期 CPU 脉冲，selection §5（内存行）实测：单请求子进程链峰值 RSS 合计约 17MB。
- **必须异步 spawn**（`node:child_process` 的异步 API）：S1 spike 两次复现并定根因——对自家 HTTP 服务同步 spawn（`execFileSync` 阻塞事件循环）会造成自死锁。此约束进入 S3 Git 接入实现的 checklist。
- 子进程是请求作用域的：不持有任何权威状态（权限、凭据、会话都在应用进程与数据库内）。应用进程是唯一的协调者。

## 3. 与维护闸门传播上界的关系（backup §3）

backup-recovery §3 规定：维护模式为**实例级全局写闸门**，若为单实例单进程形态，闸门是进程内同步标志，切换调用返回后对所有后续请求立即生效，**传播上界 T_gate = 0**；§4 步骤 2 的在途写排空检查因此在闸门生效后**立即**开始。

本模型（§1 单应用进程 + §2 请求作用域子进程）正是 T_gate = 0 成立的前提：

| 模型要素 | 对闸门的意义 |
|---|---|
| 唯一应用进程受理全部写入口（Web/API/Git） | 闸门标志只存在于一个进程内，无跨进程传播延迟 |
| Git 子进程仅由应用进程按请求 spawn，且 refs 鉴权在应用层（receive 拒绝在 spawn 前后由闸门统一判定） | 子进程不会绕过闸门写入权威数据；在途请求按起点放行边界由 backup §3/identity §5.2 定义 |
| SQLite 写全部经应用进程连接（WAL + busy_timeout） | 数据库侧无第二个写入者，排空检查只需等待应用进程内已开始的写操作终态 |

**边界与义务**：

- 本任务只**记录**该模型；闸门本身（标志数据结构与矩阵拒绝逻辑）是 **S2-T7** 的代码交付，届时 §3 的矩阵逐行测试在此模型下断言「切换调用返回后新请求立即生效」。
- 若未来引入多进程（如 worker 池）或多容器形态，本模型即失效：闸门必须改为以共享存储状态为准并定义显式传播上界 T_gate（提案随形态变更评审，backup §3 要求），且排空检查须在开启时刻 + T_gate 之后才开始。
- 维护期间允许的运行态写入（闸门生命周期运维审计行、登录会话）不进入备份，backup §3 已定义，此处不重复。

## 4. 对并发与容量的含义（承接 selection §5）

- 并发上界受容器 fd/进程限制约束（每 Git 请求一子进程），最低规格 512MB / 推荐 1GB 的推导见 selection §5；实际限制在 S3/S7 负载测试量化（DOD-13）。
- 健康检查端点 `/healthz`（liveness）已随本任务落地（server/src/app.ts）。
