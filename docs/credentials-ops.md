# 凭据配置说明（credentials-ops）

| 项目 | 内容 |
|---|---|
| 任务 / 日期 | S2-T8（breakdown §2.1） / 2026-10-13 |
| 依据 | [identity-credentials.md](contracts/identity-credentials.md) §3/§4/§6/§7（唯一语义源）、[backup-recovery.md](contracts/backup-recovery.md) §6/§8、[api.md](contracts/api.md) §1/§3/§4 |
| 读者 | 实例管理员 / 运维 |
| 验证 | 轮换步骤与 `server/test/pepper-rotation.test.ts` 同构（步骤 3 的抽查口径即复跑该测试语义）；实现位 `server/src/bootstrap/pepper.ts`、`server/src/credentials/service.ts`（token rehash-on-use）、`server/src/auth/subject.ts`（会话 rehash-on-use） |

> 本文描述**当前实现的真实行为**；与契约的差距在 §5「已知边界」如实标注，不虚构未落地的能力。

## 1. 凭据体系速览

| 凭据 | 形态 | 明文出现次数 | 失效即阻断 |
|---|---|---|---|
| 员工访问凭据（Agent/CLI 用） | `ngt_` + 43 字符随机部；`Authorization: Bearer`（Git HTTP Basic 口令形态随 S3 接入） | **仅创建响应一次**；此后界面/接口只显示 `ngt_ab…wxyz` 形态脱敏 hint（identity §3.1） | 过期/撤销/账号停用下一请求 401（E-AUTH-002/003/004） |
| Web 会话 | Cookie `ngt_sid`（HttpOnly; Secure; SameSite=Lax；服务端会话表） | 不适用（Cookie 由浏览器持有） | 过期/账号停用/口令重置后失效；idle 7 天滑动、absolute 30 天（identity §4） |
| 一次性令牌（K5） | 43 字符随机串（bootstrap 24h / 邀请与口令重置 30 分钟，单次） | **仅签发响应一次**（邀请与重置在管理页展示一次） | 已用/过期即失效，不可重放 |

管理面：`/admin`（实例管理员——员工与邀请、重置口令、建库、成员角色、维护模式开关）；自助面：`/credentials`（创建/撤销/列表）。页面操作全部经 [api.md](contracts/api.md) 既有端点走服务端授权。

## 2. pepper（K1）位置与格式

- **位置**：`/data/keys/token-pepper.key`（容器持久卷；开发/测试用 `NOTEGIT_DATA_DIR` 覆盖数据根目录时为 `<dataDir>/keys/token-pepper.key`）。
- **权限**：0600，仅应用进程可读；首次启动自动生成（32 字节随机）。
- **格式**：版本化列表（identity §6.2）：

```json
{"active": {"version": 1, "key": "<64 位 hex（32 字节）>"}, "retired": []}
```

- **用途**：访问凭据与会话 ID 的 HMAC-SHA256 键（`hmacv<版本>$<hex>` 存储串内嵌 pepper 版本；凭据哈希以此输出为唯一索引）。
- **加载时机**：应用**启动时**读取一次（`server/src/main.ts` 启动接线）；运行中编辑文件不生效，轮换需重启（见 §3）。
- **已初始化实例缺此文件会拒绝启动**（防静默重生成废掉全部已存哈希——须从密钥备份恢复，见 §4）。

## 3. pepper 轮换操作（在线，不需维护模式）

触发时机（identity §6.2）：疑似泄露、定期（建议每年）、经手人员变动。以下步骤在部署主机执行；`$DATA` 为数据目录（默认 `/data`）。

**步骤 0 —— 预备**：备份 pepper 文件（格式错误会导致启动失败）；确认密钥备份件可回滚（§4）。

```sh
# 查看当前文件（版本号记下来，下称 N）
cat $DATA/keys/token-pepper.key
```

**步骤 1 —— 生成新 pepper**：

```sh
openssl rand -hex 32
```

**步骤 2 —— 改写文件并重启**：新键为 `active`（`version` = N+1）；原 `active` 整体移入 `retired` 数组**原样保留**（版本与键值都不动）：

```json
{"active": {"version": 2, "key": "<新 hex>"},
 "retired": [{"version": 1, "key": "<原 active 的 hex>"}]}
```

然后重启应用（`docker restart <container>` 或等价方式）。启动后：新 HMAC 用 active（v2）计算；存量凭据/会话哈希（`hmacv1$…` / 旧 sid_hash）按内嵌版本选 **retired 键校验**。

> **注意（重启即失效的一次性令牌）**：K5 一次性令牌（邀请、口令重置、bootstrap）**只以 active 键校验、不消费 retired 键**——轮换重启的瞬间，所有未消费的一次性令牌立即失效，需要重新发起（重新邀请/重置）。K5 本身短时效（30 分钟 / bootstrap 24 小时）且单次使用（identity §6.1「天然轮换」），不参与 rehash-on-use 迁移。安排轮换窗口时避开有进行中邀请/重置令牌的时段即可。

**步骤 3 —— 验证 rehash-on-use**（identity §6.2 步骤 2「对用户透明」的实证）：

