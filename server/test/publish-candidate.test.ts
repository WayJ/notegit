import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { CommitIdentity, WebSubmitChange } from '../src/publish/candidate.ts';
import { buildCandidateCommit } from '../src/publish/candidate.ts';

// S3-T7 候选提交构造（implementation-breakdown §2.2 S3-T7 行第 1 项；架构 §9
// 「Web 编辑使用候选 Git tree / commit」）：base commit + 变更清单 → 候选
// tree/commit（git plumbing：read-tree/update-index/write-tree/commit-tree，
// 全异步；请求级临时 index 隔离——不在服务端全局 checkout）。
//
// 断言纪律（D6）：期望 tree/blob OID 一律由 git 现算（hash-object/ls-tree）派生，
// 不硬编码 OID。

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
};

const run = promisify(execFile);

async function git(args: string[], opts: { cwd?: string } = {}): Promise<string> {
  const r = await run('git', args, { ...opts, env: GIT_ENV });
  return r.stdout;
}

async function writeMd(dir: string, file: string, body: string | Uint8Array): Promise<void> {
  const abs = path.join(dir, file);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, body);
}

interface TreeEntry {
  mode: string;
  type: string;
  oid: string;
  path: string;
}

/** `ls-tree -r -z` 解析（与 validation-input.ts 同构，测试内独立实现防同错） */
function parseLsTree(out: string): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const record of out.split('\0')) {
    if (record === '') continue;
    const tab = record.indexOf('\t');
    assert.notEqual(tab, -1, 'ls-tree 记录须含路径分隔');
    const [mode = '', type = '', oid = ''] = record.slice(0, tab).split(' ');
    entries.push({ mode, type, oid, path: record.slice(tab + 1) });
  }
  return entries;
}

async function lsTree(cwd: string, ref: string): Promise<TreeEntry[]> {
  return parseLsTree(await git(['ls-tree', '-r', '-z', ref], { cwd }));
}

/** 测试侧独立计算期望 blob OID（git 派生，不硬编码）；spawn 喂 stdin（execFile 异步态不吃 input 选项） */
function gitStdin(cwd: string, args: string[], input: string | Uint8Array): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env: GIT_ENV });
    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (err += c.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`git ${args.join(' ')}: ${err}`))));
    child.stdin.end(typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input));
  });
}

async function expectedBlob(cwd: string, content: string | Uint8Array): Promise<string> {
  return gitStdin(cwd, ['hash-object', '--stdin'], content);
}

const IDENTITY: CommitIdentity = { name: 'alice', email: 'alice@notegit.test' };
const WHEN = '2026-10-13T12:00:00.000Z';

interface Fixture {
  dataDir: string;
  repoPath: string;
  seedMain: string;
  close(): Promise<void>;
}

async function setup(): Promise<Fixture> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'notegit-t7-cand-'));
  const repoPath = path.join(dataDir, '1.git');
  await git(['init', '--bare', '-b', 'main', repoPath]);
  const work = path.join(dataDir, 'seed');
  await git(['init', '-b', 'main', work]);
  await writeMd(work, 'README.md', '# nav\n');
  await writeMd(work, 'notes/first.md', '---\ntitle: First\n---\nbody\n');
  await git(['-C', work, 'add', '.']);
  await git(['-C', work, '-c', 'user.email=seed@notegit.test', '-c', 'user.name=seed', 'commit', '-m', 'seed']);
  await git(['-C', work, 'push', repoPath, 'main']);
  const seedMain = (await git(['--git-dir', repoPath, 'rev-parse', 'main'])).trim();
  return { dataDir, repoPath, seedMain, close: () => rm(dataDir, { recursive: true, force: true }) };
}

