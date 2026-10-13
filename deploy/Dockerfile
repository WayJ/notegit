# Notegit 服务端镜像（S8-T1 容器发行包）。
# 技术栈基线 D10：Node 24 + TypeScript + Fastify v5 + node:sqlite + git http-backend
# CGI 包装，单容器单应用进程（docs/dev/process-model.md §1）。
#
# 构建上下文 = 仓库根：
#   docker build -f deploy/Dockerfile -t notegit:0.0.0 .
# 生产部署建议用 --build-arg NODE_IMAGE=node:<24.x.y>-alpine 钉住补丁版
# （roadmap 风险表：node:sqlite RC 行为漂移靠锁定 Node 具体版本规避）。

ARG NODE_IMAGE=node:24-alpine
FROM ${NODE_IMAGE}

# 应用树固定 /app（githttp hook shim 以绝对路径指向 server/src/*.ts——路径漂移
# 会另装旧 shim，保持稳定省一面核对）；运行时 WORKDIR=/app/server（见下）。
WORKDIR /app

# ── git 与 git-daemon（N3 防回归锚点，勿拆）─────────────────────────────────
# git-http-backend 归属 git-daemon 包而非 git 包（Alpine 容器实测 +
# pkgs.alpinelinux.org v3.21/v3.22 双验证，selection §5）。镜像演进/包重排时若
# 只装 git 会静默丢失该二进制，Git clone/push 整体失效——git-daemon 不得从下行
# 拆出。
RUN apk add --no-cache git git-daemon

# 构建期存在性断言（breakdown S8-T1 完成标准）：git-http-backend 必须在位且
# 可执行——缺失即构建失败，而非运行期首个 Git 请求才暴露。
RUN test -x "$(git --exec-path)/git-http-backend"

# ── 应用与生产依赖 ──
# TS 生产执行策略（S2-T1 挂账销账，docs/dev/architecture-notes.md §10）：
# 运行时 type-stripping——Node 24 原生直跑 server/src/main.ts，镜像内不装
# typescript、无 tsc 构建步骤、无 tsx 依赖；类型检查由 tsc --noEmit 串在
# npm test（gates product）承担。
COPY package.json package-lock.json tsconfig.base.json ./
COPY server/ server/
COPY packages/ packages/
COPY cli/ cli/
# docs/contracts/ 只读；其中 rules-version.json / validation-defaults.json 是
# 校验包运行时读取的契约文件（architecture-notes §9.1「部署期打包」定稿 =
# 随镜像分发只读副本，路径布局与仓库一致——packages/validation 相对定位）。
COPY docs/contracts/rules-version.json docs/contracts/validation-defaults.json docs/contracts/
RUN npm ci --no-audit --no-fund --omit=dev

# ── 构建期自检：生产运行形态真实可载 ──
# 以镜像内生产形态（node + type-stripping + --omit=dev 依赖树）加载校验器并
# 读取两份运行时契约文件——依赖裁剪过度/契约文件缺位/平台二进制缺失在此即
# 构建失败，不带病出镜像。
RUN node --input-type=module -e "\
  const m = await import('./packages/validation/src/index.ts');\
  if (!m.rulesVersion() || !m.defaultConfig()) process.exit(1);\
  console.log('selfcheck rules-version', m.rulesVersion());"

# ── 非 root 运行用户 + /data 持久卷布局（backup §2 四分域）──
# /data 在镜像内预建并归属 notegit：docker -v 命名卷首次挂载时以镜像内属主
# 初始化卷内容（目录结构与权限随卷落盘）。keys/ 0700——token-pepper.key 由
# 应用以 0600 创建（identity §6.1），目录侧再加一道。
RUN addgroup -S -g 10001 notegit \
  && adduser -S -G notegit -u 10001 -H -s /sbin/nologin notegit \
  && mkdir -p /data/git /data/db /data/config /data/keys \
  && chmod 700 /data/keys \
  && chown -R notegit:notegit /data
USER notegit

VOLUME ["/data"]

ENV HOST=0.0.0.0 \
    PORT=3000

WORKDIR /app/server
EXPOSE 3000

# /healthz（liveness；架构 §10 运维最低清单）。磁盘水位指标随 S8-T2 扩展。
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-3000}/healthz" || exit 1

CMD ["node", "src/main.ts"]
