// THROWAWAY spike — indicative hello-world benchmark (docs/s1/selection.md).
// NOT a capacity claim: single process, single machine, no TLS, trivial handler.
import http from 'node:http';
import Fastify from 'fastify';
import express from 'express';
import { execFileSync } from 'node:child_process';
import autocannon from 'autocannon';

const results = {};
async function bench(name, start) {
  const { server, port } = await start();
  await new Promise((r) => setTimeout(r, 200));
  const j = await autocannon({ url: `http://127.0.0.1:${port}/hello`, connections: 50, duration: 3 });
  results[name] = { rps: j.requests.average, latP99: j.latency.p99, errors: j.errors };
  server.close();
}

await bench('node:http (baseline)', async () => {
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); });
  server.keepAliveTimeout = 72e3; // fastify sets long keep-alive; match it for a fair baseline
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port };
});
await bench('fastify v5', async () => {
  const app = Fastify();
  app.get('/hello', async () => 'ok');
  await app.listen({ port: 0, host: '127.0.0.1' });
  return { server: app.server, port: app.server.address().port };
});
await bench('express v5', async () => {
  const app = express();
  app.get('/hello', (req, res) => res.send('ok'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  return { server, port: server.address().port };
});

const cpu = execFileSync('sysctl', ['-n', 'machdep.cpu.brand_string']).toString().trim();
const fv = (await import('./node_modules/fastify/package.json', { with: { type: 'json' } })).default.version;
const ev = (await import('./node_modules/express/package.json', { with: { type: 'json' } })).default.version;
const { writeFileSync, mkdirSync } = await import('node:fs');
mkdirSync(new URL('./evidence/', import.meta.url).pathname, { recursive: true });
const out = `# Framework hello-world micro-benchmark — INDICATIVE (THROWAWAY spike)
date: ${new Date().toISOString()}
machine: ${cpu}, macOS, loopback, no TLS; autocannon -c 50 -d 3s; trivial GET /hello handler.
fastify ${fv}, express ${ev}, node ${process.version}
NOTE: 指示性数字（单进程、回环、无 TLS、hello-world），仅用于量级对比；不构成容量承诺。

| target | req/s (avg) | p99 latency ms | errors |
|---|---|---|---|
${Object.entries(results).map(([k, v]) => `| ${k} | ${v.rps.toFixed(0)} | ${(v.latP99 / 1000).toFixed(2)} | ${v.errors} |`).join('\n')}
`;
writeFileSync(new URL('./evidence/frameworks-bench.txt', import.meta.url).pathname, out);
console.log(out);
process.exit(0);
