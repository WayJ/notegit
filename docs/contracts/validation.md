# Notegit 统一内容校验契约（validation）

| 项目 | 内容 |
|---|---|
| 契约 | notegit-validation |
| 规则版本 | **1.0.0-draft.2**（唯一机器来源：[rules-version.json](rules-version.json)；status: draft） |
| 基线 | architecture.md §5、§9（v0.2，2026-10-12）——本文每条规则括注架构条文编号，无编号者标注为 T2 建议 |
| 任务/问题 | S1-T2（roadmap F05）；Q4 规则版本化、Q7 限制清单 |
| 机器可读定义 | [schemas/frontmatter.schema.json](schemas/frontmatter.schema.json)、[schemas/validation-report.schema.json](schemas/validation-report.schema.json)、[validation-defaults.json](validation-defaults.json) |
| 三端 | 本地 pre-commit hook / 服务端 pre-receive / 网页正式提交——共用本目录单一契约来源（S3 验收场景引用路径与版本标识） |

本契约回答 Q4（title-only、README 豁免及错误协议如何版本化）与 Q7（限制清单与建议默认值）。所有容量/超时/并发/类型清单默认值均为**建议值·待基准校正**（roadmap Q7：S1 提议，S3 实现期与 S8 用实际基准校正）。本文为 S1 契约草案，**不构成 E1 DoD 完成**；S3 实现定稿后版本升 1.0.0。

---

## 1. 范围与三端一致

三端校验对象与失败行为（架构 §5.4）：

| 入口 | scope（报告字段） | 校验对象 | 失败行为 |
|---|---|---|---|
| 本地 pre-commit | `pre-commit` | 暂存区将提交的文件内容（读 index，不读工作目录） | 退出非零，给出文件、规则与修正提示 |
| Git pre-receive | `pre-receive` | 将进入服务端的提交和引用变化 | 拒绝整次 push，返回具体错误 |
| 网页正式提交 | `web-submit` | 根据 base commit 构造的完整候选提交 | 不发布，保留草稿和错误提示 |

服务端是不可绕过的最终防线。防绕过清单（每项对应机制，均出自架构 §5.4/§9）：

| 绕过路径 | 拦截机制 | 依据 |
|---|---|---|
| 跳过本地 hook（clone 后 hook 不在、`--no-verify`） | 服务端 pre-receive 强制校验；本地 hook 仅是提前反馈 | §5.4 |
| 先写坏内容再删除（违规内容先进历史） | 服务端检查每个新引入提交相对其父提交的新增/修改文件，不能只检查最终分支差异 | §5.4 |
| 合并提交夹带 | 合并提交按父提交比较 | §5.4 |
| 新库根提交 | 检查全部文件 | §5.4 |
| 多 ref 推送（一次 push 多分支） | 所有 ref 先统一检查，通过后才允许更新（全有或全无） | §5.4 |
| tag 绕过分支接收规则 | 第一版不提供 tag 写入 | §5.4 |
| 网页直改引用 | 网页不能直接 update-ref；共用发布组件先内容校验、权限与分支检查，再以预期旧 commit 更新引用；权限变更与写入在服务端协调 | §5.4 |
| 部分暂存校验错对象 | 本地校验读取暂存区（index），不能只读工作目录 | §5.4 |
| 库内脚本攻击 hook | hook 使用随工具分发的校验程序，不执行从知识库下载的任意脚本；安装保留现有 hook，兼容安装或明确报告冲突（`notegit setup`） | §5.4 |
| 历史存量违规导入 | 另走管理员显式迁移流程，不在本契约常规校验范围 | §5.4 |
| 解析资源攻击（YAML 别名膨胀等） | YAML 安全子集 + 校验进程时间/内存/并发限制 | §5.1、§9 |

## 2. 知识文档判定与 README 豁免（架构 §5.2）

**判定顺序**：先判定文件类别（知识文档 / 附件 / 特殊文件），再套用对应规则。

