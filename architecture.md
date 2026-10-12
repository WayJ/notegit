# Notegit 架构设计文档

| 项目 | 内容 |
|---|---|
| 项目名称 | **Notegit**（暂定，最终以 GitHub 仓库名为准） |
| 版本 | v0.1（架构草案） |
| 定位 | 团队 Markdown 知识库：网页 UI 给人用，CLI 给 AI 用，按库分权限，Markdown 文件为唯一存储 |
| 目标读者 | Notegit 工具开发者、Agent Harness 维护者、未来参与开发的 AI Agent |
| 配套文档 | 《知识库PRD》、《知识库元数据Schema设计》 |

---

## 0. 阅读指引（给 Agent 的）

本文档不只是"设计说明"，也是**给未来 Agent 开发用的执行纲要**。每个决策都明确给出：

- **是什么**（What）
- **为什么**（Why，决策理由，方便 Agent 在遇到新需求时一致扩展）
- **怎么落地**（How，给开发者/Agent 的可操作约束）
- **决策日志**（哪一节哪个版本定的，方便追溯）

Agent 在执行任务前应：

1. 先通读第 1、2、3 节（背景、目标、概念）
2. 涉及模块开发时再读对应章节（UI → §6，CLI → §7，Schema → §5）
3. 涉及与外部系统（Git 平台、Agent Harness）协作时读 §8
4. 修改任何决策时，必须先在 §13 决策日志追加新条目

---

## 1. 背景与问题

### 1.1 问题

企业内多人共用一个 Markdown 知识库，三个核心痛点：

1. **副本过期**：别人改了，我还在旧版上编辑，提交时冲突
2. **写入无序**：人或 Agent 直接改主干，没有审核，污染知识库
3. **格式漂移**：frontmatter 缺失、字段不统一、目录规范无人守

### 1.2 目标

- 知识以**多级目录 + Markdown 文件**为唯一形态，不引入专有存储
- 多人/多 Agent 共用，通过 Git 协作，权限由 Git 平台控制
- Agent 能直接在本地文件夹中 `grep`、读取、导航
- 工具只解决协作特有痛点，不重复 Git 和 Shell 的能力

### 1.3 非目标（本期明确不做）

- 不做全文检索服务（用 `rg` 即可）
- 不做语义检索（后续按需扩展）
- 不实现自有权限模型（交给 Git 平台）
- 不做 Web UI 框架选型之争、不做知识图谱

> **Agent 提示**：遇到"是否要加 X 功能"的判断时，先看它是否在 1.3 列出的非目标里。是 → 拒绝；否 → 进入决策日志。

---

## 2. 用户角色

| 角色 | 说明 | 核心诉求 |
|---|---|---|
| 普通员工 | 知识的读者和贡献者 | 快速找到最新知识；方便提交自己的更新 |
| 库管理员 | 某个知识库负责人 | 管理本库成员和权限；审核本库的修改 |
| AI 助手（Agent） | 企业内的智能助手 | 拿到当前用户有权看的知识；安全地提交更新 |
| 系统管理员 | 平台运维者 | 管理整体配置、用户与库的创建 |

---

## 3. 核心概念

| 概念 | 定义 |
|---|---|
| **库（Vault）** | 一个 Git 仓库，对应一个知识域，是权限的最小单位 |
| **知识库根目录** | `~/knowbase/`，所有有权限的库平铺在此 |
| **工作副本** | 每个库在 `~/knowbase/<vault-name>/` 下的本地克隆 |
| **知识单元** | 一个 `.md` 文件，含 YAML frontmatter + 正文 |
| **元数据 Schema** | 文档顶部 6 个字段，详见《知识库元数据Schema设计》 |

---

## 4. 整体架构

