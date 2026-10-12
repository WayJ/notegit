// THROWAWAY spike test — evidence for docs/s1/selection.md (S1-T1, route A).
// Route A: pure-JS Git server built on isomorphic-git public APIs (no native git
// on the serving path). Same behavioral bar as route B tests (B1-B7).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, listen } from '../server.mjs';

const execFileP = promisify(execFile);
process.env.GIT_TERMINAL_PROMPT = '0';

const root = mkdtempSync(path.join(tmpdir(), 'spike-a-'));
const projectRoot = path.join(root, 'vaults');
const gitdir = path.join(projectRoot, 'v001.git');
execFileSync('git', ['init', '--bare', '-b', 'main', gitdir]);
{ // seed via native client over FILE transport (route under test only serves HTTP)
  const seed = path.join(root, 'seed');
  execFileSync('git', ['init', '-b', 'main', seed]);
  execFileSync('git', ['-C', seed, 'config', 'user.email', 'seed@spike']);
  execFileSync('git', ['-C', seed, 'config', 'user.name', 'seed']);
  writeMd(seed, 'README.md', '# nav\n');
  execFileSync('git', ['-C', seed, 'add', '.']);
  execFileSync('git', ['-C', seed, 'commit', '-m', 'seed']);
  execFileSync('git', ['-C', seed, 'push', gitdir, 'main']);
}
function writeMd(dir, file, body) {
  const abs = path.join(dir, file);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, body);
}

let server, port;
before(async () => { server = createServer({ projectRoot }); port = await listen(server); });
after(async () => { server.close(); rmSync(root, { recursive: true, force: true }); });

const urlFor = (creds) => `http://${creds ? `${creds}@` : ''}127.0.0.1:${port}/vaults/v001.git`;
const ALICE = 'alice:secret-a';
const BOB = 'bob:secret-b';
const serverMain = () => execFileSync('git', ['--git-dir', gitdir, 'rev-parse', 'main']).toString().trim();

test('A1: native git client can clone from isomorphic-git smart-HTTP server', async () => {
  await execFileP('git', ['clone', urlFor(ALICE), path.join(root, 'clone-a1')]);
  assert.ok(existsSync(path.join(root, 'clone-a1', 'README.md')));
});

test('A2: authenticated fast-forward push is accepted (indexPack + writeRef)', async () => {
  const dst = path.join(root, 'clone-a1');
  execFileSync('git', ['-C', dst, 'config', 'user.email', 'a@spike']);
  execFileSync('git', ['-C', dst, 'config', 'user.name', 'alice']);
  writeMd(dst, 'notes/a.md', '---\ntitle: A\n---\nbody\n');
  execFileSync('git', ['-C', dst, 'add', '.']);
  execFileSync('git', ['-C', dst, 'commit', '-m', 'add a']);
  await execFileP('git', ['-C', dst, 'push', 'origin', 'main']);
  assert.equal(execFileSync('git', ['-C', dst, 'rev-parse', 'HEAD']).toString().trim(), serverMain());
});

test('A3: force-push (non-fast-forward) is rejected; server ref unchanged', async () => {
  const dst = path.join(root, 'clone-a1');
  const before = serverMain();
  execFileSync('git', ['-C', dst, 'reset', '--hard', 'HEAD~1']);
  writeMd(dst, 'notes/b.md', '---\ntitle: B\n---\nbody\n');
  execFileSync('git', ['-C', dst, 'add', '.']);
  execFileSync('git', ['-C', dst, 'commit', '-m', 'diverged']);
  await assert.rejects(
    execFileP('git', ['-C', dst, 'push', '--force', 'origin', 'main']),
    (e) => /non-fast-forward|fetch first|rejected/i.test(String(e.stderr)),
  );
  assert.equal(serverMain(), before);
  await execFileP('git', ['-C', dst, 'fetch', '-q', 'origin']);
  execFileSync('git', ['-C', dst, 'reset', '--hard', 'origin/main']);
});

