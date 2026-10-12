# 2026-10-13 S3-T4 — pre-receive 逐提交检查

Orca dispatch `ctx_ee2b25494d02`（task_60f7ba7c3caf，branch `WayJ/s3-t4-prereceive`，基点 sprint/S3 @ 59f7aa3——brief 所记 5a90da2 为 T2 产品接线提交，实际基点取含 T1/T2/T3 的 sprint/S3 tip）。任务定义 = implementation-breakdown §2.2 S3-T4 行。规则语义唯一来源仍是 docs/contracts/validation.md（只读）；本文记录 brief 指定的「接口变更记 notes」与实现裁决。

## interface-change（packages/validation 输入接口扩展；包内规则不变）

- **`CommitDelta.treePaths?: string[]`**（validate.ts）：本提交全 tree 路径基线。E-PATH-004 判定输入由「变更路径集」扩展为「本提交全 tree 路径」——新增/修改路径与库内存量路径的大小写冲突（如推送 `Notes/First.md` 而库内有 `notes/first.md`）现在被拦截；冲突仅存在于两条**未变更**路径之间不翻案（存量不产生 issue）；字段缺省回退变更集内比对（既有语义与全部 92 项 T3 测试不变）。落地 T3 决策 §9.2.5「跨存量 tree 基线检查留 T4 扩展」。
- 落位动机：契约 §4.2「同一提交内仅大小写不同的两条路径」中「同一提交」按提交**全 tree** 读取（tree 含存量+新增路径，任一冲突必涉新增侧——存量 tree 经归纳不含冲突）；服务端 `ls-tree -r` 一次调用同时供给 treePaths 与 FileInput.mode。

## decisions

- **换装点**：placeholder-validation.ts 整体删除，新模块 `server/src/githttp/validation-input.ts` 承担 git 遍历 → CommitDelta 组装（GitTraversal 注入面：run/readBlob）；规则判定全部在 packages/validation（sprint D7）。
- **合并按父展开 = 交集**：合并提交取「相对每个父提交的变更集」交集——两父皆无的内容才是本合并新引入（evil merge 夹带）；等于某一父版本的文件在其引入提交处已/将被校验，不因合并重判（防规则升级后合并历史内容被追溯拒绝，亦免重复归因）。完备性：普通提交 vs 父 + 根提交全检 + 合并交集，经归纳覆盖一切新引入内容。
- **遍历命令**：`rev-list --parents`（根推送 old=零用 `--not --all` 锚定推送前 ref 状态——pre-receive 先于 ref 更新）；每提交 `ls-tree -r -z`（mode/oid/path，-z 免 C 引号包裹）+ `diff-tree -r -z --name-status`（根提交 `--root` vs 空 tree；有父者逐父两树式）；blob 按需 `cat-file blob`（新增 `runGitBuffer`——二进制附件字节精确，经 utf8 字符串中转会破坏）。非常规 mode（symlink/gitlink）不读 blob（gitlink 对象可缺失），mode 原样透传由 E-PATH-002/003 短路拒绝。删除条目不进 changes（契约 §2.5）。
- **报告输出协议**（validation.md §6.3）：拒绝时 stderr = 概要行 + 可读错误行（封顶 20 行防刷屏）+ `[notegit pre-receive] report: <单行 JSON>`（含 rulesVersion/scope/refs/files/issues，客户端 push 可见）；hook 退出码取报告 exitCode（1=fail/2=error，receive-pack 均整包拒绝）。授权拒绝仍走 T2 原有可读行（B4 断言兼容）。
- **审计挂接点（T6 消费）**：报告（通过与拒绝均）原子落盘 `<GIT_DIR>/notegit-validation.json`（tmp+rename）；落盘失败不改变推送判定（内容校验是闸门、审计成链是 T6 语义），stderr 留痕。并发推送为 last-writer-wins——T6 的 DB 审计链（pending→终态）才是正式形态，本文件只是其消费输入。
- **授权→校验顺序**：任一 ref 授权拒绝即整包否决、不再运行内容校验（推送已被否决；B4/B6 语义不变）。
- **knownPaths**：取推送前各非零 old tip 的全 tree 路径（链接存在性 W-LINK-101 的库内基线）；新变更路径由 validate() 自身累积。

## honest-gaps（如实标注，不虚构）

- **E-LIMIT-004/005（push 总量/库容量）未接线**：pre-receive 无法感知 pack 字节数（stdin 只有 ref 命令）；计量点在 HTTP 层（CONTENT_LENGTH，chunked 推送缺失时需累计流）——按 T3 §9.2.6「口径由消费方确认」记为 **T6/T8** 落地（校验器侧输入口 pushBytes/vaultCurrentBytes 已就绪，包内 E-LIMIT-004/005 逐码测试已有）。
- **N-UPGRADE-001 无输入**：push 协议不携带客户端规则版本；接线点预留 `git push --push-option`（hook 侧 GIT_PUSH_OPTION_* env）随 S6 CLI/hook 分发落地。
- **createValidator 并发闸门为每 hook 进程各一**（每推送一进程）：跨推送并发限制需进程间共享状态，留 T8（运维配置任务）；单进程内超时/内存限制已生效。
- **校验器配置覆盖（validation-defaults 全键）未接 DB**：当前默认值直跑，管理员可配置属 T8。
- 审计挂接点文件为单文件覆盖形态（见 decisions），非多推送并存记录。

## evidence

- 防绕过清单逐条（breakdown S3-T4 完成标准）：prereceive-validation.test.ts 11 项全绿——①无 hook 客户端 + `--no-verify` 推违规被拒（报告含 rulesVersion/E-FM-001/提交归因）②先写坏后删被拒且 ref 不变（归因引入提交）③evil merge 夹带被拒（两父皆无文件进校验）良性合并不误拒 ④根提交全检（空库首推拒+合规首推收，README 豁免标注）⑤多 ref 一违规全部 rejected（报告 refs 断言+服务端零 ref 更新）⑥tag 轻量/附注均拒 ⑦E-PATH-004 全 tree 基线（actual=存量路径）⑧symlink 经 index 夹带 E-PATH-002 ⑨.png 字节精确接受/.svg E-LIMIT-002 ⑩审计挂接点落盘（通过/拒绝两态）。
- 组装语义单元测试：prereceive-assembly.test.ts 8 项（根提交全检/普通提交 A-M-D/合并交集与良性合并/--not --all 锚定/-z 空格路径/危险 mode 透传/knownPathsOfTip）。
- route-b B5/B6 在真实校验下仍绿（githttp-behavior 13/13）。
- npm test：**server 304 + validation 96 全绿**（基线 285+92，新增 19+4）；gates 四项全过（contracts 82/82、route-b 7/7、storage 14/14、product npm ci+test exit 0）。
