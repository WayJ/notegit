# Acceptance record — sprint S2, 2026-10-13

验收人：master 会话。环境：sprint/S2 @ 498cb5c（独立临时 worktree /tmp/s2-acc，npm ci 后 fresh 运行）。任务定义单源：implementation-breakdown §2.1（D3）。

## Verdict

**pass** — 六场景 fresh 全绿（无替换证据、无未跑项）；S2 完成标准（epic S2 节四条）全部满足；doc_sync_map 触发行无未偿漂移（D11 修订伴随 epic ADR 同提交落位）。E1 DoD 中 DOD-02/DOD-03 的 S2 份额已具备实现与测试证据，但 DoD 条目仍按 epic 分配在 S9 统一验收——维持「不提前勾选」纪律。api.md 维护端点补录挂账随 S3 契约修订（T7 裁定记录在案）。

## Scenario Results

| id | command | expected | actual | pass |
|---|---|---|---|---|
| S1 | `node --test server/test/vaults-matrix.test.ts`（sprint/S2 worktree，npm ci 后） | 两员工×两不同成员集库矩阵断言绿 | tests 7 / pass 7 / fail 0（可见性/读写/载体一致） | yes |
| S2 | npm test 全量中的 scope 收窄用例 | 越范围/非成员/不存在统一 404；声明收窄不得实得全部 | 两用例 ✔（含「全部未命中→422 防声明漂移」） | yes |
| S3 | `node --test server/test/lifecycle.test.ts` | 4 状态×2 入口 8 用例逐一断言 + 边界 | tests 15 / pass 15 / fail 0（含下一请求零延迟、在途按起点放行） | yes |
| S4 | npm test 中成员管理/员工列表权限用例 | 普通成员 403 E-AUTHZ-001 | ✔（员工列表、重置口令、成员管理均 401/403/404 按矩阵） | yes |
| S5 | 依次运行 AGENTS.md `### gates` 四条 | 全部 exit 0 | contracts 82/82；spike 7/7；ddl_smoke 14/14；npm test 242/242——全部 exit 0 | yes |
| S6 | `git diff main..sprint/S2 -- docs/contracts/` + 提交核对 | 零变更，或变更均伴随 epic ADR | 变更=storage-model.md + ddl_smoke.test.mjs，均出自 D11 修正两提交（97ab349、b72833a），epic ADR D11 在案 | yes |

## DoD Checklist

S2 是身份/库/权限 sprint；E1 DoD 按 epic Sprint Breakdown 分配至各 sprint，S9 统一验收。S2 相关条目的现状（如实，不勾选）：

- [ ] DOD-02 身份与权限 — S2 份额已实现并有矩阵/403/404 测试证据（本记录 S1/S4）；Git 入口一致性待 S3 挂接后由 S3/S9 验证
- [ ] DOD-03 员工凭据 — S2 份额已实现（四状态×双入口 8 用例、HMAC 存储、scope 收窄、审计主体断言）；DOD-03 完整验证在 S9
- [ ] DOD-01/04–15 — 未到期：S3–S9 范围（同 S1 记录口径）

## Obstacles (verbatim)

- 2026-10-13 01:0x — T6/T7 并行合并出现迁移版本表断言互斥（HEAD [1..5] vs T7 [1,2,3,4,6]）；master 统一为集成真相 [1,2,3,4,5,6] 并修复拼接遗漏的 statements 数组闭合（`    ],`）——npm test 222/222 复验后放行。来源：本次集成，improvised。
- 2026-10-13 — D11 契约修正遗漏 gate 工具侧（ddl_smoke seed 缺 display_hint 列，11/14）；由 master 在 sprint/S2 补修（b72833a），14/14 恢复；T5 worker 首先发现并如实上报。
- 无其他阻塞；四条 gates 在验收环境一次全过。

## Doc-Drift Audit

| map row (change, owes) | matched this sprint | doc state | detail |
|---|---|---|---|
| 产品要求/知识格式/权限/发布部署架构变化 → architecture.md + epic ADR | 匹配：D11（credentials 表增列，权限数据模型层） | current | epic ADR D11 已记录（sprint/S2 @ 97ab349 与 storage-model.md 同提交）；architecture.md 未触发（列级 schema 细节低于其 altitude，§4 实体集未变） |
| roadmap 范围/依赖/验收条件变化 → epic 修订记录 | 无匹配 | n/a | S2 未变更范围/依赖/验收条件；api.md 维护端点补录为已挂账欠账（非范围变更），随 S3 修订 |