```
┌─────────────────────────────────────────────────────────┐
│                     Git 平台（GitLab/GitHub）             │
│   knowledge/company-public   knowledge/hr-policy         │
│   knowledge/product-docs     knowledge/eng-arch          │
│   ── 仓库级权限，由平台控制 ──                            │
└──────────────────────┬──────────────────────────────────┘
                       │ API: 列出用户可见仓库
                       │ Git: clone / pull / push
                       ▼
┌─────────────────────────────────────────────────────────┐
│                    Notegit（CLI / 守护进程）              │
│   notegit sync     发现可见仓库 → clone/pull → 报告变化  │
│   notegit submit   检测改动 → 分支 → PR → CODEOWNERS     │
│   notegit lint     校验 frontmatter / 规范 / 来源标注     │
│   notegit daemon   后台自动同步（可选）                   │
└──────────────────────┬──────────────────────────────────┘
                       │ 文件系统
                       ▼
┌─────────────────────────────────────────────────────────┐
│                    ~/knowbase/                           │
│   company-public/   hr-policy/   product-docs/           │
│   ── 平铺，一层 ──                                       │
└──────────────────────┬──────────────────────────────────┘
                       │ ls / cat / rg / $EDITOR
                       ▼
┌─────────────────────────────────────────────────────────┐
│              Agent Harness / 人                          │
│   Agent 直接在 ~/knowbase/ 下 grep、读文件、按需导航     │
│   写入走 notegit submit，不绕过审核                       │
│   网页用户则走 Notegit Web（独立模块）                    │
└─────────────────────────────────────────────────────────┘
```

**设计原则**：

- 文件系统是 source of truth，索引和状态都可从文件重建
- 权限的权威来源是 Git 平台，`notegit` 不实现第二套权限
- CLI 是操作层，不是存储层；读用原生工具，只包装写和同步

> **决策**：本地布局 `~/knowbase/` 是给 Agent 用的高级接口；Notegit Web 有自己的存储与渲染（独立模块），不要求共享同一目录。

---

## 5. 知识单元格式（Schema）

### 5.1 文件结构

```markdown
---
title: 差旅报销制度
description: 差旅费用报销的适用范围、标准与办理时限
owner: zhangsan
tags: [人事, 报销]
status: active
source: 财务部发文 2026-01 第 3 号
---

# 差旅报销制度

正文内容……
```

### 5.2 字段定义（仅 6 字段）

| 字段 | 必填 | 说明 | 谁来填 |
|---|---|---|---|
| `title` | ✅ | 文档标题 | 上传时自动取文件名，可改 |
| `owner` | ✅ | 文档负责人 | 默认为上传人，可改 |
| `description` | ❌ | 一句话摘要，供列表/搜索/AI 快速判断 | **AI 自动生成**，用户可改 |
| `tags` | ❌ | 自由标签 | 用户 |
| `status` | ❌ | `active` / `draft` / `deprecated` | 用户 |
| `source` | ❌ | 发文号/制度版本/外部链接 | **默认取上传文件名，AI 修正** |

### 5.3 自动生成规则

| 时机 | 行为 |
|---|---|
| 上传文件 | `description` 由 AI 读正文后填；`source` 默认取文件名，若为正式发文类由 AI 提取发文字号 |
| 网页新建 | `description` 留空，保存时 AI 尝试生成供确认 |
| 编辑保存 | 系统自动记录 `updated` 时间与版本号（不写进 frontmatter） |
| AI/CLI 写入 | 同编辑；AI 不得改 `owner`（提交时校验） |
| 存量文档 | 系统按目录批量派发给管理员确认 `owner` 和 `tags` |

> **决策**：系统字段（id、updated、version、checksum）一律不入 frontmatter——它们属于系统内部，**避免用户被字段淹没**。前端需要时由系统提供，不依赖用户自己维护。
> **完整规范**：见独立文档《知识库元数据Schema设计》，本文不重复。

---

## 6. 知识库模块（Web UI）

### 6.1 能力清单

- **库与权限管理**：按库分角色（阅读/编辑/管理员），用户只见自己有权限的库
- **多级目录浏览**：列表/树形导航、拖拽排序、按更新时间与标签筛选
- **搜索**：标题 + 标签 + 摘要（本期不做正文搜索）
- **上传**：拖拽 / 多选 / 整文件夹；支持 **Word、PDF、Markdown、TXT**
- **自动解析**：上传后统一转 Markdown 固化入库；解析失败时明确提示，不静默入库
- **预览 + 编辑**：富文本/Markdown 双模编辑器，自动存草稿
- **历史版本**：每文档独立版本列表，对比查看，一键还原（还原本身也留记录）
- **修改审核**：库可按需开启审核；审核人看 diff，可批准/驳回
- **回收站 + 收藏 + 标签筛选**

### 6.2 上传与解析

| 输入 | 行为 |
|---|---|
| `.docx` | 提取正文 + 图片，保留标题层级，转 Markdown |
| `.pdf` | 提取可编辑文本（扫描版提示用户） |
| `.md` | 原样入库，校验 frontmatter |
| `.txt` | 原样入库，按段落转 Markdown |

