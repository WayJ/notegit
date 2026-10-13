# 一致备份落地契约补正建议（S8-T4）

- **状态**：S8-T4 起草（2026-10-13），待 master 评审。评审通过后由 master 落对应契约原文并在 epic 的 Decisions (ADR) 记录——按仓库约束，本文件不改契约。先例：api-md-amendments.md（S4-T1，A1–A5）、search-index-amendments.md（S5-T3，C1–C4）、metrics-face-amendments.md（S8-T2，C1–C2）、maintenance-drain-amendments.md（S8-T3，M1–M5）。
- **范围**：S8-T4 落地的契约外事实面——备份触发形态（脚本 vs 管理端点）、产物目录结构与 manifest 字段定稿、`backup.completed` 审计行与指标面接线（承 metrics 建议稿 C2）、密钥件权限的落地口径、M4（maintenance-drain 建议稿）「运维行不入备份」的口径采纳、K3/K4 记录的运维义务归属。
- **实现状态**：全部已实现并测试（`server/src/backup/`——manifest/git/snapshot/verify/run/cli；接线 `metrics/routes.ts`（backup 面定稿）；31 项新测试（snapshot 10 + run 6 + verify 8 + cli 7）；npm test 全绿（771+106+345）；演练 `deploy/scripts/backup-drill.mjs` 对真实容器全绿留档 `.agents/notes/2026-10-13-S8-T4-backup-drill.txt`）。

## B1 备份触发形态：脚本（CLI）模式（backup §10「备份调度形态」的空位）

**选型：备份触发 = 随发行包分发的 CLI（`node src/backup/cli.ts backup …`），不做管理端点。** 依据：

- 闸门是**应用进程内**同步标志（backup §3 生效机制）——备份执行者是另一进程，唯一诚实的开闸路径是实例自己的维护端点（POST/DELETE /api/v1/admin/maintenance）。脚本经 HTTP 控制面驱动开/关闸并逐一复核（enable 后 GET 复核 enabled=true，fail-closed）；一个「在备份工具自己进程里翻转的闸门」是假闸门（实例照常收写）。
- 快照工作是文件系统/DB 层作业（VACUUM INTO、目录复制、抽样 fsck），产物落运维指定的输出根（可跨介质——`--keys-out`），天然不宜绑定在长 HTTP 请求上；管理端点形态还要额外解决产物传输与超时两面。
- 端点形态会让「触发备份」与「排空等待（默认至多 300s）」共占一个请求生命周期，超时语义与 §4 步骤 2 的「中止并保持维护」难以在 HTTP 层诚实呈现。
- **被否决备选**：管理端点 POST /api/v1/admin/backup——HTTP 超时耦合大目录复制、产物默认落服务自身卷（与分置精神相悖）、闸门归因反而更绕。
- 后续演进（调度形态=应用内定时 vs 外部触发，§10 待定项）留 T8/部署规格：本 CLI 已是外部触发的最小完备形态。

## B2 产物目录结构与两件分置（backup §2/§6 落地形态）

```text
<out-root>/<YYYYMMDDTHHMMSSZ>-data/     # 数据备份件（分置件 1）
├── manifest.json                       # §4 步骤 6 全字段（见 B3）
├── db/notegit.sqlite                   # 步骤 3：VACUUM INTO（独立文件、无 WAL 伴生）
├── git/<vault-id>.git/…                # 步骤 4：全目录复制（保留权限与 mtime）+ 复制件抽样 fsck
└── config/…                            # 步骤 5：原样复制
<out-root>/<YYYYMMDDTHHMMSSZ>-keys/     # 密钥备份件（分置件 2）
└── keys/token-pepper.key               # §6/identity §6.1 清单；迁移窗口 retired 条目随文件原样入件
```

