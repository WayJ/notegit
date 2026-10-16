# Acceptance record — sprint S22, 2026-10-16

验收人：master 会话。环境：主仓 sprint/S22（cf31905）。执行形态：master 直接执行
（S13-T3/S20 先例——两处呈现层小修）。backing doc：[tech-debt-tracker](../../tech-debt-tracker.md)
TD-1/TD-2（S21 验收残留 R1/R2 入账项）。

## Verdict

**pass** — TD-1（admin 员工表创建时间 ISO→相对时间）与 TD-2（browse 头部上传入口
去裸括号、「上传」→「上传文件」）清偿并被行为测试锁定；台账两行删除（本记录留痕）。
零组件/令牌变更（S22-D1：DESIGN.md 不触发——TD-1 复用 B6 已入册的相对时间呈现，
TD-2 同结构同 class 文案修正）。

## Scenario Results

| id | scenario | expected | actual | pass |
|---|---|---|---|---|
| S1 | TD-1 relTime 行为 | 与服务端 formatRelativeTime 同语义 | vm 直跑 app.js 八案全对：刚刚/分/时/天、≤7 天仍相对、>7 天回日期、NaN 回落原文、未来时刻钳刚刚（服务端同款 Math.max） | yes |
| S2 | TD-1 渲染 | 员工行不裸传 ISO | adminPage HTML 含 `ngt.relTime(e.created_at)`，cells 数组无 `e.created_at]` 裸传 | yes |
| S3 | TD-2 渲染 | 去括号、完整短语、href 不变 | 写者头部含 `>上传文件</a>`、无括号包裹正则命中、`href="/vaults/alpha/upload/docs"` 原样（web-browse-perm.test.ts 既有入口断言继续绿） | yes |
| S4 | 回归 | 四 gates 只增不减 | contracts 82/82 · spike 7/7 · storage 14/14 · product **1594/1594**（1591+3 新增，0 失败） | yes |

## DoD Checklist

- [x] TD-1/TD-2 行为被测试锁定（web-s22-debt.test.ts 3 断言）；四 gates 绿（product 1591→1594 只增不减）
- [x] 台账 TD-1/TD-2 行删除，本记录留痕

## Obstacles (verbatim)

- 无。一处预先排险：web-assets.test.ts 对 `window.ngt` 仅宽松 includes 断言，
  relTime 增员不触锁（实现前 grep 确认）。

## Doc-Drift Audit

| map row | matched | doc state | detail |
|---|---|---|---|
| 产品要求/架构 → architecture.md | 不触发（零产品要求与架构变更） | current | — |
| UI 视觉契约 → DESIGN.md | 不触发（S22-D1：复用 B6 呈现 + 文案修正，零组件/令牌变更） | current | 决策在 sprint D1 记录 |
| 台账 → 行删除 | 匹配 | master 收尾 | 随本验收执行 |