转换完成后弹"上传确认页"：用户可改 title、owner、tags、status，**`description` 和 `source` 由 AI 预填并标注"AI 生成"**，用户可一键修改。

### 6.3 文档元数据（Schema）

- 每篇文档顶部 6 字段元数据，用户**通过表单填写**，不接触 YAML
- 时间/版本/编号由系统自动记录
- 详细规则见《知识库元数据Schema设计》

### 6.4 权限

- 库的三级角色：**可阅读 / 可编辑 / 管理员**
- 权限来源：Git 平台仓库成员 + 平台 SSO（Notegit Web 内置成员管理，但底层仍映射到 Git 仓库权限）
- 未被授权的库不出现、不可搜索——**防信息泄露**

### 6.5 历史与审核

- 任何保存生成版本（修改人、时间、可选说明）
- 库开审核：修改进入待审，审核人 diff 后批准/驳回（驳回必填理由）
- 库关审核：修改直接生效，仍留版本
- 待审期间其他人看到的是修改前版本

> **决策**：默认**全库开启审核**，小团队可一库一关。

---

## 7. 命令行工具（CLI / Agent 用）

### 7.1 命令总览

| 命令 | 职责 | 频率 |
|---|---|---|
| `notegit sync` | 发现 + 同步 + 报告变化 | 高频 |
| `notegit submit` | 提交改动，走分支 + PR | 中频 |
| `notegit lint` | 校验规范 | CI + 本地 |
| `notegit ls` | 列出本地库（给 Agent） | 低频 |
| `notegit daemon` | 后台自动同步（可选） | 常驻 |

**不做**：`ls` / `cat` / `find` / `grep` / `edit` / `git` 子命令——这些都是 Shell 的活。

### 7.2 `notegit sync`

```
1. 读 .notegit/config.toml，取平台地址和 token
2. 调 API 列出当前用户可见的仓库
3. 对比 .notegit/state.json
4. 新增 → clone（默认 depth=1）
   已存在 → git pull
   失去权限 → 标记（--prune 时删除）
5. 用内容指纹判断哪些文件"真的变了"
6. 更新 state.json
7. 报告变化
```

参数：

| 参数 | 说明 |
|---|---|
| `--prune` | 删除失去权限的本地副本（有未提交修改则先备份） |
| `--vault <name>` | 只同步指定库 |
| `--depth <n>` | 克隆深度，默认 1 |
| `--full` | 全量克隆 |
| `--quiet` | 静默模式，供 cron / daemon 使用 |
| `--json` | 结构化输出，供 Agent 消费 |

### 7.3 `notegit submit`

```
1. 检测 ~/knowbase/ 下所有改动
2. 按库分组
3. 每个库：创建分支 → commit → push → 创建 PR
4. reviewer 由仓库 CODEOWNERS 自动分配
5. 提交信息 -m 必填
```

参数：

| 参数 | 说明 |
|---|---|
| `-m <msg>` | 提交信息（必填） |
| `--vault <name>` | 只提交指定库 |
| `--direct` | 直接提交到 main，跳过 PR |
| `--no-branch` | 不创建分支，在当前分支提交 |
| `--json` | 结构化输出 |

### 7.4 `notegit lint`

校验项：

- 每个 md 有 frontmatter
- 必填字段存在（title / owner）
- updated 是合法日期（系统字段，不在 frontmatter，仅校验系统状态）
- status 取值合法
- 文件名不含非法字符
- （可选）事实性段落有来源标注 — warning

### 7.5 `notegit ls`

给 Agent 用的库列表：

```bash
$ notegit ls --json
{
  "vaults": [
    {"name": "company-public", "path": "~/knowbase/company-public", "files": 42, "updated": "2026-10-08"},
    {"name": "hr-policy", "path": "~/knowbase/hr-policy", "files": 18, "updated": "2026-10-08"}
  ]
}
```

### 7.6 `notegit daemon`（可选）

- 监听文件保存，静默 3 秒后自动 submit
- 每 60 秒轮询远端，自动 pull
- 开机自启（systemd / launchd）
- `notegit pause` / `notegit resume` 临时控制
- **默认不启用**，保留显式 CLI 可控性

---

## 8. 与 Agent Harness 集成

### 8.1 读路径

