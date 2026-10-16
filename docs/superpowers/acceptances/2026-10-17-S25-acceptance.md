# S25 验收记录 — 部署就绪与基线修正（E9）

- sprint: S25 · epic: [E9 部署就绪与基线修正](../roadmaps/2026-10-16-notegit-e9-deploy-readiness.md)
- 日期：2026-10-17（物化于 2026-10-16 深夜，跨零点）· 验收人：master（WayJ）
- 执行形态：master 直做 ×4（安全敏感小改面 + 深夜自主窗口，S20/S24-T2 先例；
  用户授权「直接处理、修复完提交推送」2026-10-16）

## Evidence

- **T1 基线诊断判定**（部署报告阻塞项）：receive-audit.test.ts 于干净基线
  （main @ bb975b9 + Node v24.21.0，engines 达规）单跑 **18/18 pass、19.4s 收敛**
  （含真实 git push E2E 与 receive-pack 中断注入）。部署环境实测 Node v22.22.0
  （**违反 engines `>=24 <25`**）且克隆陈旧（其报 1111 例 vs 基线 1602 例）——
  **环境性红，非产品缺陷**；零代码改动响应，判定口径落 deploy/README（E9 D52）。
- **T2 trustProxy**（部署报告附项 1）：`AppDeps.trustProxy` 透传 Fastify
  （app.ts 唯一组装点）；main.ts 解析 `NOTEGIT_TRUST_PROXY`（逗号分隔 IP/CIDR，
  未设置 = 不信任，禁宽松 true——E9 D53）。CSRF 同源判定（csrf.ts:45
  `req.protocol`）随之在可信代理链上取 `X-Forwarded-Proto`——TLS 终结反代
  （架构 §10 定稿形态）下不再全站写 403。探针旁证：可信地址 127.0.0.1 →
  `protocol:https`；不可信地址 10.9.9.9 → 仍按连接协议（白名单边界生效）。
- **T3 cookie Secure 开关**（附项 3）：会话 cookie 属性串单源化 subject.ts
  （`sessionSetCookie`/`sessionClearCookie`；routes.ts 发放/清除 ×3 +
  lifecycle.ts rejectAuth 清除——四处发放点全收敛，防属性漂移）；
  `NOTEGIT_COOKIE_SECURE` 默认开、仅精确 `'0'` 关闭（纯 HTTP 试用形态，
  禁生产——E9 D54）。收编服务器侧未入版改动为官方实现。
- **T4 部署物料入版**（附项 2/4）：`deploy/nginx/notegit.conf` 站点模板
  （80→443 重定向 + X-Forwarded-* 头 + Git 大包流式 + TRUST_PROXY 配套注记）；
  deploy/README：两个部署面环境变量与安全边界、**engines 强制 >=24 <25
  （Node 22/23 不支持、EBADENGINE 不得忽略）**、门禁红接手核对顺序
  （①运行时版本 → ②克隆新鲜度 → ③达规重跑）。
- **行为测试**：server/test/s25-reverse-proxy.test.ts 8 例——trustProxy 三态
  矩阵（默认回归：XFP 不参与判定 403；显式配置 + XFP=https + 同源 → 204；
  异源仍 403；XFP=http 明文反代 → 204）+ cookie 两形态×两路径（默认
  Secure/HttpOnly/SameSite 与 401 清除 Max-Age=0；=0 去 Secure 保
  HttpOnly/SameSite）。
- **四 gates**（sprint/S25 @ 7907147 工作树实跑）：contracts 82/82 ·
  route-b 7/7 · ddl 14/14 · product **1610/1610**（三套件 1135+106+369，
  0 失败）。基线 1602（S24）→ S25 +8（s25-reverse-proxy），**只增不减**。
- **探针组**（S3）：S24 归档探针（probe-s24.mjs）于 S25 代码态 scratch :3211
  （dataDir /tmp/notegit-bench24 复用）复跑——P1 anon 302 /login、P2 anon 库页
  302、P3 anon API 401、P4 越权 404 与不存在 404 逐字节同体（D-IC-06）、
  P5 favicon 200、P6 ETag+no-cache、P7 缓存热窗 anon 401/无授权 404——
  **7/7 PASS，安全语义零漂移**。

## Verdict

**pass** — 部署报告四项发现全部闭环：阻塞项判定为环境性红且口径落档（D52）；
trustProxy 潜伏缺陷修复并行为锁定（D53）；cookie Secure 开关官方实现收编（D54）；
部署物料与环境口径入版（D55）。四 gates 只增不减、探针零漂移。**E9 全部 3 条
DoD 结清、epic 关闭。**

