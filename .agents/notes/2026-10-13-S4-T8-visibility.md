# S4-T8 Web×Git 双向可见与错误提示整合

## background
breakdown §2.3 S4-T8 行（S4 收口）：双向可见验证（push 后网页实时可见；网页发布后 clone 内容全等）、权限/格式错误统一提示（错误码+修正建议映射表）、web-submit 失败响应与 `examples/report-web-submit-draft-rejected.json` 同构断言（验收场景 S1 收口）、T4 遗留（上传 UI 页+直图页嵌入）、全站连通冒烟。基线 568+106 全绿（rebase 到 sprint/S4 @ f634ec5 ⊇ T7）。

## decisions
- **修正建议映射表落 `server/src/web/hints.ts`（web 域共享件）**：键来源受测试双重约束——validation 码 ⊆ `ERROR_REGISTRY`（validation §6.2 机器注册表，导入消费而非硬编码副本）、api 码 ⊆ api.md §1 错误码表（测试运行时解析 api.md——同「消费注册表」语义，防两边漂移）；模块加载期自检注册表 error 级码零漏项（注册表演进即炸）。文案与注册表消息模板的修正语义一致（模板「；」后行动指引的完整句形态）；E-PATH-005 建议改述避开 `.git` 字面量（gitrepo-static-rules 单源规则禁).
- **统一提示接线面=页面域写端点（upload/rename/delete POST），submissions 不动**：upload JSON 信封 `error.{code,message,hint}`（validation 取报告 issue 码+定位字段；branch-rules→E-AUTHZ-001、authorization→E-RES-001、base-commit→E-RES-003、execution-point 维护→E-MAINT-001）；rename/delete 同页 notice 附 code+「建议：」行。submissions 422 **保持裸 T2 报告**（与契约示例同构是本任务断言目标——加 hint 即破坏同构；报告 message 模板自身已含修正指引）、409 信封 §8.2 已定形不扩字段；candidate/audit/settle 500 无注册码不杜撰（T7 注记沿承）。页内脚本不复制映射表——upload UI 页直接展示端点返回的 hint（单一来源）。
- **同构断言三层**（web-submit-isomorphism.test.ts）：① schema 校验（测试自带 2020-12 子集校验器覆盖本仓库 schema 实际用到的全部特性——不引新依赖；不支持特性抛错不静默放行）② 示例形状同构（示例呈现的每节点键都在响应中且类型一致 + 响应顶层键集不超出示例词汇——防信封包裹）③ 语义锚（scope/result↔exitCode/README exempt/E-FM-001 四元组/summary 计数/rulesVersion==包内单一来源/vaultId/候选 commit OID/无 refs）。阴性对照：示例本身过 schema、三种被破坏的报告被拒（断言有牙——这是对「验证既有行为」类测试的 RED 等价物）。
- **上传 UI 页 = GET /vaults/{slug}/upload[/{dir}]（upload 模块 append，D5）**：fetch 直发 octet-stream（T4 契约形态，不引 multipart——browser 原生表单做不到 octet-stream，FileReader/fetch 是唯一无依赖路径）；目标目录可为不存在路径（POST 走组件路径判定，页面零校验）；入口两处——目录页面包屑后 `（上传）`、编辑页头部「上传附件」（六字段+README 两页同构，指向文档父目录）。上传成功呈现 blob URL+Markdown 引用片段（`![](url)`）。
- **直图页嵌入集合=附件通道 image/* 升格集**（png/jpg/jpeg/gif/webp）：与 upload ATTACH_CONTENT_TYPES 对齐；svg/bmp/ico 不内嵌（svg 一律 octet-stream 纵深防御——<img> 指向 octet-stream 响应不会渲染，故干脆标注不内嵌）。`<img>` src 经 escapeHtml（URL 虽为 hex+编码段安全，纵深双保险）。
- **双向可见 e2e（S1 收口）**：Git→Web 用 pushToVault（真实 clone→push）+ 浏览/预览页标记断言（T1 已有 ls-tree 一致性，本任务补完整场景）；Web→Git 用 submissions 端点发布（编辑页同一载荷形态）→ 真实 clone → 四层全等：文件集（clone ls-files == 网页目录可见集）、逐文件字节（发布内容原文）、tree OID（T7 等价形态）、网页预览呈现。web-e2e 的旧 T2 占位断言（`S4-T4` 接口占位文案）随直图页收口翻转为 `<img>` 断言——唯一被改的既有测试。
- **冒烟矩阵 = 22 页 × 4 角色（anon/member/outsider/admin）数据驱动**：302 落点（member 业务落点 + anon 统一 /login）、200 页 HTML 形状、404 反存在性（非成员与未知库同体）；附件端点真实 OID 200+nosniff / 伪造 OID 404。

## lessons
- upload 模块 requireVault 历史上不取 `name`（JSON 端点不需要）——页面模板消费 `vault.name` 得 500（escapeHtml(undefined).replaceAll）；跨模块复用守卫时补齐页面所需字段，类型注解与返回值同步改（tsc 拦了一道，node --test 单跑不拦——typecheck 是 suite 一部分的原因）。
- inject 无法确定性触发 upload/rename 端点的 base-commit 竞态（端点自解析请求时 HEAD，顺序执行无注入缝）——409 统一信封的验证由 submissions 显式 base_commit 路径（T7 既有测试）承担；端点侧 409 映射只保证代码路径统一。
- 静态规则测试（`.git` 单源、同步子进程禁令等）会扫字符串字面量——提示文案里的技术名词要避开受管字面量（改述优于加白名单）。

## handover
- S4 六波次任务全落；验收场景 S1（双向可见）已由 web-visibility-e2e 显式闭合、S6 的「契约只读」半边：docs/contracts 变更仅 api.md §13（D12 渠道：T8 新行 + T7 移交的 upload 行措辞收敛「完整冲突保护 S4-T7」→「冲突保护已由 S4-T7 组件落地」+ view 行直图页注 + 统一提示尾注），validation/schema/examples 零变更（contracts gate 82/82 佐证）。
- 统一提示当前覆盖页面域写端点；若 S5+ 需要历史/还原端点同款提示，hints.ts 直接复用（键集受注册表测试约束，扩展码先落注册表）。
- 上传 UI 页脚本行为（fetch/octet-stream/结果呈现）在 node 测试中不可执行——契约锚=页内端点与 content-type 标记 + POST 端点自身测试；浏览器行为留验收人工抽查或未来 e2e 框架。
- 冒烟矩阵新增页面时在 PAGES 数组 append 一行即可（数据驱动，角色×期望自动展开）。