Agent 直接在 `~/knowbase/` 下操作：

```bash
rg "报销流程" ~/knowbase/ -t md -l
rg "报销" ~/knowbase/hr-policy/ -t md -C 3
cat ~/knowbase/hr-policy/报销.md
ls ~/knowbase/
notegit ls --json
```

**Agent 不需要知道权限逻辑**——它看到的就是用户有权访问的所有库，权限已在 `notegit sync` 阶段由 Git 平台决定。

### 8.2 导航模式（Agent 工作流）

```
1. notegit ls --json → 知道有哪些库
2. 读 <vault>/README.md → 知道库内结构
3. 进子目录 → 读 README.md
4. rg 定位具体文件
5. cat 读取
6. 回答，附引用路径
```

### 8.3 写路径

**MCP 只读，写入走 CLI**（借鉴职责分离）：

```
读 → notegit serve --mcp（只读工具：list / read / search）
写 → notegit submit（分支 + PR + reviewer）
```

MCP 工具集（计划）：

```
notegit_list_vaults()
notegit_list_dir(vault, path)
notegit_read_file(vault, path)
notegit_search(query, vault?, path_prefix?, top_k?)
notegit_get_meta(vault, path)
```

Agent 通过 MCP 查询，要改内容必须走 `notegit submit`，**不绕过审核**。

### 8.4 Harness 启动钩子

Harness 启动时跑一次：

```bash
notegit sync --quiet
```

确保 Agent 看到的是最新知识。

### 8.5 AI 修改的可追溯性

- 所有 AI 发起的修改在 git commit 信息中标注 `[by-agent]`
- 在 Web 历史中显示"由 AI 提交，待某某审核"
- **AI 不得自行调整**：`owner`、`ai_access` 字段（提交时校验）

---

## 9. 配置文件

### 9.1 `.notegit/config.toml`（本地，不进 Git）

```toml
[platform]
type = "gitlab"
url = "https://gitlab.corp.com"
token_env = "NOTEGIT_TOKEN"

[discover]
group = "knowledge"

[clone]
depth = 1
root = "~/knowbase"

[sync]
prune_on_revoke = false
auto_sync_interval = "1h"

[identity]
source = "git_email"
```

### 9.2 仓库内 `CODEOWNERS`（进 Git，平台原生）

```
# hr-policy/CODEOWNERS
*      @HR
薪酬/   @HR-Comp
```

`notegit submit` 不解析此文件，reviewer 由 Git 平台自动分配。

---

## 10. 实现要点（给开发者/Agent）

### 10.1 技术选型

| 组件 | 推荐 | 理由 |
|---|---|---|
| CLI 语言 | Go 或 Rust | 单二进制分发，零依赖 |
| CLI 框架 | cobra / clap | 成熟 |
| Git 操作 | 直接调 `git` 命令 | 稳定，无需重新实现 |
| Frontmatter 解析 | `gopkg.in/yaml.v3` / `gray-matter` | 简单 |
| 内容指纹 | 标准库 sha256 | 无需依赖 |
| 平台 API | 官方 SDK 或 REST | GitLab / GitHub 都有 |
| Web（独立模块） | 暂不约束（可 Next.js / Rails / Django） | 本期重点是 CLI |

**不引入**：数据库、向量库、消息队列。

### 10.2 路径解析

从当前目录向上找 `.notegit/`，逻辑同 git 找 `.git/`。找到则为知识库根，找不到报错。

### 10.3 内容指纹

```go
func fingerprint(path string) string {
    meta, body := parseFrontmatter(path)
    normalized := normalize(body)
    return sha256(meta + normalized)
}
```

用途：sync 判断"内容真变了"还是"只改了格式"；跨库移动文件时识别"同一知识"。

### 10.4 并发

- `notegit sync` 多库可并行 clone/pull（限制并发数，如 4）
- 写 `state.json` 加文件锁，避免多个 `notegit` 进程冲突
- daemon 与手动命令共享锁

### 10.5 错误处理

| 场景 | 行为 |
|---|---|
| token 过期 | 提示重新登录，不静默失败 |
| 网络不可达 | 保留本地状态，下次重试 |
| 推送被拒（无权限） | 熔断该库推送，降级只读 |
| 冲突 | 报告冲突文件，提示手动解决 |
| 磁盘满 | clone 前检查剩余空间 |

---

## 11. 部署与分发

