// THROWAWAY spike code — pre-receive hook for route B evidence (docs/s1/selection.md).
// Reads push ref commands from stdin, enforces:
//  - per-ref authorization (REMOTE_USER propagated by http-backend CGI env)
//  - per-commit receive-side validation of every NEW commit in the push range
//    (架构 §5.4: 逐提交检查，防止“先写坏再删除”绕过)
// Rejecting (exit 1) rejects the WHOLE push — all refs in one push are checked
// before any update happens (架构 §5.4 多 ref 原子性).
import { execFileSync } from 'node:child_process';

const ZERO = /^0+$/;
const user = process.env.REMOTE_USER ?? '(anonymous)';
const git = (args) => execFileSync('git', args, { cwd: process.env.GIT_DIR || '.' }).toString();

function fail(msg) { throw new Error(`[spike pre-receive] user=${user}: ${msg}`); }

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  try {
    for (const line of input.trim().split('\n').filter(Boolean)) {
      checkRef(...line.split(' '));
    }
    console.error(`[spike pre-receive] user=${user}: all refs accepted`);
  } catch (e) {
    console.error(String(e.message));
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
