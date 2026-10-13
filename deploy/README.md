# Notegit 容器部署（S8-T1 发行包）

单容器部署（D10：Node 24 + TypeScript + Fastify v5 + node:sqlite + git http-backend
CGI 包装；架构 §10）。本目录交付镜像定义、最小编排示例、首次初始化演练脚本与本
部署文档；备份/恢复工具随 S8-T4/T5 落地，指标扩展随 S8-T2。

## 快速开始

```bash
# 构建（上下文 = 仓库根；构建期断言：git-http-backend 存在性 + 生产形态自检）
docker build -f deploy/Dockerfile -t notegit:0.1.0 .

# 运行（单实例 + 命名持久卷；对外建议保持回环 + 反向代理，见「HTTPS 接入」）
docker run -d --name notegit -p 127.0.0.1:3000:3000 -v notegit-data:/data notegit:0.1.0

# 或使用最小编排示例
docker compose -f deploy/docker-compose.yml up -d --build
```

- 环境变量：`PORT`（默认 3000）、`HOST`（默认 0.0.0.0）；数据目录固定 `/data`
  （`NOTEGIT_DATA_DIR` 仅为测试覆盖保留）。
- 镜像内以非 root 用户（`notegit`，uid/gid 10001）运行；`HEALTHCHECK` 探测
  `/healthz`（liveness；磁盘水位指标随 S8-T2）。
- **Node 版本 pin**：默认 `node:24-alpine`（D10 基线）；生产部署建议
  `--build-arg NODE_IMAGE=node:<24.x.y>-alpine` 钉住补丁版——node:sqlite 处于
  RC，行为漂移靠锁定具体 Node 版本规避（roadmap 风险表）。

## 最低规格

依据 [selection §5](../docs/s1/selection.md)（Linux + Docker 单容器；假设 ≤100
员工、≤200 库、日推送 ≤10⁴，待容量验证复核）：

| 项 | 最低规格 | 推荐规格 |
|---|---|---|
| CPU | 1 vCPU | 2 vCPU |
| 内存 | **768 MB**（S8-T8 修正，见下） | 1 GB |
| 磁盘（数据卷） | 2 GB | 20 GB |
| 网络 | 单端口 HTTPS（反代终结，见下） | 同左 |

**内存地板修正（S8-T8 收口，实测优先于规划值——S6 sprint D6）**：selection §5
原 512MB 地板按 S1 spike 期 RSS 114.7MB 推导；S7-T8/S8-T8 实测**全功能服务进程
RSS 基线 232–240MB**（Web/API/Git/审计/校验/搜索在线），叠加每请求 git 子进程
链预算（每链 ~17MB × 默认并发上限 8 = 136MB）与系统/页缓存/备份瞬态
（VACUUM INTO、复制件 fsck）≥100–150MB ⇒ 512MB 无余量、**修正为 768MB**。
量化与实测记录：[S8-T8 notes](../.agents/notes/2026-10-14-S8-T8-capacity.md)
（闸门实负载：并发链被钳制时子进程 RSS 峰值线性减半、墙钟 +3.6%、全部成功）。
512MB 容器不承诺：将 `git.maxConcurrentChildren` 降至 4 可勉强运行但备份窗口紧。
selection §5 / roadmap Q2 的正式修订已由
[ADR D14](../docs/superpowers/roadmaps/2026-10-12-notegit-v01.md) 执行（2026-10-14：两处均已按 768MB 修正）。

## 容量与并发限制（S8-T8 收口）

限制键的覆盖链（越右越权威，全部**热生效**——改行后下一次请求即生效，无需重启）：

```text
契约默认值（validation-defaults.json / git 域默认）
  ← 环境变量（NOTEGIT_<大写下划线键名>，值为 JSON 字面量；部署级静态覆盖）
  ← app_settings 行（管理员运行时配置；同键胜环境——SQL/ops 写行即可，
     管理端点随 api.md 契约补录，见 capacity-face-amendments G5）
```

**校验限制**（10 键，语义与默认值见
[validation-defaults.json](../docs/contracts/validation-defaults.json) 与
[validation §5.1](../docs/contracts/validation.md)）：文档/附件大小、附件类型
清单、单次 push 大小、库容量、豁免清单、校验超时/并发/内存。非法值 fail-closed
（对应入口拒绝并指名配置键，不静默回退默认值）。

