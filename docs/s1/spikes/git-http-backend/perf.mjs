// THROWAWAY spike — indicative perf evidence for route B (docs/s1/selection.md).
// Numbers are INDICATIVE (single laptop, loopback); machine context recorded below.
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, listen } from './server.mjs';

const execFileP = promisify(execFile);
// deterministic pseudo-random text so packs don't compress to nothing (realistic size)
function pseudoRandomText(bytes, seed) {
  let s = seed >>> 0 || 1;
  const words = [];
  while (words.join(' ').length < bytes) { s = (s * 1664525 + 1013904223) >>> 0; words.push(s.toString(36)); }
  return words.join(' ').slice(0, bytes);
}
process.env.GIT_TERMINAL_PROMPT = '0';

const root = mkdtempSync(path.join(tmpdir(), 'spike-b-perf-'));
const projectRoot = path.join(root, 'vaults');
const repo = path.join(projectRoot, 'v001.git');
execFileSync('git', ['init', '--bare', '-b', 'main', repo]);
execFileSync('git', ['--git-dir', repo, 'config', 'receive.denyNonFastForwards', 'true']);

// --- build synthetic knowledge repo: 500 md files x ~8KB, 20 commits ---
const work = path.join(root, 'work');
execFileSync('git', ['init', '-b', 'main', work]);
execFileSync('git', ['-C', work, 'config', 'user.email', 'p@spike']);
execFileSync('git', ['-C', work, 'config', 'user.name', 'perf']);
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
const repoSize = execFileSync('du', ['-sh', repo]).toString().trim();

// --- server + timing ---
const server = createServer({ projectRoot });
const port = await listen(server);
const url = `http://alice:secret-a@127.0.0.1:${port}/vaults/v001.git`;
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const ms = (fn) => async (...args) => { const t = performance.now(); await fn(...args); return performance.now() - t; };
const cloneMs = ms(() => { const d = path.join(root, `c-${Math.random()}`); return execFileP('git', ['clone', '-q', url, d]).then(() => rmSync(d, { recursive: true, force: true })); });

const fullClones = [];
for (let i = 0; i < 5; i++) fullClones.push(await cloneMs());

const pusher = path.join(root, 'pusher');
await execFileP('git', ['clone', '-q', url, pusher]);
execFileSync('git', ['-C', pusher, 'config', 'user.email', 'p@spike']);
execFileSync('git', ['-C', pusher, 'config', 'user.name', 'perf']);
const pushMs = ms((body, name) => {
  writeFileSync(path.join(pusher, name), body);
  execFileSync('git', ['-C', pusher, 'add', '.']);
  execFileSync('git', ['-C', pusher, 'commit', '-qm', name]);
  return execFileP('git', ['-C', pusher, 'push', '-q', 'origin', 'main']);
});
const smallPushes = [];
for (let i = 0; i < 5; i++) smallPushes.push(await pushMs(`---\ntitle: S${i}\n---\nsmall\n`, `small-${i}.md`));
const bulkPushes = [];
for (let i = 0; i < 3; i++) {
  for (let f = 0; f < 100; f++) writeFileSync(path.join(pusher, `bulk-${i}-${f}.md`), `---\ntitle: B\n---\n` + pseudoRandomText(8 * 1024, i * 1000 + f) + '\n');
  bulkPushes.push(await pushMs('', 'bulk-commit')); // name is only used once per call; add committed above
}
const fetches = [];
const fetchMs = ms(() => execFileP('git', ['-C', pusher, 'fetch', '-q', 'origin']));
for (let i = 0; i < 5; i++) fetches.push(await fetchMs());

// server process RSS (for deployment floor derivation)
const rssKb = parseInt(execFileSync('ps', ['-o', 'rss=', '-p', String(process.pid)]).toString().trim(), 10);
const cpu = execFileSync('sysctl', ['-n', 'machdep.cpu.brand_string']).toString().trim();
const mem = execFileSync('sysctl', ['-n', 'hw.memsize']).toString().trim();

const out = `# Route B (git http-backend CGI wrap) — indicative perf evidence (THROWAWAY spike)
date: ${new Date().toISOString()}
machine: ${cpu}, ${Math.round(parseInt(mem) / 1024 / 1024 / 1024)} GB RAM, macOS, loopback HTTP (no TLS)
repo: 501 md files (~8KB each, ~4.1MB content), 21+ commits, bare size: ${repoSize}
node: ${process.version}, git: ${execFileSync('git', ['--version']).toString().trim()}
NOTE: 数字为指示性（单机回环、无 TLS、无并发），用于量级对比而非容量承诺。

full clone (cold, no local cache), 5 runs: ${fullClones.map((x) => x.toFixed(0)).join(' / ')} ms -> median ${median(fullClones).toFixed(0)} ms
push 1 small md commit,     5 runs: ${smallPushes.map((x) => x.toFixed(0)).join(' / ')} ms -> median ${median(smallPushes).toFixed(0)} ms
push 100 x 8KB md commit,   3 runs: ${bulkPushes.map((x) => x.toFixed(0)).join(' / ')} ms -> median ${median(bulkPushes).toFixed(0)} ms
no-op fetch,                5 runs: ${fetches.map((x) => x.toFixed(0)).join(' / ')} ms -> median ${median(fetches).toFixed(0)} ms
server node process RSS after above load: ${rssKb} KB (${(rssKb / 1024).toFixed(1)} MB)
`;
mkdirSync(path.dirname(new URL(import.meta.url).pathname), { recursive: true });
writeFileSync(new URL('./evidence/route-b-perf.txt', import.meta.url).pathname, out);
console.log(out);
server.close(); rmSync(root, { recursive: true, force: true });
setTimeout(() => process.exit(0), 300);