## Scenario Results

| id | scenario | expected | actual | pass |
|---|---|---|---|---|
| S1 | 反代同源 | 显式配置 + XFP=https + 同源 Origin → 写放行；异源仍 403 | 测试锁定双向（204/403）；探针旁证白名单边界（可信取 XFP、不可信忽略） | yes |
| S2 | 默认回归 | 未配置 trustProxy 时 XFP 不参与判定；默认 cookie 含 Secure | 两例现行为锁定测试绿（默认 403 拒 XFP；默认 Secure 在位） | yes |
| S3 | 回归 | 四 gates 只增不减；探针组零漂移 | product 1602→1610（+8）；探针 7/7（含 D-IC-06 与缓存热窗 P7） | yes |

## Gates

contracts 82/82 · spike 7/7 · storage 14/14 · product 1610/1610（三套件
1135+106+369，0 失败）。基线 1594（S22）→ S24 +8 → S25 +8，**只增不减**。

## DoD Checklist

- [x] **DOD-E9-01 基线判定有据、环境口径落档** — T1 判定在案（达规基线 18/18
      @19.4s）；deploy/README 载明 Node 24-only 与接手核对顺序（D52）
- [x] **DOD-E9-02 反代 TLS 形态修复** — NOTEGIT_TRUST_PROXY 显式白名单 + XFP
      同源判定正确（放行/拒绝两侧行为测试）；未配置时代理头不参与判定（现行为
      锁定）；api.md §1 契约句随码；四 gates 只增不减（D53）
- [x] **DOD-E9-03 环境漂移清偿** — NOTEGIT_COOKIE_SECURE 默认行为锁定（两形态
      ×两路径测试）；nginx 模板入版；环境变量口径入 deploy/README（D54/D55）

## Obstacles (verbatim)

- 2026-10-17 — inject 默认 `Host: localhost:80` 与 https 目标归一化交互：
  `:80` 对 https 非默认端口不剥离，`https://localhost:80 ≠ https://localhost`
  伪造异源假象、掩盖 trustProxy 生效——测试夹具显式无端口 host 后即过；最小
  探针（可信/不可信地址双例）旁证 Fastify 行为正确。脚手架问题，产品零缺陷。
- 2026-10-17 — 无效 sid 的 logout 先被 CSRF 403 拦截（携带会话 Cookie 的写
  请求先过闸门），到不了 401 清 Cookie 路径——夹具补同源 Origin 后锁定
  rejectAuth 清除行为。属闸门正确行为，非缺陷。

## 部署环境接手清单（交付部署侧）

1. **弃用服务器工作区 6 文件未提交改动**（NOTEGIT_COOKIE_SECURE 已由本 sprint
   官方实现收编，语义一致：默认开、仅 '0' 关）——`git checkout -- .` 后
   `git pull` 至 main 最新（其克隆陈旧：1111 例 vs 基线 1610）。
2. **运行时达规**：Node ≥24 <25（`node --version` 核对；容器路径用
   `node:24-alpine`，部署报告所述 dockerhub 不可达属网络问题，恢复后跑
   `deploy/scripts/init-drill.mjs` 验证容器全链——本轮未验，见 Residuals）。
3. **TLS 反代形态**：按 `deploy/nginx/notegit.conf` 模板配置，应用侧设
   `NOTEGIT_TRUST_PROXY=127.0.0.1`（同机）；纯 HTTP 临时试用才设
   `NOTEGIT_COOKIE_SECURE=0`（禁生产）。
4. **重跑四 gates 核对**：product 应为 1610/1610（三套件 1135+106+369）——
   数字对不上即克隆仍陈旧。

## Residuals（记入后续，不阻塞验收）

- R1 — 容器路径本轮未验（dockerhub 不可达，构建期断言与自检未执行）——部署
  环境网络恢复后跑 init-drill 补验；属部署侧动作。
- R2 — `NOTEGIT_TRUST_PROXY` 变更热生效性未测（现有键走 app_settings 热更链，
  本键为启动期 env）——单实例重启即生效，容器编排常态，不另立项。

## Doc-Drift Audit

| map row | matched | doc state | detail |
|---|---|---|---|
| 产品要求/权限变化 → architecture.md | 不触发（部署形态=架构 §10 已定稿反代终结 TLS，本 sprint 为代码对齐已定稿架构；env 旋钮属部署物料） | current | api.md §1（CSRF 可信反代句）与 identity §4（Secure 开关口径）两契约文档已随码更新 |
| roadmap → epic 修订 | 匹配（S25 状态 + DoD 记账 + epic 关闭） | master 收尾 | 随本验收执行 |
