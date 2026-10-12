# S1-T8 收口核对报告（closeout-report）

| 项目 | 内容 |
|---|---|
| 任务 | S1-T8 收口核对：对照完成标准核对 Q1–Q4、Q6–Q8 记录齐全；汇总证据清单交 master 验收 |
| 日期 / 产出 | 2026-10-12 / S1-T8 worker（Orca dispatch `ctx_5c15ec78f399`，branch `WayJ/s1-t8-closeout`） |
| 核对基线 | `sprint/S1 @ d1b9b52`（本 worktree rebase 后与 `local/sprint/S1` **同树**，`git diff local/sprint/S1 HEAD` 为空） |
| 核对环境 | Apple M4 (arm64) / macOS / Node v24.21.0 / Python 3.9.6 + jsonschema 4.25.1 / git 2.50.1（与 [gates-evidence §1](gates-evidence.md) 记录环境一致） |
| 方法声明 | **只读核对**：除本文件外未改任何文件；三条命令均为本机真实复跑（UTC 时间戳与退出码见 §2），未引用他人输出；未 push；**不宣称 E1 DoD 任何条目完成** |

---

## 1. 七问逐条核对（Q1–Q4、Q6–Q8）

来源：[epic Open Questions 表](../superpowers/roadmaps/2026-10-12-notegit-v01.md)（L254–264）。Q5/Q9 不属 S1 交付范围（S9/S8 前落实），本表不核对。

