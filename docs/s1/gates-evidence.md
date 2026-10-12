# S1-T6 gates 落地证据

- 记录日期：2026-10-12（UTC 时间戳见各输出）
- 记录人：S1-T6 worker（Orca dispatch ctx_874331f84031）
- 运行分支：`WayJ/s1-t6-gates`，rebase 到 `local/sprint/S1`（HEAD `7c67bd6`）；worktree `/Users/jiangwei/orca/workspaces/notegit/s1-t6-gates`
- 用途：AGENTS.md `### gates` 两条命令（§2）+ selection.md 附录 A 抽验（§3，Git 路线 B 与 DB 两组）+ 验收场景 S2/S5 固化建议（§5）的实测证据
- 声明：以下全部命令为真实运行后如实记录，无任何虚构输出。其中 Postgres 测试第一次执行失败一次，已完整记录现象与根因排查（§3.3），交 master 裁决；其余全部一次通过。

## 1. 运行环境

| 项 | 本次复跑环境 |
|---|---|
| 机型 | Apple M4（arm64），16 GB RAM |
| 系统 | macOS 26.6.2（Build 25G83） |
| Node | v24.21.0 |
| git | 2.50.1 (Apple Git-155) |
| Python | 3.9.6（jsonschema 4.25.1） |
| Docker | CLI 29.8.2；daemon 29.5.2；`docker context` = **colima**（Lima VM，宿主端口经 ssh mux 转发） |

与 selection.md 附录 A 声明的 T1 证据生成环境（Apple M4/16GB、macOS、Node v24.21.0、git 2.50.1、Docker 29.5.2）的差异：

1. **Docker 后端**：本次 `docker context` 为 colima（Lima VM）；T1 证据 caveats（db-perf.txt）写的是 "Docker Desktop's macOS port-forward"。daemon 版本号一致（29.5.2），CLI 为 29.8.2。此差异只影响 Postgres 经宿主端口转发的时延量级（见 §4 指示性数字），不影响行为测试的通过与判定。
2. macOS 小版本未在 T1 记录中标注（本次 26.6.2），无法逐项对齐，仅作注明。

## 2. AGENTS.md `### gates` 两条命令（A/B）

均在仓库根目录（worktree 根）运行。

### A. 契约门禁（contracts）

- 命令：`python3 docs/contracts/tools/verify_validation_contracts.py`
- 退出码：**0**
- 输出摘录（共 84 行，末尾）：

```
[PASS] rules-version.json: artifacts 文件齐全

检查结果：82/82 通过，0 失败
```

- 与 T2 记录一致（sprint 文档 T2 行：82/82、exit=0）。

### B. Git 行为测试（tests）

- 命令：`node --test docs/s1/spikes/git-http-backend/test/route-b.test.mjs`
- 退出码：**0**
- 输出摘录：

```
✔ B1: native git client can clone over HTTP from CGI-wrapped http-backend (119.873833ms)
✔ B2: authenticated fast-forward push is accepted (619.223083ms)
✔ B7: unauthenticated ref discovery is rejected with 401 (架构 §3.2 引用发现必须鉴权) (7.210125ms)
✔ B3: force-push (non-fast-forward) is rejected; server ref unchanged (230.7845ms)
✔ B4: per-ref authorization — bob cannot write main, can write feature/*; main delete forbidden (749.64725ms)
✔ B5: receive-side per-commit validation rejects "commit bad file then delete it" range push (353.138042ms)
✔ B6: one push carrying a good ref and a bad ref is rejected atomically — no ref updated (319.068167ms)
ℹ tests 7
ℹ pass 7
ℹ fail 0
ℹ duration_ms 2591.072292
```

- 说明：该 spike `package.json` 无 dependencies，从仓库根直接运行即可，无需先 `npm install`（本次即如此实测）。

## 3. selection.md 附录 A 抽验（两组：Git 路线 B、DB）

### 3.1 Git 路线 B 组（`cd docs/s1/spikes/git-http-backend` 后逐条）

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm install` | 0 | `up to date, audited 1 package in 259ms` / `found 0 vulnerabilities` |
| `node --test test/route-b.test.mjs` | 0 | `tests 7 / pass 7 / fail 0`（duration_ms 2337.197083），与附录 A 标注 `→ 7/7` 一致 |
| `node perf.mjs` | 0 | 复跑输出见下；数字与 T1 原始证据同量级（§4） |

`node perf.mjs` 复跑输出全文：

```
# Route B (git http-backend CGI wrap) — indicative perf evidence (THROWAWAY spike)
date: 2026-10-12T14:12:58.197Z
machine: Apple M4, 16 GB RAM, macOS, loopback HTTP (no TLS)
repo: 501 md files (~8KB each, ~4.1MB content), 21+ commits, bare size: 2.7M	/var/folders/.../T/spike-b-perf-1iZyaG/vaults/v001.git
node: v24.21.0, git: git version 2.50.1 (Apple Git-155)
NOTE: 数字为指示性（单机回环、无 TLS、无并发），用于量级对比而非容量承诺。

