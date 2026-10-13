# notegit — Notegit 员工端 CLI

Notegit 知识库系统的员工端命令行工具。与服务端使用同一套内容校验规则（`packages/validation` 单一来源，校验实现内嵌于发行包，S6-T7 三端一致构建断言锁定），凭据不进入仓库或日志。

- 本文与实现同步：每命令节内置 `--help` 原文（`cli/test/docs-consistency.test.ts` 自动抽检文档与 `--help` 一致）；结构化输出样例过 `validation-report.schema.json` 契约校验。
- 状态约定：**文档只描述已实现行为**。

## 环境要求

- Node ≥ 22.13（macOS / Linux；D10 selection §6。Windows 不在首发承诺）
- 用户侧 Git（`login` 注册 credential helper、`ls` 本地状态判定、克隆/提交场景使用）

## 安装

当前未发布公共 registry，从仓库工作区打包安装。校验规则实现已内嵌发行包（S6-T7），**单 tarball 自包含，无需另装 notegit-validation**：

```sh
# 仓库内打包（或使用发布提供的 tarball）
cd cli && npm pack            # 产出 notegit-<version>.tgz
# 全局安装
npm install -g notegit-<version>.tgz
# 验证
notegit --version             # notegit <版本>，退出码 0
```

## 快速开始（主线：安装 → 登录 → ls → lint → setup）

```sh
# 1) 登录前，在网页端「查看访问凭据」页创建访问令牌（ngt_ 前缀，明文仅创建时显示一次）
# 2) 登录（令牌经环境变量 NOTEGIT_TOKEN 或隐藏交互输入；不接受命令行参数）
notegit login https://notegit.example.com --username alice
# 3) 看库：列出有权库、clone URL 与本地状态
#    （ls/lint 的凭据面为环境变量，见「环境变量」一节）
NOTEGIT_SERVER=https://notegit.example.com NOTEGIT_TOKEN=ngt_… notegit ls
# 4) 克隆（login 已注册 credential helper，免交互取凭据；库副本约定在本地根目录 <root>/<slug>）
git clone https://notegit.example.com/git/<slug>.git ~/knowbase/<slug>
# 5) 提交前手动校验，按报告修正直到通过（错误码与修正见 lint 一节）
cd ~/knowbase/<slug>
notegit lint --staged
# 6) 安装 pre-commit hook（推荐：此后每次 git commit 自动执行同一校验）
notegit setup
```

## 命令一览

| 命令 | 作用 | 状态 |
|---|---|---|
| `notegit login` | 登录并配置员工凭据（安全存储 / Git credential helper） | 已实现（S6-T2 交付） |
| `notegit ls` | 列出有权访问的知识库、clone URL 与本地状态 | 已实现（S6-T3 交付；S7-T6 离线明示：HEAD/上次同步/可能过期） |
| `notegit lint` | 手动校验知识库内容（与服务端同一规则） | 已实现（S6-T4 交付，S6-T7 接线版本探测端点） |
| `notegit setup` | 在已克隆库中安装/卸载/管理本地校验 hook 与本地根目录 | 已实现（S6-T5/T6 交付） |
| `notegit sync` | 发现并安全同步知识库到本地（克隆/快进，不覆盖本地改动） | 已实现（S7-T1 六态策略表；S7-T3 逐项结果与 JSON/退出码契约；S7-T5 撤权标记与 `sync clean` 显式清理） |
| `notegit sync` | 发现并安全同步知识库到本地（克隆/快进，不覆盖本地改动） | 已实现（S7-T1 六态策略表；S7-T3 逐项结果与 JSON/退出码契约；S7-T6 断网三态与离线明示） |

退出码契约（全部命令一致）：`0` 成功；`1` 命令失败（校验错误、查询失败等业务性失败）；`2` 用法错误或运行错误。与校验报告协议语义一致（`docs/contracts/validation.md` §6.1）。

---

## 命令文档

### notegit login

登录并配置员工凭据。访问令牌在网页端「查看访问凭据」页创建（`ngt_` 前缀，明文仅创建时显示一次）；CLI 当前无免 Web 的引导/设备码流程（服务端暂无对应端点，缺口记录于任务笔记）。

#### 帮助原文（`notegit login --help`）

```text
notegit login <server> [--username <用户名>] — 登录并配置员工凭据（安全存储 / Git credential helper）

说明：
  交互或参数提供用户名与访问令牌（ngt_，网页端「查看访问凭据」创建）；令牌仅经隐藏输入或环境变量 NOTEGIT_TOKEN 提供，绝不走命令行参数、remote URL、仓库文件或日志；校验通过后存入 0600 凭据文件并注册 Git credential helper。
  状态：已实现（S6-T2 交付）

选项：
  --username <用户名>  参数式提供用户名（缺省交互输入）
  令牌来源：环境变量 NOTEGIT_TOKEN 或隐藏交互输入（不接受 --token 参数）
  -h, --help  输出本帮助

退出码：0 成功；1 命令失败；2 用法/运行错误
```

#### 成功流程

