import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { collectRefDeltas, knownPathsOfTip, hookGitTraversal, type GitTraversal } from '../src/githttp/validation-input.ts';
import type { CommitDelta } from 'notegit-validation';

// S3-T4 校验器输入组装单元测试：git 遍历（rev-list/diff-tree/ls-tree，-z 解析）
// → packages/validation 的 CommitDelta 组装。语义基线（validation.md §1 防绕过表
// + S3-T3 §9.3 移交第 1 项）：新提交 vs 父提交的新增/修改文件、合并提交按父
// 展开（交集——两父皆无的内容才是本提交新引入）、根提交全检、E-PATH-004 全
// tree 基线（treePaths）。真实 tmp git 仓库为被测对象——不 mock git 行为。
//
// 模拟保真：pre-receive 先于 ref 更新执行（新提交不在任何 ref 上）。old=零的
// 用例须保证目标提交不被任何 ref/HEAD 可达（--not --all 锚定服务端推送前状态）。

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
};

async function git(args: string[], opts: { cwd?: string } = {}): Promise<{ stdout: string; stderr: string }> {
  return promisify(execFile)('git', args, { ...opts, env: GIT_ENV });
}

const repos: string[] = [];

/** 每用例独立仓库（无跨用例状态串扰） */
async function newRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), 'notegit-t4-asm-'));
  repos.push(repo);
  await git(['-C', repo, 'init', '-q', '-b', 'main', '.']);
  await git(['-C', repo, 'config', 'user.email', 'u@notegit.test']);
  await git(['-C', repo, 'config', 'user.name', 'u']);
  return repo;
}

async function writeMd(repo: string, file: string, body: string | Uint8Array): Promise<void> {
  const abs = path.join(repo, file);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, body);
}

async function commitAll(repo: string, message: string): Promise<string> {
  await git(['-C', repo, 'add', '.']);
  await git(['-C', repo, 'commit', '-m', message]);
  return (await git(['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
}

function pipeBlob(repo: string, args: string[], content: string | Uint8Array): Promise<string> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = execFile('git', args, { cwd: repo, env: GIT_ENV }, (err, stdout) =>
      err ? reject(err) : resolve(String(stdout).trim()),
    );
    child.stdin?.end(content instanceof Uint8Array ? Buffer.from(content) : content);
  });
}

async function addCacheInfo(repo: string, mode: string, file: string, content: string | Uint8Array): Promise<void> {
  const oid = await pipeBlob(repo, ['hash-object', '-w', '--stdin'], content);
  await git(['-C', repo, 'update-index', '--add', '--cacheinfo', `${mode},${oid},${file}`]);
}

const ZERO = '0'.repeat(40);
const changesOf = (d: CommitDelta) => d.changes.map((c) => c.path).sort();

after(async () => {
  await Promise.all(repos.map((r) => rm(r, { recursive: true, force: true })));
});

test('根提交全检：无父提交 → 全部文件进 changes（parent=null），treePaths=全 tree', async () => {
  const repo = await newRepo();
  await writeMd(repo, 'README.md', '# nav\n');
  await writeMd(repo, 'notes/first.md', '---\ntitle: First\n---\nbody\n');
  const root = await commitAll(repo, 'root');
  // 模拟首推：提交不得被任何 ref/HEAD 锚定（切到未born分支后删 main）
  await git(['-C', repo, 'checkout', '-q', '--orphan', 'carrier']);
  await git(['-C', repo, 'rm', '-rqf', '--cached', '.']);
  await git(['-C', repo, 'branch', '-D', 'main']);
  const t = hookGitTraversal(repo);
  const deltas = await collectRefDeltas(t, 'refs/heads/main', ZERO, root);
  assert.equal(deltas.length, 1);
  const d = deltas[0]!;
  assert.equal(d.commit, root);
  assert.equal(d.parent, null);
  assert.deepEqual(changesOf(d), ['README.md', 'notes/first.md']);
  assert.deepEqual([...(d.treePaths ?? [])].sort(), ['README.md', 'notes/first.md']);
});