| 问 | epic 表现状 | 核对结论 | 决议/产出位置（可定位） |
|---|---|---|---|
| Q1 技术栈组合 | **closed**（L256） | closed 正当：D10 已归档，选型记录与实测证据齐备 | [D10](../superpowers/roadmaps/2026-10-12-notegit-v01.md#decisions-adr)（L235）+ [selection.md](selection.md) §2–§4/§7 |
| Q2 运行环境/平台/最低资源 | **closed**（L257） | closed 正当：规格推导有实测依据 | [D10](../superpowers/roadmaps/2026-10-12-notegit-v01.md#decisions-adr) + [selection.md](selection.md) §5（规格表）、§6（首发平台表） |
| Q3 Git 接入/并发写入/审计核对机制 | **open**（L258） | open 正当（resolution=「S1 验证并固化契约；S3 实现」）：**S1 侧产出已交付**（下详），S3 实现未开始 | Git spike + identity 契约 + storage-model（下详） |
| Q4 title-only/豁免/错误协议版本化 | **open**（L259） | open 正当（「S1 记录最终规则…S3/S6 使用同一契约」）：**S1 侧已定案** | [validation.md](../contracts/validation.md) §2/§3/§6/§7 + [rules-version.json](../contracts/rules-version.json) |
| Q6 凭据/会话/初始管理员/账号恢复 | **open**（L261） | open 正当（「S1 固化契约，S2 实现」）：**S1 侧已定案** | [identity-credentials.md](../contracts/identity-credentials.md) 全文 + storage-model/api 落库与端点 |
| Q7 容量/超时/并发默认值 | **open**（L262） | open 正当（「S1 以 Q2 规格提出可配置值，S3/S8 校正」）：**S1 侧建议值已交付** | [validation-defaults.json](../contracts/validation-defaults.json) + [validation.md](../contracts/validation.md) §5 + [selection.md](selection.md) §5 |
| Q8 跨存储备份/密钥/升级回退 | **open**（L263） | open 正当（「S1 设计；S8 演练后记录证据」）：**S1 侧设计已定案** | [backup-recovery.md](../contracts/backup-recovery.md) 全文 |

**逐问证据**（文件均在当前 sprint/S1 树内，链接为相对路径）：

- **Q1**：D10 行（L235）内容与 selection.md §7 DRAFT 一致（Node 24 + TS + Fastify v5 + git http-backend CGI 包装 + SQLite node:sqlite WAL+busy_timeout，node:24-alpine 单容器，CLI npm 分发）。三组对比证据文件实在：`docs/s1/spikes/{git-http-backend,isomorphic-git,frameworks,db}/evidence/`（13 份，selection.md 附录 A 复跑命令齐备）。关键行为证据 route-b 7/7 本次复跑通过（§2 CMD2）。
- **Q2**：selection.md §5 规格表（CPU/内存/磁盘/镜像/网络逐项附推导：RSS 114.7MB、每并发 clone 子进程链 ~17MB 实测）；§6 三行平台决定表。依据文件 `spikes/git-http-backend/evidence/route-b-child-rss.txt`、`spikes/db/evidence/db-ops-notes.md` 存在。
- **Q3**：① Git 接入 spike：[route-b 测试](spikes/git-http-backend/test/route-b.test.mjs) B1–B7（HTTP clone、鉴权 FF push、未鉴权 401、非快进拒绝、逐 ref 授权+main 删除禁、先写坏后删拦截、多 ref 原子拒绝）本次复跑 **7/7、exit 0**（§2 CMD2）；对照路线 A 证据 `spikes/isomorphic-git/evidence/route-a-*.txt`。② 审计核对/权限机制契约：[identity §5](../contracts/identity-credentials.md)（两层实时查库检查 + 写路径执行点复查）、§8（审计主体=认证员工）；[storage-model §4](../contracts/storage-model.md)（authn/authz 规范查询）、§6（预记录→核对、排空、old→new 成链——本次 CMD3 第 4/5/9 项断言通过）。③ 并发写入：db spike S1/S2 实测（`evidence/db-sqlite-tests.txt`，WAL+busy_timeout=5000 多进程写 3/3；T6 复跑记录 [gates-evidence §3.2](gates-evidence.md)）+ storage-model §1（BEGIN IMMEDIATE）。④ 入口共用：[api.md §8](../contracts/api.md) 检查点 0–5 序列表（Web submit 与 Git receive 同组件）。「不允许检查后绕过权限」落为 identity §5.1 第 3 层 + api §8.1 检查点 5。
- **Q4**：[validation.md](../contracts/validation.md)：§2 README 全目录豁免（含判定条件与 E-PATH-004 边界）、§3 title-only 六字段 + YAML 安全子集、§6.2 错误码注册表全量（24 码，本次复跑逐码核验）+ §6.3 报告 JSON 形状、退出码 0/1/2；§7 SemVer 版本化（A/B1/B2/C 情形，B1 收紧=MAJOR 不得借道）+ **rules-version.json 为版本号唯一机器来源**（1.0.0-draft.1）。自检门禁本次复跑 **82/82、exit 0**（§2 CMD1，含 4c「示例 rulesVersion == manifest」与「版本号出现在 validation.md」两项交叉检查）。
- **Q6**：[identity-credentials.md](../contracts/identity-credentials.md)（195 行）：§2 Argon2id 参数+NIST 口令策略；§3 `ngt_` token + HMAC-SHA256(pepper) 存储 + scope 只收窄；§4 服务端会话表（拒 JWT）；§5.2 **四状态×双入口后果表**（零延迟生效）；§6.1 K1–K6 密钥清单 + §6.2 版本化 pepper 轮换（rehash-on-use）；§7.1 bootstrap token 初始化 + §7.2 三级账号恢复（含管理员全员锁死主机侧兜底）；§8 审计主体；§10 决策 D-IC-01…10（含被拒备选）。落库：[storage-model §3.2–3.4](../contracts/storage-model.md)（表结构与 identity 逐条互链）；端点与移交项定稿：[api.md](../contracts/api.md) §1（CSRF/Bearer）、§3（bootstrap/login/password-reset）、§4（凭据 CRUD）。四状态撤权路径经 CMD3 第 4/5 项 SQL 断言。
- **Q7**：[validation-defaults.json](../contracts/validation-defaults.json) 全键交付（adminConfigurable 7 键 = limits 5 + exemptions 2；runtime 3 键；合计 10 键，`kind: verdict/operational` 机器可分，对应 §7.2 B1/B2）；与 validation.md §5.1 表**双向一致**由 CMD1 检查 4d 本次复跑通过。部署规格推导：selection.md §5。校正义务（S3 第一轮/S8 终值）在 validation.md §9 明示，非静默。
- **Q8**：[backup-recovery.md](../contracts/backup-recovery.md)（158 行；与 identity 合计 353 行，与 sprint 计划 T3 行记载一致）：§1 数据分类（**不能仅备份 Git**）；§3 维护模式写入口矩阵（含写分类：运维审计行不入备份）；§4 八步快照顺序（排空→DB→Git→config/keys→manifest）；§5 不变量 1–5；§6 密钥件与数据件分置 0600；§7 全新环境十步恢复；§8 **R1–R14 逐项验证清单**（逐条挂 DoD）；§9 升级迁移/回退框架（回退=恢复升级前备份、不降 schema）；D-BR-01…08。机制实测前置：SQLite `VACUUM INTO` 并发写一致快照（db spike S3/S4，3/3）；恢复对账查询落库为 storage-model §4 `audit.drain_count`/`audit.chain`（CMD3 第 9 项断言）。

**小结**：七问全部有 ADR/契约文档链接；五个 open 项的 resolution 均明确标注了后续 sprint 义务（S2/S3/S6/S8），无静默未决——满足 sprint 场景 S6「未解决项明确标注阻碍而非静默」。epic 表规则（Open Questions 前言）禁止仅因「指定处理阶段」即改 closed，故 Q3/Q4/Q6/Q7/Q8 维持 open 是**正确状态**，本报告仅核对并确认其 S1 侧产出已交付；epic 行是否补记/关闭属 master 裁决（见 §6-G8）。

## 2. 三条命令复跑记录（fresh，2026-10-12，仓库根目录）

### CMD1 `python3 docs/contracts/tools/verify_validation_contracts.py`

- 运行时间：2026-10-12T14:36:39Z；**退出码 0**；输出「`检查结果：82/82 通过，0 失败`」，全部 82 行均 `[PASS]`，无 `[FAIL]`。
- 覆盖（节选自实际输出）：2 个 schema 2020-12 元校验 PASS；6 份 report 示例过 schema PASS；frontmatter-cases 15 例 PASS；注册表 24 码 severity/退出码列一致 PASS；「`[PASS] validation.md: 规则版本与 manifest 一致（版本号出现在文档中）`」；每份示例「rulesVersion 等于 manifest」PASS；「`[PASS] defaults: JSON 与 validation.md 键一致`」「值一致」；「`[PASS] rules-version.json: artifacts 文件齐全`」。
- 对照声明：AGENTS.md gates contracts 行（「82/82、exit 0」）、[sprint 计划](../superpowers/sprints/2026-10-12-S1-plan.md) T2 行、场景 S5 固化文本——**一致**。

### CMD2 `node --test docs/s1/spikes/git-http-backend/test/route-b.test.mjs`

- 运行时间：2026-10-12T14:36:45–49Z；**退出码 0**；`tests 7 / pass 7 / fail 0`，duration_ms 3787.4。逐项（实际输出）：

```
✔ B1: native git client can clone over HTTP from CGI-wrapped http-backend (154.001ms)
✔ B2: authenticated fast-forward push is accepted (1408.730292ms)
✔ B7: unauthenticated ref discovery is rejected with 401 (架构 §3.2 引用发现必须鉴权) (9.033041ms)
✔ B3: force-push (non-fast-forward) is rejected; server ref unchanged (253.004417ms)
✔ B4: per-ref authorization — bob cannot write main, can write feature/*; main delete forbidden (972.572375ms)
✔ B5: receive-side per-commit validation rejects "commit bad file then delete it" range push (401.80575ms)
✔ B6: one push carrying a good ref and a bad ref is rejected atomically — no ref updated (351.146958ms)
```

- 对照声明：AGENTS.md gates tests 行（「7/7、exit 0」）、场景 S2 固化文本（B1–B7 语义列举）、D7——**一致**。无需 npm install（本次直接从仓库根运行验证）。

### CMD3 `node --test docs/contracts/tools/ddl_smoke.test.mjs`

- 运行时间：2026-10-12T14:36:54Z；**退出码 0**；`tests 14 / pass 14 / fail 0`，duration_ms 112.6。逐项（实际输出，测试名即断言内容）：

```
✔ DDL：storage-model.md 全部 @schema 块可顺序执行，schema_version 含 v1 行
✔ vaults.slug 实例内唯一：重复插入被拒（架构 §7.2）
✔ 外键生效：凭据指向不存在的员工被拒（identity §3.3 归属外键）
✔ 四状态之过期/撤销/停用：authn.token 查询实时判定（identity §5.1/§5.2）
✔ 四状态之成员撤权：authz.role 查询实时判定，DELETE 即撤权（identity §5.2）
✔ vault_members：role CHECK 三角色（架构 §4.2），PK 防重复授权
✔ Web 会话：authn.session 查询覆盖 idle/absolute 过期与账号停用（identity §4/§5.2）
✔ 凭据存储：token_hash 唯一索引（identity §3.2 查找方式），scope CHECK
✔ 审计事件：pending 预记录 → 终态，排空计数与 old→new 成链查询（架构 §4.4、backup-recovery §4/§5）
✔ schema_version 历史行不可改（backup-recovery §9）：UPDATE/DELETE 均被触发器拒绝
✔ 草稿：按作者私有且每路径一份（UNIQUE），status CHECK（架构 §6）
✔ 一次性令牌（K5）：purpose CHECK + token_hash 唯一（identity §6.1/§7）
✔ app_settings：键唯一，可覆盖写入需 DELETE+INSERT 或先删（T2 §5.1 配置存储）
✔ api.md lint：API 错误码注册表内聚、前缀与 T2 不相交、rulesVersion 引用一致
```

- 对照声明：sprint 计划 T5 行「ddl_smoke 14/14」——**一致**；第 14 项（api.md lint）即场景 S3 的 api.md 侧机器核对（见 §3）。
- 附带确认：测试运行后 `git status` 干净，无临时文件残留。

## 3. 完成标准核对：「Git 接入与 Web 发布共用规则」（场景 S3）

场景原文（[sprint 计划](../superpowers/sprints/2026-10-12-S1-plan.md) L77）：「检查 T4 spike 与 T5 API 契约均引用 T2 的同一契约文件与规则版本号」→ 预期「两处引用同一文件路径、同一版本标识」。

| 核对对象 | 结果 | 证据 |
|---|---|---|
| T5 API 契约（api.md） | **✔ 满足** | [api.md L50](../contracts/api.md)：「规则版本唯一机器来源：[rules-version.json](../contracts/rules-version.json)，当前 **1.0.0-draft.1**」；L54、L82、L228、L265 等多处引用；且由 CMD3 第 14 项 lint **机器强制**（「rules-version.json 的 rulesVersion 字符串与文件路径在本文件出现」，§2.4，本次复跑 PASS） |
| T4 spike（D7 并入 T1，即 `docs/s1/spikes/git-http-backend/`） | **✘ 不满足字面核对** | 全目录检索（`grep -rn "rules-version\|rulesVersion\|1\.0\.0-draft" docs/s1/spikes/`）**零命中**。[hook-pre-receive.mjs](spikes/git-http-backend/hook-pre-receive.mjs) 实现的是硬编码最小校验（.md 须有非空 title、README 豁免、删除跳过），依据标注指向**架构 §5.2/§5.4**而非 T2 契约文件，无任何版本标识 |
| rules-version.json 本身 | ✔ | `rulesVersion: "1.0.0-draft.1"`，status draft，artifacts 四文件齐全（CMD1 检查 4f PASS） |

**判定**：按场景字面「两处引用同一文件路径、同一版本标识」为**部分满足**（api.md ✔ / spike ✘）。成因可解释：T1 spike 与 T2 契约同属 Wave 1 并行产出，spike 代码先于契约定稿，D7 将 T4 吸收进 T1 时未回补版本引用。设计机制本身是完整的：三端单一来源机制（validation §7.3：构建期同取 `docs/contracts/`、服务端权威、每报告带 `rulesVersion`）+ 共用发布组件检查点 0–5（api.md §8.1，检查点 4 明确「T2 契约 + rulesVersion」对 Web submit 与 Git receive 两入口同规则）+ S3 落地强制（S3-T3 rulesVersion 读自 rules-version.json、S3-T7 同构性测试、S6-T7 CI 断言，见 [implementation-breakdown §2.2/§2.5](implementation-breakdown.md)）。spike 的硬编码规则与 validation §2/§3.1 语义一致（title 必填、README 豁免），但**无机器可核的版本链接**。处置建议（二选一，master 裁决）：① 在 spike README/hook 注释补一行对 `docs/contracts/rules-version.json` 与 1.0.0-draft.1 的引用（spike 标注 THROWAWAY，改动最小）；② 按 D7 精神在 sprint 文档追加记录，将场景 S3 的核对口径明确为「T5 契约侧机器核对（已满足）+ 三端一致性由 S3-T3/T7 与 S6-T7 在实现层强制」。列入 §6-G1/G2。

## 4. S1 完成标准与验收场景对照

[epic S1 完成标准](../superpowers/roadmaps/2026-10-12-notegit-v01.md)（L134）四条 + [sprint 场景 S1–S6](../superpowers/sprints/2026-10-12-S1-plan.md)（L73–80）：

| 项 | 判定 | 证据 |
|---|---|---|
| 「Q1–Q4、Q6–Q8 有记录」/ 场景 S6 | **满足** | §1 逐问核对：七问均有 ADR/契约链接；open 项均显式标注后续 sprint 义务 |
| 「选型不要求外部 Git 平台」/ 场景 S1 | **满足** | D10（自带 git http-backend 包装）+ [D1](../superpowers/roadmaps/2026-10-12-notegit-v01.md#decisions-adr)（自带 Git 服务）；selection.md §1 约束表「不依赖外部平台」；ADR 行已归档（L235） |
| 「可演示服务端拒绝 push」/ 场景 S2 | **满足** | CMD2 本次复跑 7/7、exit 0（B3/B4/B5/B6 即拒绝路径）；命令已固化进 gates 与场景 S2 固化记录（L84） |
| 「Git 接入与 Web 发布能共用规则」/ 场景 S3 | **部分满足（按场景字面）** | §3：api.md 侧 ✔（机器核对）；spike 侧无版本引用（G1）。契约机制（单一来源 + 检查点 0–5 共用序列）已交付 |
| 场景 S4（Q6/Q8 设计记录齐全） | **满足** | §1 Q6/Q8：两契约存在且关键决策附依据（D-IC/D-BR 决策表、后果表、R 清单） |
| 场景 S5（gates 命令真实可运行） | **满足** | §2 CMD1/CMD2 fresh 复跑与 AGENTS.md gates、gates-evidence §2 声明一致 |

## 5. S1 交付物证据清单（T1–T7，对照 sprint 计划各行与 AGENTS.md gates）

| 任务 | 产出物 | 文件位置（当前树实测存在） | 验证方式 | 结果 |
|---|---|---|---|---|
| T1 技术选型与部署规格（Q1/Q2） | 选型记录 + DRAFT ADR + 4 组 spike 与证据 | [selection.md](selection.md)（146 行）；`docs/s1/spikes/{git-http-backend,isomorphic-git,frameworks,db}/`（含 13 份 evidence 文件）；D10 已归档 epic（L235，merge @9f8d8d4 在树内） | route-b 行为测试本次复跑 7/7（§2 CMD2）；spike 证据文件与附录 A 复跑命令齐备；master 复跑记录见 sprint 计划 T1 行 | ✔（spike 标注 THROWAWAY，perf 数字为指示性） |
| T2 统一校验契约（Q4/Q7 清单） | 契约 + 2 schema + defaults + 版本 manifest + 7 示例 + 自检工具 | [validation.md](../contracts/validation.md)（289 行）、[rules-version.json](../contracts/rules-version.json)、schemas/ 2 份、examples/ 7 份（6 report + frontmatter-cases）、[tools/verify_validation_contracts.py](../contracts/tools/verify_validation_contracts.py) | CMD1 本次复跑 **82/82、exit 0**（含版本一致、defaults 双向一致交叉检查） | ✔ |
| T3 凭据/会话/备份恢复契约（Q6/Q8） | 两份契约草案 | [identity-credentials.md](../contracts/identity-credentials.md)（195 行）+ [backup-recovery.md](../contracts/backup-recovery.md)（158 行），合计 353 行（与 sprint 计划记载一致）；merge @9fcf5b5 在树内 | 文档核对：四状态×双入口后果表、K1–K6、D-IC-01…10、维护模式矩阵、R1–R14、D-BR-01…08 均在（§1）；落库一致性经 CMD3（storage-model 表结构引用 identity 条款）间接核验 | ✔（遗留 5 项 Minor 记录在 worker 报告，仓库内不可见——见 §6-G5） |
| T4 Git 接入验证 spike | （D7 并入 T1） | route-b 7 项行为测试 = `spikes/git-http-backend/test/route-b.test.mjs` | CMD2 本次复跑 7/7 | ✔ |
| T5 API 与存储模型细化 | SQLite DDL 契约 + API 契约 + DDL 冒烟工具 | [storage-model.md](../contracts/storage-model.md)（362 行，10 表 STRICT DDL + 5 规范查询）、[api.md](../contracts/api.md)（339 行，17 码注册表 + 检查点 0–5）、[tools/ddl_smoke.test.mjs](../contracts/tools/ddl_smoke.test.mjs) | CMD3 本次复跑 **14/14、exit 0**；T2 门禁复跑无回归（CMD1 82/82） | ✔（开放项留 S2，见 §6-H） |
| T6 gates 落地 | AGENTS.md `### gates` 小节 + 运行证据文件 | [AGENTS.md](../../AGENTS.md) L10–17；[gates-evidence.md](gates-evidence.md)（**实测 201 行**，sprint 计划记载 206 行——见 §6-G6） | 两条 gate 命令本次独立复跑均与记载一致（CMD1 82/82、CMD2 7/7、exit 0）；场景 S2/S5 固化文本已入 sprint 计划（L82–85） | ✔ |
| T7 实施拆分 | S2–S9 任务分解 + 风险更新 | [implementation-breakdown.md](implementation-breakdown.md)（实测 307 行，与记载一致）；N1–N4 新风险已入 epic 风险表（L295–298，实测在树） | 结构核对：8 sprint × 7–8 任务、波次 W1–W6 WIP≤3、epic 8 风险行逐条处置 + D10 新增 4 行 | ✔ |

AGENTS.md gates 两条命令（contracts / tests）均已由本次独立复跑证实「真实可运行且当前通过」（§2）；ddl_smoke 未登记进 gates（§6-G3）。

## 6. 缺口、不一致与未决事项（如实清单，未淡化）

**核对过并确认存在的缺口/不一致**（编号供 master 裁决引用）：

- **G1（场景 S3，见 §3）**：route-b spike（T4 承接方）无 `rules-version.json`/版本号引用，场景 S3 字面核对只满足 T5 侧。需 master 裁决：补 spike 引用（最小改动）或在 sprint 文档追加口径记录（由 S3-T3/T7、S6-T7 在实现层强制）。
- **G2**：[validation.md §7.3 第 3 条](../contracts/validation.md)（L270）宣称「T4 spike 与 T5 API 契约引用…同一版本标识」——前半句与实际不符（spike 未引用），与 G1 同源。
- **G3**：`ddl_smoke.test.mjs` 未登记进 AGENTS.md `### gates`：[storage-model §8](../contracts/storage-model.md)（L352）、[api.md §12](../contracts/api.md) T6 行均「建议 T6 登记」，T6 实际只登记 2 条命令。本次复跑证明该命令可运行（14/14）。是否补登记由 master 裁决（登记本身只需改 AGENTS.md gates 小节）。
- **G4**：[backup-recovery §4](../contracts/backup-recovery.md) 步骤 8「校验命令随 T6 gates 固化」未兑现——gates 无备份件校验命令。备份件本身 S8 才产生，命令无法先测；属文档预期与 T6 实际交付的偏差，建议随 S8-T4 落地或在 backup 契约改标归属。
- **G5**：T3 遗留「5 项 Minor」（DB 引擎相关标「待 T1」、恢复演练证据留 S8）按 sprint 计划 T3 行记载仅存于 worker 报告（dispatch `ctx_7a964742de70`），**仓库内无对应文档，本次无法复核其内容**。建议 master 决定是否落档进仓库（或随 S2/S8 任务化吸收）。
- **G6**：sprint 计划 T6 行记载「gates-evidence.md 206 行」，实测 **201 行**（文件自 9ec5650 落地后无改动，`git log --follow` 单提交）。行数记载与实物不符（内容完整性不受影响）。
- **G7（契约字面滞后，实质已收敛）**：多处「待 T1」字样在 D10 定案后过时——[identity §9](../contracts/identity-credentials.md)（Argon2/HMAC 库、DB 引擎、进程模型等；实际已收敛为 S2 决策，见 implementation-breakdown S2 前置）；[backup §10](../contracts/backup-recovery.md)（DB 引擎与快照命令——D10 已定 SQLite/VACUUM INTO）；[validation §9](../contracts/validation.md)（$id 占位域名「T1 选型定案后」——实际归属 S3 实现）；[selection.md §5](selection.md) 备份窗口行「现位于 sprint/S1 集成分支 @9fcf5b5；本分支切点早于该集成，未随本分支分发」——在当前 sprint/S1 树上契约已分发，该句为历史快照。均为措辞滞后，决策归属已被 implementation-breakdown 正确接管。
- **G8**：Q3/Q4/Q6/Q7/Q8 epic 行维持 open 是正确状态（§1 小结）；是否按 T7 拆分的建议（implementation-breakdown §2.2：「Q3 的 epic 行关闭随 T8 收口记录」）在 epic resolution 列补记「S1 侧已交付」，属 master 的 epic 维护动作，本报告不代改。

**契约内开放项汇总**（均有归属 sprint，无孤儿项）：

- validation.md §9（5 条）：Q7 全部默认值待 S3/S8 校正；$id 域名（S3）；1.0.0-draft.1→1.0.0 定稿（S3）；E-LIMIT-004/005 计量口径（S3）；版本化常量 schema/文档双存漂移面（S3 建议提取常量清单）。
- storage-model.md §7（6 条）：username 大小写策略、Argon2/HMAC 库选型、登录限速默认值、审计保留期限、索引随 S7 复核、drafts 超长控制——均 S2（末项挂 T2 §5.1）。
- api.md §11（7 条）：登录限速阈值、username 大小写、Web 非默认分支提交、草稿保存 warning 校验、审计保留/导出、validations stale base 行为、/api/v1 演进策略——均 S2/S6。
- identity-credentials.md：§2 限速默认值（S2）、§9 待定清单（已收敛 S2，见 G7）。
- backup-recovery.md §10：备份调度形态、密钥件加密载体（企业选择）、备份频率/RPO/RTO 数值（Q9，S8 前落实）、maintenance 码已由 api.md §2.3 定稿（E-MAINT-001，文档内仍列待定——并入 G7）。
- roadmap：Q5（S9 前落实，硬前置 DOD-14）、Q9（S8 前落实）——S1 范围外，状态 open 正确。

**已裁决/已闭环事项**（列此存档，不算缺口）：gates-evidence §3.3 Colima 冷启动瞬时失败——master 已裁决接受（教训留 S8：宿主侧就绪检查）；T6 对 selection.md 附录 A DB 组顺序的澄清建议（§5）——selection.md 未改，属 G7 类文档澄清遗留。

## 7. 结论与移交

- S1 完成标准四条：**三条满足并附 fresh 证据**（七问有记录、不依赖外部平台、可演示服务端拒绝 push），「Git 接入与 Web 发布能共用规则」**按场景 S3 字面为部分满足**（api.md 侧机器核对通过；spike 侧缺版本引用，G1/G2），契约与机制层（单一来源、共用发布组件检查点、S3/S6 强制路径）完整。是否视为达标及 G1–G8 处置，交 master 验收裁决。
- 本报告为独立核对：三条命令全部本机真实复跑（82/82、7/7、14/14，exit 0）；除本文件外零文件改动；未 push；**不宣称 E1 DoD（含 DOD-05）任何条目完成**。
- 移交 master：① G1–G8 逐项裁决（G1/G2 为场景 S3 收口口径；G3/G4 为 gates 登记面；G5 为 T3 遗留落档）；② T8 勾选与 sprint state 变更；③ S2 启动前置核对（implementation-breakdown §2.1：S1 整体验收为最后剩余项）。