### 11.1 安装

```bash
# 方式一：单二进制
curl -fsSL https://notegit.dev/install.sh | sh

# 方式二：包管理器
brew install notegit
apt install notegit

# 方式三：Go
go install github.com/notegit/notegit@latest
```

### 11.2 初始化

```bash
notegit init --platform gitlab --url https://gitlab.corp.com --group knowledge
```

生成 `.notegit/config.toml`，提示设置 `NOTEGIT_TOKEN` 环境变量。

### 11.3 CI 集成

每个知识库仓库的 CI 加一步：

```yaml
lint:
  script:
    - notegit lint
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
```

不合规不允许 merge。

---

## 12. 演进路线

| 阶段 | 内容 | 周期 |
|---|---|---|
| **MVP** | `notegit sync` / `notegit submit` / `notegit lint` + `rg` | 2–3 周 |
| **第二阶段** | `notegit ls --json`、`notegit serve --mcp`（只读）、CI 集成 | 1–2 周 |
| **第三阶段** | `notegit daemon`、内容指纹优化、来源标注 lint | 2 周 |
| **后续** | Notegit Web 上线、语义检索（可选）、知识巡检 | 按需 |

**原则**：先让 `sync / submit / lint` 跑顺，再考虑自动化和增强。

---

## 13. 决策日志（决策沟通信息）

> **使用约定**：本节是 Notegit 项目的"宪法"——所有非显而易见的决策在此沉淀。Agent 在执行任务时若发现需要修改决策，必须先在本节追加新条目（日期、议题、决策、理由），再动代码。

### D-001 · 命名：Notegit
- **日期**：2026-02
- **议题**：项目名
- **决策**：采用 `notegit`
- **理由**：
  - Markbase 已被 npm 长期占用（同名静态站点生成器 0.0.6），不具法律可行性
  - Vaultmd / mdvault / knb / notevault / notehub / mdkb 均已被占用
  - notegit 语义直白（Note + Git），与产品定位（团队笔记走 Git 协作）一致
  - CLI 风格自然：`notegit vault sync` 读起来顺畅
  - GitHub/npm/PyPI 全空
- **回退方案**：gitscribe → konb

### D-002 · Schema：6 字段
- **日期**：2026-02
- **议题**：frontmatter 字段范围
- **决策**：`title` / `owner`（必填）+ `description` / `tags` / `status` / `source`（可选）
- **理由**：
  - 用户反馈"复杂了"，精简为最常用 6 个
  - 系统字段（id/updated/version/checksum）一律不入 frontmatter，**减少用户认知负担**
  - `description` 由 AI 自动生成、`source` 默认取上传文件名 + AI 修正，**让用户只填最关键的两项**
- **回退**：若有用户场景明确需要（如 review 流程、敏感级别），按"非破坏性新增"原则扩展，不删除现有字段

### D-003 · 存储：文件系统为唯一 source of truth
- **日期**：2026-02
- **议题**：是否引入数据库/索引
- **决策**：不引入；Git 工作副本 + Markdown 文件即存储
- **理由**：
  - 与"不重复 Git 和 Shell"原则一致
  - Agent 可直接 `rg`，无需任何中间层
  - 索引（如果需要）必须可从文件系统重建
- **回退**：若性能/搜索成瓶颈，仅引入**可重建**的派生索引（如 SQLite FTS5），仍以文件为准

### D-004 · 权限：交给 Git 平台
- **日期**：2026-02
- **议题**：Notegit 是否自建权限模型
- **决策**：不建；库即 Git 仓库，权限由 Git 平台控制
- **理由**：
  - 避免"两套权限"的灾难
  - 用户最熟悉的权限载体就是 Git
  - 通过发现机制（API 列出用户可见仓库）天然融入平台权限
- **回退**：如需"文档级"细粒度（"这库我能看，但这文档不想让 AI 读"），按需增加元数据开关（**本期不做**）

### D-005 · 审核：默认开启，按库可关
- **日期**：2026-02
- **议题**：是否所有修改都走 PR
- **决策**：默认开审核；小团队可在库设置中关闭
- **理由**：
  - 知识库的核心价值是"可信"，没人审核等于笔记
  - 但强制审核会让小团队/个人知识库摩擦过大
  - 库级开关给了团队自治空间
- **回退**：若企业有更强合规要求（多人审批），按需扩展

