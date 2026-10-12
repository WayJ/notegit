import fastify, { type FastifyInstance } from 'fastify';

/**
 * 构建Fastify v5 应用骨架。当前仅 /healthz（selection §5 liveness 端点）；
 * 数据库接线（open → pragmas → migrate → listen）随 S2-T2+ 启动流程落地。
 */
export function buildApp(): FastifyInstance {
  const app = fastify();
  app.get('/healthz', async () => ({ status: 'ok' }));
  return app;
}
