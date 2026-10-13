import type { FastifyInstance } from 'fastify';
import { rulesManifest } from 'notegit-validation';
import { rejectAuth, type RequestAuthenticator } from '../auth/lifecycle.ts';

/**
 * 规则版本元信息端点（S6-T7；api.md §3.3 补录，ADR 由 master 落）：
 *
 * - GET /api/v1/rules-version —— 200 `{rulesVersion, status}`；需认证（Bearer/会话
 *   双载体，经统一缝；未认证 401 E-AUTH-001，api.md §1 通用映射）。任意已认证
 *   员工可读（版本元信息不涉库数据，不做角色门槛）。
 * - 值的唯一来源：docs/contracts/rules-version.json（validation §7.3 三端引用：
 *   与 pre-receive/发布组件同经 notegit-validation 运行时读取，服务端不另行复制
 *   维护）。选型记录：运行时读（构建期内联被否——会引入第二份拷贝，漂移面更大）。
 * - 用途：CLI 版本探测（S6-T4 version-probe 激活端点；本地旧于服务端时客户端附
 *   N-UPGRADE-001 提示，validation §6：版本差异本身不构成拒绝理由）。
 */
export interface RulesVersionRoutesOptions {
  readonly authenticateRequest: RequestAuthenticator;
}

export function registerRulesVersionRoutes(app: FastifyInstance, opts: RulesVersionRoutesOptions): void {
  app.get('/api/v1/rules-version', async (req, reply) => {
    const outcome = await opts.authenticateRequest(req);
    if (!outcome.ok) return rejectAuth(reply, outcome);
    const manifest = rulesManifest();
    return reply.code(200).send({ rulesVersion: manifest.rulesVersion, status: manifest.status });
  });
}