### D-006 · Agent 写入：必须走 submit，不绕过
- **日期**：2026-02
- **议题**：Agent 是否能直接 git push
- **决策**：不能。Agent 改本地后必须 `notegit submit`，由 CLI 走分支+PR
- **理由**：
  - 审核是知识库的可信保障，Agent 不能破坏
  - 即使 CLI 内部也是调 git，但统一走 `notegit submit` 入口便于审计
- **落地**：
  - CLI 提交时在 commit 信息中加 `[by-agent]` 前缀
  - Web 历史显示"由 AI 提交，待某某审核"
  - **AI 不得改 `owner` 字段**（提交时校验，改即拒绝）

### D-007 · MCP：只读，写入走 CLI
- **日期**：2026-02
- **议题**：Agent 与 Notegit 的接口
- **决策**：MCP 工具集只暴露 list/read/search；任何变更走 `notegit submit`
- **理由**：
  - MCP 是查询接口，不应是写入接口
  - 强制走 CLI 入口 = 强制走审核 = 不绕过
- **MCP 工具集（计划）**：`notegit_list_vaults` / `notegit_list_dir` / `notegit_read_file` / `notegit_search` / `notegit_get_meta`

### D-008 · daemon：可选，默认关闭
- **日期**：2026-02
- **议题**：是否默认开后台守护进程
- **决策**：默认关闭；显式启用
- **理由**：
  - "显式 > 隐式"，避免用户被莫名后台行为惊吓
  - 适合追求"零命令"的团队可选启用
- **回退**：用户反馈摩擦大可改默认

### D-009 · 本地目录：扁平一层 `~/knowbase/`
- **日期**：2026-02
- **议题**：本地库的组织方式
- **决策**：所有库平铺 `~/knowbase/<vault-name>/`
- **理由**：
  - Agent `rg` 路径短，可读性好
  - 仓库名即知识域，**不需再用目录表达分类**
  - 跨库移动文件不会因层级变化而混乱

### D-010 · CLI 实现：Go 或 Rust，不引前端栈
- **日期**：2026-02
- **议题**：CLI 编程语言
- **决策**：Go 或 Rust（择一），单二进制分发
- **理由**：
  - 零依赖分发（用户不装 Node/Python）
  - 性能/并发原语对 clone 多库、文件指纹都合适
  - 跨平台一致
- **未定**：最终 Go 还是 Rust，由实现阶段决定（**决策待补 D-011**）

### D-011 · 待定
- CLI 语言最终选型（Go vs Rust）
- Web 框架选型
- 内容指纹算法版本

---

## 14. 风险与边界

| 风险 | 说明 | 缓解 |
|---|---|---|
| **不是安全边界** | 能 clone 仓库的人能拿全部内容 | 硬隔离需拆仓库 |
| **权限收紧有延迟** | 本地已有文件，下次 sync 才清理 | 提示 + `--prune` |
| **浅克隆缺历史** | `depth=1` 时 `git log` 受限 | 按需 `--full` |
| **跨库引用失效** | md 链接跨库时相对路径失效 | 约定 `notegit://` 协议（**D-012 待定**） |
| **Agent 绕过审核** | 直接 `git push` 可绕过 `notegit submit` | 平台分支保护规则 |

---

## 15. 附录：与现有方案对比

| 维度 | vaultmd（npm） | mdvault（PyPI） | markbase（npm） | **Notegit** |
|---|---|---|---|---|
| 知识来源 | md 文件 | md 文件 | md 文件 | md 文件 |
| 团队协作 | 无 | 无 | 无 | **Git + 审核** |
| 权限 | 无 | 无 | 无 | **Git 平台** |
| AI 友好 | 数据层 | MCP 检索 | 静态站点 | **CLI + MCP 只读** |
| 写入治理 | 无 | 无 | 无 | **PR + 审计** |
| 跨平台分发 | Bun | Python | Node | **单二进制（Go/Rust）** |

**Notegit 的核心差异**：**不是"又一个本地知识库工具"，而是"团队 + AI 共用的可信知识层"**——本地存储 + Git 协作 + 权限治理 + AI 友好四件套。

---

**文档结束。**

> 给未来 Agent 的最后提示：在执行开发任务前，**先读 §13 决策日志**——它告诉你哪些是"已经定下的"、哪些是"待定的"。不要在没有决策日志条目支撑的情况下修改本文档的核心决策。
