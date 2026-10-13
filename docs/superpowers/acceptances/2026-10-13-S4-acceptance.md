# Acceptance record — sprint S4, 2026-10-13

验收人：master 会话。环境：sprint/S4 @ b44c389（/tmp/s4a，npm ci fresh）。

## Verdict

**pass** — 六场景 fresh 全绿；epic S4 完成标准全部满足（网页发布后 Git 可见/Git 发布后网页可见、冲突不覆盖、草稿私有、修正重提、历史保留——最后一项历史页查询属 S5，删除保 Git 历史的 server 侧证据已在 T5）；M2（人类整理闭环）随 S4 达成（S3+S4 齐备）。契约变更均为授权渠道（D12 + 各任务授权行）；无未偿漂移。DOD-06/07 的 S4 份额已实证。

## Scenario Results

| id | command | expected | actual | pass |
|---|---|---|---|---|
| S1 | `node --test server/test/web-visibility-e2e.test.ts`（含 push→刷新与 web→clone 四等） | 双向一致 | 2/2 pass | yes |
| S2 | `node --test server/test/web-render-xss.test.ts server/test/web-attach-routes.test.ts` | XSS 全清、附件越权 404 | 18/18 pass | yes |
| S3 | `node --test server/test/web-edit-errors.test.ts` | E-FM 定位、W 级不阻断 | 9/9 pass | yes |
| S4 | `node --test server/test/drafts-routes.test.ts` | 草稿私有、撤权拒、Git 无痕 | 15/15 pass | yes |
| S5 | `node --test server/test/web-submissions-routes.test.ts` | 冲突 409 不覆盖、草稿保留 | 9/9 pass | yes |
| S6 | 四 gates + 契约 diff 核对 | 全绿；变更均授权 | 82/82、7/7、14/14、593+106；api.md 变更=D12+S6-T7+S4 授权行（合并时 master 双保留并重编号 3.5）；validation/schema/examples 零变更 | yes |

## DoD Checklist

- [ ] DOD-06 Web 整理 — S4 份额已实证（浏览/编辑/上传/重命名/删除/提示/预览限制/附件鉴权全谱）；S9 统一验收
- [ ] DOD-07 草稿与并发 — S4 份额已实证（私有/恢复/冲突不覆盖/统一权限规则/base commit 检查）；S9
- [ ] 其余 DOD — 未到期（S5/S7/S8/S9 范围）

## Obstacles (verbatim)

- 2026-10-13 — S4 与 main 的 api.md 同段追加冲突（D12 vs S4 授权行）；master 双保留合并，S6-T7 的 3.3 重编号为 3.5；门禁 82/82 复核通过。
- 2026-10-13 — 多次临时 worktree 状态残留（s4s/s4m）导致 worktree add 失败；prune+remove 后恢复。改进：结算链尾部不再链式 remove，显式分步。
- 无测试失败阻塞。

## Doc-Drift Audit

| map row | matched | doc state | detail |
|---|---|---|---|
| 产品要求/知识格式/权限/发布部署架构 → architecture.md + epic ADR | 匹配（D12 api.md 清偿；S4 各任务授权行） | current | D12 ADR 在案（main）；architecture.md 未触发（URL/页面族属 api.md §13 契约面） |
| roadmap 范围/依赖/验收 → epic 修订 | 无匹配 | n/a | 范围未变 |
