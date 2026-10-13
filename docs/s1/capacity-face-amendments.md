# 容量/并发限制收口建议稿（S8-T8）

- **状态**：S8-T8 起草（2026-10-14），待 master 评审。评审通过后由 master 落对应契约/路线文档原文并在 epic 的 Decisions (ADR) 记录——按仓库约束，本文件不改 `docs/contracts/` 与 roadmap。先例：api-md-amendments.md（S4-T1，A1–A5）、search-index-amendments.md（S5-T3…T5，C1–C4）、metrics-face-amendments.md（S8-T2）等。
- **范围**：Q7 终值校正（含唯一值修订建议与新键）、512MB 地板复核、Q9 落实状态、S3-T8 建议稿 watch 项与移交项处置。输入 = S3-T8 一轮基准（Q2 规格容器）+ S7-T8 负载数据（两次独立运行）+ S8-T8 本次闸门实负载复跑（[notes](../../.agents/notes/2026-10-14-S8-T8-capacity.md) 及同目录两个 JSON）。
- **实现状态**：除 G1 的契约值修订与 G2 的契约入册（均为 master 执行项）外全部已实现并测试：`server/src/limits/git-gate.ts`（键注册表/覆盖链/闸门）、githttp 接线（`http-backend.ts` 取槽）、观察缝 `app.childProcessGate`、`setAppSetting` 兼收 git 域键、deploy/README 容量节与地板修正；15 项新测试 RED 先行；npm test 849+106+345 全绿。

## G1 Q7 终值：九键维持 + 一键修订（validation-defaults.json + rules-version.json）

**现状**：validation-defaults.json status 仍为 suggested（Q7 open）；S3-T8 一轮基准结论为全部维持 + 4 watch items。S8 输入（S7-T8 app RSS 基线 232MB、本次复跑 240.5MB、闸门实负载）只改变了其中一项的判定（W4，见 G5）。

**终值判定表**（默认值来源 validation-defaults.json @ 1.0.0-draft.1）：

| 键 | 默认值 | 判定 | 依据（S3-T8 基准 + S8 数据） |
|---|---|---|---|
| validation.limits.maxDocumentBytes | 1 MiB | **维持** | 现实文档 ≤27ms/篇；病态稠密 3.1s/篇仍 < 10s 超时；无新反证 |
| validation.limits.maxAttachmentBytes | 10 MiB | **维持** | 判定 ~0.1ms、内存增量 10–20MB/缓冲 |
| validation.limits.attachmentAllowedExtensions | 6 项清单 | **维持** | 安全边界键；无用量证据支持放宽（放宽=MAJOR 亦无理由） |
| validation.limits.maxPushBytes | 50 MiB | **维持** | 现实压缩比 3–7x 推送 4–7s < 10s；初始导入临时调高指引已随 deploy/README 交付（S3-T8 移交项销账，见 G5） |
| validation.limits.vaultCapacityBytes | 5 GiB | **维持** | walk 成本毫秒级（pack 主导）/ 5GiB 全松 worst ~3.4s（启动 prune 已压制；W3 处置见 G5） |
| validation.exemptions.additionalNavPatterns | [] | **维持** | 接受集语义键，无资源维度 |
| validation.exemptions.specialFilePatterns | 2 项 | **维持** | 同上 |
| validation.runtime.validationTimeoutMs | 10000 ms | **维持** | 现实余量实测成立；病态负载 E-RUN-001 属设计行为（W1/W2 处置见 G5） |
| validation.runtime.maxConcurrentValidations | 4 | **维持** | 排队闸门语义（S3-T8 §3.5 澄清）；S8 无新反证 |
| validation.runtime.maxValidationMemoryMb | 256 MiB | **修订建议 256 → 512**（B2 运维型 = MINOR） | 见下 |