1. **知识文档**：扩展名（大小写不敏感）为 `.md` 的文件，套用 frontmatter 规则（§3）。
2. **README 豁免（导航文档）**：任意目录下、文件名小写后等于 `readme.md` 的文件（`README.md` / `Readme.MD` 等），豁免 frontmatter 规则（不产生 E-FM-*），语义为该目录的导航文档（架构 §2、§5.2）。豁免范围**仅限 frontmatter**：路径、类型、容量与危险 tree 条目规则（§4、§5）仍然适用。报告中对豁免文件以 `exempt: true` 标注。
   - 判定条件：文件名（含扩展名）小写 == `"readme.md"`；不限定目录层级——目录级导航是知识库的常规用法，仓库根 README 只是特例（设计裁决：全目录豁免优于仅根目录，coordinator 已批准）。
   - 同目录仅大小写不同的多个 README（如 `Readme.md` 与 `README.md`）在大小写不敏感文件系统上会冲突，由 E-PATH-004 拦截（§4）。
3. **管理员扩展豁免**：`validation.exemptions.additionalNavPatterns`（glob 清单）增加其他导航文件（如 `AGENTS.md`、`INDEX.md`）；`validation.exemptions.specialFilePatterns` 增加特殊/配置文件（如 `.editorconfig`）。扩展豁免同样仅免 frontmatter，不免路径/类型/容量规则（架构 §5.2）。
4. **附件与非 .md 文件**：不套用 frontmatter，但受类型与容量限制（§5）。
5. **删除与重命名**（架构 §5.2）：删除文件不做元数据校验；重命名按**目标路径**重新判定是否属于知识文档（改为 `.md` 即须有合法 frontmatter，改名为 README.md 即豁免）。

## 3. frontmatter 规则（架构 §5.1）

### 3.1 六字段（仅 title 必填）

机器可读定义：[schemas/frontmatter.schema.json](schemas/frontmatter.schema.json)。长度/数量上限为**版本化常量**（T2 建议值，随 rulesVersion 变更，不由管理员配置覆盖）。

| 字段 | 类型 | 必填 | 约束（版本化常量，T2 建议） | 缺省语义 | 依据 |
|---|---|---|---|---|---|
| title | 字符串 | **是** | 去空白后非空（至少一个非空白字符）；≤200 字符 | —— | §5.1（title 必填、去空白后非空） |
| owner | 字符串 | 否 | ≤100 字符 | 无 | §5.1（知识负责人，不等同最后修改人） |
| description | 字符串 | 否 | ≤500 字符 | 无 | §5.1（简短摘要） |
| tags | 字符串列表 | 否 | 每项 1–64 字符；≤32 项；不重复 | 无 | §5.1（字符串列表） |
| status | 字符串 | 否 | `active` / `draft` / `deprecated` | 缺省按 active 解释（不回写文件） | §5.1 |
| source | 字符串 | 否 | ≤500 字符 | 无 | §5.1（原始资料或依据） |

补充（均为架构 §5.1 原文要求）：

- **允许额外字段**，但其值同样只支持安全的基础 YAML 值（见 3.2）；示例：`department: 财务部`、`reviewers: [a, b]` 合法。
- **系统 ID、版本和更新时间不写入 frontmatter**；文档版本用 commit 标识，更新时间由 Git 历史派生。
- 网页新建或导入时可从文件名生成 title，提交前允许修改；不根据文件名自动断言真实来源。
- 编辑者和 Agent 按权限同样可修改 owner 等内容字段，不设 AI 专属禁改字段（架构 §5.2）。
- owner/description/source 缺失仅提示（W-FM-101），不阻断（架构 §5.3）。

### 3.2 YAML 安全子集

frontmatter 必须是 YAML 安全子集（架构 §5.1「只支持安全的基础 YAML 值，拒绝重复键与自定义对象标签，限制大小和解析资源」）：

- **允许**：标量（字符串/数字/布尔/null）、序列、映射。
- **拒绝**：重复键（E-FM-006）；自定义对象标签 `!Tag`（E-FM-007）；锚点 `&`、别名 `*`、合并键 `<<`（E-FM-007——同时防别名膨胀的资源攻击，对应 §5.1「限制解析资源」）；YAML 语法错误（E-FM-002）。
- **资源常量**（版本化，T2 建议）：frontmatter 块 ≤64 KiB、解析节点 ≤1000、嵌套深度 ≤8（E-FM-008）。

