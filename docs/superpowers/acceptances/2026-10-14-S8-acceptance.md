# Acceptance record — sprint S8, 2026-10-14

验收人：master 会话。环境：sprint/S8 @ 98a75b5（/tmp/s8a，npm ci fresh + 真实容器）。

## Verdict

**pass** — 六场景全绿（含真实容器 16 步初始化演练与全部演练档案复核）；epic S8 完成标准全部满足；**DOD-12（备份恢复演练）与 DOD-13（升级/恢复验证）的证据义务已履行**（R1–R14 全项 ×2、35 步恢复 ×2、32 步升级/回退 ×2，全部留档 .agents/notes/）；契约零变更（G1–G5/B1–B6/M1–M5/RS1–RS6/U1–U6 建议稿待 D 批——挂账而非漂移，实现均按建议稿形状全绿）；无未偿漂移。

## Scenario Results

| id | command | expected | actual | pass |
|---|---|---|---|---|
| S1 | `node deploy/scripts/init-drill.mjs`（真实容器） | 全链走通；重启数据在 | 16 步演练全链绿（15 步断言+清理）；29.3s | yes |
| S2 | `node --test server/test/maintenance-matrix.test.ts server/test/maintenance-drain.test.ts` | 矩阵逐行+排空 | 15/15 pass（真实 git 客户端含 receive 403） | yes |
| S3 | `node --test server/test/backup-snapshot.test.ts server/test/backup-verify.test.ts` | 备份+离线验证 | 18/18 pass（分置两件+manifest） | yes |
| S4 | R1–R14 恢复演练档案 | 全项过且留档 | `.agents/notes/2026-10-14-S8-T5-restore-drill.txt` 35 步 ×2 PASS（验收时复核在案） | yes |
| S5 | 升级+回退演练档案 | 升级冒烟/回退原状/跳备份拒 | `.agents/notes/2026-10-14-S8-T7-upgrade-drill-{1,2}.txt` 32 步 ×2 PASS（D-BR-08 双拒+零数据丢失断言） | yes |
| S6 | 四 gates | 全 exit 0 | contracts 82/82、spike 7/7、storage 14/14、product 850+106+345 | yes |

## DoD Checklist

- [ ] DOD-01 独立部署 — S8 份额已实证（容器+持久卷+HTTPS 说明+重启数据在——init-drill）；S9 终验
- [ ] DOD-11 审计与异常恢复 — S8 份额已实证（对账器异常注入+恢复链核对）；S9
- [ ] DOD-12 备份恢复 — **证据义务履行**（R1–R14 ×2 留档）；S9 终验勾选
- [ ] DOD-13 运维与限制 — **证据义务履行**（升级/回退 ×2+全部限制键可配+指标面）；S9 终验勾选
- [ ] 其余 DOD — 未到期（S9 范围）

## Obstacles (verbatim)

- 2026-10-13/14 — S8 建议稿集中待 D 批（metrics M 面/backup B/restore RS/upgrade U/capacity G，共 5 组）——统一随 D14 落契（master 收尾动作），非验收阻塞。
- 2026-10-14 — 已知瞬态 ×3（并发安装/pack 抖动类），复跑皆绿，与 S5-T4/S7 先例同型。

## Doc-Drift Audit

| map row | matched | doc state | detail |
|---|---|---|---|
| 产品要求/知识格式/权限/发布部署架构 → architecture.md + epic ADR | 匹配（部署/备份/升级形态） | current-with-pending | 实现全绿；deploy/README 与演练档案为证据面；五组建议稿 D14 统一落契（挂账记录在案） |
| roadmap 范围/依赖/验收 → epic 修订 | 无匹配 | n/a | 范围未变；Q9 保持 open 如实标注 |
