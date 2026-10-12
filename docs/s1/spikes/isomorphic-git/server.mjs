// THROWAWAY spike code — not product code. Evidence for docs/s1/selection.md (S1-T1 route A).
// Minimal smart-HTTP v0 Git server on isomorphic-git public APIs only:
//   GET  /vaults/<id>.git/info/refs?service=git-{upload,receive}-pack  -> ref advertisement
//   POST /vaults/<id>.git/git-upload-pack  -> want/have + packObjects
//   POST /vaults/<id>.git/git-receive-pack -> ref commands + indexPack + writeRef
// Deliberate gaps (documented in selection.md): protocol v2, side-band progress,
// thin packs, delta negotiation, shallow, packfile deltas beyond what
// isomorphic-git emits, concurrent-push ref locking beyond writeRef's own.
import http from 'node:http';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import git from 'isomorphic-git';

const USERS = { alice: 'secret-a', bob: 'secret-b' };
const ZERO = /^0+$/;
const enc = new TextEncoder();
const dec = new TextDecoder();

// ---- pkt-line codec (public API exports none) ----
export function pktLine(s) {
  const b = enc.encode(s);
  const len = (b.length + 4).toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(len, 'ascii'), b]);
}
export function pktFlush() { return Buffer.from('0000', 'ascii'); }
export function parsePktLines(buf) {
  const out = []; let i = 0;
  while (i + 4 <= buf.length) {
    const len = parseInt(dec.decode(buf.subarray(i, i + 4)), 16);
    if (!len) { i += 4; out.push({ flush: true }); continue; }
    out.push({ line: dec.decode(buf.subarray(i + 4, i + len)).replace(/\n$/, '') });
    i += len;
  }
  if (i < buf.length) out.push({ rest: buf.subarray(i) });
  return out;
}

// ---- policy + per-commit validation (same rules as route B spike) ----
function policyRef(user, newOid, ref) {
  if (ref === 'refs/heads/main') {
    if (ZERO.test(newOid)) return `deleting main is forbidden (架构 §4.3); user=${user}`;
    if (user === 'bob') return `policy: bob may not write main (per-ref authz); user=${user}`;
  }
  return null;
}
async function flattenTree(gitdir, treeOid, prefix = '') {
  const { tree } = await git.readTree({ fs: fsp, gitdir, oid: treeOid });
  const out = [];
  for (const e of tree) {
    if (e.type === 'tree') out.push(...(await flattenTree(gitdir, e.oid, `${prefix}${e.path}/`)));
    else out.push({ path: `${prefix}${e.path}`, oid: e.oid });
  }
  return out;
}

async function validateNewCommits(gitdir, newOid, oldOid) {
  // collect commits reachable from new, stopping at old (naive closure — no rev-list in public API)
  const seen = new Set(); const stack = [newOid]; const commits = [];
  while (stack.length) {
    const oid = stack.pop();
    if (!oid || oid === oldOid || seen.has(oid)) continue;
    seen.add(oid);
    let commit; try { ({ commit } = await git.readCommit({ fs: fsp, gitdir, oid })); } catch { continue; }
    commits.push({ oid, commit });
    stack.push(...commit.parent);
  }
  // per-commit manual tree diff (no diff-tree in public API)
  for (const { oid, commit } of commits) {
    let prev = new Map();
    if (commit.parent.length === 1) {
      try {
        const p = await git.readCommit({ fs: fsp, gitdir, oid: commit.parent[0] });
        prev = new Map((await flattenTree(gitdir, p.commit.tree)).map((e) => [e.path, e.oid]));
      } catch { /* root commit: empty prev */ }
    }
    // readTree is SINGLE-LEVEL: nested dirs need manual recursion (no recursive diff API)
    const cur = await flattenTree(gitdir, commit.tree);
    for (const e of cur) {
      if (!e.path.endsWith('.md') || e.path.toLowerCase() === 'readme.md') continue;
      if (prev.get(e.path) === e.oid) continue; // unchanged
      const { blob } = await git.readBlob({ fs: fsp, gitdir, oid: e.oid });
      const text = dec.decode(blob);
      const fm = text.match(/^---\s*\n([\s\S]*?)\n---/);
      if (!fm || !/^title:\s*\S/m.test(fm[1])) {
        return `${e.path} in commit ${oid.slice(0, 7)}: .md knowledge doc missing required frontmatter title`;
      }
    }
  }
  return null;
}