test('普通提交：changes=vs 父提交的 A/M（删除不进）；mode 取自 ls-tree；内容字节等于 blob；提交链成对', async () => {
  const repo = await newRepo();
  const png = randomBytes(48);
  await writeMd(repo, 'README.md', '# nav\n');
  await writeMd(repo, 'notes/first.md', '---\ntitle: First\n---\nbody\n');
  const root = await commitAll(repo, 'root');
  await writeMd(repo, 'notes/second.md', '---\ntitle: Second\n---\nbody\n');
  await writeMd(repo, 'assets/pic.png', png);
  await writeMd(repo, 'notes/first.md', '---\ntitle: First v2\n---\nbody\n'); // 修改
  const second = await commitAll(repo, 'second');
  await git(['-C', repo, 'rm', '-q', 'notes/second.md']);
  const third = await commitAll(repo, 'third');
  const t = hookGitTraversal(repo);
  const deltas = await collectRefDeltas(t, 'refs/heads/main', root, third);
  assert.equal(deltas.length, 2, '推送范围 = second + third（root 为锚定旧值）');
  const byCommit = new Map(deltas.map((d) => [d.commit, d]));
  const secondDelta = byCommit.get(second)!;
  assert.deepEqual(changesOf(secondDelta), ['assets/pic.png', 'notes/first.md', 'notes/second.md']);
  const pic = secondDelta.changes.find((c) => c.path === 'assets/pic.png')!;
  assert.equal(pic.mode, '100644');
  assert.ok(Buffer.from(pic.content as Uint8Array).equals(Buffer.from(png)), '二进制内容字节精确');
  const thirdDelta = byCommit.get(third)!;
  assert.deepEqual(changesOf(thirdDelta), [], '删除条目不进 changes（validation.md §2.5）');
  assert.equal(thirdDelta.parent, second, '父提交链成对');
});