full clone (cold, no local cache), 5 runs: 204 / 214 / 214 / 214 / 204 ms -> median 214 ms
push 1 small md commit,     5 runs: 175 / 177 / 175 / 167 / 145 ms -> median 175 ms
push 100 x 8KB md commit,   3 runs: 244 / 244 / 251 ms -> median 244 ms
no-op fetch,                5 runs: 79 / 79 / 78 / 81 / 80 ms -> median 79 ms
server node process RSS after above load: 117184 KB (114.4 MB)
```

复跑副作用与处置（环境注记）：

- `perf.mjs` 会**覆写**已跟踪文件 `evidence/route-b-perf.txt`（脚本内 `writeFileSync('./evidence/route-b-perf.txt')`）。本次复跑捕获输出后已 `git checkout --` 还原为提交版本；上表输出即复跑实测，非原文件内容。
- 该目录原本**没有** `package-lock.json`（spike 无依赖），`npm install` 会生成一份未跟踪的新 lockfile。本次运行后已删除，保持工作区除授权改动外干净。复跑者请知悉这两点。

### 3.2 DB 组（`cd docs/s1/spikes/db` 后逐条）

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm install` | 0 | `added 14 packages, and audited 15 packages in 1s` / `found 0 vulnerabilities`（依赖 `pg`） |
| `node --test test/sqlite.test.mjs` | 0 | `pass 3 / fail 0`，与附录 A 标注 `→ 3/3` 一致 |
| `./pg.sh start && node --test test/postgres.test.mjs && ./pg.sh stop` | **第一次：测试段 exit 1（0/2 失败）**；根因排查后从干净状态复跑：**exit 0（2/2）** | 两次均如实记录，详见 §3.3 |
| `node perf.mjs`（Postgres 启动状态下） | 0 | 双引擎输出见下 |

`node --test test/sqlite.test.mjs` 输出摘录：

```
✔ S1: without busy_timeout, a concurrent writer fails SQLITE_BUSY (hazard) (633.083667ms)
✔ S2: WAL + busy_timeout=5000 -> both concurrent writers succeed (655.557208ms)
✔ S3+S4: VACUUM INTO while writer commits -> consistent backup, passes integrity_check, serves reads (972.888625ms)
ℹ pass 3
ℹ fail 0
```

Postgres 测试（复跑，通过）输出摘录：

```
✔ P1: concurrent UPDATEs on different rows both commit (MVCC) (44.7115ms)
✔ P2: pg_dump under concurrent writes restores to a consistent copy (1083.709416ms)
ℹ pass 2
ℹ fail 0
```

`node perf.mjs` 复跑输出全文：

```
sqlite (node:sqlite, WAL, synchronous=NORMAL):
  1000 inserts one tx : median 0.6 ms  (1780681 rows/s)
  200 autocommit       : median 1.9 ms  (107515 rows/s)
postgres 17 (docker, localhost TCP, 1 conn):
  1000 inserts one tx : median 399.1 ms  (2506 rows/s)
  200 autocommit       : median 90.1 ms  (2220 rows/s)
note: sqlite autocommit fsyncs per tx (WAL+NORMAL); pg over TCP pays ~round-trip per statement — single-user knowledge-base write load is far below both.
```

环境注记：

- 附录 A 的字面顺序是 `./pg.sh start && … && ./pg.sh stop` 之后再 `node perf.mjs`；照此字面顺序 Postgres 已停止，perf 的 pg 探针会打印 `postgres probe skipped`。T1 原始证据 `db-perf.txt` 含双引擎数字，故本次按 start → perf → stop 顺序复跑以对齐原始证据内容。附录 A 该行建议 master 酌情澄清顺序（本次不改 selection.md）。
- Postgres 探针依赖本机 Docker daemon 与已缓存的 `postgres:17-alpine` 镜像（386MB）；无缓存环境首次运行会先拉镜像。

### 3.3 Postgres 测试第一次失败：现象、排查与结论（交 master 裁决）

**现象**（2026-10-12 14:13 左右，首次执行附录 A 该行）：

- `./pg.sh start` 正常返回 `postgres up on 127.0.0.1:55432`；`node --test test/postgres.test.mjs` **exit 1**，两个用例均在 `before()` 建池查询阶段失败，`duration_ms 45.8`：

```
✖ P1: concurrent UPDATEs on different rows both commit (MVCC) (1.80425ms)
✖ P2: pg_dump under concurrent writes restores to a consistent copy (0.28775ms)
  Error: Connection terminated unexpectedly
      at .../db/node_modules/pg-pool/index.js:45:11
```

**排查过程**（全部只读诊断，未改任何仓库文件）：

