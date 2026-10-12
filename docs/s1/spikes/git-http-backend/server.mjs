// THROWAWAY spike code — not product code. Evidence for docs/s1/selection.md (S1-T1 route B).
// Minimal Node CGI wrapper around `git http-backend`: Basic auth -> REMOTE_USER,
// stable repo-ID path mapping, streamed request/response bodies.
import http from 'node:http';
import { spawn } from 'node:child_process';

const USERS = { alice: 'secret-a', bob: 'secret-b' }; // stand-in for real credential check

function deny(res) {
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="notegit-spike"' });
  res.end('auth required');
}

export function createServer({ projectRoot, authenticate = true }) {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://spike');
    let remoteUser = null;
    if (authenticate) {
      const auth = req.headers.authorization;
      if (!auth?.startsWith('Basic ')) return deny(res);
      const [user, pass] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
      if (USERS[user] !== pass) return deny(res);
      remoteUser = user;
    }
    // 架构 §3.2: 仓库路径由稳定 ID 映射，不拼接用户输入（此处白名单正则即占位实现）
    const m = url.pathname.match(/^\/vaults\/([A-Za-z0-9][A-Za-z0-9-]*?)(?:\.git)?(\/.*)?$/);
    if (!m) { res.writeHead(404); return res.end('not found'); }
    const [, repoId, pathInfo = ''] = m;

    const env = {
      ...process.env,
      GATEWAY_INTERFACE: 'CGI/1.1',
      REQUEST_METHOD: req.method,
      QUERY_STRING: url.searchParams.toString(),
      PATH_INFO: `/${repoId}.git${pathInfo}`,
      GIT_PROJECT_ROOT: projectRoot,
      GIT_HTTP_EXPORT_ALL: '1',
      REMOTE_USER: remoteUser ?? '',
      REMOTE_ADDR: req.socket.remoteAddress ?? '127.0.0.1',
      CONTENT_TYPE: req.headers['content-type'] ?? '',
      SERVER_PROTOCOL: 'HTTP/1.1',
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
      const headers = {};
      let status = 200;
      for (const line of headerBuf.slice(0, idx).toString().split('\r\n')) {
        const i = line.indexOf(':');
        if (i === -1) continue;
        const k = line.slice(0, i).trim().toLowerCase();
        const v = line.slice(i + 1).trim();
        if (k === 'status') status = parseInt(v, 10);
        else headers[k] = v;
      }
      res.writeHead(status, headers);
      res.write(headerBuf.slice(idx + 4));
    });
    backend.stdout.on('end', () => res.end());
    backend.on('close', () => { if (!res.writableEnded) res.end(); });
    backend.on('error', (err) => { if (!res.headersSent) { res.writeHead(502); } res.end(String(err)); });
    req.on('aborted', () => backend.stdin.destroy());
  });
}

export function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
