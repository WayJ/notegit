import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';

/**
 * UI-RESTYLE 静态资产路由（样式基础设施；仅呈现层——不改任何既有路由）：
 *
 * - GET /assets/styles.css —— 全站唯一共享 CSS（DESIGN.md 设计 token 契约的
 *   落地文件，见 assets/styles.css 头注）。模块加载期一次读入（源码树直跑 /
 *   容器 COPY server/ 均覆盖该文件——deploy/Dockerfile；无打包层）。
 *
 * 公开访问（同 /login：样式不含实例数据）；GET 免 CSRF。api.md §13 既有页面
 * 路由与行为零变化——本路由是新增的纯资产端点。
 */

const STYLES = readFileSync(new URL('./assets/styles.css', import.meta.url), 'utf8');

export function registerAssetRoutes(app: FastifyInstance): void {
  app.get('/assets/styles.css', async (_req, reply) => {
    // 短缓存：文件名无内容哈希，部署重启即生效窗口（1h 内旧样式可接受）
    return reply
      .type('text/css; charset=utf-8')
      .header('cache-control', 'public, max-age=3600')
      .send(STYLES);
  });
}
