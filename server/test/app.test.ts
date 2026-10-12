import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.ts';

// selection §3/§5：Fastify v5 内置 inject()（light-my-request）免 socket 测路由；
// /healthz 为 liveness 健康检查端点。

test('GET /healthz → 200 { status: "ok" }（inject，无 socket）', async () => {
  const app = buildApp();
  const res = await app.inject({ method: 'GET', url: '/healthz' });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] ?? '', /application\/json/);
  assert.deepEqual(res.json(), { status: 'ok' });
  await app.close();
});

test('未知路径 → 404（Review Focus 5）', async () => {
  const app = buildApp();
  const res = await app.inject({ method: 'GET', url: '/nope' });
  assert.equal(res.statusCode, 404);
  await app.close();
});