**唯一值修订依据（W4 坐实）**：实现为校验入口查**进程整体 RSS**（packages/validation `validate.ts`）。两个消费进程形态：pre-receive hook 独立进程（RSS 78–160MB，256 充裕）；web-submit 走 app 进程——**S7-T8 实测基线 232MB / 本次复跑 240.5MB，距 256 阈值仅 16–24MB**。搜索索引重建、DB 页缓存增长、Node 版本 RSS 漂移任一发生即**全部网页提交 E-RUN-001**（且错误归因是「内存超限」而非真实单次校验过大——阈值语义「单次校验内存」在 app 进程被基线吃掉）。512 = 实测基线 × 2，对 768MB 修正地板（G3）仍构成有效容器保护（app RSS 过半容器即拒新校验合理）。

**建议的 changelog 记录**（master 落 rules-version.json；当前 1.0.0-draft.1、S3 定稿升版未发生——**推荐并入 1.0.0 定稿条目**，若已定稿则单走 MINOR 1.0.1，两路径皆合 §7.2 B2）：

```json
{
  "version": "1.0.0",
  "date": "<定稿日>",
  "changes": [
    "定稿（draft.1 → 1.0.0，S3 实现验收）",
    "validation.runtime.maxValidationMemoryMb 默认值 256 → 512（B2 运维型）：入口按进程整体 RSS 判定，web-submit 所在 app 进程基线 RSS 实测 232–240MB（S7-T8/S8-T8），256 阈值距基线 <25MB 构成现实误杀风险；512 = 基线 × 2（依据 .agents/notes/2026-10-14-S8-T8-capacity.md）"
  ]
}
```

同批建议：validation-defaults.json 该键 `default` 改 512、`basis` 注明「S8-T8 实测校正（app 进程基线 RSS 232–240MB）」；validation.md §5.1 表同步。

**Q7 观察位**：本终值依据为合成负载（4 员工×4 库×~1.7MB 世界）+ 规格容器基准，无真实企业用量——建议 Q7 在 roadmap 保持 open（或注记「终值已定（2026-10-14 S8-T8），试用后如需再校正走 B1/B2」），由 master 定。

## G2 新键 git.maxConcurrentChildren 的契约入册

**现状**：已实现（server 侧）：`server/src/limits/git-gate.ts`——覆盖链/env/app_settings/fail-closed/热生效语义与 validation.* 键完全同构（注册表独立）；githttp 每请求 http-backend spawn 前 FIFO 排队取槽；观察缝 `app.childProcessGate`。默认 **8**，依据：每链 ~17MB（selection §5 保守值）× 8 = 136MB 子进程预算 + 本体 232–240MB = 368MB ⊂ 768MB 地板；c=4 并发 sync 无塌陷（S7-T8）×2 覆盖；实负载验证：gate=2 时 c=4 子进程 RSS 峰值 32→16MB（线性钳制）、墙钟 +3.6%、全部成功。**排队 vs 拒绝选型：排队**——git 客户端对等待透明（TCP 背压 + Node requestTimeout 300s 兜底）；被否备选 503 拒绝（脚本/harness 面费解失败、瞬时高峰误伤）。边界（如实）：只覆盖 githttp 链，web 侧 runGit 短命令不在此键（未来可扩）。

**待 master 裁决**：契约入册位置。本键不是 `validation.*` 命名域（不改内容接受集、不耦合 rulesVersion），**建议**新开 `docs/contracts/runtime-defaults.json`（服务端运维限制默认值：git 域键起步，含 status/basis/kind=operational 字段，版本化走 ADR 记录而非 rulesVersion），validation-defaults.json 不动；server 侧注册表 `GIT_LIMIT_KEY_FIELDS` 已就位，master 落契约后可加「git 键注册表 ↔ runtime-defaults.json」交叉核对测试（现 LIMIT_KEY_FIELDS 交叉核对测试只覆盖 validation.*，本任务未动）。备选：并入 validation-defaults.json 新顶层节（缺点：命名域混用、交叉核对需拆分）。

## G3 512MB 地板复核 → 768MB（selection.md §5 + roadmap Q2 + deploy/README）

