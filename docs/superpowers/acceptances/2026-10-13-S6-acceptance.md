# Acceptance record — sprint S6, 2026-10-13

验收人：master 会话。环境：sprint/S6 @ d93cb0b（/tmp/s6a，npm ci fresh）。

## Verdict

**pass** — 六场景全绿（cli 包以自身 test 命令为证命入口）；epic S6 完成标准全部满足；写面审计通过（server/ 变更=master 授权的 rules-version 端点单点 append；api.md=授权补录 §3.3/§13）；无未偿漂移。DOD-09 的 S6 份额已实证（含防绕过三要素：部分暂存、hook 沙箱、版本一致性）；条目留 S9。

## Scenario Results

| id | command | expected | actual | pass |
|---|---|---|---|---|
| S1 | `cd cli && npm test`（lint.test.ts 19 用例，构建后运行） | 部分暂存只校验暂存内容 | 193/193 内 lint 组全绿（2/3 部分暂存用例 RED-first 交付） | yes |
| S2 | 同上（credentials/login 组） | 凭据不泄漏 | 泄漏扫描断言绿（URL/.git/config/输出） | yes |
| S3 | 同上（ls 组） | 两员工集合一致、schema 固化 | 13 用例绿（集合一致 + deepEqual schema + 退出码） | yes |
| S4 | 同上（hooks-sandbox/setup 组） | 恶意样本不执行、兼容两模式、卸载还原 | 沙箱断言 + 兼容链 e2e + 还原断言全绿 | yes |
| S5 | 同上（rules-version-consistency 组） | 三端一致、MAJOR 漂移失败 | 10 用例绿（含端点常量==api.md） | yes |
| S6 | 四 gates + `git diff main..sprint/S6 -- server/ docs/contracts/` | gates 全绿；写面隔离 | 82/82、7/7、14/14、399+106+193 全 exit 0；server/ 仅授权端点 3 文件、contracts 仅 api.md 授权补录 | yes |

## DoD Checklist

- [ ] DOD-09 CLI — S6 份额已实证（五命令四实现+文档一致性 13 测试+流程 e2e；sync 骨架如实标 S7）；完整验证 S9（含 DOD-09 的「sync 有文档」项依赖 S7）
- [ ] DOD-05 内容校验 — 三端一致性构建断言落地（S6 份额）；S9 统一验证
- [ ] 其余 DOD — 未到期（S4/S5/S7/S8/S9 范围）

## Obstacles (verbatim)

- 2026-10-13 — 首次 fresh checkout 后 cli 包首跑 1 失败（pack 安装冒烟类瞬态，与 S6-T7 结算时同型）；复跑 2×193/193 全绿。记为已知瞬态，非产品缺陷。
- 2026-10-13 — master 验证方法错误一次：直接 `node --test test/*.ts` 裸跑大量失败（tests 依赖 build 产物）；纠正为包自身 `npm test`（tsc --noEmit && build && node --test）作为证命入口。经验：以包脚本为准，不裸跑。
- 无其他阻塞。

## Doc-Drift Audit

| map row | matched | doc state | detail |
|---|---|---|---|
| 产品要求/知识格式/权限/发布部署架构 → architecture.md + epic ADR | 匹配（api.md 端点补录——URL 面契约） | current | api.md §3.3 rules-version 端点为 master 授权补录（T7 spec 内授权+验收复核）；architecture.md 未触发（端点属既有 §8.1 能力面） |
| roadmap 范围/依赖/验收 → epic 修订 | 无匹配 | n/a | 范围未变；sync 骨架=S6 计划 D6 既有裁定 |