**git 子进程并发**：`git.maxConcurrentChildren`（默认 8；S8-T8 新键，契约入册
走 [建议稿 G2](../docs/s1/capacity-face-amendments.md)）——每请求 git 子进程
链（`git http-backend` 一条链）的并发上限，超出 **FIFO 排队**（不拒绝：git
客户端对等待透明；TCP 背压停住客户端发送，排队上限由客户端超时与反代约束）。
容量修正建议：`NOTEGIT_GIT_MAX_CONCURRENT_CHILDREN`（JSON 字面量，如 `4`）或
app_settings 行 `git.maxConcurrentChildren`。

**初始导入指引**（S3-T8 移交项）：单库全量初始导入 ≈150–250MiB（压缩后）会超
50MiB 默认 push 上限——管理员临时调高、完成后回落（热生效）：

```sql
-- 临时调高（app_settings 行；等价环境变量 NOTEGIT_VALIDATION_LIMITS_MAX_PUSH_BYTES）
INSERT INTO app_settings (key, value, updated_at) VALUES
  ('validation.limits.maxPushBytes', '536870912', '<ISO 时间>');  -- 512MiB 示例
-- 导入完成后 DELETE FROM app_settings WHERE key = 'validation.limits.maxPushBytes';
```

## 数据布局（/data 持久卷）

唯一持久数据目录（[backup §2](../docs/contracts/backup-recovery.md) 四分域）：

```text
/data
├── git/<vault-id>.git   # 每库独立 bare 仓库（路径经数据库稳定 ID 映射）
├── db/                  # node:sqlite 数据库（WAL）
├── config/              # 应用配置；初始化期含一次性 admin-bootstrap.token（用后即删）
└── keys/                # token-pepper.key 等（0600；目录 0700；与数据备份分置）
```

两侧（Git 与 db）缺一即失能；备份/恢复流程与一致性要求见 backup-recovery 契约
（恢复工具随 S8-T5 交付）。备份执行者的主机侧访问路径：命名卷经
`docker volume inspect notegit-data` 定位挂载点，或改用 bind mount 直达目录。

### 一致备份（S8-T4 工具随镜像分发）

备份触发 = 脚本模式（选型与被否备选见
[docs/s1/backup-face-amendments.md](../docs/s1/backup-face-amendments.md) B1）：
CLI 随镜像分发，在容器内执行（`/data` 直达；产物建议落**独立卷/介质**）。

```sh
# 产物目录须对容器用户（notegit）可写——命名卷初建属 root，首次挂载后交付：
#   docker exec -u root notegit chown notegit:notegit /backup
# 管理令牌：--token-file 或 NOTEGIT_ADMIN_TOKEN 环境变量（不进 argv/日志）
docker exec notegit node src/backup/cli.ts backup \
  --data-dir /data --out /backup \
  --url http://127.0.0.1:3000 \
  --token-file /run/secrets/backup-admin.token \
  --keys-out /backup-keys        # 可选：密钥件直写另一介质根（backup §6 分置）
```

产物为**分置两件**：`<时间戳>-data/`（manifest.json + db 快照 + git 复制 + config）
与 `<时间戳>-keys/`（pepper 全文件含 retired 条目；文件 0600、目录 0700）。
流程自动覆盖 backup-recovery §4 步骤 1–7：维护端点开/关闸（闸门属应用进程——
脚本不自设闸门）、排空（默认 300s 有界超时，超时中止并保持维护模式）、
`VACUUM INTO`、git 复制 + 抽样 fsck（失败中止）、manifest 全字段、
backup.completed 审计行（完成后 `GET /api/v1/admin/metrics` 的
`backup.last_completed_at` 更新）。

**离线验证**（§4 步骤 8；不起服务，可在宿主对拷出的产物执行）：

```sh
docker cp notegit:/backup ./backup-set
node server/src/backup/cli.ts verify --data-item ./backup-set/<时间戳>-data [--fsck]
```

运维义务（backup §6）：**K3 TLS 私钥位置、K4 DB 口令保管处**的记录须与密钥件
同置保存（工具不代管部署层机密）；密钥件建议移至独立介质/访问控制域静态加密
存放。演练证据（真实容器 16 步全绿）：
[.agents/notes/2026-10-13-S8-T4-backup-drill.txt](../.agents/notes/2026-10-13-S8-T4-backup-drill.txt)。

## HTTPS 接入（选型记录）

**定稿：反向代理终结 TLS，容器保持 HTTP。**（K3 交付形态——identity §6.1 K3：
TLS 证书/私钥由部署方提供与管控，属实例外流程；selection §5 网络行「反代终结或
容器内 TLS，S2 决定」的空位在此落定。）