**现状**：deploy/README 已按修正值同步（本任务所有权内）；selection.md §5 内存行（512MB 地板，按 S1 spike 期 RSS 114.7MB 推导）与 roadmap Q2 行仍为旧值——**修订属 master**。

**建议修订**（selection.md §5 内存行 + roadmap Q2 行）：

> 内存：最低 **768 MB**（S8-T8 修正：全功能服务进程 RSS 基线实测 232–240MB（S7-T8/S8-T8，S2–S6 功能并入后；selection §5 原按 spike 期 114.7MB 推导的 512MB 地板作废）+ 每并发 clone 子进程链 ~17MB × 默认并发上限 8 = 136MB + 系统/页缓存/备份瞬态 ≥100–150MB；512MB 档经 `git.maxConcurrentChildren` 降至 4 可勉强运行但备份窗口紧，不承诺）；推荐 **1 GB**（维持）。

**建议 ADR 条目**（epic Decisions）：D-xx「部署内存地板 512MB → 768MB（S8-T8 实测修正，RSS 232–240MB 基线 + 并发链预算）；覆盖 selection.md §5 spike 期推导值；git.maxConcurrentChildren=8 默认与地板联动」。

## G4 Q9 落实状态注记（roadmap Q9 行）

**现状**：未与试用方确认任何数值（试用方尚未接洽）——如实标注，不虚构。三要素框架与建议参数位已备（可用性/备份频率 RPO/可接受恢复损失 RTO，含 S8 演练实证基础），见 [notes §Q9](../../.agents/notes/2026-10-14-S8-T8-capacity.md)。落实责任 = 产品/试用负责人，时限 = S9 试用启动前。

**建议 roadmap Q9 行注记**：状态保持 open，resolution 列追加「2026-10-14 S8-T8：三要素参数框架已备（.agents/notes/2026-10-14-S8-T8-capacity.md），数值待试用方接洽后落实（S9 前）」。

## G5 S3-T8 建议稿 watch 项与移交项处置（全链核对记录）

| 项 | S3-T8 留下的表述 | S8-T8 处置 | 归宿 |
|---|---|---|---|
| W1 lineOfIndex 二次项 | 优化机会（预控行号索引），病态稠密由超时兜底 | **不改契约不改值**：性能优化属 epic「后续演进」排除项（roadmap 明示不进 S2–S9）；真实用量未落地无从触发改动 | 建议 master 入 tech-debt-tracker 或后续演进清单 |
| W2 超时 × push 上限交互 | >10x 压缩比 50MiB 推送可能 E-RUN-001 | **维持两值**：无真实用量证据；若试用后频繁触达，优先 W1 优化而非调值（原判据不变） | 本表即记录，无契约动作 |
| W3 vault walk 松对象线性 | 5GiB 全松 worst ~3.4s/push；GB 级库换 count-objects/缓存 | **维持 5GiB**：启动 prune 持续压制；真实 GB 级库未出现 | 观察位随 Q7（G1 表） |
| W4 maxValidationMemoryMb RSS 口径 | 地板 512MB 容器下阈值 256 与 node 基线间隔偏窄，「边缘形态值得 S8 复核」 | **触发修订**：256 → 512（G1）——S8 实测 app 基线 232–240MB 将「边缘形态」坐实为现实误杀风险 | G1（master 执行） |
| 移交：初始导入临时调高 maxPushBytes 指引 | 「随交付文档成文（S8/交付材料）」 | **已落地**：deploy/README「容量与并发限制」节（本任务） | 已销账 |
| 移交：app_settings 管理端点 + config 审计 kind | 「随 api.md/storage-model 契约修订补录」 | **仍 open**：storage-model §5 已注册 `config.update` 审计 kind、api.md 无端点；当前管理员经 SQL/ops 写行（热生效）；git 域键同此面 | 建议 master 随 api.md 下一批补录（端点 + 配置快照入审计一并） |
| 移交：配置快照入审计（生效观察面） | 「S8 运维指标若需要」 | **未做**（无契约面支撑，随上项同批） | 同上批补录 |
