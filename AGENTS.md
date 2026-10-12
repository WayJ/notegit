## supervibe

- roadmaps_dir: docs/superpowers/roadmaps/
- sprints_dir: docs/superpowers/sprints/
- acceptances_dir: docs/superpowers/acceptances/
- notes: .agents/notes/
- debt_tracker: docs/tech-debt-tracker.md
- wip_limit: 3

### gates

- contracts: 未配置；确定技术栈后记录实际可运行的契约校验命令。
- tests: 未配置；建立实现与验证环境后记录实际可运行的测试命令。

上述条目是待配置说明，不是 shell 命令。当前只有规划文档，不得据此宣称实现检查通过。验收要求来自 epic 的 Definition of Done，不能用未配置的 gates 代替验收证据。

### doc_sync_map

| change | owes |
|---|---|
| 产品要求、知识格式、权限、发布或部署架构变化 | 同步 architecture.md；在所属 epic 的 Decisions (ADR) 中追加日期、依据和覆盖关系 |
| roadmap 范围、依赖或验收条件变化 | 在所属 epic 追加修订记录；影响架构时同步 architecture.md |

### 维护约定

2026-10-12 初始化。架构依据：[architecture.md](architecture.md)。roadmap 是能力规划，sprint 按完成标准结束，当前不承诺日历工期。planned / ready 只记录在 epic 的 Sprint Breakdown 中，启动前不生成 sprint 执行文档。语言、框架、数据库与容量限制留给实现前选型，不从示例推断技术栈。只有 sprint 已启动时才记录实际实现状态。
