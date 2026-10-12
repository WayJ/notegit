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
| `notegit login` | 登录并配置员工凭据（安全存储 / Git credential helper） | S6-T2 交付 |
| `notegit ls [--json]` | 列出有权访问的知识库、clone URL 与本地状态 | S6-T3 交付 |
| `notegit sync` | 发现并安全同步知识库到本地 | **S7 实现**（本 sprint 仅骨架，sprint/S6 D6） |
| `notegit setup [--uninstall]` | 在已克隆库中安装/管理本地校验 hook | S6-T6 交付 |
| `notegit lint [--staged\|--all] [--json]` | 手动校验（与服务端同一规则） | S6-T4 交付 |

## 退出码

| 码 | 语义 |
|---|---|
| 0 | 成功 |
| 1 | 命令失败（校验错误、查询失败等业务性失败） |
| 2 | 用法错误或运行错误 |

与校验报告协议的退出码语义一致（`docs/contracts/validation.md` §6.1：0=通过、1=校验错误、2=运行错误）。
