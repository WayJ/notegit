import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { initBareVaultRepo } from '../src/gitrepo/lifecycle.ts';
import { vaultRepoPath } from '../src/vaults/repo-path.ts';
import { deriveVaultIndex } from '../src/search/derive.ts';

// S5-T3 派生面单元：deriveVaultIndex 从已发布默认分支派生 title/tags/摘要
// （implementation-breakdown §2.4 S5-T3 行：frontmatter title/tags + 正文首段摘要；
// 消费 packages/validation 的解析面 extractFrontmatter + git 读取面）。
// 真实 bare 仓库 + 真实 git（与 publish/history 测试同构，无 mock）。

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

async function commitAll(dir: string, message: string): Promise<void> {
  await git(['-C', dir, 'add', '.']);
  await git(['-C', dir, '-c', 'user.email=seed@notegit.test', '-c', 'user.name=seed', 'commit', '-m', message]);
}

async function writeMd(dir: string, file: string, body: string): Promise<void> {
  const abs = path.join(dir, file);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, body);
}

const DOC_TAGS_BLOCK =
  '---\ntitle: 报销制度\nowner: finance\ntags:\n  - 财务\n  - 流程\n---\n\n第一段摘要行一。\n第一段摘要行二。\n\n第二段正文，不进摘要。\n';
const DOC_TAGS_FLOW =
  "---\ntitle: \"带引号: 标题\"\ntags: [onboarding, \"入职 流程\"]\n---\n\nflow 首段。\n\n后续。\n";
const DOC_NO_TAGS = '---\ntitle: 无标签文档\n---\n\n唯一一段。\n';
const README_BODY = '# 导航\n\nREADME 正文首段（frontmatter 豁免）。\n';

let dataDir: string;
let repo: string;

before(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'notegit-t3-derive-'));
  await initBareVaultRepo(dataDir, 1);
  repo = vaultRepoPath(dataDir, 1);
  const seed = path.join(dataDir, 'seed');
  await git(['init', '-b', 'main', seed]);
  await writeMd(seed, 'README.md', README_BODY);
  await writeMd(seed, 'finance/expense.md', DOC_TAGS_BLOCK);
  await writeMd(seed, 'onboarding.md', DOC_TAGS_FLOW);
  await writeMd(seed, 'plain.md', DOC_NO_TAGS);
  await writeMd(seed, 'assets/logo.png', '\u{FFFD}binary\u{FFFD}');
  await commitAll(seed, 'seed');
  await git(['-C', seed, 'push', repo, 'main']);
});

after(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

test('派生：默认分支 .md 全集（含 README 豁免），附件不进索引', async () => {
  const idx = await deriveVaultIndex(repo, 'main');
  assert.equal(idx.headCommit, (await git(['--git-dir', repo, 'rev-parse', 'main'])).trim(), 'head = 已发布默认分支');
  const paths = idx.docs.map((d) => d.path).sort();
  assert.deepEqual(paths, ['README.md', 'finance/expense.md', 'onboarding.md', 'plain.md']);
});

test('派生：frontmatter title/tags（块式与流式）+ 正文首段摘要', async () => {
  const idx = await deriveVaultIndex(repo, 'main');
  const byPath = new Map(idx.docs.map((d) => [d.path, d]));

  const block = byPath.get('finance/expense.md')!;
  assert.equal(block.title, '报销制度');
  assert.deepEqual(block.tags, ['财务', '流程']);
  assert.equal(block.summary, '第一段摘要行一。 第一段摘要行二。', '首段 = 空行分隔的第一段（含段内换行合并）');

  const flow = byPath.get('onboarding.md')!;
  assert.equal(flow.title, '带引号: 标题', '引号包裹的 title 去引号');
  assert.deepEqual(flow.tags, ['onboarding', '入职 流程'], '流式 tags 含引号项去引号');

  const plain = byPath.get('plain.md')!;
  assert.equal(plain.title, '无标签文档');
  assert.deepEqual(plain.tags, [], '无 tags 字段 = 空数组');
  assert.equal(plain.summary, '唯一一段。');
});

test('派生：README（frontmatter 豁免）title 为 NULL、tags 空、摘要取正文首段', async () => {
  const idx = await deriveVaultIndex(repo, 'main');
  const readme = idx.docs.find((d) => d.path === 'README.md')!;
  assert.equal(readme.title, null, '无 frontmatter → 无 title（如实记录，不用文件名伪造）');
  assert.deepEqual(readme.tags, []);
  assert.equal(readme.summary, '# 导航', '正文首段（标题行也是正文的一部分）');
});

test('派生：分支前进后 head 跟随、删除路径消失（派生自当前已发布内容）', async () => {
  const seed = path.join(dataDir, 'seed');
  await writeMd(seed, 'plain.md', '---\ntitle: 改写后\n---\n\n新首段。\n');
  await rm(path.join(seed, 'onboarding.md'));
  await commitAll(seed, 'rewrite');
  await git(['-C', seed, 'push', repo, 'main']);

  const idx = await deriveVaultIndex(repo, 'main');
  assert.equal(idx.headCommit, (await git(['--git-dir', repo, 'rev-parse', 'main'])).trim());
  assert.ok(!idx.docs.some((d) => d.path === 'onboarding.md'), '已删除路径不再出现在派生集');
  assert.equal(idx.docs.find((d) => d.path === 'plain.md')!.summary, '新首段。');
});

test('派生：非默认分支的提交不影响派生（只看已发布默认分支）', async () => {
  const seed = path.join(dataDir, 'seed');
  await git(['-C', seed, 'checkout', '-b', 'topic']);
  await writeMd(seed, 'topic-only.md', '---\ntitle: 仅_topic\n---\n\ntopic 首段。\n');
  await commitAll(seed, 'topic');
  await git(['-C', seed, 'push', repo, 'topic']);
  await git(['-C', seed, 'checkout', 'main']);

  const idx = await deriveVaultIndex(repo, 'main');
  assert.ok(!idx.docs.some((d) => d.path === 'topic-only.md'), 'topic 分支内容不进默认分支派生集');
});

test('派生：分支不存在（尚无提交的空库）→ headCommit NULL、docs 空', async () => {
  await initBareVaultRepo(dataDir, 2);
  const empty = vaultRepoPath(dataDir, 2);
  const idx = await deriveVaultIndex(empty, 'main');
  assert.equal(idx.headCommit, null);
  assert.deepEqual(idx.docs, []);
});
