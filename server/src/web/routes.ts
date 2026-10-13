import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import type { RequestAuthenticator } from '../auth/lifecycle.ts';
import type { MaintenanceGate } from '../maintenance/gate.ts';
import { createPageGuard } from './page-kit.ts';
import { webWriteGuard } from './write-gate.ts';
import { registerShellRoutes } from './shell.ts';
import { registerBrowseRoutes } from './browse/routes.ts';
import { registerViewRoutes } from './view/routes.ts';
import { registerUploadRoutes } from './upload/routes.ts';
import { registerEditRoutes } from './edit/routes.ts';
import { registerRenameRoutes } from './rename/routes.ts';
import { registerHistoryRoutes } from './history/routes.ts';
import { registerSearchPageRoutes } from './search/routes.ts';
import { submissionsPlugin } from './edit/submissions.ts';

/**
 * Web 页面域组装点（唯一主链路——S4 plan D5 骨架裁决，S3 教训对策）：
 *
 * 本文件只做三件事：定义全域共享选项、构造共享页面认证守卫、按序注册各页面
 * 模块。S4-T2 起各任务（预览/表单/上传/重命名删除/草稿/冲突保护/双向收口）
 * 新增自己的页面模块目录，并仅在下方注册表 append 一行——不改本文件既有行、
 * 不改 web/ 之外的注册代码。页面模块自声明所需选项（结构化子集），不反向
 * 依赖本文件。
 *
 * 全域约定（各模块遵守）：页面路由 GET 免 CSRF；认证经统一缝
 * authenticateRequest（实时查库 D-IC-05；未认证 302 /login）；无权库与不存在
 * 同 404 页（D-IC-06）；插值唯一通道 escapeHtml；数据页实时渲染（无页内缓存）。
 */

export interface WebRoutesOptions {
  readonly db: DatabaseSync;
  readonly authenticateRequest: RequestAuthenticator;
  /** S4-T1 起：数据目录（S3-T1 布局 <dataDir>/git/<id>.git）。注入后目录浏览/
   * 预览读真实 bare 仓库；缺省（S2 测试形态）浏览路由仍注册、仓库读取呈空态。
   * 生产装配（main.ts）恒传入。 */
  readonly dataDir?: string;
  /** S4-T5 维护闸门 web 缝（T4 遗留移交；backup-recovery §3 矩阵 web 行）：
   *  注入后全部 web 写操作（upload/rename/delete；未来 edit submit POST 自动
   *  覆盖——凡 /vaults/ 下非安全方法）维护模式 503（write-gate.ts）。缺省不
   *  拦截（无 gate 调用形态）；生产装配（app.ts）恒传入。 */
  readonly maintenanceGate?: MaintenanceGate;
}

export function registerWebRoutes(app: FastifyInstance, opts: WebRoutesOptions): void {
  const shared = { ...opts, requirePageUser: createPageGuard(opts.authenticateRequest) };
  // S4-T5 缝（T4 遗留）：web 写守卫——/vaults/ 下非安全方法维护模式 503
  // （backup §3 矩阵 web 行；api/v1 与 /git 各有同语义闸门，不在此层）
  app.addHook('onRequest', webWriteGuard(opts.maintenanceGate));
  registerShellRoutes(app, shared); // S2-T8 外壳四页（/login、/、/admin、/credentials）
  registerBrowseRoutes(app, shared); // S4-T1 有权库列表 + 目录浏览 + 预览占位
  // S4-T2+ ：各任务页面模块在此 append（一行一模块）
  registerViewRoutes(app, shared); // S4-T2 Markdown 预览与安全渲染（view 路由族自本任务起由 view/ 模块持有，S4-T1 占位退役）
  registerEditRoutes(app, shared); // S4-T3 元数据表单与正文编辑（edit 路由族；提交走 S3-T7 发布组件占位调用面，HTTP 接线属 T7）
  registerUploadRoutes(app, shared); // S4-T4 上传端点 + 附件鉴权读取（blob 寻址，URL 不可枚举；view 附件通道装配）
  registerRenameRoutes(app, shared); // S4-T5 重命名与删除（目标路径重判定/历史保留；GET 表单页 + POST 走发布组件）
  registerHistoryRoutes(app, shared); // S5-T1 提交历史与文档 diff（默认分支实时读 Git；库级/路径级历史页 + 逐文件 diff；无权=不存在 404）
  registerSearchPageRoutes(app, shared); // S5-T4 元数据查找页（/search?q=——查询面实时成员过滤，与 API 端点同一判定面）
  // S4-T7 提交端点（api.md §8.2 POST /api/v1/vaults/{slug}/submissions）：编辑页
  // 「提交」按钮消费端——/api/v1 域（认证 401 JSON、app 级 maintenanceGuard/
  // CSRF 自动覆盖）；冲突保护 409 E-RES-003 含当前 tip（组件层 gate 透传为最后一道）
  app.register(submissionsPlugin, {
    db: opts.db,
    authenticateRequest: opts.authenticateRequest,
    ...(opts.dataDir !== undefined ? { dataDir: opts.dataDir } : {}),
    ...(opts.maintenanceGate !== undefined ? { maintenanceGate: opts.maintenanceGate } : {}),
  });
}
