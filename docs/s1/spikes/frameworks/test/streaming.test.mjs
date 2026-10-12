// THROWAWAY spike test — can Fastify and Express host the Git smart-HTTP route
// (raw, chunked, bidirectional body streaming to a git http-backend CGI child)?
// The Git protocol requires: no body buffering, streaming request->CGI stdin and
// CGI stdout->response, arbitrary content types.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeFastifyGitApp } from '../fastify-git.mjs';
import { makeExpressGitApp } from '../express-git.mjs';

const execFileP = promisify(execFile);
process.env.GIT_TERMINAL_PROMPT = '0';

async function cloneThrough(appFactory, name) {
  const root = mkdtempSync(path.join(tmpdir(), `spike-fw-${name}-`));
  const projectRoot = path.join(root, 'vaults');
  execFileSync('git', ['init', '--bare', '-b', 'main', path.join(projectRoot, 'v001.git')]);
  {
    const seed = path.join(root, 'seed');
    execFileSync('git', ['init', '-b', 'main', seed]);
    execFileSync('git', ['-C', seed, 'config', 'user.email', 's@s']);
    execFileSync('git', ['-C', seed, 'config', 'user.name', 's']);
    const fs = await import('node:fs');
    fs.writeFileSync(path.join(seed, 'README.md'), '# nav\n');
    execFileSync('git', ['-C', seed, 'add', '.']);
    execFileSync('git', ['-C', seed, 'commit', '-m', 'seed']);
    execFileSync('git', ['-C', seed, 'push', path.join(projectRoot, 'v001.git'), 'main']);
  }
  const server = await appFactory({ projectRoot });
  if (!server.listening) await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const dst = path.join(root, 'clone');
  await execFileP('git', ['clone', `http://alice:x@127.0.0.1:${port}/vaults/v001.git`, dst]);
  assert.ok(existsSync(path.join(dst, 'README.md')));
  // push back through the framework too (receive direction, POST + pack body)
  execFileSync('git', ['-C', dst, 'config', 'user.email', 'a@a']);
  execFileSync('git', ['-C', dst, 'config', 'user.name', 'a']);
  const fs = await import('node:fs');
  fs.writeFileSync(path.join(dst, 'n.md'), '---\ntitle: N\n---\nx\n');
  execFileSync('git', ['-C', dst, 'add', '.']);
  execFileSync('git', ['-C', dst, 'commit', '-m', 'n']);
  await execFileP('git', ['-C', dst, 'push', 'origin', 'main']);
  server.close();
  rmSync(root, { recursive: true, force: true });
}

test('fastify v5 can host git smart-HTTP: clone + push stream through to http-backend CGI', async () => {
  await cloneThrough(makeFastifyGitApp, 'fastify');
});

test('express v5 can host git smart-HTTP: clone + push stream through to http-backend CGI', async () => {
  await cloneThrough(makeExpressGitApp, 'express');
});