1. 取一条**轮换前**签发的 `ngt_` token 发请求：

   ```sh
   curl -s -o /dev/null -w '%{http_code}\n' \
     -H "Authorization: Bearer ngt_<轮换前的 token>" \
     https://<host>/api/v1/me
   # 预期 200 —— 命中 retired 键校验成功
   ```

2. 查库确认该凭据哈希已**立即迁移**到 active 版本（rehash-on-use 回写）：

   ```sh
   sqlite3 $DATA/db/notegit.sqlite \
     "SELECT token_hash FROM credentials WHERE id = <该凭据 id>;"
   # 预期前缀 hmacv2$（= 新 active 版本；步骤 3.1 之后即完成，无需等待）
   ```

3. 浏览器旧会话同样验证：用轮换前登录的会话刷新页面 → 正常可用（`sessions.sid_hash` 已以 active 键重算）。

语义同构的自动化测试：`node --test server/test/pepper-rotation.test.ts`（token/会话 rehash-on-use、宽限期、retired 移除后未迁移载体失效、四状态映射保持）。

**步骤 4 —— 宽限期后移除 retired**（identity §6.2 步骤 3，默认宽限期 30 天）：编辑文件删除 `retired` 条目 → 重启。**从未在宽限期内使用而未迁移的 token 与会话全部失效**——员工需重新登录、重签发访问凭据（提前公告）。已被使用过的载体不受影响（步骤 3 已把它们迁移到 active）。

> 移除条目前建议先用 DB 核对迁移进度：
> `sqlite3 $DATA/db/notegit.sqlite "SELECT COUNT(*) FROM credentials WHERE token_hash LIKE 'hmacv1$%';"`（0 = 全部迁移，可安全移除；非 0 = 尚有未迁移凭据，移除后它们失效）。

## 4. 备份联动（backup 契约 K 清单引用）

- 密钥清单唯一来源：[identity §6.1](contracts/identity-credentials.md)（K1 pepper、K2 Argon2 盐〔随库〕、K3 TLS、K4 DB 口令、K5 一次性令牌〔哈希随库〕、K6 预留）。
- **两件分置**（[backup-recovery §6](contracts/backup-recovery.md)）：数据备份件（DB + Git + config）与**密钥备份件**（`/data/keys/` + K3/K4 位置的记录）独立存放、独立访问控制；密钥件 0600，建议静态加密。单件合一 = 一次泄露全失守。
- **迁移窗口强制项**（identity §6.2 步骤 4）：pepper 轮换进行中（文件含 retired 条目）产生的备份**必须包含完整 pepper 文件**，否则恢复后旧哈希无法校验。恢复演练的对应核对点为 R12（backup §8）。
- 恢复时缺密钥件：网页可重登改密，但全部 token/会话无法校验（Agent 通道全断）——由恢复清单核对暴露（backup §6）。

## 5. bootstrap token 与恢复流程（identity §7）

### 5.1 首次初始化

1. 空库首次启动：应用写一次性 bootstrap token 到 `$DATA/config/admin-bootstrap.token`（0600，TTL 24 小时，库内只存 HMAC 哈希）。
2. 管理员在主机读取（例：`docker exec <container> cat /data/config/admin-bootstrap.token`）——**不打印到容器日志**（凭据不进日志，D-IC-07）。
3. 提交 `POST /api/v1/auth/bootstrap`（token + 自定用户名/口令）→ 创建实例管理员；**token 单次失效、文件由应用删除**；此后该端点永久 410（E-RES-006），重放无效。
4. 未用过而过期：重启应用自动重生成（不会锁死）。

### 5.2 口令恢复（分三级，identity §7.2）

| 情形 | 流程 |
|---|---|
| 普通员工忘记口令 | 实例管理员在 `/admin` 员工管理点「重置口令」→ 生成 30 分钟单次 K5 令牌（**明文仅展示一次**，经企业内渠道交付）→ 员工提交 `POST /api/v1/auth/password-reset` 设新口令（该账号全部 Web 会话随即失效；token 不自动撤销） |
| 管理员忘记口令、仍有其他在岗管理员 | 任一管理员按上述普通员工流程为其重置 |
| 管理员**全员**锁死（最后防线） | 主机侧恢复：`docker exec <container> notegit admin recover` 生成一次性恢复令牌（产生 `admin.host_recovery` 审计行） |

### 5.3 与实现的差距（如实）

- **K5 一次性令牌不消费 retired 键**（§3 注意框）：轮换重启即作废全部未消费的邀请/重置/bootstrap 令牌，须重新发起；token 与 Web 会话则经 rehash-on-use 平滑迁移。
- `notegit admin recover` 命令名已定稿（identity §7.2 遗留项，S2-T3 记录），**命令本体尚未实现**——随 S8 容器发行/运维任务落地；在此之前，主机侧等价兜底是直接访问数据卷（能访问部署主机/数据卷者本已等同完全控制实例，identity §7.2 合理性边界）。
- pepper 轮换/retired 移除目前是**主机侧文件操作**：契约审计 kind `keys.pepper_rotate` / `keys.pepper_prune` 已注册（storage-model §5），但应用侧无 pepper 版本追踪，**当前不产生审计行**——挂账至运维工具化（S8）。
- 宽限期 30 天是操作纪律（identity §6.2 建议值），**当前实现无可配置项**；retired 条目的移除由管理员手动执行（§3 步骤 4）。
