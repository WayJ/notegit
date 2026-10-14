import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execGit } from '../src/publish/git-exec.ts';
import { readDirTree, readLastCommits } from '../src/web/browse/tree.ts';
import { relativeTimeText, absoluteTimeText } from '../src/web/browse/pages.ts';
import {
  browseHarness,
  seededVault,
  addEmployee,
  addMember,
  gitOut,
  repoPathOf,
  type BrowseHarness,
} from './web-browse-fixtures.ts';

// S11-T3 批量派生单元面：readLastCommits 以单次（常数次）git spawn 得到
// 「当前目录条目 → 最新触及提交」——逐条目 spawn 禁止（D4/N+1 风爆）。spawn
// 次数经注入缝计数证明；映射正确性与另行 spawn 的逐路径 `git log -n1` 对照
// （测试侧对照面，同 lsTreeSeq 语义）。relativeTimeText 分档为纯函数直调。

let seq = 0;

async function commitAs(h: BrowseHarness, vaultId: number, author: string, date: Date, files: Record<string, string>): Promise<void> {
  const repoPath = repoPathOf(h, vaultId);
  const work = path.join(h.dataDir, `gl-${vaultId}-${++seq}`);
  await gitOut(['clone', repoPath, work]);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(work, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
  }
  await gitOut(['-C', work, 'add', '.']);
  await gitOut([
    '-C', work,
    '-c', `user.name=${author}`,
    '-c', `user.email=${author}@notegit.test`,
    'commit', `--date=${date.toISOString()}`, '-m', `by ${author}`,
  ]);
  await gitOut(['-C', work, 'push', 'origin', 'HEAD:refs/heads/main']);
  await rm(work, { recursive: true, force: true });
}

async function gitlogHarness() {
  const h = await browseHarness();
  const alice = addEmployee(h.db, { username: 'alice' });
  const vaultId = await seededVault(h, 'alpha', alice);
  addMember(h.db, vaultId, alice, 'editor', alice);
  await commitAs(h, vaultId, 'alice', new Date(Date.now() - 7 * 86_400_000), {
    'README.md': '# nav\n',
    'docs/getting-started.md': 'v1\n',
    'docs/nested/deep.md': 'v1\n',
    'assets/logo.txt': 'logo\n',
  });
  await commitAs(h, vaultId, 'bob', new Date(Date.now() - 3_600_000), {
    'docs/getting-started.md': 'v2\n',
    'docs/added-later.md': 'new\n',
  });
  return { h, vaultId };
}

/** 对照面：另行 spawn 的逐路径 `git log -n1`（测试直通 git，不经生产读面） */
async function oracleLastCommit(repoPath: string, pathSpec: string): Promise<{ author: string; iso: string }> {
  const out = await gitOut(['--git-dir', repoPath, 'log', '-n', '1', '--format=%an%x1f%aI', '--', pathSpec]);
  const [author, iso] = out.trim().split('\x1f');
  return { author, iso };
}

test('readLastCommits：单次 git spawn 映射全目录条目（spawn 次数与条目数无关）', async () => {
  const { h, vaultId } = await gitlogHarness();
  try {
    const repo = repoPathOf(h, vaultId);
    const root = await readDirTree(h.dataDir, vaultId, 'main', '');
    const docs = await readDirTree(h.dataDir, vaultId, 'main', 'docs');
    if (root.kind !== 'ok' || docs.kind !== 'ok') throw new Error('seed 失败');

    let spawns = 0;
    const counting = (args: readonly string[], opts: Parameters<typeof execGit>[1]): Promise<string> => {
      spawns++;
      return execGit(args, opts);
    };
    const rootMap = await readLastCommits(h.dataDir, vaultId, 'main', '', root.entries, counting);
    assert.equal(spawns, 1, `3 条目应恰好 1 次 spawn（实测 ${spawns}）`);
    const docsMap = await readLastCommits(h.dataDir, vaultId, 'main', 'docs', docs.entries, counting);
    assert.equal(spawns, 2, `2 条目应再 1 次 spawn——每调用恒 1 次（实测累计 ${spawns}）`);
    assert.ok(rootMap.size >= 3 && docsMap.size >= 3, '映射覆盖全部条目');
  } finally {
    await h.close();
  }
});

test('readLastCommits：条目 → 最新触及提交与逐路径 git log 对照一致（blob/tree 前缀）', async () => {
  const { h, vaultId } = await gitlogHarness();
  try {
    const repo = repoPathOf(h, vaultId);
    const root = await readDirTree(h.dataDir, vaultId, 'main', '');
    const docs = await readDirTree(h.dataDir, vaultId, 'main', 'docs');
    if (root.kind !== 'ok' || docs.kind !== 'ok') throw new Error('seed 失败');
    const rootMap = await readLastCommits(h.dataDir, vaultId, 'main', '', root.entries);
    const docsMap = await readLastCommits(h.dataDir, vaultId, 'main', 'docs', docs.entries);

    // 根：blob 精确路径；tree 前缀（docs → docs/ 下任一路径最新触及）
    for (const e of root.entries) {
      const got = rootMap.get(e.name);
      assert.ok(got !== undefined, `根条目 ${e.name} 应有映射`);
      const spec = e.type === 'tree' ? `${e.name}/` : e.name;
      const want = await oracleLastCommit(repo, spec);
      assert.equal(got.author, want.author, `根条目 ${e.name} 作者`);
      assert.equal(got.isoTime, want.iso, `根条目 ${e.name} 时间`);
    }
    // 子目录：前缀剥离后仍正确（getting-started → bob；nested → alice）
    assert.equal(docsMap.get('getting-started.md')?.author, 'bob');
    assert.equal(docsMap.get('nested')?.author, 'alice');
    for (const e of docs.entries) {
      const spec = e.type === 'tree' ? `docs/${e.name}/` : `docs/${e.name}`;
      const want = await oracleLastCommit(repo, spec);
      assert.equal(docsMap.get(e.name)?.author, want.author, `docs 条目 ${e.name} 作者`);
    }
  } finally {
    await h.close();
  }
});

test('relativeTimeText：分档（刚刚/分钟/小时/天）与绝对时间回退（纯函数直调）', () => {
  const now = Date.parse('2026-10-14T12:00:00+08:00');
  assert.equal(relativeTimeText('2026-10-14T11:59:40+08:00', now), '刚刚');
  assert.equal(relativeTimeText('2026-10-14T11:55:00+08:00', now), '5 分钟前');
  assert.equal(relativeTimeText('2026-10-14T09:00:00+08:00', now), '3 小时前');
  assert.equal(relativeTimeText('2026-10-12T10:00:00+08:00', now), '2 天前');
  assert.equal(relativeTimeText('2026-09-01T00:00:00+08:00', now), '2026-09-01 00:00', '超 30 天回退绝对日期');
  assert.equal(relativeTimeText('2026-10-14T12:05:00+08:00', now), '2026-10-14 12:05', '未来时间戳（时钟偏移）回退绝对时间');
  assert.equal(absoluteTimeText('2026-10-14T11:36:31+08:00'), '2026-10-14 11:36', 'title 绝对时间形态');
});
