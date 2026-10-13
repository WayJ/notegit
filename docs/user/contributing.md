# 贡献流程：网页与 Git 双通道

网页与原生 Git 两条通道**共用同一套权限与内容校验**（暂存区 pre-commit、服务端 pre-receive、网页提交三个入口同一规则实现、同一规则版本——当前 `1.0.0-draft.2`，以服务端为运行时权威）。选哪条只看顺手：改一两篇文档用网页，批量整理或 Agent 协作用 Git。

- 通道一的网页操作（编辑/上传/重命名/删除/还原）见[快速上手](quickstart.md)。
- 权限与撤权语义见[权限与撤权边界](permissions.md)。

## 通道一：网页

1. 打开编辑页（`/vaults/<slug>/edit/<路径>.md`；不存在的路径即新建模式，详见[快速上手](quickstart.md)），填元数据表单（`title` 必填）与正文。
2. 需要中断就「保存草稿」——草稿私有、可跨设备恢复、不产生 Git 版本。
3. 「提交」发布到默认分支：服务端以你打开编辑器时的 base commit 做预期旧值检查，通过校验后产生一笔提交。
4. 上传/重命名/删除/还原同理，各自产生一笔提交并进入同一份历史。

## 通道二：原生 Git

```sh
# 0) 已完成 notegit login（凭据与 clone URL 见快速上手第 7 节；token 作 Git HTTP Basic 口令）
# 1) 克隆（clone URL 形态：https://<服务器地址>/git/<slug>.git）
git clone https://<服务器地址>/git/<slug>.git ~/knowbase/<slug>

# 2) 修改 Markdown，检查并选择性暂存
cd ~/knowbase/<slug>
git diff
git add docs/报销制度.md

# 3) 提交前本地校验（与 pre-commit hook、服务端同一规则；未装 hook 也可手动跑）
notegit lint --staged
# 推荐一次性装好 pre-commit hook（此后每次 git commit 自动校验；不破坏已有外来 hook）
notegit setup

# 4) 提交并推送（默认分支快进推送成功即发布）
git commit -m "补充差旅报销流程"
git push origin main
```

分支规则（服务端固定执行，客户端改不掉）：

| 规则 | 行为 |
|---|---|
| 默认分支（main） | editor 可**快进**推送；禁止 force push、禁止删除；库可配置 `main_admin_only` 后仅库管理员可写 |
| 非默认分支 | editor 可创建、快进更新、删除（存放候选修改；网页端 v1 只提交默认分支） |
| tag / 其他 ref 命名空间 | 第一版不提供写入 |
| 多 ref 一次推送 | 先全部检查、通过才更新——一条违规整次拒绝 |

推送被拒时 Git 输出会带 `路径:错误码:摘要`（含规则版本）——本地跑 `notegit lint` 能拿到同一份完整报告。

## 校验错误修正

校验失败的提交/推送/网页提交都会被拦下并给出**可照做的修正提示**。最常见的一例（知识文档缺 frontmatter）：

```sh
cd ~/knowbase/<slug>
printf '# 没有 frontmatter 的知识文档\n' > bad.md
git add bad.md
notegit lint --staged
```

```text
bad.md：未通过
  错误 E-FM-001 bad.md：知识文档缺少 frontmatter（首行须为 `---`）
```

按提示补上必填元数据后复跑，直到退出码 0（警告 `W-*` 不阻断）：

```sh
printf -- '---\ntitle: 修复后的文档\n---\n\n正文。\n' > bad.md
git add bad.md
notegit lint --staged
```

常见错误速查（完整错误码注册表与消息模板见 [validation 契约](../contracts/validation.md)）：

| 错误码 | 含义 | 修正 |
|---|---|---|
| `E-FM-001` | 知识文档缺 frontmatter | 首行起补 `---` 块 |
| `E-FM-*`（其余） | title 空 / 字段类型错 / 非法 status | 按消息改 frontmatter |
| `E-PATH-*` | 路径或 tree 条目违规（含符号链接、submodule、大小写冲突） | 移除违规条目或改路径 |
| `E-LIMIT-*` | 附件类型/大小、文档大小、单次 push、库容量超限 | 拆分或压缩；确需导入大批内容找管理员临时调额 |

三条提醒：

- **本地 hook 可以被跳过，服务端校验永远在**：`--no-verify` 提交、先写坏内容再删除、合并提交夹带、多 ref 推送都绕不过 pre-receive。
- **格式合规 ≠ 事实正确**：校验只管格式与边界，内容对不对靠贡献者与库管理员。
- 客户端规则版本旧于服务端时，lint 报告会附 `N-UPGRADE-001` 提示——重装新版本 CLI tarball 即更新内嵌规则（版本差异本身不构成拒绝理由，判定以服务端为准）。

## 冲突处理

两类冲突，都不静默覆盖：

**网页 × 网页（或网页 × Git）并发提交**：两人基于同一 base 编辑，后提交者收到 **409 冲突提示**（附当前分支 tip），草稿完整保留。处理：刷新拿到最新内容，把自己的修改合并进去再提交。

**Git 非快进推送**：默认分支只接受快进——本地落后时 push 被拒、本地改动保留。处理：

```sh
# 取回远端并在本地整合后再推（不要 force——force push 一律被拒）
git fetch origin
git rebase origin/main
# 或 git merge --ff-only origin/main（本地无新提交时）
git push origin main
```

**sync 不会替你解决冲突**：`notegit sync` 只对干净且位于默认分支的副本快进更新；有未提交修改、未推送提交、分叉或位于其他分支时**跳过并逐库报告**，绝不自动 stash/reset/rebase。本地副本要怎么整合由你决定。
