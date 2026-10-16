# Epic E9 — 部署就绪与基线修正（Deployment Readiness）

立项：2026-10-16。来源：企业试部署环境（独立主机，nginx 反代 + 容器路径）首轮运行
报告（2026-10-16 用户转交）——四项发现：① product gate 在该环境红（
receive-audit.test.ts 超时，npm test 12 分钟不收敛）；② buildApp 未配置 trustProxy，
架构 §10 定稿的「反代终结 TLS」形态下 `req.protocol` 恒为 http，浏览器 Origin 为
https → 全站写操作将被 CSRF 判异源 403（潜伏，纯 HTTP 下不可见）；③ 纯 HTTP 试用
形态（cookie Secure 由环境裁决）的改动留在服务器工作区未入版；④ nginx 反代片段在
系统层未入版。本 epic 收敛仓库侧可落地项，并给出部署环境的接手口径。

## Rationale

- ①经干净基线判定（S25-T1）：main @ bb975b9 + Node v24.21.0（engines 达规）单跑
  receive-audit **18/18 pass、19.4s 收敛**（含真实 git push E2E 与中断注入）；该
  环境实测 Node v22.22.0（违反 engines `>=24 <25`，node:sqlite 行为面完全不同）且
  克隆陈旧（其报 1111 例 vs 基线 1602 例）——**环境问题，非产品缺陷**。接手第一步
  = 核对运行时版本与克隆新鲜度，该口径须落 deploy/README 防复发。
- ②是真实潜伏缺陷：csrf.ts 判定用 `req.protocol`（csrf.ts:45），而全仓库零处
  trustProxy/X-Forwarded-Proto 处理——代码落后于架构 §10 已定稿的部署形态。
- ③④同属「环境配置不入版」的漂移：配置靠记忆重建，改动留在工作区必生分叉。

## Decisions (ADR)

| id | decision | rationale |
|---|---|---|
| D52 | 基线判定一律以「干净基线 + engines 达规运行时」为准——部署环境故障先核对 Node 版本（engines 强制）与克隆新鲜度（测试总数对表），环境性问题不构成产品缺陷、不以改代码响应 | 证据纪律：门禁红先定位是代码红还是环境红；engines 存在即契约 |
| D53 | trustProxy = **显式白名单**：`NOTEGIT_TRUST_PROXY` 逗号分隔 IP/CIDR 列表（如 `127.0.0.1` 或 `10.0.0.0/8,172.20.0.5`），经 buildApp deps 显式传入 Fastify；未设置 = 不信任任何代理头（现行为零变化）；**禁宽松 `true`** | 信任边界显式化——信任了代理头即信任 X-Forwarded-Proto/For 参与 protocol/ip 判定，白名单必须由部署者显式声明 |
| D54 | 会话 cookie Secure 属性由 `NOTEGIT_COOKIE_SECURE` 裁决：默认开（未设置即开）；**仅精确 `'0'` 关闭**；=0 形态限纯 HTTP 本地/内网试用，**禁生产**（同链路可克隆会话、口令明文——identity/api.md 已记录的安全代价）；cookie 属性串单源化，四处发放点全走一处 | 收编服务器侧未入版改动为官方实现；默认行为零变化；单源防四处属性漂移 |
| D55 | 环境配置一律入版：nginx 反代片段模板化 `deploy/nginx/`；环境变量口径（Node 24-only、TRUST_PROXY、COOKIE_SECURE）落 deploy/README——环境重建不再靠记忆 | 附项 ④ 的制度化；漂移治理 |

## Sprint Breakdown

| sprint | scope | state |
|---|---|---|
| S25 | T1 基线诊断判定（master）· T2 trustProxy 支持+CSRF 行为测试 · T3 cookie Secure 开关+属性锁定测试 · T4 nginx 模板 + deploy/README 口径 | done（2026-10-17 验收 pass——[acceptance](../acceptances/2026-10-17-S25-acceptance.md)；E9 关闭：基线判定在案、反代 TLS 写路径修复、部署物料入版，1610/1610） |

## Definition of Done

- [x] **DOD-E9-01 基线判定有据、环境口径落档** — receive-audit 于达规基线绿有实证
      记录；deploy/README 载明 Node 24-only（engines 强制、EBADENGINE 不得忽略）与
      接手核对步骤（版本 → 克隆新鲜度 → 再跑门禁）——[acceptance](../acceptances/2026-10-17-S25-acceptance.md)
- [x] **DOD-E9-02 反代 TLS 形态修复** — `NOTEGIT_TRUST_PROXY` 显式配置下 CSRF 同源
      判定经 X-Forwarded-Proto 正确（放行/拒绝两侧行为测试锁定）；未配置时代理头
      不参与判定（现行为锁定）；四 gates 只增不减（1610/1610）——[acceptance](../acceptances/2026-10-17-S25-acceptance.md)
- [x] **DOD-E9-03 环境漂移清偿** — `NOTEGIT_COOKIE_SECURE` 开关默认行为锁定（两种
      形态测试）；nginx 反代模板入版；环境变量口径入 deploy/README——[acceptance](../acceptances/2026-10-17-S25-acceptance.md)