- 两件恒为**不同顶层目录**（`--keys-out` 可直写另一介质根）；测试断言「数据件内不得出现 keys、密钥件内不得出现数据域」。
- 权限口径（D-BR-04「密钥件权限 0600」的落地解释）：目录需要 x 位才可遍历，故**文件 0600、件根与 keys 目录 0700**，复制后 chmod 强制（不信任 umask/来源权限），verify 与演练按此断言（deploy/README 数据布局行同口径：「0600；目录 0700」）。
- 中止清扫：任一步骤失败删除两件半成品目录并原样上抛（无 manifest 的件不可被误认作完整备份——双保险：verify 以 manifest-present 为第一核对项）；错误不触碰闸门（保持维护，与排空超时同一保守姿态，管理员显式处置）。
- 同 stamp 重跑拒绝覆盖（备份不可静默覆盖）。

## B3 manifest 字段定稿（backup §4 步骤 6 全字段 + 任务补记）

随数据件存放（`<…>-data/manifest.json`）；`docs/contracts/storage-model.md` 的核对面（§7/§8）全部可从本清单核对。字段（形状定义 `server/src/backup/manifest.ts`，必填清单 `REQUIRED_MANIFEST_FIELDS` 供离线验证防漂移）：

| 字段 | 内容 | 契约依据 |
|---|---|---|
| backup_id | UTC 秒级时间戳（件目录名基） | §4 步骤 6（随备份集存放） |
| app_version / backup_tool_version | server 包版本 / 备份工具版本常量 | §4 步骤 6「应用版本」「备份工具版本」 |
| host | 主机标识（os.hostname，可注入） | 任务补记「主机标识」 |
| db.engine / engine_version / schema_version | sqlite / sqlite_version() / max(schema_version) | §4 步骤 6「DB 引擎及版本」「DB schema 版本」（D-BR-03 双版本） |
| time.maintenance_enabled_at / completed_at / maintenance_duration_ms | t0 / 完成时刻 / 维护时长 | §4 步骤 1/6/7 |
| vault_count / vaults[]（id、slug、default_branch、head_oid） | 每库默认分支 HEAD OID；空库 unborn → null | §4 步骤 6、D-BR-03 |
| items.data（dir_name、bytes、domains{git,db,config}、files[]） | 件名 / 内容字节合计（不含 manifest 自身）/ 域字节 / 文件级 SHA-256 清单 | §4 步骤 6「各件字节数」；步骤 8 哈希核对的材料 |
| items.keys（dir_name、bytes、files[]） | 同上（密钥件） | §6 |
| drain（outcome、waited_ms） | 排空实况；timeout 仅出现于管理员显式继续的异常态 | §4 步骤 2、§5 |
| fsck（mode、sample_size、checked[]、failures） | 抽样实况；failures 非空不会出现在成功产物（fsck 非零一律中止） | §4 步骤 4「复制后抽样 git fsck」 |

**「各件字节数」口径**：件**内容**字节合计——manifest.json 自身不计入（自含哈希/字节不可构造）；文件级清单（sha256+bytes）覆盖两件全部内容文件且不含 manifest.json。verify 复算全量（比 §4 步骤 8 的「抽样哈希核对」更强，离线核对频率低、不吝全量）。

## B4 backup.completed 审计行与指标面接线（承 metrics 建议稿 C2 定稿）

- **审计行**：`event_kind='backup.completed'`（storage-model §5 注册表既有 kind，无需新注册）、直接终态 succeeded、actor_kind=system、entry=api、**运行态写入不入备份一致性集合**（backup §3 写分类——物理上写于快照之后，天然不入）。detail 携带 backup_id/data_item/keys_item/vault_count/maintenance_duration_ms/drain_outcome/fsck_checked/host（键名全部过脱敏守卫；无任何凭据材料）。操作者身份由紧邻的 maintenance.enable 行携带（端点归因），完成行不重复主体。
- **指标面（metrics 建议稿 C2 的「T4 落地时定稿」在此定稿）**：`GET /api/v1/admin/metrics` 的 `backup` 字段定稿为 **`{wired: true, last_completed_at: string | null}`**——完成时间 = 最新 backup.completed 成功行的 occurred_at（**以审计行为唯一来源**，与 T2 失败计数同一选型，不另立账本）；尚无备份如实 null。R14「备份完成时间可查且正常」即消费本字段。
- 排空超时中止**不写** backup.completed（未完成不记完成时间）；可观测面 = CLI 错误输出 + GET /api/v1/admin/maintenance 进度（maintenance-drain 建议稿 M2(b) 的注册表裁决项维持留白）。

