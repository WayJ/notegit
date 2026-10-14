# Acceptance record — sprint S13, 2026-10-14

验收人：master 会话。环境：sprint/S13 @ 3d56077；部署态 gh-pages @ 56a4991（源=site/ 同提交）；线上 https://wayj.github.io/notegit/。前置：T1∥T2 重派后交付（首派双双死于宿主会话重启 terminal_missing）；T3（部署）按 epic Q-E3-1 裁决由 master 执行。

## Verdict

**pass** — 五场景全绿；DOD-E3-01/02/03 达标；E3 全部 3 条 DoD 达标、epic 关闭；线上站点可用；无未偿漂移。

## Scenario Results

| id | command | expected | actual | pass |
|---|---|---|---|---|
| S1 | dist/index.html 结构（landing.test 15 断言） | hero/能力卡/URL 契约/零外部依赖 | 15/15（先红后绿）；grep 复核 | yes |
| S2 | 能力如实 | 不虚构 | known-limitations 关键词零命中（测试锁定）；许可证如实「未声明」 | yes |
| S3 | 链接扫描 | 零死链 | 10 页 154 相对链接 dead=0（两次策略修正后：未映射→blob URL、放宽至全扩展名） | yes |
| S4 | 幂等 | 连跑逐字一致 | docs-build 测试锁定（9/9）；master 复跑确认 | yes |
| S5 | 线上部署 | Pages 可访问 | gh-pages 推送（temp-dir 构建，主 worktree 零接触）；Pages API 已配置源=gh-pages/；**https://wayj.github.io/notegit/ 200 + 5 抽样文档页全 200** | yes |

## DoD Checklist

- [x] **DOD-E3-01 落地页** — T1（DESIGN token 全引用、移动端、能力如实）
- [x] **DOD-E3-02 文档站** — T2 + master 死链修正（9 页全映射 + blob 改写）
- [x] **DOD-E3-03 构建部署** — build-site.mjs 幂等；gh-pages 部署线（master）；冒烟=本记录+notes

## Obstacles (verbatim)

- 2026-10-14 — v0.2.0 tag 缺陷发现于本 sprint 结算途中：跨包依赖声明漏升（server dep/cli devDep notegit-validation 仍 0.1.0）致全新安装 404 + 两处测试版本硬编码随之碎——main 热修（784afd9）、**同日重定位 tag**（旧 tag 删除重打，发布说明如实披露）、drain 测试三次负载闪断（0ms 全等断言撞时钟精度→改 <50ms 语义断言）。
- 2026-10-14 — T1/T2 首派死于宿主会话重启（用户暂停指令后会话退出带走终端）；T1 死前遗问（href 形态/许可证）由 master 裁决并入重派契约（URL 契约九链接 + 许可证如实未声明）。
- 2026-10-14 — gh-pages 构建曾触发安全检查（rm 命令替换模式）——改 temp-dir 纯增量构建，主 worktree 零接触（更安全形态）。

## Doc-Drift Audit

| map row | matched | doc state | detail |
|---|---|---|---|
| 产品要求/发布架构 → architecture.md + epic ADR | 匹配（站点为呈现面，零产品代码变更） | current | D21–D23 在册 |
| roadmap → epic 修订 | 匹配（S13 完成 + E3 关闭） | master 收尾 | 随本验收执行 |
