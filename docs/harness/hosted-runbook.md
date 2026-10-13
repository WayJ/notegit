# 托管 Harness 运行手册（按员工隔离）

> S7-T7 交付。依据：[架构 §7.2](../../architecture.md#72-本地与托管环境)（「托管环境使用按员工/会话隔离的目录和凭据。不同员工的可写工作目录不共享」）、[§4.1](../../architecture.md#41-身份)（「托管 Harness 必须按员工或任务隔离凭据和工作目录」）、[breakdown §2.6 S7-T7](../s1/implementation-breakdown.md)、DOD-10。
> 隔离断言测试：`cli/test/hosted-isolation.test.ts`（随 `npm test` 运行）。

## 1. 托管布局规范

每员工（或每会话）一套独立环境变量布局；任何可写路径不得跨员工共享：

```text
/srv/notegit/                    # 托管基目录（Harness/实例管理员管理）
├── employees/                   # 共享父目录（0755，仅用于遍历）
│   ├── alice/                   # 员工私有目录（0700——CLI 创建/收紧）
│   │   ├── credentials          #   NOTEGIT_CREDENTIALS_FILE（0600）
│   │   └── knowbase/            #   NOTEGIT_LOCAL_ROOT（0700；库副本 = <root>/<slug>）
│   └── bob/…
```

| 环境变量 | 布局要求 | CLI 保证（现行实现） |
|---|---|---|
| `NOTEGIT_LOCAL_ROOT` | `<基目录>/employees/<员工>/knowbase`（员工私有） | `sync` 首次创建即 **0700**；预存在目录（含误配宽松权限）收紧到 0700 |
| `NOTEGIT_CREDENTIALS_FILE` | `<基目录>/employees/<员工>/credentials` | 文件 **0600**（含显式收紧）；创建时父目录 0700 |
| `NOTEGIT_SERVER` / `NOTEGIT_TOKEN` | 每会话指向实例与该员工自己的访问凭据 | 令牌绝不进命令行参数、remote URL、仓库文件或日志 |

- sync 的状态与并发锁全部位于 `<root>/.notegit/`（`sync-state.json`、`locks/`）——随根目录天然隔离，**无任何跨员工共享文件**。
- 根目录权限面的理由：列举目录即可泄露库 slug（库可见性本身是权限数据，identity §5.2），故其他员工不得持有任何组/其他权限位；凭据机密由文件 0600 位保护。
- 若使用 `notegit setup --local-root` 持久化：配置文件同样按员工隔离（`NOTEGIT_CONFIG_FILE` 或 `XDG_CONFIG_HOME` 指向员工私有路径）。托管布局应始终显式设置 `NOTEGIT_LOCAL_ROOT`（环境变量优先级高于配置）。

## 2. 会话启动

```sh
# 每员工/每会话的环境（Harness 注入；不要写入任何共享文件）
export NOTEGIT_SERVER=https://notegit.example.com
export NOTEGIT_LOCAL_ROOT=/srv/notegit/employees/alice/knowbase
export NOTEGIT_CREDENTIALS_FILE=/srv/notegit/employees/alice/credentials
export NOTEGIT_TOKEN=ngt_…   # 或省略，login 时隐藏交互输入

notegit login "$NOTEGIT_SERVER" --username alice   # 校验 + 0600 落盘 + 注册 credential helper
notegit ls                                          # 按当前员工权限列出可见库
notegit sync                                        # 克隆/快进到 <root>/<slug>
```

### 共用 OS 账号时的注意事项

- `login` 注册的 git credential helper 写入全局 git 配置（`--global`，键按 `host:port` 作用域）。多员工共用同一 OS 账号（同一 `HOME`）时：该键值对所有员工相同（同一 CLI 安装路径），**不含任何凭据内容**；helper 运行时经会话环境读取 `NOTEGIT_CREDENTIALS_FILE` 指向的员工私有文件，不串读（断言见测试）。
- 条件允许时优先按员工使用独立 OS 账号/`HOME`（`HOME`、`GIT_CONFIG_GLOBAL` 随之隔离），彻底避免共享面。

## 3. 机制事实（当前实现核对结果，S7-T7）

- `NOTEGIT_LOCAL_ROOT`：三级解析（环境变量 > `setup --local-root` 持久化配置 > `~/knowbase`），`ls`/`sync`/`sync clean` 同一解析面（`cli/src/ls/local-status.ts` `localRootOf`）。本任务补缺：`sync` 创建根目录由默认权限改为 **0700 创建 + 预存在收紧**（`ensureLocalRoot`；原先随 umask 落成 0755，托管机上其他 OS 用户可列举）。
- `NOTEGIT_CREDENTIALS_FILE`：`环境变量 > XDG_CONFIG_HOME > ~/.config/notegit/credentials`（`cli/src/credentials.ts` `credentialsFilePath`）。`login` 落盘与 credential helper（`get`/`store`/`erase`）全部经该函数取路径——按会话环境各归各文件。
- 全 CLI 无硬编码共享可写路径；`sync` 之外的命令不创建本地根目录。

## 4. 隔离验证（三断言）

| # | 断言 | 测试（`cli/test/hosted-isolation.test.ts`） |
|---|---|---|
| 1 | 目录隔离：两员工（不同 env 布局、同一 OS 账号的最苛刻形态）根目录 0700——跨员工读取被拒；根下恰为各自可见库；预存在宽松根被收紧 | 「目录隔离…」「预存在宽松根目录…」 |
| 2 | 凭据存储隔离：各员工文件 0600、互只含各自令牌；一方 login 不改写另一方文件；helper 按会话环境取各自令牌 | 「凭据存储隔离…」 |
| 3 | 并行不交叉：两员工真实双进程、双根并发首次 sync——目录/状态文件/共享库互不交叉，两根仍 0700 | 「并行隔离…」 |

复跑：仓库根 `npm test`（或 `cd cli && npm test`）。

## 5. 边界声明（本版不实现）

- **共享只读对象缓存**（如跨员工共享 git 对象缓存/浅克隆缓存）：本版不提供（breakdown S7-T7 行「共享只读缓存放后续，不在本版实现」）。未来引入时须按架构 §7.2「如未来共享对象缓存，必须独立评估缓存读取权限」另行立项评估——对象内容与可达性是权限数据，不能默认无害。
- 本版唯一支持的托管形态 = 每员工独立可写根目录 + 私有凭据文件；不提供任何跨员工共享可写路径。
