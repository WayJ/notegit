# S1-T1 Spikes — THROWAWAY 实验代码（非产品代码）

本目录全部内容为 2026-10-12 S1-T1 技术选型的 throwaway 实验（spike），仅用于产出
`docs/s1/selection.md` 的可复跑证据。**不作为产品代码维护**：无兼容承诺、无安全加固、
不做错误处理完备性。每个子目录自带测试与证据文件；复跑方法见各目录 README/selection.md 附录。

- `git-http-backend/` — 路线 B：Node 包装 `git http-backend`（CGI）+ pre-receive hook
- `isomorphic-git/` — 路线 A：isomorphic-git 纯 JS 服务端能力验证
- `frameworks/` — Fastify/Express（NestJS 见文档证据）流式透传 + 指示性微基准
- `db/` — SQLite(node:sqlite/better-sqlite3) vs PostgreSQL 行为实验
