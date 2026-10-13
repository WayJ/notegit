# Notegit 管理员手册

面向实例管理员与运维：账号、凭据、库授权、维护模式、备份/恢复/升级与指标。部署本身（镜像构建、运行、HTTPS、首次初始化演练）见 [deploy/README.md](../../deploy/README.md)；本文从「实例已跑起来、管理员已 bootstrap」讲起。

> 依据：[api.md](../contracts/api.md)（端点契约）、[identity-credentials.md](../contracts/identity-credentials.md)（凭据语义）、[backup-recovery.md](../contracts/backup-recovery.md)（备份/恢复/升级手册）。文档只描述已实现行为，一致性由 `cli/test/delivery-docs-consistency.test.ts` 抽检。

## 1. 两种管理员

- **实例管理员**：管账号、凭据代管、维护模式、指标、审计——全部经 `/admin` 管理页或 admin API（非实例管理员一律 403）。bootstrap 建立的第一个账号即实例管理员。
- **库管理员**：业务库内的成员与设置管理（`main_admin_only` 等），经库成员端点授权，不自动拥有其他库。

管理页是网页壳，全部操作走同一套 API——下文命令行示例与页面按钮等价。

## 2. 员工生命周期

第一版**无自助注册**：员工由实例管理员邀请。会话登录走 `POST /api/v1/auth/login`（拿 `ngt_sid` Cookie；下文 curl 以 `-b cookies.txt` 表示）。

```sh
# 邀请（一次性口令重置令牌，明文仅此一次、30 分钟单次有效，经企业内渠道交付）
curl -fsS -X POST https://<服务器地址>/api/v1/admin/employees -b cookies.txt \
  -H 'content-type: application/json' \
  -d '{"username":"alice","display_name":"Alice"}'
# → {"username":"alice","password_reset_token":"…"}

# 员工设初始口令（公开端点，员工自行执行；口令 12–64 字符）
curl -fsS -X POST https://<服务器地址>/api/v1/auth/password-reset \
  -H 'content-type: application/json' \
  -d '{"reset_token":"…","new_password":"<≥12 字符>"}'

# 停用/启用（停用后该账号全部会话与令牌下一请求 401；可顺带调整 is_instance_admin）
curl -fsS -X PATCH https://<服务器地址>/api/v1/admin/employees/{username} -b cookies.txt \
  -H 'content-type: application/json' -d '{"active":false}'

# 重置口令（重新签发一次性令牌；重置完成后该账号全部会话失效）
curl -fsS -X POST https://<服务器地址>/api/v1/admin/employees/{username}/password-reset -b cookies.txt
```

运营注意：

- **没有「最后一名管理员」保护**：可以把自己停用/降级导致全员锁死。规划中的主机侧恢复命令 `notegit admin recover` **尚未实现**——请始终保持至少两名实例管理员（见[已知限制](../known-limitations.md)）。
- 员工列表 `GET /api/v1/admin/employees`（分页）；全部操作有审计行（`employee.create` / `employee.deactivate` / `employee.password_reset`）。

## 3. 访问凭据与代管

员工访问凭据（`ngt_` 令牌）**自助为主、代管兜底**：

- 员工在网页「我的凭据」页（`/credentials`）自助创建/撤销：`name` + `expires_at` 必填（≤90 天），明文仅创建时显示一次，服务端只存 HMAC 摘要（`display_hint` 掩码回显）。
- 管理员代管**只能列出与撤销，看不到明文**（谁也拿不回明文）：

```sh
# 列出某员工全部凭据（状态/到期/最后使用）
curl -fsS https://<服务器地址>/api/v1/admin/employees/{username}/credentials -b cookies.txt

# 撤销其中一条（下一请求即 401；审计 credential.revoke 记代管）
curl -fsS -X DELETE https://<服务器地址>/api/v1/admin/employees/{username}/credentials/{id} -b cookies.txt
```

- 员工离职/设备失窃的处置顺序：停用账号（一下全断）＞撤销具体凭据＞移除库成员。边界语义见[权限与撤权边界](../user/permissions.md)。
- pepper（令牌摘要密钥）位置、轮换与密钥件备份：见 [credentials-ops.md](../credentials-ops.md)。

