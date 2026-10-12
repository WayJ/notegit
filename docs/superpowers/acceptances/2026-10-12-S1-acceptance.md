# Acceptance record — sprint S1, 2026-10-12

验收人：master 会话（监督者）。验收环境：sprint/S1 @ 32ce835（独立临时 worktree /tmp/s1-accept，非陈旧构建）。Sprint 文档：docs/superpowers/sprints/2026-10-12-S1-plan.md。收口输入：docs/s1/closeout-report.md（T8 独立核对 + G1–G8 处置）。

## Verdict

**pass** — 六个场景全部在本环境 fresh 运行通过（无替换证据、无未跑项）；S1 范围内的完成标准（epic S1 节四条）全部满足；doc_sync_map 两条触发行无未偿漂移。E1 DoD（DOD-01–15）按 epic 自己的分配属 S2–S9 验证范围，本记录如实标注未到期（见 DoD Checklist），epic 开工规则 3 与 S1 节明文「不提前勾选最终 DoD」——此为 epic 预定义的口径，非本次验收的放宽。

## Scenario Results

| id | command | expected | actual | pass |
|---|---|---|---|---|
| S1 | `grep -c "^| D10" docs/superpowers/roadmaps/2026-10-12-notegit-v01.md`；`grep -o "自带 Git 服务\|不依赖外部" docs/s1/selection.md` | ADR 行存在；选型明确自带服务、无外部平台依赖 | D10 行 1 条（decision 含「git http-backend CGI 包装」）；selection.md L17「自带 Git 服务，不依赖外部平台」+ D1（epic L226）佐证 | yes |
| S2 | `node --test docs/s1/spikes/git-http-backend/test/route-b.test.mjs` | 非快进/越权 ref/绕过路径测试全过，exit 0 | pass 7 / fail 0，exit 0（B3 非快进、B4 逐 ref 授权、B5 先写后删、B6 多 ref 原子拒绝全绿；duration 16.3s） | yes |
| S3 | `grep -h "rules-version.json"`（api.md + spike README + hook）＋读 manifest | 两处以上引用同一文件路径、同一版本标识 | api.md、README、hook 三处同引 `docs/contracts/rules-version.json`；manifest=1.0.0-draft.1；版本串在三文件各自出现（hook 含运行时读取+漂移断言） | yes |
| S4 | `grep -c "D-IC-\|K[1-6]\|四状态" identity-credentials.md`；`grep -c "R[0-9]\|维护模式" backup-recovery.md` | 两契约存在且关键决策附依据 | identity 22 处命中（含四状态×双入口后果表、K1–K6）；backup 35 处命中（含 R1–R14、维护模式矩阵） | yes |
| S5 | 依次运行 AGENTS.md `### gates` 三条命令并核对退出码 | 全部 exit 0，输出与声明一致 | cmd1 contracts: exit 0「82/82 通过，0 失败」；cmd2 tests: exit 0 pass 7；cmd3 storage: exit 0 pass 14 | yes |
| S6 | 对照 epic Open Questions 逐问核对（Q1–Q4、Q6–Q8） | 七问均有 ADR/文档链接；未决项显式标注去向 | Q1/Q2 closed（链接 D10/selection §5–§6）；Q3/Q4/Q6/Q7/Q8 open 且 resolution 各自指向 S1 实际产出（契约/spike 文件在树内可定位）；Q5/Q9 open 属 S8/S9 范围（不在本场景七问内，如实记录） | yes |

## DoD Checklist

E1 DoD（DOD-01–15）逐项核对。S1 是实现准备 sprint：产品实现始于 S2（epic Sprint Breakdown 与 implementation-breakdown §2 的任务分配）。各条状态如实标注「未到期 + 归属 sprint」，不勾选、不虚构证据——依据 epic 开工规则 3（部分条件满足不勾选整条 E1 DoD）与 epic S1 节（关联 DOD-01/04/05/09/11/12/13 的实现准备，但不提前勾选最终 DoD）。

- [ ] DOD-01 独立部署 — 未到期：S8 实现、S9 验证（S1 交付部署规格推导 selection §5 与 D10 镜像形态）
- [ ] DOD-02 身份与权限 — 未到期：S2 实现、S9 验证（S1 交付 storage-model 授权表 DDL + api.md 授权端点契约）
- [ ] DOD-03 员工凭据 — 未到期：S2 实现（S1 交付 identity-credentials 四状态×双入口后果表 + DDL）
- [ ] DOD-04 原生 Git — 未到期：S3 实现（S1 交付 route-b spike 行为证据 7/7，含非快进拒绝/逐 ref 授权）
- [ ] DOD-05 内容校验 — 未到期：S3/S6 实现（S1 交付 validation 契约 + 机器 manifest + gates 门禁 82/82）
- [ ] DOD-06 Web 整理 — 未到期：S4 实现
- [ ] DOD-07 草稿与并发 — 未到期：S4 实现（S1 交付 api.md 发布检查点 0–5 与 base-commit 语义）
- [ ] DOD-08 历史与查找 — 未到期：S5 实现
- [ ] DOD-09 CLI — 未到期：S6 实现（S1 交付错误协议与退出码 0/1/2 契约）
- [ ] DOD-10 Harness 与同步 — 未到期：S7 实现
- [ ] DOD-11 审计与异常恢复 — 未到期：S3 实现（S1 交付审计表 DDL 与主体字段契约）
- [ ] DOD-12 备份恢复 — 未到期：S8 实现（S1 交付 backup-recovery 契约 R1–R14；演练证据 S8）
- [ ] DOD-13 运维与限制 — 未到期：S8 实现（S1 交付 Q7 默认值清单，待基准校正）
- [ ] DOD-14 企业试用 — 未到期：S9（Q5 保持 open，无真实试用不得关闭——如实记录）
- [ ] DOD-15 交付材料 — 未到期：S9

## Obstacles (verbatim)

无。本次验收运行六场景三条 gate 命令全部一次通过，无阻塞、无变通、无替换证据。（此前 T6 阶段的 Colima 冷启动瞬时失败已在 gates-evidence §3.3 如实记录并经 master 裁决接受，非本次运行事件；不作为本次 obstacle 重录。）

## Doc-Drift Audit

| map row (change, owes) | matched this sprint | doc state | detail |
|---|---|---|---|
| 产品要求/知识格式/权限/发布部署架构变化 → 同步 architecture.md + epic ADR 追加 | 匹配：D10 技术选型决策（部署形态具体化） | current | epic Decisions (ADR) 已追加 D10 行（含日期/依据/被否决备选，L236）✓；architecture.md 未触发：技术栈由 AGENTS.md 维护约定与 D9 明文留给实现前选型，选型落在其既有框架内（契约是对 §4/§5 的细化而非变更），无产品要求/知识格式/权限/发布架构变化 |
| roadmap 范围/依赖/验收条件变化 → epic 追加修订记录 | 无匹配 | n/a | S1 未变更范围/依赖/验收条件：D7（T4 并入 T1）是 sprint 内任务重划，记录在 sprint 文档；T7 核对确认 epic 依赖边未变；风险表追加 N1–N4 属风险登记非范围变更 |

---

记录追加性声明：本记录为 S1 首次验收。若同日重跑，将以 `-2` 后缀另立，不覆盖本文件。
