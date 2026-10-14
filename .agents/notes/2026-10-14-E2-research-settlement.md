# E2 GUI research — settlement note (2026-10-14)

- 首派 ctx_13319324e660 于 01:02:59 失败（terminal_missing：宿主重启触发 orchestration recovery，worker 终端丢失，零产出）——worktree/分支清理后重派。
- 重派 ctx_19c32a5a2fe9（task_8b03b27f95b8，worktree e2-gui-research-2）：01:51 启动，02:09 worker_done（commit bdbb528）。
- demo 环境随宿主重启丢失，master 重建（幂等种子脚本 /tmp/notegit-demo-seed.sh；流程存 master 记忆 notegit-demo-env）。
- master 验收：两份产出全读；抽查 F-4（库级历史 diff 链接 → 404）与 F-1（view 页 0 编辑链接）均在 demo 复现，实锤成立；安全不变量交叉验证表（§2.2）与 demo 冒烟一致。
- 合并：cd6eb76（--no-ff，仅 docs/e2-gui/**，+331 行），推送 origin/main。
- 后续：master 起草 E2 epic（Deliverables/DoD/Sprint Breakdown），框架选型（research.md §4 三方案）呈用户裁决后启动 Sprint。