## B5 M4 口径采纳与排空消费（承 maintenance-drain 建议稿）

- **M4 采纳 (a)「语义不入」**：快照内的 `maintenance.enable` 行（写于步骤 1、早于步骤 3 的 VACUUM INTO）随快照物理存在；恢复/对账侧将其视为运行态遗留忽略即可（零额外排除机制），manifest.time.maintenance_enabled_at（t0）即为该口径的时序界标。请 master 按此落 backup §3 的精确化文本。
- **步骤 2 消费**：备份编排直接调用 T3 排空原语 `waitForDrain`（判据 = audit.drain_count 含待核对行；默认 300s 可配 `--drain-timeout-ms`）；超时默认**中止并保持维护**（结构保证：超时路径不执行 disable）；`--force-drain-timeout` 为管理员显式继续通道，manifest.drain 如实记 timeout（§5 异常态由 S8-T6 恢复对账处置）。

## B6 K3/K4 记录与调度空位（如实标注的运维义务）

- 密钥备份件按 identity §6.1 清单覆盖 **K1**（`/data/keys/` 全目录，含 retired 条目）；**K3（TLS 私钥）/K4（DB 口令）** 的「记录」（保管位置，非机密本体）属部署层——工具不代管、不虚构，deploy/README「备份」节记录运维义务：K3/K4 保管处记录须与密钥件同置保存（backup §6 原文「外加部署层机密的记录」）。
- K5 一次性令牌哈希在 DB 内随快照走（§6 原文）；K2 盐内嵌口令哈希串同库。
- 备份频率/RPO/RTO 数值（Q9）不预设——机制与参数位已备（`--drain-timeout-ms`、外部触发形态），数值留 T8 与试用方落实。

## 测试与证据锚点

- 快照核（步骤 3–6 逐项 + 拒绝覆盖 + 空实例）：`server/test/backup-snapshot.test.ts`（10 项）。
- 编排（步骤 1–2、7：HTTP 控制、排空三路径、审计行、指标接线、403 拒触）：`server/test/backup-run.test.ts`（6 项，真实应用 + 真实维护端点）。
- 离线验证（绿路径 + manifest 缺失/篡改/件缺位/HEAD 互证/库行互证/复制件 fsck/幂等）：`server/test/backup-verify.test.ts`（8 项）。
- CLI 参数面（令牌卫生、默认值、fsck 形态）：`server/test/backup-cli.test.ts`（7 项）。
- 演练（D5）：`deploy/scripts/backup-drill.mjs`——真实容器 16 步全绿留档 `.agents/notes/2026-10-13-S8-T4-backup-drill.txt`（含负路径：产物篡改必被离线验证捕获）。
- TDD：snapshot/run/verify/cli 四组均先 RED（模块缺失/形状不符）后实现转绿；metrics 面接线同步更新 T2 预留断言（wired=true）。

## 落点汇总

| id | 契约文件 | 落点 | 性质 | 实现状态 |
|---|---|---|---|---|
| B1 | backup-recovery §10（备份调度形态）/ api.md（不新增端点） | 触发形态=脚本 | 选型记录（ADR 归档） | 已实现（backup/cli.ts） |
| B2 | backup-recovery §2/§6 | 产物结构 + 分置/权限口径 | 落地形态定稿 | 已实现（snapshot.ts + 断言） |
| B3 | backup-recovery §4 步骤 6 | manifest 字段表 | 字段定稿 | 已实现（manifest.ts + REQUIRED 清单） |
| B4 | api.md（metrics §3.8 建议）+ storage-model §5 消费注记 | backup 面定稿 {wired,last_completed_at} | C2 收口 | 已实现（metrics/routes.ts） |
| B5 | backup-recovery §3/§4 | M4(a) 口径 + 排空消费语义 | 精确化建议（承 M4/M2） | 已实现（run.ts） |
| B6 | backup-recovery §6 | K3/K4 记录运维义务 + Q9 数值留白 | 如实标注 | 文档记录（deploy/README） |
