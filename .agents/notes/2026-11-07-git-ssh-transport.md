# Git over SSH 传输面（公钥白名单 + upload-pack/receive-pack 直调）

## 背景

架构 §3.2 原定「第一版支持 HTTPS，SSH 留到后续」。dshent 平台侧的成员本地同步诉求是「配好 ssh key 就能 clone」——
HTTP Basic 令牌要求成员保管令牌并逐库输入，SSH 公钥是成员既有习惯。本批把 SSH 面补齐。

## 交付

- `server/src/gitssh/keys.ts`：公钥登记册（`ssh_keys` 表）。指纹取 OpenSSH 形态
  `SHA256:<base64(sha256(公钥 wire blob))>`（与 `ssh-keygen -lf` 同款）；登记册存公钥本体，
  私钥永不进库；吊销即失效（软删留痕，同指纹可再登记）。
- `server/src/gitssh/server.ts`：SSH 服务。公钥白名单认证（未登记/已吊销/账号停用一律拒）→
  命令白名单（只放 `git-upload-pack` / `git-receive-pack`）→ 授权（`authorize()` 实时查成员关系，
  与 HTTP 面同一 MembershipSource）→ 维护闸门拒写 → spawn `git upload-pack` / `git receive-pack`
  （cwd=`<dataDir>/git`，参数为库目录名 `<vault-id>.git`，路径只由 DB 稳定 ID 映射）。
- `server/src/gitssh/routes.ts`：公钥登记管理面（实例管理员代成员登记/吊销；审计记 `ssh_key.create`/
  `ssh_key.revoke`，只记指纹不记公钥本体）。
- 迁移 0012（`ssh_keys` 表 + 活指纹唯一索引）；`NOTEGIT_SSH_PORT` 显式开启（缺省不起 SSH 面）；
  宿主密钥落 `<dataDir>/ssh/host_ed25519_key`（0600，首启生成）。

## 决策与偏差

- **SSH 面不新造授权/校验链**：推送侧复用与 HTTP 面同构的 hook 环境（`REMOTE_USER=<employeeId>:<keyId>`、
  `NOTEGIT_DB`/`NOTEGIT_VAULT_ID`/`NOTEGIT_VAULT_SLUG`/`NOTEGIT_PUSH_ID`/`NOTEGIT_PUSH_BYTES_FILE`），
  于是授权复查、内容校验、分支规则与审计在两条传输面上判定一致。实测证据：reader 推分支被授权层拒、
  editor 推默认分支被 `main_admin_only` 拒、缺 frontmatter 的文档被内容校验拒——三条规则在 SSH 面同样生效。
- **权限口径**：SSH 载体按员工实时角色判定（与 Web 会话载体同口径），不像 token 载体那样带库清单收窄——
  公钥即本人身份，收窄由上游「员工无权即无权」保证。
- **实现期踩坑（三处，均已修正）**：① ssh2 的 `accept()` 必须在事件回调内**同步**调用，异步 accept 会让
  通道已被关闭，客户端只看到 "Connection closed by remote host"；② `session.on('env')` 的 accept 只在客户端
  要求回复（wantReply）时才有，无条件调用即崩（git 的 `GIT_PROTOCOL` 请求不带 wantReply）；
  ③ 子进程 stdout 管道若用默认 `end:true`，通道可写侧先关，随后的 `exit()` 被 ssh2 丢弃——
  客户端收不到 exit-status，git 报 "remote transport reported error"。收尾顺序固定为：先 `exit(code)` 再 `end()`。

## 验证证据

`server/test/gitssh.test.ts`（真实 git 客户端，2026-11-07 实跑 5/5 绿）：

- 命令解析只放行两个 pack 服务，路径只解出合法 slug；
- 已登记公钥的成员经 `git ls-remote ssh://git@127.0.0.1:<port>/docs.git` 读到 refs；
- 未登记公钥认证失败（客户端拿不到 refs）；
- 非成员读不到 refs（无权库与不存在同形）；reader 能 clone 但推不动；
- editor 经 SSH clone + 推分支成功、admin 推默认分支成功（`git log` 验到新提交）。

## 遗留

- 宿主密钥轮换面未做（当前首启生成后随数据卷留存）。
- `ssh2` 的可选原生加速未启用（install 脚本未跑，走纯 JS crypto——功能无差）。