1. 容器自身健康：`docker logs` 末尾 `database system is ready to accept connections`，`docker ps` 显示 `127.0.0.1:55432->5432/tcp` 映射存在。
2. `pg.sh start` 的就绪判定是 `docker exec … pg_isready`（容器内 unix socket）——**不覆盖宿主机侧端口转发链路**是否可用。
3. `lsof -nP -iTCP:55432`：监听者是 `ssh`（PID 10325，`~/.colima/_lima/colima/ssh.sock [mux]`，即 Colima/Lima 的宿主端口转发进程）；容器停止后该监听随之消失——确认它就是本容器的转发，**不是**外部端口冲突。
4. 重启容器后立即用 pg 客户端（复用 spike 的 `pg` 模块）直连 `127.0.0.1:55432` 执行 `SELECT 1`：约 10ms 内 OK——转发链路此时正常。
5. 从干净状态（stop → start）完整复跑附录 A 原命令链：**2/2 通过，exit 0**（§3.2 摘录即此）。

**结论**：Colima 的 ssh 端口转发在容器冷启动后的极短窗口内可能丢弃首个宿主侧连接，属环境瞬时问题（本机 docker context=colima；T1 证据期的后端按其 caveats 是 Docker Desktop），非 spike 代码缺陷；`pg.sh` 的就绪门未探测宿主侧链路。是否在 pg.sh 中补宿主侧 TCP 探测（如 `pg_isready -h 127.0.0.1 -p 55432` 或等价探针）由 master 裁决——本次未改 pg.sh（既有文件，超出授权）。失败不可稳定复现（复跑一次即通过）。

## 4. 指示性数字对比（T1 原始证据 vs 本次复跑，同一台机器）

数字为指示性（单机、回环/本地），用于量级对照而非容量承诺；差异来源含 Docker 后端（Docker Desktop → colima）与运行时刻的系统状态。

| 指标 | T1 原始（evidence 文件） | 本次复跑 |
|---|---|---|
| route-b full clone median | 197 ms | 214 ms |
| route-b push 1 small md | 162 ms | 175 ms |
| route-b push 100×8KB | 238 ms | 244 ms |
| route-b no-op fetch | 75 ms | 79 ms |
| route-b server RSS | 114.7 MB | 114.4 MB |
| sqlite 1000 inserts/tx | 0.4 ms | 0.6 ms |
| sqlite 200 autocommit | 1.3 ms | 1.9 ms |
| pg 1000 inserts/tx | 207.3 ms | 399.1 ms |
| pg 200 autocommit | 45.7 ms | 90.1 ms |

（Postgres 经宿主端口转发路径变慢约 2×，与 §1 环境差异一致；SQLite 为本地文件不受影响。选型结论不受影响：行为测试全过，量级同阶。）

## 5. 验收场景命令固化建议（S2/S5，供 master 应用到 sprint 文档）

对应 sprint 文档 D5：「带 † 的命令在 T6 选型落地后固化，固化时附日期追加记录，不改写原行」。以下为建议的最终命令文本（本次未改 sprint 文档；两条均已在 §2 实测通过）。

**S2（服务端可演示拒绝非法 push）建议固化文本：**

> 在 sprint/S1 仓库根运行 `node --test docs/s1/spikes/git-http-backend/test/route-b.test.mjs`（无需 npm install）→ 退出码 0，7/7 通过（B1–B7 覆盖：HTTP clone、鉴权快进 push、未鉴权 ref 发现 401、非快进拒绝、逐 ref 授权与 main 删除禁止、先写坏内容再删除的区间 push 拦截、多 ref 原子拒绝）。〔†2026-10-12 固化；实测证据：docs/s1/gates-evidence.md §2B〕

**S5（gates 命令真实可运行）建议固化文本：**

> 在 sprint/S1 仓库根依次运行 AGENTS.md `### gates` 记录的两条命令并核对退出码与输出：① `python3 docs/contracts/tools/verify_validation_contracts.py` → 退出码 0，输出含「检查结果：82/82 通过，0 失败」；② `node --test docs/s1/spikes/git-http-backend/test/route-b.test.mjs` → 退出码 0，7/7 通过。〔†2026-10-12 固化；实测证据：docs/s1/gates-evidence.md §2〕

另附一条非 † 事项的建议（master 酌情）：附录 A DB 组的 perf 行与 pg stop 的先后顺序见 §3.2 环境注记，建议在附录 A 澄清为 `./pg.sh start && node perf.mjs && ./pg.sh stop`（或注明字面顺序下 pg 探针会 skip）。

## 6. 变更清单与工作区状态

- 本次任务改动：AGENTS.md（仅 `### gates` 小节，diff 5+/3−）+ 本文件（新增）。
- 复跑过程产生的临时物（spike 目录 node_modules、git-http-backend 生成的未跟踪 package-lock.json、被 perf.mjs 覆写过的 evidence/route-b-perf.txt）均已清理/还原，`git status` 干净（除上述两处授权改动）。
- 未 push 任何远端；不宣称 E1 DoD 任何条目完成。
