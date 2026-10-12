// THROWAWAY spike — peak RSS of git child processes during HTTP clone (route B).
// Purpose: back the deployment-spec memory row in selection.md with a measurement
// instead of an estimate. INDICATIVE (single laptop, loopback).
import { execFileSync, execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, listen } from './server.mjs';

const execFileP = promisify(execFile);
function pseudoRandomText(bytes, seed) {
  let s = seed >>> 0 || 1; const words = [];
  while (words.join(' ').length < bytes) { s = (s * 1664525 + 1013904223) >>> 0; words.push(s.toString(36)); }
  return words.join(' ').slice(0, bytes);
}
process.env.GIT_TERMINAL_PROMPT = '0';

const root = mkdtempSync(path.join(tmpdir(), 'spike-b-rss-'));
const projectRoot = path.join(root, 'vaults');
const repo = path.join(projectRoot, 'v001.git');
execFileSync('git', ['init', '--bare', '-b', 'main', repo]);
execFileSync('git', ['--git-dir', repo, 'config', 'receive.denyNonFastForwards', 'true']);
const work = path.join(root, 'work');
execFileSync('git', ['init', '-b', 'main', work]);
execFileSync('git', ['-C', work, 'config', 'user.email', 'p@spike']);
execFileSync('git', ['-C', work, 'config', 'user.name', 'rss']);
writeFileSync(path.join(work, 'README.md'), '# nav\n');
execFileSync('git', ['-C', work, 'add', '.']);
execFileSync('git', ['-C', work, 'commit', '-qm', 'root']);
let n = 0;
for (let c = 0; c < 20; c++) {
  for (let f = 0; f < 25; f++) {
    const dir = path.join(work, `area-${Math.floor(n / 50)}`);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `doc-${n}.md`), `---\ntitle: Doc ${n}\n---\n` + pseudoRandomText(8 * 1024, n) + '\n'); n++;
  }
  execFileSync('git', ['-C', work, 'add', '.']);
  execFileSync('git', ['-C', work, 'commit', '-qm', `batch ${c}`]);
}
execFileSync('git', ['-C', work, 'push', '-q', repo, 'main']);

const server = createServer({ projectRoot, authenticate: (u, p) => (u === 'alice' && p === 'secret-a') ? u : null });
await listen(server);
const port = server.address().port;
const url = `http://alice:secret-a@127.0.0.1:${port}/vaults/v001.git`;

// sample RSS of every git process (http-backend + upload-pack/receive-pack chains)
function serverSideRss(clientRootPid) {
  // server-side = descended from THIS node process WITHOUT passing through the
  // client `git clone` subprocess we spawn (that subtree is the client, plus the
  // ps sampler itself).
  try {
    const out = execFileSync('ps', ['-eo', 'rss=,ppid=,pid=,comm=']).toString();
    const rows = out.split('\n').map(l => l.trim()).filter(Boolean)
      .map(l => { const m = l.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/); return m && { kb: +m[1], ppid: +m[2], pid: +m[3], cmd: m[4] }; }).filter(Boolean);
    const byPid = new Map(rows.map(r => [r.pid, r]));
    const walk = (r, stopAt) => {
      let cur = r;
      for (let i = 0; i < 10 && cur; i++) { if (cur.pid === stopAt) return true; cur = byPid.get(cur.ppid); }
      return false;
    };
    return rows.filter(r => r.cmd !== 'ps' && !walk(r, clientRootPid) && walk(r, process.pid));
  } catch { return []; }
}

const peaks = {};
const seen = new Set();
const dst = path.join(root, 'clone');
let clientRootPid = -1;
const sampler = setInterval(() => {
  for (const p of serverSideRss(clientRootPid)) {
    seen.add(p.cmd);
    peaks[p.cmd] = Math.max(peaks[p.cmd] || 0, p.kb);
  }
}, 5);
const t0 = performance.now();
const cloneChild = spawn('git', ['clone', '-q', url, dst], { stdio: 'ignore' });
clientRootPid = cloneChild.pid;   // promisify(execFile) hides the ChildProcess; spawn keeps .pid
await new Promise((res, rej) => { cloneChild.on('error', rej); cloneChild.on('exit', c => c === 0 ? res() : rej(new Error('clone exit ' + c))); });
const ms = performance.now() - t0;
clearInterval(sampler);

console.log(`# Route B — git child-process peak RSS during HTTP clone (THROWAWAY spike)`);
console.log(`date: ${new Date().toISOString()}`);
console.log(`machine: Apple M4, 16 GB RAM, macOS, loopback; node ${process.version}`);
console.log(`repo: 501 md files ~8KB each (~4.1MB), same generator as route-b-perf.txt`);
console.log(`clone wall time: ${ms.toFixed(0)} ms (sampling every 5ms via ps)`);
for (const [cmd, kb] of Object.entries(peaks).sort((a, b) => b[1] - a[1])) {
  console.log(`peak RSS ${cmd} : ${(kb / 1024).toFixed(1)} MB`);
}
console.log('processes seen:', [...seen].join(' | '));
console.log(`NOTE: 指示性单机测量；进程存活仅数十至数百毫秒，ps 采样可能略低于真实峰值。`);
server.close(); rmSync(root, { recursive: true, force: true });
process.exit(0);