## 4. 建库与授权

```sh
# 建库（创建者即库管理员；默认分支 main，同时初始化 bare 仓库）
curl -fsS -X POST https://<服务器地址>/api/v1/vaults -b cookies.txt \
  -H 'content-type: application/json' -d '{"name":"员工手册","slug":"v-handbook"}'

# 授权（reader | editor | admin；移除 = DELETE 同路径）
curl -fsS -X PUT https://<服务器地址>/api/v1/vaults/{slug}/members/{username} -b cookies.txt \
  -H 'content-type: application/json' -d '{"role":"editor"}'

# 需要锁主干时：仅库管理员可写默认分支
curl -fsS -X PATCH https://<服务器地址>/api/v1/vaults/{slug} -b cookies.txt \
  -H 'content-type: application/json' -d '{"main_admin_only":true}'
```

分支规则（服务端固定执行）：默认分支禁 force push/删除；非默认分支 editor 可建可删；无 tag 写入。需要内容隔离就拆库——库内没有文档级权限。

## 5. 维护模式

维护模式是**实例级全局写闸门**：开启后网页/API 一切写操作 503（`E-MAINT-001`）、Git push（receive-pack）403；**读与登录放行**。用于备份、恢复、升级窗口。

```sh
# 开启（幂等；审计 maintenance.enable）
curl -fsS -X POST https://<服务器地址>/api/v1/admin/maintenance -b cookies.txt

# 排空进度（pending = 在途写计数；等它归零再继续备份步骤）
curl -fsS https://<服务器地址>/api/v1/admin/maintenance -b cookies.txt
# → {"enabled":true,"drain":{"pending":0}}

# 显式关闭（审计 maintenance.disable）
curl -fsS -X DELETE https://<服务器地址>/api/v1/admin/maintenance -b cookies.txt
```

恢复/升级场景以 `NOTEGIT_MAINTENANCE_ON_START=1` 启动实例——进程起来即处维护态，由你在收尾时显式关闭。

## 6. 备份、恢复与升级手册

完整流程规范（一致性模型、十步恢复、R1–R14 验证清单、升级 §9）见 [backup-recovery 契约](../contracts/backup-recovery.md)；本节是**命令面板**。工具随镜像分发，容器内执行；管理令牌只走 `--token-file` 或 `NOTEGIT_ADMIN_TOKEN` 环境变量（不进 argv/日志）。

### 6.1 日常备份

```sh
# 一致备份：开维护→排空→VACUUM INTO→git 复制+抽样 fsck→关维护；产物分置两件
docker exec notegit node src/backup/cli.ts backup \
  --data-dir /data --out /backup \
  --url http://127.0.0.1:3000 \
  --token-file /run/secrets/backup-admin.token \
  --keys-out /backup-keys

# 离线验证（不起服务，可在宿主执行；交付/归档前必跑）
docker cp notegit:/backup ./backup-set
node server/src/backup/cli.ts verify --data-item ./backup-set/<时间戳>-data --fsck
```

产物 = `<时间戳>-data/`（manifest + DB 快照 + git + config）与 `<时间戳>-keys/`（pepper 全文件，0600/0700）**分置两件**；K3 TLS 私钥与 K4 DB 口令的记录由运维随密钥件同置保存（工具不代管部署层机密）。

### 6.2 全新环境恢复（两相位）

```sh
# 相位一（离线）：装载前验证→目标四域全新→按序装载→完整性核对
node server/src/backup/cli.ts restore \
  --data-item ./backup-set/<时间戳>-data \
  --keys-item ./backup-keys/<时间戳>-keys \
  --data-dir /data

# 相位二（实例侧）：以维护态启动新实例后，对账 + 触发搜索索引全量重建（不退出维护）
NOTEGIT_MAINTENANCE_ON_START=1 PORT=3000 npm start
node src/backup/cli.ts finalize \
  --data-dir /data --url http://127.0.0.1:3000 \
  --token-file /run/secrets/admin.token
```

然后按 backup-recovery §8 的 **R1–R14** 清单逐项核对（权限/内容/历史/索引/审计成链），全绿才显式退出维护。

### 6.3 升级（与回退）

