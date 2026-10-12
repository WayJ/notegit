# Acceptance record — sprint S3, 2026-10-13

验收人：master 会话。环境：sprint/S3 @ 67b82b0（/tmp/s3-acc，npm ci 后 fresh）。任务单源：implementation-breakdown §2.2。

## Verdict

**pass** — 七场景 fresh 全绿；epic S3 完成标准全部满足（标准客户端闭环/拒绝谱系/共用规则——同构性实证）；M1（Git 闭环）达成：内部技术验证里程碑完成（epic 里程碑表：M1 = S2+S3）；契约零变更（D11 之外无触碰）；无未偿漂移。E1 DoD 的 DOD-04/05/11 S3 份额已具备实现与测试证据，条目本身留 S9 统一验收。

## Scenario Results

| id | command | expected | actual | pass |
|---|---|---|---|---|
| S1 | `node --test server/test/githttp-behavior.test.ts`（含 B1/B2） | 标准 clone/首推/二次 clone 闭环 | 13/13 pass（B1 HTTP clone、B2 FF push、空库闭环在内） | yes |
| S2 | 同上（B3–B6） | 非法 push 全谱拒绝 | 13/13 pass（非快进 ref 不变、逐 ref 授权、先写后删拦截、多 ref 原子拒绝，真实校验与规则下） | yes |
| S3 | `node --test server/test/githttp-ref-rules.test.ts server/test/vaults-policy.test.ts` | 只读/无权/受限分支被拒 | 14/14 pass（reader push 拒、main_admin_only 三态、命名空间收紧） | yes |
| S4 | `node --test server/test/publish-isomorphism.test.ts` | 同一违规样本两入口同 rulesVersion 同错误集 | 2/2 pass | yes |
| S5 | AGENTS.md gates 四条 fresh | 全 exit 0 | contracts 82/82；spike 7/7；storage 14/14；npm test 395+106 | yes |
| S6 | `node --test server/test/receive-audit.test.ts` | 中断不虚假成功、残留标待核对 | 18/18 pass（含 SIGKILL 中断注入、quarantine 原子性、对账面） | yes |
| S7 | `git diff main..sprint/S3 -- docs/contracts/` | 零变更 | 零变更 | yes |

## DoD Checklist

- [ ] DOD-04 原生 Git — S3 份额已实证（行为测试 13/13 产品级；force/delete/tag 拒绝；分支规则）；完整 DoD 验证 S9
- [ ] DOD-05 内容校验 — S3 份额已实证（packages/validation 单一来源、防绕过清单逐条、同构性）；S4/S6 消费后 S9 验证
- [ ] DOD-11 审计与异常恢复 — S3 份额已实证（预记录成链、中断不虚报、待核对面）；S8 恢复演练 + S9 验证
- [ ] 其余 DOD — 未到期：S4–S9 范围（口径同 S1/S2 记录）

## Obstacles (verbatim)

- 2026-10-13 — T4/T5 并行致 pre-receive.ts 实质语义冲突；master 重建（T5 骨架 ref-rules 单源 + T4 校验管线，占位段删除），三件仲裁（授权先行/检查点行互补/audit entry 扩宽）记录于合并提交 9cf28f9；重建后 npm test 319+96 全绿。
- 2026-10-13 — 一次命令链误删未完成合并的临时 worktree（分支未动，merge 未提交即弃）；重做合并解决。来源：本次集成，improvised。
- 验收环境四条 gates 一次全过；无其他阻塞。

## Doc-Drift Audit

| map row (change, owes) | matched this sprint | doc state | detail |
|---|---|---|---|
| 产品要求/知识格式/权限/发布部署架构变化 → architecture.md + epic ADR | 无匹配 | n/a | S3 实现均落架构 §3/§5 既有框架内；packages/validation 接口扩展（treePaths）为代码层非契约变更 |
| roadmap 范围/依赖/验收条件变化 → epic 修订记录 | 无匹配 | n/a | 范围/依赖/验收未变；api.md 补录欠账（维护端点、vault-delete、config-audit kind）累积记录于 sprint 台账，随 S4 契约修订一并处理 |
