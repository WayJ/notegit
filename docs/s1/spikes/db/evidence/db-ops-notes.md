# DB spike — ops observations (S1-T1, 2026-10-12)

## Measured / verified this session

| item | value | how observed |
|---|---|---|
| postgres:17-alpine image size | 386 MB | `docker images` (local pull) |
| node:24-alpine image size | 234 MB | `docker images` (local pull, node:24.6.0-alpine3.22) |
| postgres container RSS (idle, after churn+dump) | 45.3 MiB | `docker stats --no-stream` |
| node:sqlite status | "Release candidate" (since v25.7.0); unflagged since v23.4.0/v22.13.0 | nodejs.org/api/sqlite.json (fetched 2026-10-12) |
| better-sqlite3 13.0.3 | ships prebuilt `.node` for 8 targets incl. linux-x64/arm64 + linuxmusl-x64/arm64; `scripts.install: none`; runtime dep `node-addon-api`; ~30 MB node_modules | local `npm install` in clean tmp dir (181 ms warm / 13.5 s cold), package.json inspected |

## Architecture-fit observations (analysis, tied to architecture v0.2)

- 架构 §10: 一个容器（app+git+DB）+ 持久卷 + 维护模式一致备份。
  - SQLite: DB = 文件，与 app 同容器零成本；备份 = `VACUUM INTO`（实测 S3：并发写下一致，integrity_check ok）或维护模式期间直接停写复制文件。
  - PostgreSQL: 需要第二个容器（compose/两进程同容器）。第二个容器破坏"单容器部署"的最简形态；塞进同一容器则需管理 postgres 进程生命周期（init 脚本、信号转发、独立升级路径），运维面显著变大。
- 并发写（§9 单实例）：SQLite 单写者，但 WAL + busy_timeout=5000 下多进程/多连接写实测全部成功（S2），知识库场景写频率低；PostgreSQL MVCC 天然多写者（P1）。
- 备份一致性：SQLite `VACUUM INTO` 在线一致快照实测（S3/S4）；PostgreSQL `pg_dump` 并发写下一致快照实测（P2）。两者都满足 DOD-12 要求，SQLite 路径少一个活动部件。
- 升级：SQLite 随应用（改 schema 即迁移）；node:sqlite 与 Node 版本绑定（RC 状态，Node 24 LTS 内无 flag）。PostgreSQL major 升级需 pg_upgrade 或 dump/restore。
- 驱动：pg（纯 JS）成熟；better-sqlite3 为原生模块（有 prebuilds，包括 musl）；node:sqlite 零依赖内置。
- 陷阱（spike 实录）：SQLite 默认无 busy_timeout —— 并发写立即 SQLITE_BUSY（S1），必须配置；这进入 selection.md 的部署注意项。

## Verdict input for selection.md

单实例 + 单容器 + 低频写 + 维护模式备份 → SQLite（node:sqlite，RC）为主选；
better-sqlite3（同步 API、成熟、prebuilds）为备选（若需要其特性或想避开 RC 标签）；
PostgreSQL 为容量/多实例未来演进路径（架构 §11），首发不选，理由：额外容器/进程、
备份与升级复杂度，单实例知识库负载下收益不可见（perf 见 db-perf.txt，注意
Docker Desktop port-forward 使 pg 数字偏悲观——注明）。
