// THROWAWAY spike test — evidence for docs/s1/selection.md (S1-T1, route B).
// Route B: Node child_process wrapping `git http-backend` (CGI protocol).
// NOTE: git commands that talk to OUR in-process HTTP server MUST be async
// (execFile): execFileSync would block the event loop and self-deadlock.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, listen } from '../server.mjs';

const execFileP = promisify(execFile);
process.env.GIT_TERMINAL_PROMPT = '0'; // fail fast instead of hanging on any credential prompt

const root = mkdtempSync(path.join(tmpdir(), 'spike-b-'));
const projectRoot = path.join(root, 'vaults');
execFileSync('git', ['init', '--bare', '-b', 'main', path.join(projectRoot, 'v001.git')]);
// 架构 §4.3: 禁止强制推送 —— 原生 receive-pack 配置即拦截（B3 的被测实现）
execFileSync('git', ['--git-dir', path.join(projectRoot, 'v001.git'), 'config', 'receive.denyNonFastForwards', 'true']);
// seed one commit on main directly via file transport
{
  const seed = path.join(root, 'seed');
  execFileSync('git', ['init', '-b', 'main', seed]);
  execFileSync('git', ['-C', seed, 'config', 'user.email', 'seed@spike']);
  execFileSync('git', ['-C', seed, 'config', 'user.name', 'seed']);
  writeMd(seed, 'README.md', '# nav\n');
  execFileSync('git', ['-C', seed, 'add', '.']);
  execFileSync('git', ['-C', seed, 'commit', '-m', 'seed']);
  execFileSync('git', ['-C', seed, 'push', path.join(projectRoot, 'v001.git'), 'main']);
}

// install pre-receive hook shim -> node validator (B4/B5/B6 的被测实现)
{
  const hookPath = path.join(projectRoot, 'v001.git', 'hooks', 'pre-receive');
  const hookScript = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hook-pre-receive.mjs');
  writeFileSync(hookPath, `#!/bin/sh\nexec node "${hookScript}"\n`);
  execFileSync('chmod', ['+x', hookPath]);
}

function writeMd(dir, file, body) {
  const abs = path.join(dir, file);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, body);
}

let server, port;
before(async () => {
  server = createServer({ projectRoot });
  port = await listen(server);
});
after(async () => { server.close(); rmSync(root, { recursive: true, force: true }); });

const urlFor = (repo, creds) => `http://${creds ? `${creds}@` : ''}127.0.0.1:${port}/vaults/${repo}`;
const ALICE = 'alice:secret-a';
const BOB = 'bob:secret-b';

test('B1: native git client can clone over HTTP from CGI-wrapped http-backend', async () => {
  await execFileP('git', ['clone', urlFor('v001.git', ALICE), path.join(root, 'clone-b1')]);
  assert.ok(existsSync(path.join(root, 'clone-b1', 'README.md')));
});

test('B2: authenticated fast-forward push is accepted', async () => {
  const dst = path.join(root, 'clone-b1');
  execFileSync('git', ['-C', dst, 'config', 'user.email', 'a@spike']);
  execFileSync('git', ['-C', dst, 'config', 'user.name', 'alice']);
  writeMd(dst, 'notes/a.md', '---\ntitle: A\n---\nbody\n');
  execFileSync('git', ['-C', dst, 'add', '.']);
  execFileSync('git', ['-C', dst, 'commit', '-m', 'add a']);
  await execFileP('git', ['-C', dst, 'push', 'origin', 'main']);
  const head = execFileSync('git', ['-C', dst, 'rev-parse', 'HEAD']).toString().trim();
  const remote = execFileSync('git', ['--git-dir', path.join(projectRoot, 'v001.git'), 'rev-parse', 'main']).toString().trim();
  assert.equal(head, remote);
});

test('B7: unauthenticated ref discovery is rejected with 401 (架构 §3.2 引用发现必须鉴权)', async () => {
  // pins behavior of the auth layer implemented for B1 — regression guard for the
  // "no unauthenticated object/ref reads" requirement
  const res = await fetch(`http://127.0.0.1:${port}/vaults/v001.git/info/refs?service=git-upload-pack`);
  assert.equal(res.status, 401);
  const res2 = await fetch(`http://127.0.0.1:${port}/vaults/v001.git/info/refs?service=git-upload-pack`,
    { headers: { authorization: 'Basic ' + Buffer.from('alice:wrong').toString('base64') } });
  assert.equal(res2.status, 401);
});

