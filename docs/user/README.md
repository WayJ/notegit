# Notegit 用户文档（员工视角）

> 面向使用 Notegit 的员工：在网页上整理知识，或用 Git/CLI 在本地工作。部署与管理请看[管理员手册](../admin/README.md)；部署本身见 [deploy/README.md](../../deploy/README.md)。
>
> 文档只描述**已实现行为**（breakdown S9-T6 / DOD-15）；与实现的一致性由 `cli/test/delivery-docs-consistency.test.ts` 自动抽检。

| 文档 | 内容 |
|---|---|
| [安装与快速上手](quickstart.md) | 首次登录 → 浏览 → 编辑 → 上传 → 历史 → 搜索；CLI 安装 |
| [贡献流程](contributing.md) | 网页与 Git 双通道、冲突处理、校验错误修正 |
| [权限与撤权边界](permissions.md) | 库角色、访问凭据、撤权后会发生什么 |
| [历史边界：重命名与跨库移动](history-boundary.md) | 重命名历史跟随、跨库移动不跟随、旧引用仍可解析 |

第一版的能力边界与已知限制集中声明在 [known-limitations.md](../known-limitations.md)。
