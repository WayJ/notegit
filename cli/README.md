# notegit — Notegit 员工端 CLI

Notegit 知识库系统的员工端命令行工具。与服务端使用同一套内容校验规则（`packages/validation` 单一来源，校验实现内嵌于发行包，S6-T7 三端一致构建断言锁定），凭据不进入仓库或日志。

- 本文与实现同步：每命令节内置 `--help` 原文（`cli/test/docs-consistency.test.ts` 自动抽检文档与 `--help` 一致）；结构化输出样例过 `validation-report.schema.json` 契约校验。
- 状态约定：**文档只描述已实现行为**。`sync` 为 S7 占位骨架，本文如实标注、不给出可用示例。

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
| `notegit ls` | 列出有权访问的知识库、clone URL 与本地状态 | 已实现（S6-T3 交付） |
| `notegit lint` | 手动校验知识库内容（与服务端同一规则） | 已实现（S6-T4 交付，S6-T7 接线版本探测端点） |
| `notegit setup` | 在已克隆库中安装/卸载/管理本地校验 hook 与本地根目录 | 已实现（S6-T5/T6 交付） |
| `notegit sync` | 发现并安全同步知识库到本地（S7 实现，本 sprint 仅骨架） | **S7 实现**（本 sprint 仅骨架，sprint/S6 决策 D6） |

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
  实时按当前员工权限列出可见库（GET /api/v1/vaults，Bearer）；本地状态 = 未克隆/已克隆/落后/未知（对照本地根目录 <root>/<slug>）。凭据占位面：NOTEGIT_SERVER 与 NOTEGIT_TOKEN 环境变量（S6-T2 login 交付后接管）；本地根目录默认 ~/knowbase，可用 NOTEGIT_LOCAL_ROOT 覆盖。
  状态：已实现（S6-T3 已实现（--json schema 固化于 cli/test/ls.test.ts））

选项：
  --json  输出 JSON（schema 固化）
  -h, --help  输出本帮助

退出码：0 成功；1 命令失败；2 用法/运行错误
```

#### 成功输出

表格形态：

```text
服务器 https://notegit.example.com；本地根目录 ~/knowbase

库                  状态    角色      默认分支  名称
engineering-notes  未克隆   editor  main    工程笔记
handbook           未克隆   reader  main    员工手册
```

结构化输出（`notegit ls --json`，schema 固化于 `cli/test/ls.test.ts`）：

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
        "remote_tip": null
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
| `unknown` | 无法判定（非 git 目录、远端不可达、本地领先/分叉等；精确六态机属 S7 sync） |

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

`sync` 的安全同步（克隆/快进、脏工作区与未推送提交保护、逐库报告）按规划属 **S7**（sprint/S6 决策 D6）；本版本仅保留命令骨架占位，运行返回退出码 2：

```text
$ notegit sync
notegit sync: 尚未实现（S7 实现（本 sprint 仅骨架——sprint/S6 决策 D6））
```

当前更新本地副本请直接使用 git：`git -C ~/knowbase/<slug> pull --ff-only`。

#### 帮助原文（`notegit sync --help`）

```text
notegit sync — 发现并安全同步知识库到本地（S7 实现，本 sprint 仅骨架）

说明：
  按安全策略克隆/快进更新可见库，遇脏工作区、未推送提交、分叉等保留改动并逐库报告。注意：sync 真实现属 S7，本 sprint 不提供。
  状态：尚未实现（S7 实现（本 sprint 仅骨架——sprint/S6 决策 D6））

选项：
  -h, --help  输出本帮助

退出码：0 成功；1 命令失败；2 用法/运行错误（占位命令一律退出码 2）
```

---

## 结构化输出与退出码

| 面 | 说明 |
|---|---|
| `notegit ls --json` | 列表 JSON（schema 固化于 `cli/test/ls.test.ts`）；失败走 stderr 文本 + 退出码 1（无 JSON 错误信封） |
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
| `NOTEGIT_TOKEN` | `login`、`ls`、`lint` | 访问令牌（login 的令牌来源之一；ls/lint 凭据面） |
| `NOTEGIT_SERVER` | `ls`、`lint` | 服务端基址（`https://host[:port]`；lint 仅用于规则版本探测） |
| `NOTEGIT_LOCAL_ROOT` | `ls`、`setup` | 本地根目录覆盖；优先级：显式参数/环境变量 > CLI 配置（`setup --local-root` 持久化）> 缺省 `~/knowbase` |
| `NOTEGIT_CREDENTIALS_FILE` | `login`、`credential` | 凭据文件路径覆盖（测试隔离用；缺省 `~/.config/notegit/credentials`，尊重 `XDG_CONFIG_HOME`） |

## 安全边界

- 令牌不接受 `--token` 命令行参数（防进程列表泄漏）；来源仅隐藏交互输入或 `NOTEGIT_TOKEN` 环境变量。
- CLI 输出只出现掩码（`ngt_ab…wxyz` 形，与服务端 `display_hint` 同款）。
- 凭据唯一落盘 = 0600 权限的凭据文件；不写入 remote URL、`.git/config` 或任何日志（泄漏扫描断言见 `cli/test/login-integration.test.ts`）。
- credential helper 按 host 作用域 + 空值重置：本 CLI 是该 server 凭据的唯一来源，token 不透传其他 helper；不影响用户其他 host 的 helper 配置。
- pre-commit hook 只运行随工具分发的校验程序，不执行知识库内任何脚本/hook 样本（沙箱断言 `cli/test/hooks-sandbox.test.ts`）；对既有外来 hook 默认拒绝安装（保留原状），`--chain` 才启用兼容链。