### 3.3 schema 违规 → 错误码映射

| schema/YAML 违规 | 错误码 |
|---|---|
| 知识文档缺少 frontmatter 块 | E-FM-001（§5.3） |
| YAML 解析失败（语法错误） | E-FM-002（§5.3） |
| title 缺失或去空白后为空 | E-FM-003（§5.1/§5.3） |
| 任一字段类型不符 | E-FM-004（§5.3） |
| status 非法取值 | E-FM-005（§5.1/§5.3） |
| YAML 重复键 | E-FM-006（§5.1） |
| 自定义 tag / anchor / alias / merge key | E-FM-007（§5.1） |
| frontmatter 大小/节点/深度超资源常量 | E-FM-008（§5.1） |
| 字段长度/数量/唯一性超常量 | E-FM-009（§5.1 常量为 T2 建议） |

正反示例：

```markdown
---
title: 差旅报销制度          # 合法：仅 title 必填即成立
owner: zhangsan
tags: [人事, 报销]
source: 财务部正式发文
---
```

```markdown
---
title: "   "                 # 非法：去空白后为空 → E-FM-003
status: archived             # 非法：status 枚举外 → E-FM-005
tags: 人事                   # 非法：tags 须为列表 → E-FM-004
secret: !exec "rm -rf /"     # 非法：自定义 tag → E-FM-007
---
```

## 4. 路径与 Git tree 条目规则

所有路径检查按 **Git tree 条目**执行（架构 §9），防目录逃逸与额外凭据访问。

### 4.1 路径合法字符集与形状（版本化常量，T2 建议值；依据架构 §9 防逃逸）

| 规则 | 常量/要求 | 违规码 |
|---|---|---|
| 编码与规范化 | UTF-8，且须为 **NFC** 规范形式（macOS 工作副本常见 NFD，提交前须规范化；否则同名两形态） | E-PATH-001 |
| 禁止形状 | 空路径组件、`.` / `..` 组件、前导 `/`（绝对路径）、反斜杠 `\`、以 `/` 结尾 | E-PATH-001 |
| 禁止字符 | 控制字符 U+0000–001F、U+007F–009F | E-PATH-001 |
| 组件首尾 | 组件不以空格或 `.` 结尾（Windows 兼容） | E-PATH-001 |
| 保留名 | 组件（去扩展名、不分大小写）不为 `CON PRN AUX NUL COM1–9 LPT1–9` | E-PATH-001 |
| 长度 | 单组件 ≤200 字节；全路径 ≤1024 字节 | E-PATH-001 |
| 深度 | ≤16 级目录 | E-PATH-001 |
| 允许字符 | Unicode 字母（含中文）、数字、空格及 `-_.()[]{}@,#%&=~;'!^+`（允许清单制；`/ \ : * ? " < > |` 及控制字符在禁止之列） | —— |

### 4.2 危险 tree 条目（架构 §9：第一版禁止符号链接和 submodule）

| 条目 | 违规码 | 依据 |
|---|---|---|
| tree 条目 mode `120000`（符号链接） | E-PATH-002 | §9 |
| tree 条目 mode `160000`（gitlink/submodule） | E-PATH-003 | §9 |
| 组件名为 `.git` 或文件 `.gitmodules` | E-PATH-005 | §9/T2 |
| 非法 mode（除 `100644`/`100755` 外） | E-PATH-005 | §9/T2 |
| 同一提交内仅大小写不同的两条路径 | E-PATH-004 | §9/T2（混合 macOS/Windows/Linux 协作的防丢文件建议） |

## 5. 附件、类型与容量限制（Q7）

架构 §9：文档大小、附件大小、单次 push 和库容量设**管理员可配置**限制；接收与校验进程限制时间、内存和并发。图像等小附件随 Git 保存。以下默认值全部为**建议值·待基准校正**（Q7：S3 实现期/S8 校正）；机器可读定义见 [validation-defaults.json](validation-defaults.json)。

### 5.1 默认值与配置项

