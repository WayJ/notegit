# D29 凭据委托——验证记录（2026-10-16，master）

背景：E4 roadmap D29（2026-10-15 裁决）把「凭据委托落契」列为未来底座 epic 工作项。
E6 立项后逐项核实：**绝大部分在 S1/S3 期已实现**——E4 立项时的差距分析未核实存量，
误把「已建成」记为「待落契」。本记录修正并留验证证据。

## 语义 × 存量对照（逐项核实源码与实景）

| D29 语义 | 存量实现 | 证据 |
|---|---|---|
| 委托凭据＝员工权限子集（read/read_write × 库清单，只能收窄） | S1-T3 凭据域：`POST /api/v1/credentials {scope:{access,vaults}}`；identity §3.4 | api.md §4；credentials/service.ts |
| 三入口一致 scope 收窄 | authorize×VaultScope（web/api 共用 lifecycle.ts:212-222）；git 入口 http-backend.ts:127-128 同一 scope 面 | 源码行号 |
| 审计主体＝真实员工 | audit_events.employee_id（actor_kind=employee） | DDL 迁移 0006 |
| **审计标注凭据来源** | `credential_ref` 列（credential:<id> / session:<短哈希>，不含 token 材料）——**写侧**自 S3-T6 在位 | DDL:153；audit.ts 写面 |
| 审计读侧 credential_ref 可见 | **缺**：api.md §9 两端点契约在册、代码无路由（/api/v1/vaults/{slug}/audit 与 /api/v1/admin/audit 均 404 实证） | 本记录；S19-T1 补 |
| 成员表不因 agent 膨胀 | 凭据与 vault_members 正交（凭据行不建成员） | §4/identity §3 |

## 实景验证（demo 127.0.0.1:3210，2026-10-16）

alice 签发 read_write scoped（vaults:[team-handbook]）凭据：

1. **scoped 写通过**：POST submissions（Bearer）→ **201**（变更 docs/d29-verify.md）
2. **scope 外同形态**：同 token → product-notes（alice 有权、token 无 scope）与 no-such-vault
   提交均 **404 且逐字节同体**（D-IC-06——scope 越出与无权不可区分）
3. **read-only 拒写**：read scope token POST → **403**
4. 审计 credential_ref 读侧可见 → **待 S19-T1**（本 sprint 闭环）
5. **撤销即失效**：DELETE 凭据后同 token → **401**

验证产物（①的临时文档）已用正规删除提交清理（201）。

## 结论

- DOD-E6-02 以「已实现（S1/S3）＋验证收口」记账：S19-T1 落地 §9 读侧后第 4 项闭环。
- agent-guide.md 补「最小作用域建议」章（master 文档动作，随 S19 结算）。