test('候选提交：base + 变更清单 → tree/commit（parent 链、tree 内容、身份与消息全对）', async () => {
  const f = await setup();
  try {
    const docBody = '---\ntitle: Second\n---\nbody\n';
    const bin = new Uint8Array([0x00, 0x01, 0xff, 0x0a, 0x0d, 0x00]);
    const changes: WebSubmitChange[] = [
      { kind: 'upsert', path: 'docs/second.md', mode: '100644', content: docBody },
      { kind: 'upsert', path: 'assets/logo.bin', mode: '100644', content: bin },
      { kind: 'upsert', path: 'tools/run.sh', mode: '100755', content: '#!/bin/sh\necho hi\n' },
      { kind: 'delete', path: 'notes/first.md' },
    ];
    const c = await buildCandidateCommit({
      repoPath: f.repoPath,
      baseCommit: f.seedMain,
      changes,
      message: 'web: add second, remove first',
      identity: IDENTITY,
      committedAt: WHEN,
    });

    assert.match(c.commitOid, /^[0-9a-f]{40}$/, 'commit OID');
    assert.match(c.treeOid, /^[0-9a-f]{40}$/, 'tree OID');

    // 提交对象：parent 链、tree、身份（author/committer=服务端注入的认证身份）、时间戳、消息
    const epoch = Math.floor(Date.parse(WHEN) / 1000); // 派生：ISO → git 时间戳
    const commitText = await git(['cat-file', 'commit', c.commitOid], { cwd: f.repoPath });
    assert.match(commitText, new RegExp(`^tree ${c.treeOid}\\n`));
    assert.match(commitText, new RegExp(`\\nparent ${f.seedMain}\\n`));
    assert.match(commitText, new RegExp(`\\nauthor ${IDENTITY.name} <${IDENTITY.email}> ${epoch} \\+0000\\n`));
    assert.match(commitText, new RegExp(`\\ncommitter ${IDENTITY.name} <${IDENTITY.email}> ${epoch} \\+0000\\n`));
    assert.match(commitText, /\n\nweb: add second, remove first\n$/);

    // 候选 tree：= 基线 tree − 删除 + upsert（期望 blob OID 由 git 现算）
    const base = await lsTree(f.repoPath, f.seedMain);
    const second = await expectedBlob(f.repoPath, docBody);
    const logo = await expectedBlob(f.repoPath, bin);
    const runSh = await expectedBlob(f.repoPath, '#!/bin/sh\necho hi\n');
    const expected = [
      ...base.filter((e) => e.path !== 'notes/first.md'),
      { mode: '100644', type: 'blob', oid: second, path: 'docs/second.md' },
      { mode: '100644', type: 'blob', oid: logo, path: 'assets/logo.bin' },
      { mode: '100755', type: 'blob', oid: runSh, path: 'tools/run.sh' },
    ].sort((a, b) => (a.path < b.path ? -1 : 1));
    const got = (await lsTree(f.repoPath, c.commitOid)).sort((a, b) => (a.path < b.path ? -1 : 1));
    assert.deepEqual(got, expected, '候选 tree = 基线 − 删除 + upsert（mode 与 blob OID 全对）');

    // 二进制内容逐字节精确（经 git 取回比对）
    const binOid = (await git(['rev-parse', `${c.commitOid}:assets/logo.bin`], { cwd: f.repoPath })).trim();
    const binR = await run('git', ['cat-file', 'blob', binOid], { cwd: f.repoPath, env: GIT_ENV, maxBuffer: 1 << 20, encoding: 'buffer' });
    const binBlob = binR.stdout as unknown as Buffer; // encoding:'buffer' → stdout 即 Buffer
    assert.ok(binBlob.equals(Buffer.from(bin)), '二进制内容逐字节精确');

    // 校验器输入派生面：changedFiles=新增/修改（删除不进），deletedPaths、tree 路径基线
    assert.deepEqual(
      c.changedFiles.map((x) => [x.path, x.mode]).sort((a, b) => (a[0] < b[0] ? -1 : 1)),
      [
        ['assets/logo.bin', '100644'],
        ['docs/second.md', '100644'],
        ['tools/run.sh', '100755'],
      ],
    );
    const changedByPath = new Map(c.changedFiles.map((x) => [x.path, x]));
    assert.deepEqual(changedByPath.get('docs/second.md')!.content, docBody, '文本内容原样进校验器输入');
    assert.deepEqual(changedByPath.get('assets/logo.bin')!.content, bin, '二进制内容原样进校验器输入');
    assert.deepEqual(changedByPath.get('tools/run.sh')!.mode, '100755', 'mode 原样（执行位保留）');
    assert.deepEqual(c.deletedPaths, ['notes/first.md']);
    assert.deepEqual(c.baseTreePaths, base.map((e) => e.path));
    assert.deepEqual(c.candidateTreePaths, got.map((e) => e.path), '候选全 tree 路径（E-PATH-004 基线输入）');
  } finally {
    await f.close();
  }
});