```sh
notegit login https://notegit.example.com --username alice
# 访问令牌（ngt_…，输入不回显）：   ← 隐藏输入；或 NOTEGIT_TOKEN=ngt_… notegit login …
```

```text
已登录 alice@notegit.example.com（凭据 ngt_ab…wxyz）
凭据已保存（权限 0600）：~/.config/notegit/credentials
已注册 Git credential helper：credential.https://notegit.example.com.helper
现在可免交互访问：git ls-remote https://notegit.example.com/<vault>.git
```

- 凭据文件：`~/.config/notegit/credentials`（权限 0600；`XDG_CONFIG_HOME`/`NOTEGIT_CREDENTIALS_FILE` 可覆盖）。
- credential helper 按 host 作用域注册（`credential.<protocol>://<host>.helper`，空值重置继承链）：本 CLI 是该 host 凭据的唯一来源，token 不透传 osxkeychain/libsecret 等其他 helper，也不影响用户其他 host 的配置。
- 此后 `git clone` / `fetch` / `push` 对该 server 免交互（git 自动调用内部子命令 `notegit credential`，无需手动运行）。

#### 错误与修正

| 触发步骤 | 实际输出（示例） | 退出码 | 修正 |
|---|---|---|---|
| `notegit login`（缺 server） | `notegit login: 需要 server（如 https://notegit.example.com）。用法：notegit login <server> [--username <用户名>]（notegit login --help 查看用法）` | 2 | 补上 server 地址 |
| `notegit login not-a-url` | `notegit login: server URL 无效：not-a-url（需 http(s)://host[:port]）（notegit login --help 查看用法）` | 2 | 使用 `http(s)://host[:port]` 形态 |
| `notegit login https://… --token ngt_…` | `notegit login: 不接受 --token 命令行参数（令牌会随进程列表泄漏）。请改用环境变量 NOTEGIT_TOKEN 或交互输入。` | 2 | 改用 `NOTEGIT_TOKEN` 环境变量或隐藏输入（安全红线） |
| 令牌粘贴不完整 / 形态不符 | `notegit login: 令牌形态不符（应为 ngt_ 前缀 + 43 字符，identity §3.1）。凭据请在网页端「查看访问凭据」页创建。` | 1 | 回网页端重新复制完整令牌再试 |
| 服务端核对 401（E-AUTH-001 无效） | `notegit login: 凭据无效：请核对令牌（在网页端「查看访问凭据」确认）（E-AUTH-001）。` | 1 | 核对令牌；必要时新建凭据 |
| 服务端核对 401（E-AUTH-002 过期） | `notegit login: 凭据已过期：过期凭据不可续期，请在网页端新建凭据后重试（E-AUTH-002）。` | 1 | 新建凭据后重试 |
| 服务端核对 401（E-AUTH-003 撤销） | `notegit login: 凭据已撤销：请在网页端新建凭据后重试（E-AUTH-003）。` | 1 | 新建凭据后重试 |
| 服务端核对 401（E-AUTH-004 停用） | `notegit login: 账号已停用：请联系实例管理员（E-AUTH-004）。` | 1 | 联系实例管理员 |
| server 地址不可达 | `notegit login: 无法连接服务端 https://…（<原因>）。请核对 server 地址。` | 1 | 核对 server 地址/网络 |

> 安全边界：令牌只经隐藏交互输入或 `NOTEGIT_TOKEN` 环境变量进入 CLI；输出只出现掩码（`ngt_ab…wxyz` 形，与服务端 `display_hint` 同款）；凭据唯一落盘是 0600 凭据文件，不进 remote URL、`.git/config`、日志（扫描断言见 `cli/test/login-integration.test.ts`）。

---

### notegit ls

实时按当前员工权限列出有权库（`GET /api/v1/vaults`，Bearer）、clone URL 与本地状态。

**凭据面（当前边界，如实标注）**：`ls` 从环境变量 `NOTEGIT_SERVER` 与 `NOTEGIT_TOKEN` 读取服务端与令牌——`login` 写入的凭据文件/helper 服务于 git 推拉，尚未被 `ls` 自动接管（见「环境变量」）。

#### 帮助原文（`notegit ls --help`）

```text
notegit ls [--json] — 列出有权访问的知识库、clone URL 与本地状态

说明：
  实时按当前员工权限列出可见库（GET /api/v1/vaults，Bearer）；本地状态 = 未克隆/已克隆/落后/未知（对照本地根目录 <root>/<slug>）。S7-T6 起逐库附上次同步时间（消费 sync 状态面）与离线副本 HEAD；有副本但无法对照远端时标注「可能过期」。凭据占位面：NOTEGIT_SERVER 与 NOTEGIT_TOKEN 环境变量（S6-T2 login 交付后接管）；本地根目录默认 ~/knowbase，可用 NOTEGIT_LOCAL_ROOT 覆盖。
  状态：已实现（S6-T3 已实现（--json schema 固化于 cli/test/ls.test.ts）；S7-T6 离线明示（HEAD/上次同步/可能过期））

选项：
  --json  输出 JSON（schema 固化；local 含 head/remote_tip/last_sync）
  -h, --help  输出本帮助

退出码：0 成功；1 命令失败；2 用法/运行错误
```

