import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { startApp } from '../src/main.ts';
import { initBareVaultRepo } from '../src/gitrepo/lifecycle.ts';
import { vaultRepoPath } from '../src/vaults/repo-path.ts';
import { sweepVaultResidue } from '../src/gitrepo/hygiene.ts';

// S3-T8 T7 honest-gap 收口 2/2：残留清理（运维级最小实现）。
// 三个残留源（T6/T7 notes）：① notegit-push-*.bytes 计数文件（进程硬崩残留）；
// ② objects/incoming-* 隔离目录（receive-pack 拒绝/中断后不自动清的惰性垃圾）；
// ③ 拒绝发布的无引用松对象（web 候选提交 -w 落库后被拒——git prune 域）。
// 锚点裁决：启动时（listen 之前）——单进程假设（架构 §9）下启动无在途写，
// 三类残留皆可安全清；被引用对象/refs/配置不动（git prune 只删不可达松对象，
// 不重排 pack——避免每次启动 repack 大库）。

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
};

const run = promisify(execFile);

async function git(args: string[], opts: { cwd?: string } = {}): Promise<string> {
  return (await run('git', args, { ...opts, env: GIT_ENV })).stdout;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

const stubHash = async (p: string) => `stub-hash$${p}`;

async function makeVault(dataDir: string, vaultId: number): Promise<string> {
  await initBareVaultRepo(dataDir, vaultId);
  const repoPath = vaultRepoPath(dataDir, vaultId);
  const seed = path.join(dataDir, `seed-${vaultId}`);
  await git(['init', '-b', 'main', seed]);
  await mkdir(path.join(seed, 'notes'), { recursive: true });
  await writeFile(path.join(seed, 'notes', 'first.md'), '---\ntitle: First\n---\nbody\n');
  await git(['-C', seed, 'add', '.']);
  await git(['-C', seed, '-c', 'user.email=seed@notegit.test', '-c', 'user.name=seed', 'commit', '-m', 'seed']);
  await git(['-C', seed, 'push', repoPath, 'main']);
  return repoPath;
}

test('残留清扫：notegit-push-*.bytes 与 objects/incoming-* 删除；其余文件不动', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'notegit-t8-hyg-'));
  try {
    const repo = await makeVault(dataDir, 101);
    await writeFile(path.join(repo, 'notegit-push-push-abc.bytes'), '123');
    await writeFile(path.join(repo, 'notegit-push-push-def.bytes'), '456');
    await mkdir(path.join(repo, 'objects', 'incoming-xyz'), { recursive: true });
    await writeFile(path.join(repo, 'objects', 'incoming-xyz', 'loose'), 'x');
    await writeFile(path.join(repo, 'notegit-validation.json'), '{}'); // T4 报告文件——不在清扫面

    const result = await sweepVaultResidue(dataDir);
    assert.equal(result.bytesFiles, 2, '两个计数文件');
    assert.equal(result.quarantineDirs, 1, '一个隔离目录');
    assert.equal(await exists(path.join(repo, 'notegit-push-push-abc.bytes')), false);
    assert.equal(await exists(path.join(repo, 'notegit-push-push-def.bytes')), false);
    assert.equal(await exists(path.join(repo, 'objects', 'incoming-xyz')), false);
    assert.equal(await exists(path.join(repo, 'notegit-validation.json')), true, '非残留文件不动');
    assert.equal(await exists(path.join(repo, 'HEAD')), true);
    assert.equal(await exists(path.join(repo, 'refs', 'heads')), true, 'refs 不动');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('松对象清理：无引用松对象被 prune；可达对象与 refs 完好（可再 push/clone）', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'notegit-t8-hyg2-'));
  try {
    const repo = await makeVault(dataDir, 202);
    // 模拟拒绝发布的 web 候选残留：hash-object -w 落库但无引用
    const orphan = await new Promise<string>((resolve, reject) => {
      const child = execFile('git', ['hash-object', '-w', '--stdin'], { cwd: repo, env: GIT_ENV }, (err, stdout) =>
        err ? reject(err) : resolve(String(stdout).trim()),
      );
      child.stdin?.end('orphan blob from rejected submit');
    });
    // 可达对象基线
    const mainOid = (await git(['--git-dir', repo, 'rev-parse', 'main'])).trim();

    const result = await sweepVaultResidue(dataDir);
    assert.equal(result.prunedRepos, 1, '有松对象的库执行了 prune');

    const catOrphan = await run('git', ['--git-dir', repo, 'cat-file', '-e', orphan], { env: GIT_ENV }).then(
      () => 'exists',
      () => 'gone',
    );
    assert.equal(catOrphan, 'gone', '无引用松对象已清');
    const catMain = await run('git', ['--git-dir', repo, 'cat-file', '-e', mainOid], { env: GIT_ENV }).then(
      () => 'exists',
      () => 'gone',
    );
    assert.equal(catMain, 'exists', '可达对象完好');

    // 库仍可用：新提交可推送（refs/对象库未损坏）
    const seed = path.join(dataDir, 'seed-202');
    await git(['-C', seed, 'pull', repo, 'main']);
    await mkdir(path.join(seed, 'notes'), { recursive: true });
    await writeFile(path.join(seed, 'notes', 'second.md'), '---\ntitle: Second\n---\n');
    await git(['-C', seed, 'add', '.']);
    await git(['-C', seed, '-c', 'user.email=s@notegit.test', '-c', 'user.name=s', 'commit', '-m', 'second']);
    await git(['-C', seed, 'push', repo, 'main']);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('启动接线：startApp 启动即清扫（listen 前完成）', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'notegit-t8-hyg3-'));
  try {
    const repo = await makeVault(dataDir, 303);
    await writeFile(path.join(repo, 'notegit-push-push-hardcrash.bytes'), '999');
    await mkdir(path.join(repo, 'objects', 'incoming-crash'), { recursive: true });
    await writeFile(path.join(repo, 'objects', 'incoming-crash', 'obj'), 'x');

    const inst = await startApp({ dataDir, host: '127.0.0.1', port: 0, hashPassword: stubHash });
    try {
      assert.equal(await exists(path.join(repo, 'notegit-push-push-hardcrash.bytes')), false, '计数文件启动即清');
      assert.equal(await exists(path.join(repo, 'objects', 'incoming-crash')), false, '隔离目录启动即清');
    } finally {
      await inst.close();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
