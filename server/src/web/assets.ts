import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';

/**
 * UI-RESTYLE 静态资产路由（样式基础设施；仅呈现层——不改任何既有路由）：
 *
 * - GET /assets/styles.css —— 全站唯一共享 CSS（DESIGN.md 设计 token 契约的
 *   落地文件，见 assets/styles.css 头注）。模块加载期一次读入（源码树直跑 /
 *   容器 COPY server/ 均覆盖该文件——deploy/Dockerfile；无打包层）。
 *
 * S12-T3（D19-A 第一步 / G10）：GET /assets/app.js —— 全站唯一共享页脚本
 * （各页重复内联 api() fetch 封装的最小公共抽取，行为零变化；语义与缓存
 * 约定见 assets/app.js 头注）。与 styles.css 同构注册：模块加载期一次读入、
 * 公开访问（脚本不含实例数据）、GET 免 CSRF。
 *
 * 缓存热修（2026-10-15，v2 换轨日暴露）：可变内容挂稳定 URL 不得配强缓存
 * （原 public, max-age=3600 使视觉切换后全体用户最长 1h 仍见旧 CSS）。改
 * **协商缓存**：`Cache-Control: no-cache`（每次重验证）+ 内容 sha256 ETag，
 * If-None-Match 命中回 304——内容未变零传输、内容即变即时生效。契约注记随
 * 本热修同步（api.md §13 共享静态资产段）。
 */

const STYLES = readFileSync(new URL('./assets/styles.css', import.meta.url), 'utf8');
const APP_JS = readFileSync(new URL('./assets/app.js', import.meta.url), 'utf8');

/** 内容 ETag（sha256 双引号形态——协商缓存比较用；启动期一次计算） */
function contentEtag(body: string): string {
  return `"${createHash('sha256').update(body).digest('hex')}"`;
}

/** 协商缓存发送（styles.css/app.js 共用：no-cache + ETag；命中 If-None-Match 304） */
function sendNegotiated(reply: FastifyReply, contentType: string, body: string): FastifyReply {
  const etag = contentEtag(body);
  reply.type(contentType).header('cache-control', 'no-cache').header('etag', etag);
  if (reply.request.headers['if-none-match'] === etag) {
    return reply.code(304).send();
  }
  return reply.send(body);
}

export function registerAssetRoutes(app: FastifyInstance): void {
  app.get('/assets/styles.css', async (_req, reply) => {
    return sendNegotiated(reply, 'text/css; charset=utf-8', STYLES);
  });
  app.get('/assets/app.js', async (_req, reply) => {
    return sendNegotiated(reply, 'application/javascript; charset=utf-8', APP_JS);
  });
}