test('候选提交：空库根提交（base=null）——无 parent、全 tree 即变更集', async () => {
  const f = await setup();
  try {
    const empty = path.join(f.dataDir, '2.git');
    await git(['init', '--bare', '-b', 'main', empty]);
    const c = await buildCandidateCommit({
      repoPath: empty,
      baseCommit: null,
      changes: [{ kind: 'upsert', path: 'README.md', mode: '100644', content: '# nav\n' }],
      message: 'root',
      identity: IDENTITY,
      committedAt: WHEN,
    });
    const commitText = await git(['cat-file', 'commit', c.commitOid], { cwd: empty });
    assert.doesNotMatch(commitText, /\nparent /, '根提交无 parent');
    assert.deepEqual(c.baseTreePaths, [], '空库无基线路径');
    assert.deepEqual(c.candidateTreePaths, ['README.md']);
    assert.deepEqual(c.deletedPaths, []);
  } finally {
    await f.close();
  }
});

test('候选提交：同输入同 committedAt → 同 OID（确定性）；不同时间 → 不同 OID', async () => {
  const f = await setup();
  try {
    const mk = (iso: string) =>
      buildCandidateCommit({
        repoPath: f.repoPath,
        baseCommit: f.seedMain,
        changes: [{ kind: 'upsert', path: 'docs/x.md', mode: '100644', content: '---\ntitle: X\n---\nb\n' }],
        message: 'm',
        identity: IDENTITY,
        committedAt: iso,
      });
    const a = await mk(WHEN);
    const b = await mk(WHEN);
    const other = await mk('2026-10-13T13:00:00.000Z');
    assert.equal(a.commitOid, b.commitOid, '同输入同时间——OID 确定（服务端时钟归因可复现）');
    assert.notEqual(a.commitOid, other.commitOid);
  } finally {
    await f.close();
  }
});

test('候选提交：变更清单畸形 fail-closed——删除不存在的路径 / 同路径重复命令 / base 不在库内', async () => {
  const f = await setup();
  try {
    await assert.rejects(
      buildCandidateCommit({
        repoPath: f.repoPath,
        baseCommit: f.seedMain,
        changes: [{ kind: 'delete', path: 'no/such.md' }],
        message: 'm',
        identity: IDENTITY,
        committedAt: WHEN,
      }),
      /不.*基线|不在|delete|no\/such/i,
      '删除基线不存在的路径须拒绝（变更清单与基线不一致）',
    );
    await assert.rejects(
      buildCandidateCommit({
        repoPath: f.repoPath,
        baseCommit: f.seedMain,
        changes: [
          { kind: 'upsert', path: 'docs/x.md', mode: '100644', content: 'a' },
          { kind: 'delete', path: 'docs/x.md' },
        ],
        message: 'm',
        identity: IDENTITY,
        committedAt: WHEN,
      }),
      /重复/,
      '同路径重复命令须拒绝',
    );
    await assert.rejects(
      buildCandidateCommit({
        repoPath: f.repoPath,
        baseCommit: 'f'.repeat(40),
        changes: [{ kind: 'upsert', path: 'docs/x.md', mode: '100644', content: 'a' }],
        message: 'm',
        identity: IDENTITY,
        committedAt: WHEN,
      }),
      /base|基线/i,
      'base commit 对象不在库内须拒绝（不信任客户端声明的基线）',
    );
  } finally {
    await f.close();
  }
});
