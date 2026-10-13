# Notegit 容器部署（S8-T1 发行包）

单容器部署（D10：Node 24 + TypeScript + Fastify v5 + node:sqlite + git http-backend
CGI 包装；架构 §10）。本目录交付镜像定义、最小编排示例、首次初始化演练脚本与本
部署文档；备份/恢复工具随 S8-T4/T5 落地，指标扩展随 S8-T2。

## 快速开始

```bash
# 构建（上下文 = 仓库根；构建期断言：git-http-backend 存在性 + 生产形态自检）
docker build -f deploy/Dockerfile -t notegit:0.0.0 .

# 运行（单实例 + 命名持久卷；对外建议保持回环 + 反向代理，见「HTTPS 接入」）
docker run -d --name notegit -p 127.0.0.1:3000:3000 -v notegit-data:/data notegit:0.0.0

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
| 内存 | 512 MB | 1 GB |
| 磁盘（数据卷） | 2 GB | 20 GB |
| 网络 | 单端口 HTTPS（反代终结，见下） | 同左 |

**S7-T8 负载数据修正（sprint D6，实测优先于规划值）**：selection §5 的内存行按
S1 spike 期 RSS 114.7MB 推导；S7-T8 实测**当前全功能服务进程 RSS 基线 232MB**
（Web/API/Git/审计/校验在线，负载增量仅 ~17MB），512MB 地板对「本体 232MB +
数并发 clone 子进程链（每链 ~17MB）」余量已明显收窄。**512MB 地板复核收口在
S8-T8**（容量/并发限制量化任务，DOD-13）——在此之前生产部署按 1GB 档供给。

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
（工具随 S8-T4/T5 交付）。备份执行者的主机侧访问路径：命名卷经
`docker volume inspect notegit-data` 定位挂载点，或改用 bind mount 直达目录。

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
- 并发 clone/push 的子进程上限量化与可配置限制随 S8-T8（Q7 终值）。
- 磁盘水位、校验耗时、失败推送等指标端点随 S8-T2（R14）。