test('合并提交按父展开（交集）：两父皆无的文件进 changes；等于某一父版本的不进', async () => {
  const repo = await newRepo();
  await writeMd(repo, 'README.md', '# nav\n');
  await commitAll(repo, 'base');
  await git(['-C', repo, 'checkout', '-q', '-b', 'feat']);
  await writeMd(repo, 'notes/feat.md', '---\ntitle: Feat\n---\nbody\n');
  const featHead = await commitAll(repo, 'feat work');
  await git(['-C', repo, 'checkout', '-q', 'main']);
  await writeMd(repo, 'notes/main2.md', '---\ntitle: Main2\n---\nbody\n');
  const mainHead = await commitAll(repo, 'main2 work');
  // evil merge：合并后塞入两父皆不存在的文件
  await git(['-C', repo, 'merge', '--no-ff', '--no-commit', 'feat']);
  await writeMd(repo, 'notes/smuggled.md', 'smuggled\n');
  await git(['-C', repo, 'add', '.']);
  await git(['-C', repo, 'commit', '-m', 'evil merge']);
  const merge = (await git(['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();

  const t = hookGitTraversal(repo);
  const deltas = await collectRefDeltas(t, 'refs/heads/main', mainHead, merge);
  const byCommit = new Map(deltas.map((d) => [d.commit, d]));
  const mergeDelta = byCommit.get(merge)!;
  assert.ok(mergeDelta !== undefined, '合并提交在推送范围内');
  assert.deepEqual(changesOf(mergeDelta), ['notes/smuggled.md'], '仅两父皆无的内容是本合并新引入（交集语义）');
  // feat 侧提交随合并进入推送范围，其自身变更独立成 delta
  const featDelta = byCommit.get(featHead)!;
  assert.deepEqual(changesOf(featDelta), ['notes/feat.md']);
  // treePaths 是合并结果全 tree（E-PATH-004 基线输入）
  const tree = mergeDelta.treePaths ?? [];
  for (const expected of ['README.md', 'notes/main2.md', 'notes/feat.md', 'notes/smuggled.md']) {
    assert.ok(tree.includes(expected), `treePaths 应含 ${expected}`);
  }
});

test('良性合并：常规合并（无手工塞入）不产生合并级 changes——两侧内容各自归因', async () => {
  const repo = await newRepo();
  await writeMd(repo, 'README.md', '# nav\n');
  await commitAll(repo, 'base');
  await git(['-C', repo, 'checkout', '-q', '-b', 'feat']);
  await writeMd(repo, 'notes/feat.md', '---\ntitle: Feat\n---\nbody\n');
  await commitAll(repo, 'feat work');
  await git(['-C', repo, 'checkout', '-q', 'main']);
  await writeMd(repo, 'notes/main2.md', '---\ntitle: Main2\n---\nbody\n');
  const mainHead = await commitAll(repo, 'main2 work');
  await git(['-C', repo, 'merge', '--no-ff', '-m', 'benign merge', 'feat']);
  const merge = (await git(['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
  const t = hookGitTraversal(repo);
  // feat 分支未推送：推送范围含 feat 侧提交；合并本身无新内容
  const deltas = await collectRefDeltas(t, 'refs/heads/main', mainHead, merge);
  const mergeDelta = deltas.find((d) => d.commit === merge)!;
  assert.deepEqual(changesOf(mergeDelta), [], '等于某一父版本的文件不进合并 changes（不重判存量）');
});

test('新 ref（old=零）锚定服务端已有历史：--not --all 排除既有提交', async () => {
  const repo = await newRepo();
  await writeMd(repo, 'README.md', '# nav\n');
  const head = await commitAll(repo, 'only');
  const t = hookGitTraversal(repo);
  // 模拟「推送新分支，但其提交已全部在服务端其他 ref 上」：HEAD 可达 → 无新提交
  const deltas = await collectRefDeltas(t, 'refs/heads/newbranch', ZERO, head);
  assert.equal(deltas.length, 0, '已有历史不重复校验');
});

test('路径含空格经 -z 原样解析（无 C 引号包裹）', async () => {
  const repo = await newRepo();
  await writeMd(repo, 'README.md', '# nav\n');
  const root = await commitAll(repo, 'root');
  await writeMd(repo, 'notes/with space.md', '---\ntitle: Spaced\n---\nbody\n');
  const spaced = await commitAll(repo, 'spaced path');
  const t = hookGitTraversal(repo);
  const deltas = await collectRefDeltas(t, 'refs/heads/main', root, spaced);
  const d = deltas.find((x) => x.commit === spaced)!;
  assert.ok(d.changes.some((c) => c.path === 'notes/with space.md'), `应含原始路径（实际：${changesOf(d).join()}）`);
});

test('危险 mode 透传：symlink(120000) 与 gitlink(160000) 进 changes；gitlink 不读 blob 不抛错', async () => {
  const repo = await newRepo();
  await writeMd(repo, 'README.md', '# nav\n');
  const root = await commitAll(repo, 'root');
  await addCacheInfo(repo, '120000', 'notes/link', '/etc/passwd');
  await addCacheInfo(repo, '160000', 'notes/sub', '0'.repeat(40));
  await git(['-C', repo, 'commit', '-m', 'tree entries']);
  const head = (await git(['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
  const t = hookGitTraversal(repo);
  const deltas = await collectRefDeltas(t, 'refs/heads/main', root, head);
  const d = deltas.find((x) => x.commit === head)!;
  const link = d.changes.find((c) => c.path === 'notes/link')!;
  assert.equal(link.mode, '120000', 'symlink mode 原样进 FileInput（E-PATH-002 判定依据）');
  const sub = d.changes.find((c) => c.path === 'notes/sub')!;
  assert.equal(sub.mode, '160000', 'gitlink mode 原样进 FileInput（E-PATH-003 判定依据）');
  // gitlink 指向的 commit 对象不存在——不得因读 blob 抛错
  assert.ok(sub.content !== undefined);
});

test('knownPathsOfTip：给定提交的全 tree 路径（链接存在性判定的库内基线）', async () => {
  const repo = await newRepo();
  await writeMd(repo, 'README.md', '# nav\n');
  await writeMd(repo, 'notes/first.md', '---\ntitle: First\n---\nbody\n');
  const head = await commitAll(repo, 'root');
  const t: GitTraversal = hookGitTraversal(repo);
  const paths = await knownPathsOfTip(t, head);
  assert.ok(paths.includes('README.md'));
  assert.ok(paths.includes('notes/first.md'));
});