#### 成功输出

表格形态（S7-T6 起含离线明示列：HEAD 短 sha、上次同步时间（UTC）；有副本但无法对照远端的库在「备注」标注「可能过期」——不声称一定使用最新知识）：

```text
服务器 https://notegit.example.com；本地根目录 ~/knowbase

库                  状态    角色      默认分支  名称      HEAD      上次同步（UTC）      备注
engineering-notes  已克隆   editor  main    工程笔记  3f2a1bc   2026-10-13 08:00
handbook           未知     reader  main    员工手册  9d81e02   2026-10-12 17:30  可能过期
```

结构化输出（`notegit ls --json`，schema 固化于 `cli/test/ls.test.ts`；`local.last_sync` 为该库上次经 `notegit sync` 成功同步的时间，未同步/无副本为 `null`——S7-T6 消费 sync 状态面）：

```json
{
  "server": "https://notegit.example.com",
  "local_root": "~/knowbase",
  "vaults": [
    {
      "slug": "engineering-notes",
      "name": "工程笔记",
      "role": "editor",
      "default_branch": "main",
      "main_admin_only": false,
      "clone_url": "https://notegit.example.com/git/engineering-notes.git",
      "local": {
        "path": null,
        "status": "not_cloned",
        "head": null,
        "remote_tip": null,
        "last_sync": null
      }
    }
  ]
}
```

本地状态 `local.status` 四值语义：

| 值 | 语义 |
|---|---|
| `not_cloned` | 本地根目录下无 `<root>/<slug>` 副本 |
| `cloned` | 本地 head == 默认分支远端 tip |
| `behind` | 本地 head 是远端 tip 的祖先（落后，可快进） |
| `unknown` | 无法判定（非 git 目录、远端不可达、本地领先/分叉等；精确六态见 `notegit sync`，S7-T1） |

本地状态判定会对每库做一次 `git fetch`（取远端 tip，凭据走 login 注册的 helper；token 不进 URL/参数）。

#### 错误与修正

| 触发步骤 | 实际输出（示例） | 退出码 | 修正 |
|---|---|---|---|
| 未配置凭据（无 `NOTEGIT_SERVER`/`NOTEGIT_TOKEN`） | `notegit ls: 未配置服务器或凭据（设置 NOTEGIT_SERVER 与 NOTEGIT_TOKEN；S6-T2 login 交付后将接管凭据获取）` | 1 | 设置两个环境变量（见「环境变量」） |
| 令牌无效/过期/撤销（服务端 401） | `notegit ls: 认证失败（401）：token 无效、过期或已撤销` | 1 | 网页端新建凭据后更新 `NOTEGIT_TOKEN` |
| server 不可达 | `notegit ls: 无法连接服务器 https://…：fetch failed` | 1 | 核对 `NOTEGIT_SERVER` 地址/网络 |
| `notegit ls --verbose`（未知选项） | `notegit ls: 未知选项：--verbose（notegit ls --help 查看用法）` | 2 | 只使用 `--json`/`-h` |

---

### notegit lint

提交前手动校验知识库内容，与 pre-commit hook、服务端同一规则实现（`packages/validation`，内嵌于发行包）。`--staged` 只读 git index（部分暂存只校验暂存内容）；`--all` 校验 index 全部已跟踪条目。

#### 帮助原文（`notegit lint --help`）

```text
notegit lint [--staged | --all] [--json] — 手动校验知识库内容（与服务端同一规则）

说明：
  消费 packages/validation 同一实现（D5 工作区依赖）。--staged 只读 git index（不读工作目录——部分暂存只校验暂存内容）；--all 校验 index 全部已跟踪条目（将提交的完整树，内容同样取 index）。报告过 validation-report 协议（schemas/validation-report.schema.json）；本地规则旧于服务端时报告附 N-UPGRADE-001 提示（未配置凭据时静默跳过，探测失败时 stderr 一行说明；提示不改变退出码）。
  状态：已实现（S6-T4 已实现（--json 报告协议固化于 cli/test/lint.test.ts））

选项：
  --staged  只校验暂存区内容（相对 HEAD 的新增/修改；删除不校验）
  --all     校验 index 全部已跟踪条目
  --json    输出 validation-report JSON（退出码 0/1/2 同报告 exitCode）
  凭据面（仅版本提示用，可选）：环境变量 NOTEGIT_SERVER 与 NOTEGIT_TOKEN
  -h, --help  输出本帮助

退出码：0 成功；1 命令失败；2 用法/运行错误
```

#### 校验循环（报错 → 修正 → 复跑）

按以下步骤可人工复现同一错误码（E-FM-001）：

```sh
cd ~/knowbase/<slug>
printf '# 没有 frontmatter 的知识文档\n' > bad.md
git add bad.md
notegit lint --staged            # 退出码 1
```

