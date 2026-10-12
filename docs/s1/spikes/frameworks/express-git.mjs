// THROWAWAY spike — Express v5 hosting git smart-HTTP via http-backend CGI.
// Express does not parse bodies without body-parser middleware, so req is the
// raw stream; nothing else needed for pass-through streaming.
import express from 'express';
import { spawn } from 'node:child_process';

function cgi(req, res, projectRoot) {
  const url = new URL(req.url, 'http://spike');
  const m = url.pathname.match(/^\/vaults\/([A-Za-z0-9][A-Za-z0-9-]*?)(?:\.git)?(\/.*)?$/);
  if (!m) { res.writeHead(404); return res.end('not found'); }
  const env = {
    ...process.env,
    GATEWAY_INTERFACE: 'CGI/1.1', REQUEST_METHOD: req.method,
    QUERY_STRING: url.searchParams.toString(),
    PATH_INFO: `/${m[1]}.git${m[2] ?? ''}`,
    GIT_PROJECT_ROOT: projectRoot, GIT_HTTP_EXPORT_ALL: '1',
    REMOTE_USER: 'alice', REMOTE_ADDR: '127.0.0.1',
    CONTENT_TYPE: req.headers['content-type'] ?? '', SERVER_PROTOCOL: 'HTTP/1.1',
  };
  if (req.headers['content-length']) env.CONTENT_LENGTH = req.headers['content-length'];
  if (req.headers['content-encoding']) env.HTTP_CONTENT_ENCODING = req.headers['content-encoding'];
  if (req.headers['accept-encoding']) env.HTTP_ACCEPT_ENCODING = req.headers['accept-encoding'];
  const backend = spawn('git', ['http-backend'], { env });
  req.pipe(backend.stdin);
  let headerBuf = Buffer.alloc(0);
  backend.stdout.on('data', (chunk) => {
    if (res.headersSent) return res.write(chunk);
    headerBuf = Buffer.concat([headerBuf, chunk]);
    const idx = headerBuf.indexOf('\r\n\r\n');
    if (idx === -1) return;
    const headers = {}; let status = 200;
    for (const line of headerBuf.slice(0, idx).toString().split('\r\n')) {
      const i = line.indexOf(':'); if (i === -1) continue;
      const k = line.slice(0, i).trim().toLowerCase(); const v = line.slice(i + 1).trim();
      if (k === 'status') status = parseInt(v, 10); else headers[k] = v;
    }
    res.writeHead(status, headers);
    res.write(headerBuf.slice(idx + 4));
  });
  backend.stdout.on('end', () => res.end());
  backend.on('close', () => { if (!res.writableEnded) res.end(); });
}

export async function makeExpressGitApp({ projectRoot }) {
  const app = express();
  app.all(['/vaults/:repo', '/vaults/:repo/*path'], (req, res) => cgi(req, res, projectRoot));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  return server;
}