| 配置键 | 默认值 | 单位 | 类型 | 变更级别 | 依据与说明 |
|---|---|---|---|---|---|
| `validation.limits.maxDocumentBytes` | 1048576 | bytes | 判定型 | 见 §7 B1 | §9 文档大小限制；1 MiB（建议） |
| `validation.limits.maxAttachmentBytes` | 10485760 | bytes | 判定型 | 见 §7 B1 | §9 附件大小限制；10 MiB（建议） |
| `validation.limits.attachmentAllowedExtensions` | [".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf"] | 扩展名清单 | 判定型 | 见 §7 B1 | §5.2/§9 类型规则；**svg 默认排除**——可内嵌脚本属安全边界（建议） |
| `validation.limits.maxPushBytes` | 52428800 | bytes | 判定型 | 见 §7 B1 | §9 单次 push 限制；50 MiB（建议） |
| `validation.limits.vaultCapacityBytes` | 5368709120 | bytes | 判定型 | 见 §7 B1 | §9 库容量限制；5 GiB（建议） |
| `validation.exemptions.additionalNavPatterns` | [] | glob 清单 | 判定型 | 见 §7 B1 | §5.2 管理员导航豁免扩展；默认空 |
| `validation.exemptions.specialFilePatterns` | [".gitignore", ".gitattributes"] | glob 清单 | 判定型 | 见 §7 B1 | §5.2 特殊/配置文件；默认最小清单（建议） |
| `validation.runtime.validationTimeoutMs` | 10000 | ms | 运维型 | 见 §7 B2 | §9 时间限制；单次校验运行（建议）；超时→E-RUN-001/退出码 2 |
| `validation.runtime.maxConcurrentValidations` | 4 | 并发数 | 运维型 | 见 §7 B2 | §9 并发限制；单实例（建议） |
| `validation.runtime.maxValidationMemoryMb` | 512 | MiB | 运维型 | 见 §7 B2 | §9 内存限制；单次校验（建议） |

### 5.2 类型规则

- 非 `.md` 文件必须是**附件**（扩展名命中 `attachmentAllowedExtensions`）或**特殊文件**（命中 `specialFilePatterns` / `additionalNavPatterns`），否则 E-LIMIT-002。**清单制（不在清单即拒绝）是 T2 设计裁决**：架构 §5.2 仅规定附件和配置文件不套用 frontmatter 但仍受类型规则约束、未逐类型列举放行范围，本契约结合架构 §12「第一版限制支持范围与容量」将其收紧为显式清单制（与 README 全目录豁免同属 coordinator 批准的设计裁决）。
- 扩展名匹配大小写不敏感；以实际字节内容做扩展名核验（伪装扩展名的深度内容检测不在第一版范围）。

### 5.3 容量与资源判定位置

- 文档/附件超限：逐文件判定（E-LIMIT-001/003）。
- push 总量超限（E-LIMIT-004）与库容量超限（E-LIMIT-005）：push 级判定，问题落在 `refs` 层面，不归属单文件。
- 超限必须给出可理解错误（roadmap 风险表：明确限制并测量）。

## 6. 结构化错误协议（架构 §5.3/§5.4）

### 6.1 严重级别、退出码与提示策略

- **severity**：`error`（阻断：拒绝提交/整次 push/不发布）、`warning`（提示但允许，架构 §5.3）、`info`（通知）。
- **退出码**（CLI/hook，架构 §5.4）：`0`=通过（可含 warning）、`1`=校验错误、`2`=运行错误。支持 `--json` 输出本协议报告。
- **提示策略**（架构 §5.3）：默认 CLI 只报告 warning；网页按需展开，避免大量可选字段提示阻碍正常贡献。外部链接与跨库链接第一版不做可达性检查；不做事实正确性自动判断。
- **错误码结构**：`^(E|W|N)-[A-Z]+-\d{3}$`；区域：FM=frontmatter、PATH=路径/tree、LIMIT=限制、RUN=运行时、LINK=链接、UPGRADE=升级提示。码与 rule id 一经发布为稳定标识（改名=MAJOR，见 §7）。

### 6.2 错误码注册表（全量，含定位字段与消息模板；severity 列为机器解析位）