test('A4: per-ref authorization — bob cannot write main, can write feature/*; main delete forbidden', async () => {
  const dst = path.join(root, 'clone-bob');
  await execFileP('git', ['clone', urlFor(BOB), dst]);
  execFileSync('git', ['-C', dst, 'config', 'user.email', 'b@spike']);
  execFileSync('git', ['-C', dst, 'config', 'user.name', 'bob']);
  writeMd(dst, 'notes/by-bob.md', '---\ntitle: ByBob\n---\nbody\n');
  execFileSync('git', ['-C', dst, 'add', '.']);
  execFileSync('git', ['-C', dst, 'commit', '-m', 'bob change']);
  await assert.rejects(
    execFileP('git', ['-C', dst, 'push', 'origin', 'main']),
    (e) => /policy.*bob.*main|bob may not write main/i.test(String(e.stderr)),
  );
  await execFileP('git', ['-C', dst, 'push', 'origin', 'HEAD:refs/heads/feature/x']);
  const refs = execFileSync('git', ['--git-dir', gitdir, 'for-each-ref', '--format=%(refname)']).toString();
  assert.match(refs, /refs\/heads\/feature\/x/);
  const alice = path.join(root, 'clone-a1');
  await assert.rejects(
    execFileP('git', ['-C', alice, 'push', 'origin', ':main']),
    (e) => /delete.*main|deleting main/i.test(String(e.stderr)),
  );
  await execFileP('git', ['-C', alice, 'push', 'origin', ':refs/heads/feature/x']);
});

test('A5: per-commit receive validation rejects "commit bad file then delete it" range push', async () => {
  const dst = path.join(root, 'clone-a1');
  const before = serverMain();
  writeMd(dst, 'notes/bad.md', 'no frontmatter at all\n');
  execFileSync('git', ['-C', dst, 'add', '.']);
  execFileSync('git', ['-C', dst, 'commit', '-m', 'add bad']);
  execFileSync('git', ['-C', dst, 'rm', '-q', 'notes/bad.md']);
  execFileSync('git', ['-C', dst, 'commit', '-m', 'remove bad']);
  await assert.rejects(
    execFileP('git', ['-C', dst, 'push', 'origin', 'main']),
    (e) => /bad\.md.*title|title.*bad\.md/i.test(String(e.stderr)),
  );
  assert.equal(serverMain(), before);
  execFileSync('git', ['-C', dst, 'reset', '--hard', 'origin/main']);
});

test('A6: one push carrying a good ref and a bad ref is rejected atomically — no ref updated', async () => {
  const dst = path.join(root, 'clone-a1');
  const mainBefore = serverMain();
  writeMd(dst, 'notes/good.md', '---\ntitle: Good\n---\nbody\n');
  execFileSync('git', ['-C', dst, 'add', '.']);
  execFileSync('git', ['-C', dst, 'commit', '-m', 'good on main']);
  execFileSync('git', ['-C', dst, 'branch', 'bad-branch']);
  execFileSync('git', ['-C', dst, 'checkout', '-q', 'bad-branch']);
  writeMd(dst, 'notes/evil.md', 'missing title here\n');
  execFileSync('git', ['-C', dst, 'add', '.']);
  execFileSync('git', ['-C', dst, 'commit', '-m', 'evil on bad-branch']);
  execFileSync('git', ['-C', dst, 'checkout', '-q', 'main']);
  await assert.rejects(
    execFileP('git', ['-C', dst, 'push', 'origin', 'main', 'bad-branch']),
    (e) => /evil\.md/i.test(String(e.stderr)),
  );
  assert.equal(serverMain(), mainBefore);
  const refs = execFileSync('git', ['--git-dir', gitdir, 'for-each-ref', '--format=%(refname)']).toString();
  assert.doesNotMatch(refs, /bad-branch/);
  execFileSync('git', ['-C', dst, 'branch', '-D', 'bad-branch']);
});

test('A7: unauthenticated ref discovery is rejected with 401', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/vaults/v001.git/info/refs?service=git-upload-pack`);
  assert.equal(res.status, 401);
});
