# Acceptance record — sprint S12, 2026-10-14

验收人：master 会话。环境：sprint/S12 @ 9bb46c8+D 批（demo 127.0.0.1:3210 同码 + npm ci fresh）。前置：T1∥T2 → T3 三任务结算（台账在 plan；T3 两处写面偏离 master 追认；amendments 两次 add/add union）。

## Verdict

**pass** — 六场景全绿；DOD-E2-08/09/10 达标；**E2 全部 10 条 DoD 达标（见 E2 closure 记录）**；契约 D 批六处落契（预览端点行含路径终局裁决/编辑行体验补记//drafts 行/共享资产注/维护缝补句/布局壳句；gates 82/82 复验）；无未偿漂移。

## Scenario Results

| id | command | expected | actual | pass |
|---|---|---|---|---|
| S1 | demo：POST /edit-preview（markdown+注入负载）与鉴权 | 渲染正确+注入不可达+越权 404 | h1/strong/https 链接渲染；script/onerror 0 命中；bob→product-notes 404 | yes |
| S2 | 编辑页自动保存接线 | 定时器+状态文案 | 30000 常量+AUTOSAVE_INTERVAL_MS+「已自动保存/失败重试」文案在位（行为级测试 4 例在套件） | yes |
| S3 | /drafts 三态 | alice 多库/bob 空态/匿名 302 | alice 见 team-handbook remote-work 草稿+继续编辑；bob「尚无本人草稿…」如实空态；302 | yes |
| S4 | 粘贴/拖拽接线+共享资产 | 事件监听+资产可达+引用 | paste/drop 监听在位；/assets/app.js 200（application/javascript）；页面 src 引用恰一（行为级测试 3 例在套件） | yes |
| S5 | 顶栏 | 账户位全域+登出+角色可见性 | browse/cite 状态页账户位在位；/drafts 导航入口；admin 链接 admin 3/alice 0；匿名无账户位 | yes |
| S6 | §2.2 表+e2e+gates+DESIGN | 全绿零回归 | 302/403/409/403；e2e 21/21；82/82+7/7+14/14+978/106/369；内联 hex 0 | yes |

## DoD Checklist

- [x] **DOD-E2-08 编辑体验** — S1–S4（预览同管线/自动保存/我的草稿/粘贴上传，15+14+5 测试锁定）
- [x] **DOD-E2-09 框架决策落地** — D19 入册 + T3 交付（共享 app.js 抽取、四页改造行为零变化、内联 -2859B/login -53.3%、edit 域 viewer 收口）
- [x] **DOD-E2-10 质量与安全回归** — S6
- **E2 汇总：DOD-E2-01~10 全部达标**（01–04=S10、05–07=S11、08–10=S12）

## Obstacles (verbatim)

- 2026-10-14 — T1 预览端点路径：worker 在 master 批复到达前按「裁决不拖延」自主落前缀外路径（/edit-preview）；master 复审追认为终局（写闸门不变量零豁免更诚实）——先例记录：批复延迟时 worker 可自主选择可逆方案并在报告披露。
- 2026-10-14 — T3 两处写面披露（ui-style 计数断言/六处 routes 呈现层传参）：先斩后奏但与既定先例同形，master 追认；worker 完成后 reply 通道关闭，追认记入台账。
- 2026-10-14 — waiter 槽被误起后台进程注册占用（`&` 误用），--wait 不可用 ~50 分钟；改 Monitor 轮询值守（45s 非阻塞 check）完成 S12 全程——流程教训入 master 记忆。

## Doc-Drift Audit

| map row | matched | doc state | detail |
|---|---|---|---|
| 产品要求 → architecture.md + epic ADR | 匹配（编辑体验/共享脚本） | current | D19/D20 在册；§13 六处落契 |
| roadmap 范围/依赖/验收 → epic 修订 | 匹配（S12 完成+E2 收口） | master 收尾 | 随本验收执行 stub/E2 终态同步 |
