## supervibe

- roadmaps_dir: docs/superpowers/roadmaps/
- sprints_dir: docs/superpowers/sprints/
- acceptances_dir: docs/superpowers/acceptances/
- notes: .agents/notes/
- debt_tracker: docs/tech-debt-tracker.md
- wip_limit: 3

### gates

（2026-10-12 由 S1-T6 实测固化并记录，同日 master 补登第三条（G3）与第四条（S2-T1 产品测试，适用分支自 sprint/S2 起）；命令均在仓库根目录运行。完整命令行、退出码与输出摘录见 [docs/s1/gates-evidence.md](docs/s1/gates-evidence.md)。）

- contracts: `python3 docs/contracts/tools/verify_validation_contracts.py` — 统一校验契约自检门禁（依赖 python3 ≥ 3.9 与 jsonschema ≥ 4）。2026-10-12 实测：exit 0，82/82 检查通过。
- tests: `node --test docs/s1/spikes/git-http-backend/test/route-b.test.mjs` — Git HTTP 接入行为测试（B1–B7，spike 无 npm 依赖、无需 install；实测环境 Node v24.21.0）。2026-10-12 实测：exit 0，7/7 通过。
- storage: `node --test docs/contracts/tools/ddl_smoke.test.mjs` — 存储模型 DDL 冒烟（S1-T5 交付，node:sqlite 真实建表与约束断言；无 npm 依赖）。2026-10-12 master 在 sprint/S1 合并态实测：exit 0，14/14 通过。
- product: `npm ci --no-audit --no-fund && npm test` — 产品测试套件（tsc --noEmit + node --test：pragma 断言、迁移重入、路由 inject；S2-T1 起生效，随任务增长）。2026-10-12 master 在 sprint/S2 合并态 @ 25dd001 实测：exit 0，14/14 通过。

gates 通过仅证明上述检查命令真实可运行且当前通过；验收要求仍来自 epic 的 Definition of Done，不得以 gates 通过宣称 E1 DoD 完成（DoD 证据在对应 sprint 验收时产生）。

### doc_sync_map

| change | owes |
|---|---|
| 产品要求、知识格式、权限、发布或部署架构变化 | 同步 architecture.md；在所属 epic 的 Decisions (ADR) 中追加日期、依据和覆盖关系 |
| roadmap 范围、依赖或验收条件变化 | 在所属 epic 追加修订记录；影响架构时同步 architecture.md |

### 维护约定

2026-10-12 初始化。架构依据：[architecture.md](architecture.md)。roadmap 是能力规划，sprint 按完成标准结束，当前不承诺日历工期。planned / ready 只记录在 epic 的 Sprint Breakdown 中，启动前不生成 sprint 执行文档。语言、框架、数据库与容量限制留给实现前选型，不从示例推断技术栈。只有 sprint 已启动时才记录实际实现状态。

## UI 样式规范（强制）

**所有面向浏览器的界面（HTML 页面、CSS、内联样式、错误/提示文案呈现）必须遵循 [DESIGN.md](DESIGN.md)。** 该文件是本仓库 UI 的唯一视觉契约：色板（米色画布 `#faf9f5` / 珊瑚主色 `#cc785c` / 深海军蓝表面 `#181715` 三色体系）、字体层级（衬线 display + 人文无衬线 body，标题负字距）、间距与圆角 token、组件形态（按钮/卡片/输入框/徽章）均以 DESIGN.md 为准。

任何涉及 UI 的实现任务（新页面、改样式、加组件）在动手前先读 DESIGN.md；样式值一律引用其 token 语义（颜色/字号/间距/圆角），不得内联随意 hex 或凭默认审美发挥。DESIGN.md 未覆盖的组件，按其「Iteration Guide」原则推导（先衬线放大再考虑加粗、不引入第四种表面色、coral 只用于主 CTA 与整幅强调卡）。对 DESIGN.md 的修订与对契约文件同权——先改文档再改代码，不留静默偏离。