export function createServer({ projectRoot, authenticate = true }) {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => { if (process.env.SPIKE_DEBUG) console.error('SERVER-ERR', e); if (!res.headersSent) res.writeHead(500); res.end(String(e?.message ?? e)); });
  });

  async function handle(req, res) {
    const url = new URL(req.url, 'http://spike');
    if (process.env.SPIKE_DEBUG) console.error('REQ', req.method, url.pathname + url.search);
    let user = null;
    if (authenticate) {
      const auth = req.headers.authorization;
      if (!auth?.startsWith('Basic ')) return deny(res);
      const [u, p] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
      if (USERS[u] !== p) return deny(res);
      user = u;
    }
    const m = url.pathname.match(/^\/vaults\/([A-Za-z0-9][A-Za-z0-9-]*?)(?:\.git)?(\/.*)?$/);
    if (!m) { res.writeHead(404); return res.end('not found'); }
    const gitdir = path.join(projectRoot, `${m[1]}.git`);

    if (req.method === 'GET' && m[2] === '/info/refs') {
      const service = url.searchParams.get('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') { res.writeHead(400); return res.end('bad service'); }
      // listRefs returns relative names under a filepath — resolve each manually
      const names = await git.listRefs({ fs: fsp, gitdir, filepath: 'refs/heads' }).catch(() => []);
      const refs = [];
      for (const n of names) {
        const oid = await git.resolveRef({ fs: fsp, gitdir, ref: `refs/heads/${n}` }).catch(() => null);
        if (oid) refs.push({ ref: `refs/heads/${n}`, oid });
      }
      const caps = service === 'git-receive-pack' ? '\0report-status delete-refs quiet atomic ofs-delta' : '';
      const body = [pktLine(`# service=${service}\n`), pktFlush()];
      if (refs.length === 0) body.push(pktLine(`0000000000000000000000000000000000000000 capabilities^{}${caps}\n`));
      refs.forEach((r, i) => body.push(pktLine(`${r.oid} ${r.ref}${i === 0 ? caps : ''}\n`)));
      body.push(pktFlush());
      res.writeHead(200, { 'content-type': `application/x-${service}-advertisement` });
      for (const c of body) res.write(c);
      return res.end();
    }

    if (req.method === 'POST' && m[2] === '/git-upload-pack') {
      const lines = parsePktLines(Buffer.from(await readBody(req)));
      const wants = []; const haves = [];
      for (const l of lines) {
        if (l.line?.startsWith('want ')) wants.push(l.line.slice(5, 45));
        else if (l.line?.startsWith('have ')) haves.push(l.line.slice(5, 45));
      }
      const haveSet = new Set();
      for (const h of haves) await collectClosure(haveSet, gitdir, h);
      const oids = new Set();
      for (const w of wants) await collectClosure(oids, gitdir, w, haveSet);
      const { filename } = await git.packObjects({ fs: fsp, gitdir, oids: [...oids], write: true });
      const pack = await fsp.readFile(path.join(gitdir, 'objects', 'pack', filename));
      res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
      res.write(pktLine('NAK\n'));
      res.write(pack);
      return res.end();
    }

    if (req.method === 'POST' && m[2] === '/git-receive-pack') {
      const { commands, packBytes } = parsePushRequest(Buffer.from(await readBody(req)));
      const rejectAll = (msg, ref) => report(res, commands.map((c) => [c.ref, c.ref === ref ? msg : 'atomic: another ref in this push was rejected']));
      // 1) per-ref policy for ALL commands first (架构 §5.4 统一检查)
      for (const c of commands) {
        const err = policyRef(user, c.new, c.ref);
        if (err) return rejectAll(err, c.ref);
      }
      // 2) ingest packfile into a quarantine-named pack + indexPack
      if (packBytes?.length) {
        const tmp = `quarantine-${Date.now()}-${Math.random().toString(36).slice(2)}.pack`;
        await fsp.writeFile(path.join(gitdir, 'objects', 'pack', tmp), packBytes);
        // indexPack wants dir + path RELATIVE to dir (incl. objects/pack/ prefix)
        await git.indexPack({ fs: fsp, dir: gitdir, gitdir, filepath: `objects/pack/${tmp}` });
      }
      // 3) non-FF + per-commit validation for ALL commands (no ref updated yet)
      for (const c of commands) {
        if (ZERO.test(c.new)) continue;
        const current = await git.resolveRef({ fs: fsp, gitdir, ref: c.ref }).catch(() => null);
        if (!ZERO.test(c.old) && current !== c.old) return rejectAll('non-fast-forward (old oid mismatch)', c.ref);
        if (!ZERO.test(c.old)) {
          const desc = await git.isDescendent({ fs: fsp, gitdir, oid: c.new, ancestor: c.old }).catch(() => false);
          if (!desc) return rejectAll('non-fast-forward (not a descendant)', c.ref);
        }
        const err = await validateNewCommits(gitdir, c.new, ZERO.test(c.old) ? null : c.old);
        if (err) return rejectAll(err, c.ref);
      }
      // 4) all checks passed -> commit refs
      for (const c of commands) {
        if (ZERO.test(c.new)) await git.deleteRef({ fs: fsp, gitdir, ref: c.ref });
        else await git.writeRef({ fs: fsp, gitdir, ref: c.ref, value: c.new, force: true });
      }
      return report(res, commands.map((c) => [c.ref, null]));
    }

    res.writeHead(404); res.end('not found');
  }
  return server;
}

