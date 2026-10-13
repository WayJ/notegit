# 安装与快速上手（员工视角）

从拿到账号到能在网页和本地两条通道工作的最短路径：**登录 → 浏览 → 编辑 → 上传 → 历史 → 搜索**，最后装 CLI。

- 网页端无需安装——浏览器打开服务器地址即可。
- 命令行（CLI + 原生 Git）适合批量整理和 Agent 协作，安装见文末。
- 角色与撤权的完整语义见[权限与撤权边界](permissions.md)；双通道贡献细节见[贡献流程](contributing.md)。

## 0. 你会从管理员那里拿到什么

管理员邀请你时会创建账号并给你一段**一次性口令令牌**（30 分钟内有效、只能用一次，经企业内渠道交付）。首次使用要先用它设置自己的口令；此外别无自助注册途径。

## 1. 首次设口令并登录

登录页没有「忘记密码/首次激活」表单，首次设口令经一次性令牌消费端点完成（任意有 curl 的机器即可）：

```sh
# 用管理员给的一次性令牌设置口令（口令长度须在 12–64 个字符之间）
curl -fsS -X POST https://<服务器地址>/api/v1/auth/password-reset \
  -H 'content-type: application/json' \
  -d '{"reset_token":"<一次性令牌>","new_password":"<你的新口令>"}'
```

然后打开 `https://<服务器地址>/login`，用用户名和口令登录。会话由 `ngt_sid` Cookie 维持（约 7 天不活动或 30 天绝对上限后过期，届时重新登录）。

> 口令遗忘了找管理员重置：重置后旧会话全部失效。

## 2. 浏览知识与文档预览

1. 登录后进入首页，点「知识库」到达 `/vaults`：这里列出**你有权限的库**（slug、名称、你的角色）。看不到的库不会出现——无权库与不存在的库表现一致。
2. 点进一个库进入目录浏览页（`/vaults/<slug>/browse`）：多级目录逐层进入，`README.md` 作为导航文档在页首展示。
3. 点任意 `.md` 文档进入预览页（`/vaults/<slug>/view/<路径>`）：安全渲染的 Markdown、frontmatter 元数据徽章；图片等附件经鉴权读取（无权者拿不到）。

浏览器地址即知识位置：库 + 库内路径。引用某段知识时的完整格式（含 commit）见下文「历史、diff 与还原」一节。

## 3. 编辑文档

编辑器在「编辑页」，直达地址 `/vaults/<slug>/edit/<路径>.md`（editor 及以上角色）：

- **改既有文档**：把预览页地址里的 `view` 换成 `edit` 即是；`README.md` 豁免元数据表单，直接编辑正文。
- **新建文档**：直接访问一个尚不存在的路径（如 `/vaults/<slug>/edit/notes/新主题.md`）即进入新建模式，`title` 自动按文件名预填（提交前可改）。
- **元数据表单**：`title` 必填（去空白后非空）；`owner` / `description` / `tags` / `status` / `source` 可选。缺 `title` 或 frontmatter 缺失会就地提示（如 `E-FM-001`），不会发布。
- **正文**：Markdown 文本框。
- **保存草稿**：草稿按作者私有，存在服务端数据库，不进 Git；换台电脑登录也能恢复。
- **提交**：正式提交产生一笔 Git 提交并发布到默认分支。提交时服务端按你打开编辑器时的 base commit 检查——如果别人已先提交，你会收到**冲突提示（409）**，草稿保留、页面提示刷新后重试，绝不静默覆盖你的或对方的修改。处理办法见[贡献流程·冲突处理](contributing.md#冲突处理)。

目录浏览页的每个文件条目旁有「重命名 / 删除」入口（重命名/删除都是一笔提交、历史可追溯，见[历史边界](history-boundary.md)）；整目录的上传入口见下节。

## 4. 上传 Markdown 与图片附件

目录浏览页「上传」（`/vaults/<slug>/upload/<子目录>`，editor 及以上角色）：

- 支持 Markdown 文档与常见图片附件；附件扩展名与大小受实例限制约束（超限会得到 `E-LIMIT-*` 错误并指明限额，不会默默截断）。
- 上传 `.md` 同样要走校验：`README.md`（名称大小写不敏感）豁免 frontmatter，其余知识文档必须自带 `title` 等必填元数据，否则提交被拒并就地提示；目标路径会按所选文件名预填（可改，可再嵌子目录）。
- 上传即产生一笔提交（附件与引用它的 Markdown 变更分步提交）；附件 URL 按 blob 寻址、不可枚举，读取仍受库权限约束。

## 5. 搜索

顶栏「查找」进入 `/search`：按**标题 / 标签 / 摘要**关键词查找你有权库中的已发布文档（ASCII 关键词不区分大小写；单次查询最多返回 100 条）。搜索基于派生索引，刚发布的内容可能有短暂延迟；索引不泄露无权库——查询按当前成员关系实时过滤，撤权后下一查询即消失。

正文全文/语义检索不在第一版范围（见[已知限制](../known-limitations.md)）。

## 6. 历史、diff 与还原

- **库级历史**（`/vaults/<slug>/history`）：默认分支全部提交。
- **路径历史**（`/vaults/<slug>/history/<路径>`）：该文档的提交序列，重命名后历史跟随（旧路径历史同样保留，见[历史边界](history-boundary.md)）。
- **diff / 版本预览**：逐版本对比与当时内容回看；逐提交寻址按该提交时的实际路径。
- **还原**：路径历史页每行「还原到此版本」——以**一笔新提交**恢复内容，不改写、不删除任何历史。

**引用格式（三要素）**：`库 / 路径 @ commit`，例如 `v-handbook / docs/getting-started.md @ 4c55b7a0…`。凭 commit 可在版本预览页回放核对；顶栏「引用解析」（`/cite`）页可粘贴解析。

## 7. 安装命令行（可选，本地/Git 通道）

需要 Node ≥ 22.13（macOS/Linux）与 Git。当前未发布公共 registry，使用发布方提供的 tarball（或仓库内打包）：

```sh
# 安装（单 tarball 自包含，校验规则已内嵌）
npm install -g notegit-<version>.tgz
notegit --version

# 登录前，先在网页「我的凭据」页（/credentials）创建访问令牌
# （ngt_ 前缀，明文仅创建时显示一次）

# 登录（令牌经环境变量或隐藏交互输入，不接受命令行参数）
NOTEGIT_TOKEN=ngt_… notegit login https://<服务器地址> --username <你的用户名>

# 日常环境（ls/sync 的凭据面）
export NOTEGIT_SERVER=https://<服务器地址>
export NOTEGIT_TOKEN=ngt_…

# 列出有权库与本地状态；同步到本地根目录（默认 ~/knowbase，可用 NOTEGIT_LOCAL_ROOT 覆盖）
notegit ls
notegit sync

# 凭据文件位置（默认 ~/.config/notegit/credentials，0600）可用 NOTEGIT_CREDENTIALS_FILE 覆盖
```

此后即是原生 Git 工作流（clone/fetch/commit/push，提交前 `notegit lint --staged` 本地校验）：完整流程与错误修正见[贡献流程](contributing.md)，逐命令细节见 [cli/README.md](../../cli/README.md)，Agent 视角见 [Agent 使用指南](../harness/agent-guide.md)。