```text
notegit lint --staged（scope=pre-commit，规则版本 1.0.0-draft.1）

bad.md：未通过
  错误 E-FM-001 bad.md：知识文档缺少 frontmatter（首行须为 `---`）

小结：1 个文件，1 个未通过，1 个错误，0 个警告
```

按提示补上 frontmatter 后复跑，直到退出码 0（警告不阻断）：

```sh
printf -- '---\ntitle: 修复后的文档\n---\n\n正文。\n' > bad.md
git add bad.md
notegit lint --staged            # 退出码 0（可含 W- 前缀警告）
```

#### 结构化错误样例（`notegit lint --staged --json`）

上例同一状态的 JSON 输出（过 `docs/contracts/schemas/validation-report.schema.json`）：

```json
{
  "rulesVersion": "1.0.0-draft.1",
  "scope": "pre-commit",
  "result": "fail",
  "exitCode": 1,
  "summary": {
    "filesTotal": 1,
    "filesPassed": 0,
    "filesFailed": 1,
    "errorCount": 1,
    "warningCount": 0
  },
  "files": [
    {
      "path": "bad.md",
      "status": "fail",
      "issues": [
        {
          "severity": "error",
          "code": "E-FM-001",
          "rule": "frontmatter.missing",
          "message": "bad.md：知识文档缺少 frontmatter（首行须为 `---`）"
        }
      ]
    }
  ]
}
```

- `result`/`exitCode` 对应关系：`pass`→0（可含警告）、`fail`→1（校验错误）、`error`→2（运行错误，fail-closed）。
- 错误码全集与消息模板见 `docs/contracts/validation.md`（E-FM-*/E-PATH-*/E-LIMIT-*/E-RUN-*；W-* 为不阻断的警告）。

#### 常见错误

| 触发步骤 | 实际输出（示例） | 退出码 | 修正 |
|---|---|---|---|
| `notegit lint`（缺范围） | `notegit lint: 需要 --staged 或 --all 之一指定校验范围（notegit lint --help 查看用法）` | 2 | 加 `--staged` 或 `--all` |
| `notegit lint --staged --all`（互斥） | `notegit lint: --staged 与 --all 互斥（notegit lint --staged \| --all）` | 2 | 二选一 |
| 在非 git 目录运行 | 报告 `E-RUN-002`（`result: "error"`），如 `校验内部错误：当前目录不在 git 仓库中（lint 需在知识库内运行）；请重试并反馈管理员` | 2 | 进入已克隆的知识库目录再运行 |

非 git 目录的 `--json` 错误报告样例（fail-closed，同样过报告 schema）：

```json
{
  "rulesVersion": "1.0.0-draft.1",
  "scope": "pre-commit",
  "result": "error",
  "exitCode": 2,
  "summary": { "filesTotal": 0, "filesPassed": 0, "filesFailed": 0, "errorCount": 1, "warningCount": 0 },
  "files": [],
  "issues": [
    {
      "severity": "error",
      "code": "E-RUN-002",
      "rule": "run.internal",
      "message": "校验内部错误：当前目录不在 git 仓库中（lint 需在知识库内运行）；请重试并反馈管理员",
      "actual": "当前目录不在 git 仓库中（lint 需在知识库内运行）"
    }
  ]
}
```

#### 规则版本提示（N-UPGRADE-001）

配置了 `NOTEGIT_SERVER`/`NOTEGIT_TOKEN` 时，lint 会探测服务端规则版本（`GET /api/v1/rules-version`）；本地规则旧于服务端时报告追加提示（不改变退出码）。报告 `notices` 片段（完整报告形态同上例，另含 `notices` 字段）：

```text
"notices": [
  { "code": "N-UPGRADE-001", "message": "客户端校验规则为 1.0.0-draft.1，服务端为 1.1.0；请运行 notegit setup 更新" }
]
```

本地规则内嵌于 CLI 发行包——收到该提示后的更新方式是**安装包含新规则的 CLI 新版本**（`npm install -g` 新 tarball）。提示消息中的「请运行 notegit setup 更新」为校验契约的固定文案；`setup` 安装的是 hook（与 CLI 同包同版本），更新规则本体以重装 CLI 包为准。未配置凭据时静默跳过探测；探测失败时 stderr 一行说明、不影响报告。

---

### notegit setup

在已克隆的知识库内安装/卸载 pre-commit hook（提交时自动执行与 `notegit lint --staged` 同一校验），并管理本地根目录配置。hook 只运行随工具分发的校验程序，绝不执行知识库内的任何脚本/hook 样本（沙箱断言见 `cli/test/hooks-sandbox.test.ts`）。

#### 帮助原文（`notegit setup --help`）

