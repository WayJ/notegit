---
epic: E3
created: 2026-10-14
basis: 用户裁决（2026-10-14）：产品介绍面选「独立文档/官网站」——完整产品官网，非登录页改造/非仅 README
research: docs/e2-gui/research.md §1（六竞品均有产品官网/文档站形态参照）
predecessor: E2（closed @ 98875a7——v0.2.0 已 tag 发布）
---

# Notegit E3 产品官网与文档站 Roadmap

## 背景与定位

v0.2.0 已发布但无任何产品介绍面（匿名访问即 302 登录；仓库无根 README）。E3 交付**静态官网+文档站**：产品定位、核心能力、快速部署入口 + 既有库内文档（user/admin/deploy/known-limitations/release-notes）的可浏览呈现。

## 技术裁决（开工即定，ADR 接续 E2 编号）

| id | decision | rationale | date |
|---|---|---|---|
| D21 | 站点=纯静态 HTML/CSS + 极少 vanilla JS，零构建依赖（无 VitePress/Docusaurus）；DESIGN.md token 体系为唯一视觉契约（与产品 UI 同源品牌） | 与 D19 路线一致（零构建链哲学）；DESIGN.md 已是仓库 UI 强制契约；静态页 GitHub Pages/任意静态服务可托管 | 2026-10-14 |
| D22 | 文档页=构建期预渲染：Node 脚本复用产品自身 Markdown 渲染管线（server/src/web/view/render.ts 只读）把 docs/**/*.md 转静态 HTML——单一渲染真相源（站上文档=产品内文档渲染） | 不引 marked/markdown-it；安全清理通道自动继承；文档源单一不双写 | 2026-10-14 |
| D23 | 发布面=gh-pages 分支（构建产物 dist 提交该分支；master 执行部署脚本推送）；源（site/ + 脚本）在 main | GitHub Pages 免 Actions 即可启用；产物可复核（分支内容=所见） | 2026-10-14 |

## Deliverables

| id | deliverable |
|---|---|
| H01 | 落地页（产品定位/核心能力卡/三入口说明/快速部署/文档与 GitHub 入口） |
| H02 | 文档站（既有库内文档预渲染呈现：导航/目录/移动端适配） |
| H03 | 构建与部署脚本（build-site.mjs → dist；deploy 脚本推 gh-pages）+ 可复核冒烟 |

## Definition of Done

- [ ] **DOD-E3-01 落地页**：匿名可访问；产品定位与核心能力如实（不虚构未实现能力——与 known-limitations 一致）；DESIGN.md token 合规（视觉抽检零内联 hex）；移动端可用。
- [ ] **DOD-E3-02 文档站**：user 四篇/admin/deploy/known-limitations/release-notes-v0.2.0 全部可浏览；导航与相对链接可用（站内无死链——链接扫描 100% 200/file 存在）；渲染与产品 view 管线同源（D22）。
- [ ] **DOD-E3-03 构建部署**：build-site.mjs 一键产 dist（幂等）；部署脚本推 gh-pages 分支；冒烟（产物文件清单+首页 HTML 关键元素断言）留档。

## Sprint Breakdown

| sprint | state | note |
|---|---|---|
| S13 | started | 官网与文档站（H01–H03）；2026-10-14 go：用户裁决「独立文档/官网站」、D21–D23 技术裁决入册、四要素明确（范围=本表与 S13 plan、执行=Orca worker ≤3 superpowers+TDD、评审=master、验证=TDD+场景实测）；2026-10-14 started：[2026-10-14-S13-plan.md](../sprints/2026-10-14-S13-plan.md) |

## Open Questions

| id | question | status |
|---|---|---|
| Q-E3-1 | GitHub Pages 正式启用（源=gh-pages 分支）与自定义域名 | in-progress——2026-10-14 用户指令「发布到 github pages」：部署由 master 执行（gh-pages 推送 + Pages API 启用）；自定义域名仍留用户 |
