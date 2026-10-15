# Acceptance record — sprint S18, 2026-10-16

验收人：master 会话。环境：sprint/S18 @ 45731ce 合并态 + 契约 D 批；demo 127.0.0.1:3210 同码。前置：T1 ∥ T2 写面隔离并行交付（api-read/vaults.ts vs api-read/{tree,docs}.ts；amendments add/add union 一次）。

## Verdict

**pass** — S1–S5 全绿；四 gates 全绿（82/82、7/7、14/14、1070+106+369——+27 只增不减）；**agent 消费全链实景跑通**（凭据签发 → Bearer → vaults → tree → docs → ETag 304）；DOD-E6-01/04/05 的 S18 份额达标。E6 保持 open（S19 凭据委托、S20 容量待做）。

## Scenario Results

| id | command | expected | actual | pass |
|---|---|---|---|---|
| S1 | agent 消费仿真（Bearer 全链） | 形状稳定/协商缓存 | 凭据 201（ngt_ token 一次性明文）→ vaults `{vaults:[{slug,name,role,default_branch,main_admin_only,doc_count}]}` → tree（`{entries:[{path,type,size}],truncated}`）→ docs（fm.title=差旅报销制度、body 73<body_raw 95 双字段）→ ETag=`"<oid>"` If-None-Match 304；**read scope 已收窄生效**（token scope=vaults:[team-handbook] → 列表无 product-notes） | yes |
| S2 | 锚定读取 | ref=OID 同一树 | code-review.md @首提交 7c6bb2b=404、@HEAD=200（后加文件锚定差异实证）；README 首提交内容=HEAD（未改）；ref=main → 400；ref=未知 hex → 404；目录路径 → 404；非 .md 415 由 21 例测试锁定（demo 无非 md 文件） | yes |
| S3 | 侧信道 | 无权库零出现 | bob：vaults 无 product-notes；tree/docs 对 product-notes 与 no-such-vault **逐字节同体**；撤权即时（测试锁定） | yes |
| S4 | 变更感知 | 如实状态 | index-status：head=ae80a99、lag_ms=374、failures=0（真实数据）；三态（健康/失败/无行全 null）测试锁定 | yes |
| S5 | 回归 | 零弱化 | 匿名 401 API 信封；§2.2 + e2e-final-regression 在全量内绿；写通道零变更 | yes |

## Gates

contracts 82/82 · spike 7/7 · storage 14/14 · product `npm ci && npm test` 1070/106/369（1043→1070 = T1 +6、T2 +21）。

## DoD Checklist（S18 份额）

- [x] **DOD-E6-01 读协议（份额）** — 四端点稳定 JSON（vaults 增量/index-status/tree/docs）；S1/S2 证据
- [x] **DOD-E6-04 契约与指南（份额）** — api.md §6 三行 + §1 E-RES-009 + §5 vaults 行落契（D 批）；agent-guide.md 三章骨架（认证/锚定引用/变更感知）
- [x] **DOD-E6-05 安全回归（份额）** — S3/S5 + 四 gates；epic 级随 S19/S20 复验
- **Q-E6-1 定案**：tree=全量+1000 截断如实标注（v1 不预设分页）

## Obstacles (verbatim)

- 2026-10-16 — T1 必要偏差：任务书（master 起草）把 GET /api/v1/vaults 写作新建裸数组端点——实际该端点已存在且被 CLI（cli/src/ls/api.ts 形状校验）与 Web 页面消费；worker 选可逆增量（保留 {vaults:[...]} 信封+仅增 doc_count）并写入建议稿待裁——master 追认（任务书前提错误，worker 处置正确；裸数组若为目标形态应走 §11 版本演进单独批次）。
- 2026-10-16 — T2 两披露追认：空库 unborn HEAD → 404 E-RES-001（D4 未及，建议稿行文承载）；frontmatter 保守行式解析（块标量/嵌套 → null 降级，与 search 派生面同哲学——不引 YAML 依赖）。
- 2026-10-16 — master 三裁（建议稿待裁项）：ref 缺省回显默认分支名（agent 需知读到哪个头）；frontmatter「解析失败→null」单句承载不逐 YAML 形态入契；E-RES-009 与 B1/B2 同批落契。
- 2026-10-16 — master 验收探针两次正则猜错页面标记（credentials 请求体字段名/history 页 OID 提取）——均为探针问题非产品缺陷；S2 改 git 直取 OID 后实证。

## Doc-Drift Audit

| map row | matched | doc state | detail |
|---|---|---|---|
| 产品要求 → architecture.md + epic ADR | 匹配（读协议=D36/D37/D38 在册；新端点经 api.md D 批落契） | current | D35–D38 在册 |
| roadmap → epic 修订 | 匹配（S18 验收记账） | master 收尾 | 随本验收执行 |
