// THROWAWAY spike code — pre-receive hook for route B evidence (docs/s1/selection.md).
// Rules source & version: docs/contracts/rules-version.json (rulesVersion 1.0.0-draft.2,
// S1-T2 validation contract — same machine source api.md cites; sprint scenario S3).
// Reads push ref commands from stdin, enforces:
//  - per-ref authorization (REMOTE_USER propagated by http-backend CGI env)
//  - per-commit receive-side validation of every NEW commit in the push range
//    (架构 §5.4: 逐提交检查，防止“先写坏再删除”绕过)
// Rejecting (exit 1) rejects the WHOLE push — all refs in one push are checked
// before any update happens (架构 §5.4 多 ref 原子性).
// The title check below is a minimal hard-coded subset of the contract's rules;
// manifest-driven validation is S3-T3 work. The hook only asserts the manifest's
// rulesVersion matches its builtin constant (drift alarm) and surfaces it in the
// pre-receive report line (G1/G2 fix, 2026-10-12).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ZERO = /^0+$/;
const user = process.env.REMOTE_USER ?? '(anonymous)';
const git = (args) => execFileSync('git', args, { cwd: process.env.GIT_DIR || '.' }).toString();

// G1/G2: single rules-version source (docs/contracts/rules-version.json), resolved
// relative to this file (<repo-root>/docs/s1/spikes/git-http-backend/ → root is 4 up).
const RULES_VERSION_CONSTANT = '1.0.0-draft.2';
const MANIFEST_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..',
  'docs', 'contracts', 'rules-version.json'
);
function readManifestVersion() { // string | null (null = manifest unreadable at this location)
  try { return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')).rulesVersion ?? null; }
  catch { return null; }
}

function fail(msg) { throw new Error(`[spike pre-receive] user=${user}: ${msg}`); }

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  let rulesVersion = RULES_VERSION_CONSTANT;
  let rulesSource = 'builtin constant (manifest not found)';
  try {
    const manifestVersion = readManifestVersion();
    if (manifestVersion !== null) {
      rulesVersion = manifestVersion;
      rulesSource = 'docs/contracts/rules-version.json';
      if (manifestVersion !== RULES_VERSION_CONSTANT) {
        fail(`rules version drift: manifest ${manifestVersion} != builtin ${RULES_VERSION_CONSTANT} — sync docs/contracts/rules-version.json (G1/G2 consistency assertion)`);
      }
    }
    for (const line of input.trim().split('\n').filter(Boolean)) {
      checkRef(...line.split(' '));
    }
    console.error(`[spike pre-receive] user=${user}: all refs accepted`);
    console.error(`[spike pre-receive] report: ${JSON.stringify({ scope: 'pre-receive', result: 'pass', rulesVersion, rulesSource })}`);
  } catch (e) {
    console.error(String(e.message));
    console.error(`[spike pre-receive] report: ${JSON.stringify({ scope: 'pre-receive', result: 'fail', rulesVersion, rulesSource })}`);
    process.exit(1);
  }
});

function checkRef(oldOid, newOid, ref) {
  // --- per-ref authorization ---
  if (ref === 'refs/heads/main') {
    if (ZERO.test(newOid)) fail('deleting main is forbidden (架构 §4.3)');
    if (user === 'bob') fail('policy: bob may not write main (per-ref authz)');
  }
  if (ZERO.test(newOid)) return; // delete of non-default branch: allowed for editors

  // --- per-commit validation of every commit new to the server ---
  const revArgs = ZERO.test(oldOid)
    ? ['rev-list', newOid, '--not', '--all']
    : ['rev-list', `${newOid}`, `^${oldOid}`];
  const commits = git(revArgs).trim().split('\n').filter(Boolean);
  for (const c of commits) {
    // --root covers the initial commit; linear-history check (merge nuance → selection.md notes)
    const entries = git(['diff-tree', '--no-commit-id', '--name-status', '-r', '--root', c]).trim().split('\n').filter(Boolean);
    for (const entry of entries) {
      const [status, p] = entry.split('\t');
      if (!/\.md$/.test(p)) continue;
      if (p.toLowerCase() === 'readme.md') continue; // 导航文档豁免 frontmatter（架构 §5.2）
      if (status === 'D') continue; // deletions: no metadata validation (架构 §5.2)
      if (status !== 'A' && status !== 'M') continue;
      const content = git(['show', `${c}:${p}`]);
      const fm = content.match(/^---\s*\n([\s\S]*?)\n---/);
      if (!fm || !/^title:\s*\S/m.test(fm[1])) {
        fail(`${p} in commit ${c.slice(0, 7)}: .md knowledge doc missing required frontmatter title`);
      }
    }
  }
}