function report(res, results) {
  if (process.env.SPIKE_DEBUG) console.error('REPORT-LINES', JSON.stringify(results));
  res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result' });
  res.write(pktLine('unpack ok\n'));
  for (const [ref, err] of results) res.write(err ? pktLine(`ng ${ref} ${err}\n`) : pktLine(`ok ${ref}\n`));
  res.write(pktFlush());
  res.end();
}

function parsePushRequest(buf) {
  // commands are pkt-lines; after the flush-pkt following them, EVERYTHING is packfile.
  // (parsePktLines can't be reused here: raw 'PACK' header bytes are not pkt-lines.)
  const commands = []; let packBytes = null;
  let i = 0; let sawCommand = false;
  while (i + 4 <= buf.length) {
    const lenStr = buf.subarray(i, i + 4).toString('ascii');
    if (!/^[0-9a-f]{4}$/.test(lenStr)) { packBytes = buf.subarray(i); break; } // not pkt-line -> pack start
    const len = parseInt(lenStr, 16);
    if (len === 0) { // flush
      if (sawCommand) { packBytes = buf.subarray(i + 4); break; }
      i += 4; continue;
    }
    const line = buf.subarray(i + 4, i + len).toString('utf8').replace(/\n$/, '');
    const mRef = line.match(/^([0-9a-f]{40}) ([0-9a-f]{40}) (refs\/\S+)(?:\0.*)?$/);
    const mDel = line.match(/^:(refs\/\S+)$/); // modern git shorthand: delete without oids
    if (mRef) { commands.push({ old: mRef[1], new: mRef[2], ref: mRef[3] }); sawCommand = true; }
    else if (mDel) { commands.push({ old: '0'.repeat(40), new: '0'.repeat(40), ref: mDel[1] }); sawCommand = true; }
    i += len;
  }
  return { commands, packBytes: packBytes && packBytes.length ? Buffer.from(packBytes) : null };
}

async function collectClosure(set, gitdir, tip, stopAt) {
  const stack = [tip];
  while (stack.length) {
    const oid = stack.pop();
    if (!oid || set.has(oid) || stopAt?.has(oid)) continue;
    set.add(oid);
    let commit; try { ({ commit } = await git.readCommit({ fs: fsp, gitdir, oid })); } catch { continue; }
    stack.push(commit.tree, ...commit.parent);
    let tree; try { ({ tree } = await git.readTree({ fs: fsp, gitdir, oid: commit.tree })); } catch { continue; }
    const sub = [...tree];
    while (sub.length) {
      const e = sub.pop();
      set.add(e.oid);
      if (e.type === 'tree') {
        try { ({ tree } = await git.readTree({ fs: fsp, gitdir, oid: e.oid })); sub.push(...tree); } catch { /* partial */ }
      }
    }
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => resolve(Buffer.concat(chunks))); req.on('error', reject);
  });
}
function deny(res) {
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="notegit-spike"' });
  res.end('auth required');
}
export function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
