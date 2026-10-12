# notegit — Notegit 员工端 CLI

Notegit 知识库系统的员工端命令行工具。与服务端使用同一套内容校验规则（`packages/validation` 工作区依赖，D5），凭据不进入仓库或日志。

## 环境要求

- Node ≥ 22.13（macOS / Linux；D10 selection §6。Windows 不在首发承诺）
- 用户侧 Git（`login`/`sync` 场景使用）

## 安装（当前为 workspace 打包产物安装）

```sh
npm install -g notegit-<version>.tgz notegit-validation-<version>.tgz
```

> 说明：`notegit-validation` 尚未发布到公共 registry；从仓库打包时两个 tarball 需一起安装（`D5` 工作区依赖）。

## 命令

| 命令 | 作用 | 状态 |
|---|---|---|
| `notegit login <server> [--username <用户名>]` | 登录并配置员工凭据（安全存储 / Git credential helper） | 已实现（S6-T2） |
| `notegit ls [--json]` | 列出有权访问的知识库、clone URL 与本地状态 | S6-T3 交付 |
| `notegit sync` | 发现并安全同步知识库到本地 | **S7 实现**（本 sprint 仅骨架，sprint/S6 D6） |
| `notegit setup [--uninstall]` | 在已克隆库中安装/管理本地校验 hook | S6-T6 交付 |
| `notegit lint [--staged\|--all] [--json]` | 手动校验（与服务端同一规则） | S6-T4 交付 |

## login（S6-T2 已实现）

```sh
notegit login https://notegit.example.com --username alice
# 或省略 --username，交互输入；令牌始终隐藏输入或经环境变量提供
NOTEGIT_TOKEN=ngt_… notegit login https://notegit.example.com --username alice
```

流程与凭据去向（identity §3.1「凭据不入 remote URL/仓库文件/日志」红线）：

1. 访问令牌在网页端「查看访问凭据」页创建（`ngt_` 前缀，明文仅创建时显示一次）。
2. CLI 以 `Authorization: Bearer` 调 `GET /api/v1/credentials` 校验令牌（四状态按 E-AUTH-001..004 映射为可读错误：无效/过期（不可续期）/撤销/账号停用）。
3. 校验通过后凭据写入本 CLI 的存储文件（`~/.config/notegit/credentials`，权限 0600；可用 `NOTEGIT_CREDENTIALS_FILE` 覆盖，测试隔离用）。
4. 注册按 host 作用域的 Git credential helper（`credential.<server>.helper`，空值重置 + `notegit credential` 子命令），此后 `git ls-remote`/`clone`/`fetch`/`push` 对该 server 免交互取凭据。

安全边界：

- 令牌不接受 `--token` 命令行参数（防进程列表泄漏）；来源仅隐藏交互输入或 `NOTEGIT_TOKEN` 环境变量。
- CLI 输出只出现掩码（`ngt_ab…wxyz` 形，与服务端 `display_hint` 同款）。
- helper 配置带空值重置：本 CLI 是该 server 凭据的唯一来源，token 不透传给 osxkeychain/libsecret 等其他 helper（避免第二份副本与 headless 环境的 keychain 阻塞）；不影响用户其他 host 的 helper 配置。
- 凭据按 `protocol+host` 归属（server URL 的路径部分忽略）；Basic 用户名按 api.md §1 任意、仅为标识。

## 退出码

| 码 | 语义 |
|---|---|
| 0 | 成功 |
| 1 | 命令失败（校验错误、查询失败等业务性失败） |
| 2 | 用法错误或运行错误 |

与校验报告协议的退出码语义一致（`docs/contracts/validation.md` §6.1：0=通过、1=校验错误、2=运行错误）。