```text
notegit setup [--chain] [--local-root <路径>] [--uninstall] — 在已克隆库中安装/卸载/管理本地校验 hook 与本地根目录

说明：
  在当前仓库安装 pre-commit hook（不执行库内脚本）。已有外来 pre-commit 时默认明确报告冲突并拒绝安装（保留现有 hook）；加 --chain 改用兼容链：原 hook 原样保留为 pre-commit.user，提交时先运行原 hook 再追加 notegit 校验。卸载还原 .git/hooks 原状（兼容链卸载把原 hook 还原回 pre-commit），重复安装/卸载幂等。--local-root 把本地根目录持久化到 CLI 配置（notegit ls 按 <根>/<slug> 对照，缺省 ~/knowbase）；同时提示性检查 Git credential helper 注册状态。
  状态：已实现（S6-T6 交付（兼容两模式与卸载还原测试：cli/test/setup-*.test.ts））

选项：
  --chain            已有外来 pre-commit 时采用兼容链（保留原 hook 为 pre-commit.user，先运行原 hook 再追加 notegit 校验）；默认为明确报告冲突拒绝安装
  --local-root <路径>  持久化本地根目录到 CLI 配置（~ 按当前 HOME 展开；缺省取环境变量 NOTEGIT_LOCAL_ROOT）
  --uninstall        卸载并还原 .git/hooks 原状（幂等；外来 hook 不触碰）
  -h, --help         输出本帮助

退出码：0 成功；1 命令失败；2 用法/运行错误
```

#### 成功流程

```text
$ notegit setup            # 在已克隆库内
已安装 notegit pre-commit hook：<仓库>/.git/hooks/pre-commit
本地根目录：~/knowbase（notegit ls 按 <根>/<slug> 对照；--local-root 可修改并持久化）
凭据 helper：已注册（credential.https://notegit.example.com.helper）。   ← 未登录时提示「未登录（运行 notegit login 登录后，git 推拉可免交互）。」
```

安装后提交受校验保护：有效提交放行；无效提交被阻断并回显报告（`提交已阻止：修正以上问题后重试（notegit lint --staged 可复现本报告）`）。重复安装幂等；`notegit setup --uninstall` 卸载并还原 `.git/hooks` 原状。

#### 错误与修正

| 触发步骤 | 实际输出（示例） | 退出码 | 修正 |
|---|---|---|---|
| 库内已有外来 pre-commit，直接安装 | `notegit setup: <仓库>/.git/hooks/pre-commit 已存在非 notegit 的外来 pre-commit hook，未做任何改动（保留现有 hook）。` 与 `兼容链安装（保留原 hook 并追加 notegit 校验）请加 --chain；或自行处理既有 hook 后重试。` | 1 | 加 `--chain` 走兼容链（原 hook 保留为 `pre-commit.user`，先原 hook 后 notegit 校验）；或自行处理既有 hook 后重试 |
| `--chain` 但 `pre-commit.user` 已存在且当前 pre-commit 又是外来 hook | `notegit setup: 冲突——保留件 <仓库>/.git/hooks/pre-commit.user 已存在，而当前 pre-commit 又是外来 hook。` 与 `为避免覆盖此前的原 hook，已拒绝安装；请先运行 notegit setup --uninstall 还原，或手动处理后再试。` | 1 | 先 `notegit setup --uninstall` 还原或手动处理 |
| 在非 git 目录运行 | `notegit setup: 不在 git 工作树内，无法安装（…not a git repository…）。请在已克隆的知识库内运行。` | 2 | 进入已克隆的知识库目录再运行 |
| 卸载时无可卸载的 notegit hook | `未发现 notegit pre-commit hook，无需卸载。` | 0 | 无需处理（幂等） |

---

### notegit sync

发现当前员工可见库（`GET /api/v1/vaults`，凭据面同 `ls`），按**架构 §7.3 策略表**同步到 `<本地根目录>/<slug>`（目录三级解析同 `ls`：`NOTEGIT_LOCAL_ROOT` > CLI 配置 > `~/knowbase`）：

| 工作副本状态 | 行为 |
|---|---|
| 新库（无本地副本） | 完整克隆（浅克隆仅 `--depth` 显式选项） |
| 干净且位于默认分支 | `git fetch` 后快进（`--ff-only` 语义；已最新则不动） |
| 有未提交修改（含未跟踪文件） | 跳过并报告，逐字节保留本地改动 |
| 领先远端（未推送提交） | 跳过并报告 |
| 与远端分叉 | 跳过并报告 |
| 位于其他分支 / 分离头指针 | 跳过并报告 |
| 库已撤权（fetch 收 404，S7-T5） | 跳过并报告（`reason_code=revoked`），状态文件标记 `revoked`；本地副本保留、不自动删除；重新授权后下次 `sync` 自动恢复更新并清除标记 |

**不覆盖红线**：任何情况下不自动 stash / reset / rebase / 覆盖用户修改。slug 改名只提示本地目录映射变化，不移动、不删除目录。逐库报告成功 / 跳过 / 失败；退出码非零当且仅当有失败（跳过不判失败）。

