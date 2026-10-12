// THROWAWAY spike — Fastify v5 hosting git smart-HTTP via http-backend CGI.
// Key point: git content types must bypass body parsing with a STREAMING
// content-type parser (parseAs buffer would load whole packs into memory).
import Fastify from 'fastify';
import { spawn } from 'node:child_process';

function cgi(req, rawRes, projectRoot, remoteUser) {
  const url = new URL(req.url, 'http://spike');
  const m = url.pathname.match(/^\/vaults\/([A-Za-z0-9][A-Za-z0-9-]*?)(?:\.git)?(\/.*)?$/);
  if (!m) { rawRes.writeHead(404); rawRes.end('not found'); return; }
  const env = {
    ...process.env,
    GATEWAY_INTERFACE: 'CGI/1.1', REQUEST_METHOD: req.method,
    QUERY_STRING: url.searchParams.toString(),
    PATH_INFO: `/${m[1]}.git${m[2] ?? ''}`,
    GIT_PROJECT_ROOT: projectRoot, GIT_HTTP_EXPORT_ALL: '1',
    REMOTE_USER: remoteUser ?? '', REMOTE_ADDR: '127.0.0.1',
    CONTENT_TYPE: req.headers['content-type'] ?? '', SERVER_PROTOCOL: 'HTTP/1.1',
  };
  if (req.headers['content-length']) env.CONTENT_LENGTH = req.headers['content-length'];
  if (req.headers['content-encoding']) env.HTTP_CONTENT_ENCODING = req.headers['content-encoding'];
  if (req.headers['accept-encoding']) env.HTTP_ACCEPT_ENCODING = req.headers['accept-encoding'];
  const backend = spawn('git', ['http-backend'], { env });
  const src = req.__forwardedBody ?? req;
  src.pipe(backend.stdin);
  src.on('error', () => backend.stdin.destroy());
  let headerBuf = Buffer.alloc(0);
  backend.stdout.on('data', (chunk) => {
    if (rawRes.headersSent) return rawRes.write(chunk);
    headerBuf = Buffer.concat([headerBuf, chunk]);
    const idx = headerBuf.indexOf('\r\n\r\n');
    if (idx === -1) return;
    const headers = {}; let status = 200;
    for (const line of headerBuf.slice(0, idx).toString().split('\r\n')) {
      const i = line.indexOf(':'); if (i === -1) continue;
      const k = line.slice(0, i).trim().toLowerCase(); const v = line.slice(i + 1).trim();
      if (k === 'status') status = parseInt(v, 10); else headers[k] = v;
    }
    rawRes.writeHead(status, headers);
    rawRes.write(headerBuf.slice(idx + 4));
  });
  backend.stdout.on('end', () => rawRes.end());
  backend.on('close', () => { if (!rawRes.writableEnded) rawRes.end(); });
}

export async function makeFastifyGitApp({ projectRoot }) {
  const app = Fastify();
  // stream git request bodies through untouched (no buffering): a parser without
  // parseAs receives the RAW STREAM as payload; passing it to done() forwards it
  app.addContentTypeParser('*', (req, payload, done) => done(null, payload));
  app.route({
    method: ['GET', 'POST'],
    url: '/vaults/*',
    handler: (req, reply) => {
      reply.hijack(); // take over the raw response for CGI streaming
      // req.body is the forwarded raw stream for POSTs (GET has none)
      const rawReq = Object.assign(req.raw, { __forwardedBody: req.body });
      cgi(rawReq, reply.raw, projectRoot, 'alice');
    },
  });
  await app.ready();
  return app.server;
}
