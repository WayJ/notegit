// THROWAWAY spike — indicative perf evidence for route A (docs/s1/selection.md).
// Same synthetic repo protocol as route B perf (500 x ~8KB incompressible md, 20+ commits).
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, listen } from './server.mjs';

const execFileP = promisify(execFile);
process.env.GIT_TERMINAL_PROMPT = '0';

const root = mkdtempSync(path.join(tmpdir(), 'spike-a-perf-'));
const projectRoot = path.join(root, 'vaults');
const repo = path.join(projectRoot, 'v001.git');
execFileSync('git', ['init', '--bare', '-b', 'main', repo]);

const work = path.join(root, 'work');
execFileSync('git', ['init', '-b', 'main', work]);
execFileSync('git', ['-C', work, 'config', 'user.email', 'p@spike']);
execFileSync('git', ['-C', work, 'config', 'user.name', 'perf']);
function pseudoRandomText(bytes, seed) {
  let s = seed >>> 0 || 1; const words = [];
  while (words.join(' ').length < bytes) { s = (s * 1664525 + 1013904223) >>> 0; words.push(s.toString(36)); }
  return words.join(' ').slice(0, bytes);
}
writeFileSync(path.join(work, 'README.md'), '# nav\n');
execFileSync('git', ['-C', work, 'add', '.']);
execFileSync('git', ['-C', work, 'commit', '-qm', 'root']);
let n = 0;
for (let c = 0; c < 20; c++) {
  for (let f = 0; f < 25; f++) {
    const dir = path.join(work, `area-${Math.floor(n / 50)}`);
    if (!exists(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `doc-${n}.md`), `---\ntitle: Doc ${n}\n---\n` + pseudoRandomText(8 * 1024, n) + '\n'); n++;
  }
  execFileSync('git', ['-C', work, 'add', '.']);
  execFileSync('git', ['-C', work, 'commit', '-qm', `batch ${c}`]);
}
function exists(p) { try { require('node:fs').statSync(p); return true; } catch { return false; } }
execFileSync('git', ['-C', work, 'push', '-q', repo, 'main']);
const repoSize = execFileSync('du', ['-sh', repo]).toString().trim();

const server = createServer({ projectRoot });
const port = await listen(server);
const url = `http://alice:secret-a@127.0.0.1:${port}/vaults/v001.git`;
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

const fullClones = [];
for (let i = 0; i < 5; i++) {
  const d = path.join(root, `c-${Math.random()}`);
  const t = performance.now();
  await execFileP('git', ['clone', '-q', url, d]);
  fullClones.push(performance.now() - t);
  rmSync(d, { recursive: true, force: true });
}
const pusher = path.join(root, 'pusher');
await execFileP('git', ['clone', '-q', url, pusher]);
execFileSync('git', ['-C', pusher, 'config', 'user.email', 'p@spike']);
execFileSync('git', ['-C', pusher, 'config', 'user.name', 'perf']);
const smallPushes = [];
for (let i = 0; i < 5; i++) {
  writeFileSync(path.join(pusher, `small-${i}.md`), `---\ntitle: S${i}\n---\nsmall\n`);
  execFileSync('git', ['-C', pusher, 'add', '.']);
  execFileSync('git', ['-C', pusher, 'commit', '-qm', `s${i}`]);
  const t = performance.now();
  await execFileP('git', ['-C', pusher, 'push', '-q', 'origin', 'main']);
  smallPushes.push(performance.now() - t);
}
const bulkPushes = [];
for (let i = 0; i < 3; i++) {
  for (let f = 0; f < 100; f++) writeFileSync(path.join(pusher, `bulk-${i}-${f}.md`), `---\ntitle: B\n---\n` + pseudoRandomText(8 * 1024, i * 1000 + f) + '\n');
  execFileSync('git', ['-C', pusher, 'add', '.']);
  execFileSync('git', ['-C', pusher, 'commit', '-qm', `bulk ${i}`]);
  const t = performance.now();
  await execFileP('git', ['-C', pusher, 'push', '-q', 'origin', 'main']);
  bulkPushes.push(performance.now() - t);
}
const fetches = [];
for (let i = 0; i < 5; i++) {
  const t = performance.now();
  await execFileP('git', ['-C', pusher, 'fetch', '-q', 'origin']);
  fetches.push(performance.now() - t);
}
const rssKb = parseInt(execFileSync('ps', ['-o', 'rss=', '-p', String(process.pid)]).toString().trim(), 10);
const cpu = execFileSync('sysctl', ['-n', 'machdep.cpu.brand_string']).toString().trim();

const out = `# Route A (isomorphic-git pure-JS server) — indicative perf evidence (THROWAWAY spike)
date: ${new Date().toISOString()}
machine: ${cpu}, 16 GB RAM, macOS, loopback HTTP (no TLS)
repo: 501 md files (~8KB each, ~4.1MB content), 21+ commits, bare size: ${repoSize}
node: ${process.version}, git client: ${execFileSync('git', ['--version']).toString().trim()}, isomorphic-git: ${(await import('./node_modules/isomorphic-git/package.json', { with: { type: 'json' } })).default.version}
NOTE: 数字为指示性（单机回环、无 TLS、无并发）。服务端 fetch 采用「全量 closure + packObjects」的简化实现，增量协商（have/want delta 协商）未实现，fetch 时间随推送历史增长可能进一步劣化。

full clone (cold), 5 runs: ${fullClones.map((x) => x.toFixed(0)).join(' / ')} ms -> median ${median(fullClones).toFixed(0)} ms
push 1 small md commit, 5 runs: ${smallPushes.map((x) => x.toFixed(0)).join(' / ')} ms -> median ${median(smallPushes).toFixed(0)} ms
push 100 x 8KB md commit, 3 runs: ${bulkPushes.map((x) => x.toFixed(0)).join(' / ')} ms -> median ${median(bulkPushes).toFixed(0)} ms
no-op fetch, 5 runs: ${fetches.map((x) => x.toFixed(0)).join(' / ')} ms -> median ${median(fetches).toFixed(0)} ms
server node process RSS after above load: ${rssKb} KB (${(rssKb / 1024).toFixed(1)} MB)
`;
const { writeFileSync: wf } = await import('node:fs');
mkdirSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'evidence'), { recursive: true });
wf(new URL('./evidence/route-a-perf.txt', import.meta.url).pathname, out);
console.log(out);
server.close(); rmSync(root, { recursive: true, force: true });
setTimeout(() => process.exit(0), 300);