**撤权标记（S7-T5）**：员工在某库的成员关系被移除后，服务端对其 Git 通道一律返回 404（与不存在一致，不泄露存在性）。`sync` 在判定面 fetch 收到 404 时按跳过处理（`reason_code=revoked`，携带离线副本 commit 与上次同步时间），并在状态文件 `<root>/.notegit/sync-state.json` 为该库置 `revoked` 位——本地副本**保留、不自动删除**；管理员重新授权后该库回到可见列表，下次 `sync` 即恢复正常更新并清除标记。已标记库不再出现在后续 `sync` 报告中（列表移除后不参与自动更新）。

**文本人读输出**（缺省）：逐库行（成功走 stdout、跳过/失败走 stderr）+ 汇总行（如实计数，不把部分成功报成全部成功）：

```text
$ notegit sync
v-notes：已克隆（HEAD 3f2a1bc）→ /Users/alice/knowbase/v-notes
v-handbook：已快进 9d81e02 → 4c55b7a
v-draft：跳过——工作区有未提交修改（含未跟踪文件）；保留本地改动，不自动 stash/reset/rebase
同步完成：共 3 库（成功 2、跳过 1、失败 0）
```

**结构化输出**（`--json`，S7-T3；S7-T5 扩展 revoked）：stdout 仅一份 JSON 文档——`vaults[]` 逐项结果（`status` ∈ success/skipped/failed + `reason_code`（成功=cloned/fast_forwarded/up_to_date；跳过=dirty/ahead/diverged/other_branch/revoked；失败=status_error/clone_failed/head_unreadable/fast_forward_failed/internal/lock_failed）+ 细节字段 `head`/`from`+`to`/`reason`/`message`）+ `summary` 计数（total/success/skipped/failed，与逐项复数一致）+ `generatedAt`（ISO 8601 UTC）。schema 固化于 `cli/test/sync-report.test.ts`；用法/认证等命令级错误不产生 JSON 信封（stderr 文本 + 退出码，同 `ls` 契约）：
**断网与离线副本**（S7-T6；架构 §7.1「失败时明确提示离线副本的 commit 和同步时间，不能声称一定使用最新知识」）：网络失败的失败行按三态给可读原因（无法连接 / 超时 / HTTP 错误码），已有副本的失败行明示离线副本 commit 与上次同步时间（「可能过期」）；已成功库保留其结果，断网库的工作副本逐字节不动，克隆失败不残留半成品目录：
```text
v-notes：失败——克隆失败：无法连接服务器（fatal: unable to access 'https://notes.example.com/git/v-notes.git/': Failed to connect …）
v-handbook：失败——快进失败：服务器 HTTP 错误 500（fatal: … The requested URL returned error: 500）；离线副本 9d81e02（可能过期），上次同步 2026-10-12T17:30:00.000Z
同步完成：共 2 库（成功 0、跳过 0、失败 2）
```
服务器整体不可达（库列表拉取失败）时不产出逐库结果，stderr 给出可理解报错与离线提示：`notegit sync: 无法连接服务器 https://…：fetch failed；本地副本未刷新、可能过期（notegit ls 可查看各库 HEAD 与上次同步时间）`。
**结构化输出**（`--json`，S7-T3；S7-T6 扩失败码域）：stdout 仅一份 JSON 文档——`vaults[]` 逐项结果（`status` ∈ success/skipped/failed + `reason_code`（成功=cloned/fast_forwarded/up_to_date；跳过=dirty/ahead/diverged/other_branch；失败=status_error/clone_failed/head_unreadable/fast_forward_failed/internal/lock_failed + 断网三态 net_unreachable/timeout/http_error）+ 细节字段 `head`/`from`+`to`/`reason`/`message`——断网类失败的 `message` 携带「离线副本 <commit>（可能过期），上次同步 <时间>」明示）+ `summary` 计数（total/success/skipped/failed，与逐项复数一致）+ `generatedAt`（ISO 8601 UTC）。schema 固化于 `cli/test/sync-report.test.ts`；用法/认证等命令级错误不产生 JSON 信封（stderr 文本 + 退出码，同 `ls` 契约）：

```json
{
  "server": "https://notes.example.com",
  "local_root": "/Users/alice/knowbase",
  "generatedAt": "2026-10-13T08:00:00.000Z",
  "vaults": [
    { "slug": "v-notes", "status": "success", "reason_code": "cloned", "path": "/Users/alice/knowbase/v-notes", "head": "3f2a1bc0…" },
    { "slug": "v-handbook", "status": "success", "reason_code": "fast_forwarded", "path": "/Users/alice/knowbase/v-handbook", "from": "9d81e02…", "to": "4c55b7a…" },
    { "slug": "v-draft", "status": "skipped", "reason_code": "dirty", "path": "/Users/alice/knowbase/v-draft", "reason": "工作区有未提交修改（含未跟踪文件）；保留本地改动，不自动 stash/reset/rebase" },
    { "slug": "v-gone", "status": "skipped", "reason_code": "revoked", "path": "/Users/alice/knowbase/v-gone", "reason": "库已不可访问（服务端对 fetch 返回 404——权限可能已被撤销或库已删除）；本地副本保留、不自动删除，可用 notegit sync clean 显式清理", "head": "8c31d90…", "last_sync": "2026-10-12T09:30:00.000Z" },
    { "slug": "v-broken", "status": "failed", "reason_code": "status_error", "path": "/Users/alice/knowbase/v-broken", "message": "目录存在但不是 git 仓库（或 HEAD 不可读）：…" },
    { "slug": "v-remote", "status": "failed", "reason_code": "net_unreachable", "path": "/Users/alice/knowbase/v-remote", "message": "快进失败：无法连接服务器（fatal: unable to access '…': Failed to connect …）；离线副本 4c55b7a（可能过期），上次同步 2026-10-13T08:00:00.000Z" }
  ],
  "summary": { "total": 6, "success": 2, "skipped": 2, "failed": 2 }
}
```