| code | rule id | severity | 退出码 | 定位字段 | 消息模板（中文） | 依据 |
|---|---|---|---|---|---|---|
| E-FM-001 | frontmatter.missing | error | 1 | path | {path}：知识文档缺少 frontmatter（首行须为 `---`） | §5.3 |
| E-FM-002 | frontmatter.parse_failure | error | 1 | path, line | {path}：frontmatter YAML 解析失败：{actual} | §5.3 |
| E-FM-003 | frontmatter.title_required | error | 1 | path, line, field | {path}：{field} 缺失或去空白后为空；填写非空标题（≤200 字符） | §5.1/§5.3 |
| E-FM-004 | frontmatter.field_type | error | 1 | path, line, field | {path}：字段 {field} 类型错误，期望 {expected}，实际 {actual} | §5.3 |
| E-FM-005 | frontmatter.status_enum | error | 1 | path, line, field | {path}：status 非法取值 {actual}；允许 active/draft/deprecated（缺省 active） | §5.1/§5.3 |
| E-FM-006 | frontmatter.duplicate_key | error | 1 | path, line | {path}：frontmatter 存在重复键 {field} | §5.1 |
| E-FM-007 | frontmatter.unsafe_yaml | error | 1 | path, line | {path}：frontmatter 含不安全构造（自定义 tag/锚点/别名/合并键） | §5.1 |
| E-FM-008 | frontmatter.resource_limit | error | 1 | path, actual, limit | {path}：frontmatter 超资源常量（{limit}）；请精简元数据 | §5.1 |
| E-FM-009 | frontmatter.field_constraint | error | 1 | path, line, field, actual, limit | {path}：字段 {field} 违反约束 {limit}（实际 {actual}） | §5.1（常量为 T2 建议） |
| E-PATH-001 | path.invalid | error | 1 | path, actual, expected | {path}：路径不合法（字符集/NFC/形状/长度/深度/保留名）：{actual} | §9/T2 |
| E-PATH-002 | tree.symlink | error | 1 | path, actual | {path}：tree 条目为符号链接（{actual}）；第一版禁止，请改为常规文件 | §9 |
| E-PATH-003 | tree.gitlink | error | 1 | path, actual | {path}：tree 条目为 submodule/gitlink（{actual}）；第一版禁止 | §9 |
| E-PATH-004 | path.case_conflict | error | 1 | path, actual | {path}：与 {actual} 仅大小写不同；大小写不敏感系统上会互相覆盖 | §9/T2 |
| E-PATH-005 | tree.forbidden_entry | error | 1 | path, actual | {path}：禁止的 tree 条目（{actual}：.git 组件/.gitmodules/非法 mode） | §9/T2 |
| E-LIMIT-001 | limit.document_size | error | 1 | path, actual, limit | {path}：文档 {actual} 字节超上限 {limit}；请拆分 | §9 |
| E-LIMIT-002 | limit.file_type | error | 1 | path, actual, expected | {path}：文件类型 {actual} 不在允许清单 {expected} | §5.2/§9 |
| E-LIMIT-003 | limit.attachment_size | error | 1 | path, actual, limit | {path}：附件 {actual} 字节超上限 {limit} | §9 |
| E-LIMIT-004 | limit.push_size | error | 1 | ref, actual, limit | {ref}：本次 push 总量 {actual} 字节超上限 {limit}；请分批推送 | §9 |
| E-LIMIT-005 | limit.vault_capacity | error | 1 | ref, actual, limit | {ref}：库容量将超上限 {limit}（当前+本次 {actual}）；请清理或申请扩容 | §9 |
| E-RUN-001 | run.timeout | error | 2 | limit | 校验运行超时/资源超限（{limit}）；本次操作被拒绝，可重试或减小规模 | §9 |
| E-RUN-002 | run.internal | error | 2 | —— | 校验内部错误：{actual}；请重试并反馈管理员 | §5.4 |
| W-FM-101 | frontmatter.optional_field_missing | warning | 0 | path, field | {path}：可选字段 {field} 缺失；不影响提交 | §5.3 |
| W-LINK-101 | link.intra_vault_missing | warning | 0 | path, line, actual | {path}：库内相对链接目标 {actual} 不存在 | §5.3 |
| N-UPGRADE-001 | upgrade.rules_stale | info | 0 | message | 客户端校验规则为 {actual}，服务端为 {expected}；请运行 notegit setup 更新 | §5.4 |