```sh
# 1) 升级前一致备份（开维护→排空→快照；维护保持开启）
docker exec notegit node src/backup/cli.ts upgrade pre-backup \
  --data-dir /data --out /backup \
  --url http://127.0.0.1:3000 --token-file /run/secrets/backup-admin.token

# 2) 证据闸门：无/假/跳过备份证据必拒（D-BR-08——想 --skip-pre-upgrade-backup 会被拒）
node server/src/backup/cli.ts upgrade gate --data-item ./backup-set/<时间戳>-data

# 3) 换镜像，以维护态启动（schema 前向迁移随启动自动执行，幂等可重入）
# 4) 升级后核对（维护断言 + schema_version 有序核对）
docker exec notegit node src/backup/cli.ts upgrade post \
  --data-dir /data --url http://127.0.0.1:3000 \
  --token-file /run/secrets/admin.token

# 5) 审计对账 → 冒烟 → 显式退出维护
docker exec notegit node src/audit/reconcile-cli.ts reconcile \
  --data-dir /data --url http://127.0.0.1:3000 \
  --token-file /run/secrets/admin.token --json
```

**回退 = 恢复升级前备份**（走 6.2 两相位），不做 schema 降级。真实演练证据：init/backup/restore/upgrade 四类断言化脚本见 `deploy/scripts/`，历次留档 `.agents/notes/2026-10-1*-*.txt`。

### 6.4 异常对账

Git/数据库间出现可疑状态（中断写、半应用）时：维护模式下跑对账，`pending/待核对` 审计行被标终态、refs 与审计 old→new 成链核对、孤儿仓库/配置行检出——完成前不退出维护。

## 7. 指标与健康

- 存活：`GET /healthz`（容器 HEALTHCHECK 同源）。
- 运维指标：`GET /api/v1/admin/metrics`（实例管理员）——磁盘水位（分域用量 + warn/critical 阈值 0.80/0.90）、失败推送与未对账计数、网页提交失败、校验失败数与耗时分布（web-submit scope）、认证失败计数（**重启归零**）、`backup.last_completed_at`（以 `backup.completed` 审计行为唯一来源；从未备份如实为 null）。
- 搜索索引：`GET /api/v1/admin/search-index`（逐库 `head_commit` vs `live_commit`、`lag_ms`、连续失败）；`POST /api/v1/admin/search-index/rebuild` 触发全量重建（异步，重建中再触发 409）。
- 审计查询：`GET /api/v1/admin/audit`（按库/主体/事件/状态/时间过滤）。

## 8. 容量与限制配置

限制键的唯一源是 [validation-defaults.json](../contracts/validation-defaults.json)（文档/附件大小、附件类型清单、单次 push、库容量、豁免、校验超时/并发/内存）+ `git.maxConcurrentChildren`（git 子进程并发上限，默认 8，超出 FIFO 排队不拒绝）。覆盖链：契约默认 ← 环境变量 `NOTEGIT_<键名>`（JSON 字面量）← `app_settings` 行（同键胜环境）。全部**热生效**，非法值 fail-closed（拒绝并指名键，不静默回退）。

- 运行时改值 = 写 `app_settings` 行（SQL/ops）；HTTP 配置端点（`GET/PUT /api/v1/admin/config`）契约已定稿、**HTTP 挂接尚未实现**，勿按端点方式操作。
- 大批量初始导入会超默认 push 上限——临时调高、完成后回落的示例见 [deploy/README.md](../../deploy/README.md)「初始导入指引」。
- 内存地板 768MB 的推导与降级路径（512MB 不承诺）见 [deploy/README.md](../../deploy/README.md)「最低规格」。

## 9. 快速索引

| 事 | 去哪 |
|---|---|
| 部署/升级镜像/HTTPS/初始化演练 | [deploy/README.md](../../deploy/README.md) |
| 凭据体系与 pepper 轮换 | [credentials-ops.md](../credentials-ops.md) |
| 员工视角使用 | [docs/user/](../user/README.md) |
| Agent/Harness 接入 | [docs/harness/](../harness/README.md) |
| 边界与已知限制 | [known-limitations.md](../known-limitations.md) |
| 端点/错误码全集 | [api.md](../contracts/api.md) |