Git 传输（clone/fetch）走服务端 Smart HTTP，凭据经 `login` 注册的 credential helper（token 不进 URL/参数/日志）。

#### notegit sync clean（S7-T5：显式清理）

`notegit sync clean [--force]` 显式清理**已标记撤权**库的本地副本——只处理状态文件中 `revoked` 标记的库，是纯本地动作（不联网、不需要凭据），未标记的目录（含 slug 改名产生的孤儿目录）一概不碰：

```text
$ notegit sync clean
v-gone：已清理（本地副本已删除）
清理完成：共 1 个撤权标记库（已清理 1、拒绝 0、失败 0）
```

默认（不带旗标）遇到**未导出的本地数据**时拒绝删除并给出导出指引——删除不可逆，宁可拒绝：

```text
$ notegit sync clean
v-gone：拒绝清理——检测到未导出的本地数据：工作区有未提交修改（含未跟踪文件）
  导出指引：git -C /Users/alice/knowbase/v-gone bundle create /Users/alice/knowbase/v-gone.bundle --all（或整体复制 /Users/alice/knowbase/v-gone 目录留档）
  如确认放弃这些内容，可带强制旗标重试（notegit sync clean --help 查看用法）
清理完成：共 1 个撤权标记库（已清理 0、拒绝 1、失败 0）
```

- 拒绝原因：未提交修改（含未跟踪文件）、未推送提交（任何本地分支/tag/HEAD/暂存栈上领先于远端记忆的提交）、暂存栈条目、目录不是 git 仓库（内容不可判定）、安全探测不可判定——均 fail-safe 方向（多拒绝）。
- `--force`：越过拒绝**强制删除**并在 stderr 警示丢弃了什么（选型记录见 `cli/src/sync/clean.ts` 模块头——D7 禁的是「自动」清理；显式命令 + 拒绝文案 + 用户主动加旗标构成知情决定）。
- 退出码：`0` = 全部目标已清理（或无可清理）；`1` = 存在拒绝或失败；`2` = 用法错误。
- 清理成功后状态条目随之移除；若管理员随后重新授权，下次 `sync` 会重新克隆。

#### 帮助原文（`notegit sync --help`）

```text
notegit sync [--depth <深度>] [--json] | notegit sync clean [--force] — 发现并安全同步知识库到本地（克隆/快进，不覆盖本地改动）

说明：
  发现当前员工可见库（GET /api/v1/vaults，Bearer；同 ls），按架构 §7.3 策略表同步到 <本地根目录>/<slug>：无副本 → 完整克隆；干净且位于默认分支 → fetch 后快进（--ff-only 语义）；有未提交修改、领先远端、分叉或位于其他分支 → 跳过并逐库报告（绝不自动 stash/reset/rebase）；fetch 收 404（撤权）→ 跳过（reason_code=revoked）并在状态文件标记，本地副本保留不自动删除，重新授权后下次 sync 自动恢复。子命令 clean 显式清理已标记撤权库的本地副本：遇未提交修改、未推送提交、暂存栈或不可判定内容时拒绝并给出导出指引（git bundle / 整目录复制）；--force 强制删除并警示丢弃内容。浅克隆仅 --depth 显式选项；slug 改名只提示映射变化，不移动本地目录。逐库报告成功/跳过/失败（status + reason_code + 细节）；退出码非零当且仅当有失败（跳过不判失败；clean 中拒绝/失败计非零）。
  状态：已实现（S7-T1 六态策略表 + S7-T3 逐项结果/JSON/退出码契约 + S7-T5 撤权标记与显式清理）
  发现当前员工可见库（GET /api/v1/vaults，Bearer；同 ls），按架构 §7.3 策略表同步到 <本地根目录>/<slug>：无副本 → 完整克隆；干净且位于默认分支 → fetch 后快进（--ff-only 语义）；有未提交修改、领先远端、分叉或位于其他分支 → 跳过并逐库报告（绝不自动 stash/reset/rebase）。浅克隆仅 --depth 显式选项；slug 改名只提示映射变化，不移动本地目录。逐库报告成功/跳过/失败（status + reason_code + 细节）；退出码非零当且仅当有失败（跳过不判失败）。断网时逐库失败原因码区分 net_unreachable/timeout/http_error，失败 message 明示离线副本 commit 与上次同步时间（可能过期——不声称最新）；克隆失败不残留半成品目录。
  状态：已实现（S7-T1 六态策略表 + S7-T3 逐项结果/JSON/退出码契约 + S7-T6 断网三态与离线明示）

选项：
  --depth <深度>  新库浅克隆（显式选项；缺省完整克隆，不影响已有副本的快进更新）
  --json          逐库结构化 JSON 报告（stdout 仅 JSON：vaults[] + summary 计数 + generatedAt；schema 固化于 test/sync-report.test.ts）
  clean [--force]  子命令——显式清理已标记撤权库的本地副本（纯本地动作，不联网）：默认遇未提交修改/未推送提交/暂存栈/不可判定内容拒绝并给导出指引；带 --force 强制删除并在 stderr 警示丢弃内容；只处理状态文件中 revoked 标记的库，不碰未标记目录；退出码 1 = 存在拒绝或失败
  凭据面：环境变量 NOTEGIT_SERVER 与 NOTEGIT_TOKEN（同 ls）；Git 传输凭据经 credential helper（clean 不需要凭据）
  本地根目录：NOTEGIT_LOCAL_ROOT / CLI 配置 / 缺省 ~/knowbase（同 ls 三级解析）
  网络超时：NOTEGIT_SYNC_TIMEOUT_MS 毫秒覆盖 clone/fetch 超时（慢网/调试调优；缺省 clone 300 秒、fetch 120 秒）
  -h, --help      输出本帮助

退出码：0 成功；1 命令失败；2 用法/运行错误
```