**行号语义**：`line` 为知识文档内 1 起始行号（frontmatter 区或链接所在行）；tree/容量级问题无行号，省略字段。

**限制类定位字段语义**（消除歧义的固定约定）：`limit` = 数值上限（整数）；`limitKey` = 对应配置键（字符串，如 `validation.limits.maxDocumentBytes`），两者互补可同报；push 级问题（E-LIMIT-004/005、E-RUN-001）以 issue 的 `ref` 字段定位所属 ref，不落在单文件上。

### 6.3 报告 JSON 形状（machine-readable）

Schema：[schemas/validation-report.schema.json](schemas/validation-report.schema.json)（JSON Schema 2020-12）。要点：

- 顶层必填：`rulesVersion`、`scope`、`result`（pass/fail/error）、`exitCode`（0/1/2，schema 以 if/then 锁定与 result 的映射）、`summary`（filesTotal/filesPassed/filesFailed/errorCount/warningCount）、`files[]`。
- **部分通过/部分失败**：`files[]` 逐文件 `status: pass|fail` 与 `issues[]`；存在任一 error ⇒ `result=fail`。示例见 [examples/report-field-errors-partial.json](examples/report-field-errors-partial.json)（同批 1 过 1 败）。
- **push 全有或全无**：scope=pre-receive 时 `refs[]` 必填（schema 强制）；`result=fail|error` ⇒ 所有 `outcome=rejected`，服务端不做部分接受；`files[].commit` 定位引入问题的新提交（逐提交检查，§5.4）。示例见 [examples/report-push-multiref.json](examples/report-push-multiref.json)。
- 运行级问题（超时/内部错误）置于顶层 `issues[]`，`result=error`、退出码 2；示例见 [examples/report-runtime-error.json](examples/report-runtime-error.json)。
- 网页提交示例（scope=web-submit，失败不发布、保留草稿、README 以 `exempt: true` 标注）：[examples/report-web-submit-draft-rejected.json](examples/report-web-submit-draft-rejected.json)。
- 通过含警告示例：[examples/report-pass-with-warnings.json](examples/report-pass-with-warnings.json)；危险 tree 示例：[examples/report-dangerous-tree.json](examples/report-dangerous-tree.json)。
- 错误输出标明规则版本（`rulesVersion`，§5.4）；客户端规则过期时服务端附 `notices[]` 的 N-UPGRADE-001（版本差异本身不构成拒绝理由——判定一律以服务端规则为准）。

## 7. 规则版本化（Q4）

### 7.1 版本号语义

- `rulesVersion` 采用 **SemVer**（`MAJOR.MINOR.PATCH[-prerelease]`）；当前 `1.0.0-draft.2`（status: draft），S3 实现定稿升 `1.0.0`。
- **唯一机器来源**：[rules-version.json](rules-version.json)（含 changelog）。每次规则变更：升版本号 + changelog 记录（版本、日期、变更点、默认值变更须记**旧值→新值**）。
- 判定「兼容/破坏」的准绳：**默认配置下的内容接受集**与**协议形状**是否变化。

### 7.2 三类变更情形

**情形 A：加字段（新增可选能力）→ MINOR**

适用：新增可选 frontmatter 字段（含其常量）、新增可选配置项、新增 W-/N- 码、报告新增**可选**字段。理由：旧校验器按 §5.1「允许额外字段」忽略新字段，既有内容判定不变。
边界（与 B1 衔接，不得借道）：新增配置项若其**默认值**使默认配置下原本接受的内容被拒绝（例如新键默认拒绝某类文件），属 B1「收紧」情形，按 MAJOR 处理；A 的 MINOR 仅覆盖不缩小接受集的新增。
例外：新增 **E- 码**必然伴随新拒绝规则（接受集收缩）→ 按情形 C 升 MAJOR；仅当新码是既有码的等价细分并在 changelog 声明为兼容别名时可为 MINOR。

**情形 B：改默认值 → 分两类（不得互相打洞）**

**B1 判定型默认值**（`validation.limits.*`、`validation.exemptions.*`——改变默认配置下的内容接受集或安全边界）：

