import path from 'node:path';
import { mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import { browseHarness, gitOut, repoPathOf, type BrowseHarness } from './web-browse-fixtures.ts';

/**
 * S5-T1 测试夹具：在 web-browse-fixtures（会话/仓库/种子）之上追加「多笔顺序
 * 提交」种子与一致性对照助手。对照原则同 S4-T1 lsTreeSeq：另行直通 spawn
 * `git log` / `git diff` 取期望输出，绝不经生产读面。
 */

/** 一笔种子变更：写/改若干文件（undefined 值 = 删除该路径） */
export interface HistoryStep {
  readonly message: string;
  readonly author?: { name: string; email: string };
  readonly files: Record<string, string | undefined>;
}

/**
 * 一次 clone 后按序落多笔提交、末尾一次 push（快进整串）——多提交历史与
 * 分页窗口测试的数据源。每步 add -A 后以独立 message/author 提交（作者可
 * 填写任意值——正是 DOD-03「不信任 commit 作者」的样本面）。
 */
let histSeq = 0;

export async function pushHistorySeries(
  h: BrowseHarness,
  vaultId: number,
  steps: readonly HistoryStep[],
): Promise<void> {
  const repoPath = repoPathOf(h, vaultId);
  const work = path.join(h.dataDir, `hist-${vaultId}-${++histSeq}`);
  await gitOut(['clone', repoPath, work]);
  for (const step of steps) {
    for (const [rel, content] of Object.entries(step.files)) {
      const full = path.join(work, rel);
      if (content === undefined) {
        await unlink(full).catch(() => {});
      } else {
        await mkdir(path.dirname(full), { recursive: true });
        await writeFile(full, content, 'utf8');
      }
    }
    const name = step.author?.name ?? 'hist';
    const email = step.author?.email ?? 'hist@notegit.test';
    await gitOut(['-C', work, 'add', '-A']);
    await gitOut(['-C', work, '-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-m', step.message]);
  }
  await gitOut(['-C', work, 'push', 'origin', 'HEAD:refs/heads/main']);
  await rm(work, { recursive: true, force: true });
}

/** 直通 `git log`：`[shortOid, authorName, authorDate, subject]` 序列（默认分支、
 *  可选路径过滤、skip/n 窗口）——历史页一致性对照（与页面同一命令形态） */
export async function gitLogSeq(
  repoPath: string,
  opts: { path?: string; skip?: number; limit?: number } = {},
): Promise<string[][]> {
  const args = [
    '--git-dir', repoPath, 'log', '--format=%h%x1f%an%x1f%aI%x1f%s',
    ...(opts.skip !== undefined ? ['--skip', String(opts.skip)] : []),
    ...(opts.limit !== undefined ? ['-n', String(opts.limit)] : []),
    'refs/heads/main',
    ...(opts.path === undefined ? [] : ['--', opts.path]),
  ];
  const out = await gitOut(args);
  return out
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l !== '')
    .map((l) => {
      const f = l.split('\x1f');
      const subject = f.slice(3).join('\x1f'); // 主题内嵌分隔符时并回（字段序保障）
      return [f[0], f[1], f[2], subject];
    });
}

/** 直通 `git diff --no-color`：整段原文（一致性对照按行切分） */
export async function gitDiffOut(repoPath: string, base: string, target: string, filePath: string): Promise<string> {
  return gitOut(['--git-dir', repoPath, 'diff', '--no-color', base, target, '--', filePath]);
}

/** 空树 OID（根提交 diff 基线——对 /dev/null 空输入做 `hash-object -t tree`，
 *  不硬编码哈希算法；gitOut 不关 stdin，故不能用 --stdin 形态） */
export async function emptyTreeOid(repoPath: string): Promise<string> {
  const out = await gitOut(['--git-dir', repoPath, 'hash-object', '-t', 'tree', '/dev/null']);
  return out.trim();
}

/** 解析提交全 OID（对照用） */
export async function revCommitOid(repoPath: string, rev: string): Promise<string> {
  const out = await gitOut(['--git-dir', repoPath, 'rev-parse', '--verify', `${rev}^{commit}`]);
  return out.trim();
}

// ── 页面侧提取（与 S4-T1 pageEntrySeq 同法：data 属性） ─────────────────────

/** 从历史页 HTML 提取提交行序列：`[shortOid, authorName, authorDate, subject]` */
export function pageCommitSeq(body: string): string[][] {
  const seq: string[][] = [];
  const re = /<li class="commit" data-short="([^"]*)" data-author="([^"]*)" data-date="([^"]*)"[^>]*data-subject="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) seq.push([m[1], m[2], m[3], m[4]]);
  return seq;
}

/** escapeHtml（web/pages.ts 五实体）的精确逆映射——页面提取文本还原对照 git 原文 */
export function unescapeHtml(s: string): string {
  return s
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&');
}

/** 从 diff 页 HTML 提取行序列：`[kind, 原文行]`（还原转义——与 git diff 原文对照） */
export function pageDiffLines(body: string): string[][] {
  const lines: string[][] = [];
  const re = /<span class="diff-line" data-kind="(add|del|ctx|meta)">([^<]*)<\/span>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) lines.push([m[1], unescapeHtml(m[2])]);
  return lines;
}

export { browseHarness };