- 依据：企业侧通常已有 PKI/ACME 与证书轮换流程，反代终结让证书生命周期留在
  运维边界内（K3「常规证书运维，实例外流程」）；应用不持有私钥，镜像与容器
  面不引入证书装载/轮换逻辑；单端口 HTTPS 目标由反代对外呈现，满足架构 §10。
- 被否决备选：**容器内 TLS**（Fastify @fastify/https）——证书与私钥须进容器
  （volume 挂载 + 属主/权限面扩大），轮换需重启或热加载逻辑，收益仅省一跳
  反代；如未来单机直连场景确需，再按 backup §3 模型评审补记。
- 部署形态：容器端口只发布到宿主回环（compose 示例即如此），反代与 Notegit
  同机时上游用 `127.0.0.1:3000`；跨机时将发布地址改为内网接口并保证链路可信。
- 最小反代示例（nginx，TLS 证书由部署方提供）：

```nginx
server {
  listen 443 ssl;
  server_name notegit.example.internal;
  ssl_certificate     /etc/nginx/tls/fullchain.pem;   # 部署方提供（K3）
  ssl_certificate_key /etc/nginx/tls/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    # Git Smart HTTP 大包双向流式：关闭请求体缓冲、放宽超时
    client_max_body_size 0;
    proxy_request_buffering off;
    proxy_read_timeout 300s;
  }
}
```

## 首次初始化

1. 起容器后等健康检查通过（`docker inspect --format '{{.State.Health.Status}}' notegit` = `healthy`）。
2. 读取一次性管理员初始化令牌（identity §7.1；初始化期落盘于
   `/data/config/admin-bootstrap.token`，**单次有效、用后即删**）：

   ```bash
   docker exec notegit cat /data/config/admin-bootstrap.token
   ```

3. 初始化管理员（api.md §3；`bootstrap` 端点一次性，之后永久 410）：

   ```bash
   curl -fsS -X POST http://127.0.0.1:3000/api/v1/auth/bootstrap \
     -H 'content-type: application/json' \
     -d '{"bootstrap_token":"<上一步令牌>","username":"root","display_name":"Root Admin","password":"<强口令>"}'
   ```

4. 之后走管理页（`/admin`）或 API：邀请员工 → 员工设口令登录 → 建库 → 创建
   Git 凭据（`ngt_` token，Git HTTP Basic 口令侧）。

以上全链的自动化验证：**首次初始化演练脚本**（断言化、可复跑）：

```bash
node deploy/scripts/init-drill.mjs            # 全新容器→健康→bootstrap→邀请→
                                              # 建库→push/网页双通道→重启→数据仍在
node deploy/scripts/init-drill.mjs --keep     # 保留容器与卷供检查
```

退出码 0 = 全链绿；输出即留档材料（DOD-01 场景的演练证据形态）。

## 生产运行形态（TS 执行策略，S2-T1 挂账销账）

**定稿：运行时 type-stripping——`node src/main.ts` 直跑**（镜像 CMD 即此）。
Node 24 原生擦除 TS 类型（本仓代码限定可擦除语法，tsconfig 钉住），镜像内
`npm ci --omit=dev`：不装 typescript、无 tsc 构建步骤、无 tsx 运行时依赖；类型
检查由 `tsc --noEmit` 串在 `npm test`（gates product）承担，运行形态与测试形态
同一代码路径。被否决备选与依据见
[architecture-notes §10](../docs/dev/architecture-notes.md)；镜像内另有构建期
自检（以生产依赖树真实加载校验器与契约文件，见 Dockerfile）。

## 升级与回退

换镜像 tag → 重新 `docker run`/`up -d`：应用启动时自动执行 schema 前向迁移
（每迁移单事务、幂等可重入）。升级前强制备份与回退演练的完整流程随 S8-T7 交付；
在此之前升级操作参考 [backup §9](../docs/contracts/backup-recovery.md) 框架。

## 已知边界

- 第一版无高可用承诺（架构 §10）；单实例单应用进程（process-model §1），进程
  生命周期由容器 restart policy 负责。
- 并发 clone/push 的子进程上限已量化落地（S8-T8：`git.maxConcurrentChildren`
  默认 8、FIFO 排队，见「容量与并发限制」节）；web 侧发布/搜索的短命令 git
  子进程不在此键范围。Q7 唯一值修订建议（maxValidationMemoryMb 256→512）待
  master 契约批（建议稿 G1）。
- 磁盘水位、校验耗时、失败推送等指标端点随 S8-T2（R14）。