| 变化方向 | 版本级别 | 说明 |
|---|---|---|
| 收紧（默认配置下原本接受 → 拒绝） | **MAJOR** | 与情形 C「接受集收缩」同规，不得借「只是改默认值」降级 |
| 安全边界放宽（附件类型加项、路径字符集/危险条目放宽等扩大危险面） | **MAJOR** | 放宽的是安全边界，按破坏性变更处理 |
| 非安全放宽（如调大非安全长度/容量上限：仅使原本拒绝 → 接受，不扩大危险面） | MINOR | 部署可固定配置；旧客户端可能误拒，由 N-UPGRADE-001 引导升级 |

**B2 运维型默认值**（`validation.runtime.*`：超时/并发/内存——不改变内容接受集判定，超时产出的是 E-RUN-001 运行错误/退出码 2，不是内容判定）：任何调整 → **MINOR**，changelog 记录旧值→新值。

两类以 `validation-defaults.json` 的 `kind` 字段（verdict/operational）机器可分；新增判定型配置键归 B1，新增运维型归 B2。

**情形 C：删字段/破坏性变更 → MAJOR**

适用：删除或更名 frontmatter 字段、配置键、错误码、rule id；收紧 schema 硬规则或路径字符集（接受集收缩，含 B1 收紧情形）；报告必填字段删除、更名或语义反转；版本号语义本身变更。MAJOR 发布时服务端与全部分发物（CLI/hook/网页）同步升级。

**PATCH**：消息文案修正、文档澄清——不改接受集、不改协议形状。

### 7.3 三端引用同一版本的方式（S3 验收场景）

1. **单一来源**：三端实现（hook 校验程序、服务端 pre-receive/发布组件、网页提交组件）在构建/发布时从同一 git 路径 `docs/contracts/`（schema + rules-version.json + defaults）取定义，不各自复制维护。
2. **运行时权威**：服务端版本为准（§5.4）。每份报告必带 `rulesVersion`；pre-receive 在客户端上报/本地规则版本与服务端不一致时附 N-UPGRADE-001。
3. **可校验引用**：T4 spike 与 T5 API 契约引用「`docs/contracts/rules-version.json` 的 `rulesVersion`」作为同一版本标识（sprint S1 场景 S3 的核对点）。
4. 部署级偏差（管理员改配置）不改变 `rulesVersion`（配置≠规则版本）；配置快照记录于服务端配置管理，与本契约的版本化解耦。

## 8. 验证工具（本契约自检门禁）

```sh
pip3 install --user jsonschema   # 依赖：python3 ≥3.9，jsonschema ≥4
python3 docs/contracts/tools/verify_validation_contracts.py
```

检查：schema 2020-12 元校验；全部报告示例过 schema；frontmatter object 用例过 schema；示例错误码全部在注册表；severity 与前缀一致；示例 `rulesVersion` == manifest；defaults JSON 与本文 §5.1 表双向一致；result↔exitCode 映射；fail ⇒ refs 全 rejected。建议 T6 将本命令登记为 contracts gate。

## 9. 开放项（待校正/待定稿）

- **Q7 校正**：§5.1 全部默认值为建议值，S3 实现期以 Q2 部署规格、S8 以实际基准校正（校正值按 §7.2 定版本级别）。
- **$id 占位域名**（`notegit.local`）：T1 选型定案后由实现固定真实 $id，保持文件路径与 `rulesVersion` 机制不变（PATCH 级）。
- **定稿**：S3 实现首版校验通过验收后，`1.0.0-draft.2 → 1.0.0`（status: final），changelog 记录。
- E-LIMIT-004/005 的超限计量精确口径（打包对象字节数 vs 解压字节数）在 S3 实现时确认；`ref` 定位字段已纳入 schema（issue 级）。
- §3.1/§3.2/§4.1 的版本化常量目前同时存在于 schema 与文档文本，门禁未做两者机器交叉核对——S3 定稿时建议提取常量清单文件或由代码生成文档表，消除该漂移面。
- 本契约为 S1 草案：**不宣称 E1 DoD（含 DOD-05）完成**；DOD-05 的实证（暂存区/服务端/网页同规则、各绕过路径实测拦截）属 S3/S9 验收。