test('B3: force-push (non-fast-forward) is rejected; server ref unchanged', async () => {
  const dst = path.join(root, 'clone-b1');
  const before = execFileSync('git', ['--git-dir', path.join(projectRoot, 'v001.git'), 'rev-parse', 'main']).toString().trim();
  execFileSync('git', ['-C', dst, 'reset', '--hard', 'HEAD~1']);
  writeMd(dst, 'notes/b.md', '---\ntitle: B\n---\nbody\n');
  execFileSync('git', ['-C', dst, 'add', '.']);
  execFileSync('git', ['-C', dst, 'commit', '-m', 'diverged']);
  await assert.rejects(
    execFileP('git', ['-C', dst, 'push', '--force', 'origin', 'main']),
    (e) => /non-fast-forward|fetch first|rejected/i.test(String(e.stderr)),
  );
  const after = execFileSync('git', ['--git-dir', path.join(projectRoot, 'v001.git'), 'rev-parse', 'main']).toString().trim();
  assert.equal(after, before, 'server ref must be unchanged after rejected force push');
});

test('B4: per-ref authorization — bob cannot write main, can write feature/*; main delete forbidden', async () => {
  const dst = path.join(root, 'clone-bob');
  await execFileP('git', ['clone', urlFor('v001.git', BOB), dst]);
  execFileSync('git', ['-C', dst, 'config', 'user.email', 'b@spike']);
  execFileSync('git', ['-C', dst, 'config', 'user.name', 'bob']);
  writeMd(dst, 'notes/by-bob.md', '---\ntitle: ByBob\n---\nbody\n');
  execFileSync('git', ['-C', dst, 'add', '.']);
  execFileSync('git', ['-C', dst, 'commit', '-m', 'bob change']);
  // bob -> main: must be rejected by per-ref policy
  await assert.rejects(
    execFileP('git', ['-C', dst, 'push', 'origin', 'main']),
    (e) => /policy.*bob.*main|bob may not write main/i.test(String(e.stderr)),
  );
  // bob -> feature/*: must be accepted
  await execFileP('git', ['-C', dst, 'push', 'origin', 'HEAD:refs/heads/feature/x']);
  const refs = execFileSync('git', ['--git-dir', path.join(projectRoot, 'v001.git'), 'for-each-ref', '--format=%(refname)']).toString();
  assert.match(refs, /refs\/heads\/feature\/x/);
  // deleting main is forbidden even for alice (架构 §4.3)
  const alice = path.join(root, 'clone-b1');
  await assert.rejects(
    execFileP('git', ['-C', alice, 'push', 'origin', ':main']),
    (e) => /delete.*main|deleting main/i.test(String(e.stderr)),
  );
  // deleting a non-default branch is allowed for editors (架构 §4.3)
  await execFileP('git', ['-C', alice, 'push', 'origin', ':refs/heads/feature/x']);
  const refs2 = execFileSync('git', ['--git-dir', path.join(projectRoot, 'v001.git'), 'for-each-ref', '--format=%(refname)']).toString();
  assert.doesNotMatch(refs2, /refs\/heads\/feature\/x/);
});

test('B5: receive-side per-commit validation rejects "commit bad file then delete it" range push', async () => {
  const dst = path.join(root, 'clone-b1');
  // resync to server state (B3 left local main diverged on purpose)
  await execFileP('git', ['-C', dst, 'fetch', '-q', 'origin']);
  execFileSync('git', ['-C', dst, 'reset', '--hard', 'origin/main']);
  const before = execFileSync('git', ['--git-dir', path.join(projectRoot, 'v001.git'), 'rev-parse', 'main']).toString().trim();
  writeMd(dst, 'notes/bad.md', 'no frontmatter at all\n');
  execFileSync('git', ['-C', dst, 'add', '.']);
  execFileSync('git', ['-C', dst, 'commit', '-m', 'add bad']);
  execFileSync('git', ['-C', dst, 'rm', '-q', 'notes/bad.md']);
  execFileSync('git', ['-C', dst, 'commit', '-m', 'remove bad']);
  await assert.rejects(
    execFileP('git', ['-C', dst, 'push', 'origin', 'main']),
    (e) => /bad\.md.*title|title.*bad\.md/i.test(String(e.stderr)),
  );
  const after = execFileSync('git', ['--git-dir', path.join(projectRoot, 'v001.git'), 'rev-parse', 'main']).toString().trim();
  assert.equal(after, before);
  // clean up local divergence so later tests start from server state
  execFileSync('git', ['-C', dst, 'reset', '--hard', 'origin/main']);
});

test('B6: one push carrying a good ref and a bad ref is rejected atomically — no ref updated', async () => {
  const dst = path.join(root, 'clone-b1');
  const mainBefore = execFileSync('git', ['--git-dir', path.join(projectRoot, 'v001.git'), 'rev-parse', 'main']).toString().trim();
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
  const mainAfter = execFileSync('git', ['--git-dir', path.join(projectRoot, 'v001.git'), 'rev-parse', 'main']).toString().trim();
  assert.equal(mainAfter, mainBefore, 'good ref must NOT be updated when the same push carries a violating ref');
  const refs = execFileSync('git', ['--git-dir', path.join(projectRoot, 'v001.git'), 'for-each-ref', '--format=%(refname)']).toString();
  assert.doesNotMatch(refs, /bad-branch/);
  execFileSync('git', ['-C', dst, 'branch', '-D', 'bad-branch']);
});