---

## 结构化输出与退出码

| 面 | 说明 |
|---|---|
| `notegit ls --json` | 列表 JSON（schema 固化于 `cli/test/ls.test.ts`）；失败走 stderr 文本 + 退出码 1（无 JSON 错误信封） |
| `notegit sync --json` | 逐库结果 JSON：`vaults[]`（status/reason_code/细节）+ `summary` 计数 + `generatedAt`（schema 固化于 `cli/test/sync-report.test.ts`）；退出码非零当且仅当有失败（跳过不判失败）；命令级失败同 ls——stderr 文本，无 JSON 错误信封 |
| `notegit lint --json` | validation-report 协议（`docs/contracts/schemas/validation-report.schema.json`）；`result` pass/fail/error ↔ 退出码 0/1/2 |
| pre-commit hook `--json` | 与 `notegit lint --staged --json` 同一报告（hook≡lint 等价断言 `cli/test/hooks-lint.test.ts`） |

退出码（与 `docs/contracts/validation.md` §6.1 校验语义一致）：

| 码 | 语义 |
|---|---|
| 0 | 成功（校验语义：通过，可含 warning） |
| 1 | 命令失败（校验错误、查询失败等业务性失败；校验语义：内容未通过） |
| 2 | 用法错误或运行错误（未知命令/选项、非 git 目录、内部错误；校验语义：运行错误，fail-closed） |

## 环境变量

| 变量 | 消费命令 | 说明 |
|---|---|---|
| `NOTEGIT_TOKEN` | `login`、`ls`、`lint`、`sync` | 访问令牌（login 的令牌来源之一；ls/lint/sync 凭据面） |
| `NOTEGIT_SERVER` | `ls`、`lint`、`sync` | 服务端基址（`https://host[:port]`；lint 仅用于规则版本探测） |
| `NOTEGIT_LOCAL_ROOT` | `ls`、`setup`、`sync` | 本地根目录覆盖；优先级：显式参数/环境变量 > CLI 配置（`setup --local-root` 持久化）> 缺省 `~/knowbase` |
| `NOTEGIT_CREDENTIALS_FILE` | `login`、`credential` | 凭据文件路径覆盖（测试隔离用；缺省 `~/.config/notegit/credentials`，尊重 `XDG_CONFIG_HOME`） |
| `NOTEGIT_SYNC_TIMEOUT_MS` | `sync` | 网络操作（clone/fetch）超时毫秒数覆盖（慢网/调试调优；正整数，缺省 clone 300 秒、fetch 120 秒；非法值忽略） |

## 安全边界

- 令牌不接受 `--token` 命令行参数（防进程列表泄漏）；来源仅隐藏交互输入或 `NOTEGIT_TOKEN` 环境变量。
- CLI 输出只出现掩码（`ngt_ab…wxyz` 形，与服务端 `display_hint` 同款）。
- 凭据唯一落盘 = 0600 权限的凭据文件；不写入 remote URL、`.git/config` 或任何日志（泄漏扫描断言见 `cli/test/login-integration.test.ts`）。
- credential helper 按 host 作用域 + 空值重置：本 CLI 是该 server 凭据的唯一来源，token 不透传其他 helper；不影响用户其他 host 的 helper 配置。
- pre-commit hook 只运行随工具分发的校验程序，不执行知识库内任何脚本/hook 样本（沙箱断言 `cli/test/hooks-sandbox.test.ts`）；对既有外来 hook 默认拒绝安装（保留原状），`--chain` 才启用兼容链。
