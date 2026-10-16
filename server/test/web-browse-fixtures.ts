import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db/connection.ts';
import { migrate } from '../src/db/migrate.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { buildApp } from '../src/app.ts';
import { createSession, DEFAULT_SESSION_TIMEOUTS } from '../src/auth/sessions.ts';
import { initBareVaultRepo } from '../src/gitrepo/lifecycle.ts';
import { vaultRepoPath } from '../src/vaults/repo-path.ts';
import { invalidateVaultTreeCache } from '../src/readcache/tree-cache.ts';
import { FIXTURE_DDL, addEmployee, addVault, addMember } from './credentials-fixtures.ts';

/**
 * S4-T1 测试夹具：S2-T8 页面形态（buildApp + 会话 Cookie）× S3 真实仓库形态
 * （dataDir 布局 + bare 仓库 + git CLI 种子提交）。目录浏览断言以另行 spawn 的
 * `git ls-tree` 输出为对照（完成标准「目录渲染与 git ls-tree 一致」），故夹具
 * 暴露仓库路径与直通 git 助手，不经任何生产代码读面。
 */

export interface BrowseHarness {
  app: ReturnType<typeof buildApp>;
  db: DatabaseSync;
  dataDir: string;
  /** 员工会话 Cookie 头（真实 sessions 表行——认证走统一缝 authenticateRequest） */
  session(employeeId: number): Record<string, string>;
  close(): Promise<void>;
}

/** 直通 git：stdout（测试对照与种子专用——不经生产读面） */
export function gitOut(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { env: process.env });
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => (err += c));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(Buffer.concat(out).toString('utf8')) : reject(new Error(`git ${args[0]}: ${err}`)),
    );
  });
}

let seedSeq = 0;

/** 向 bare 仓库推一笔种子提交（临时工作目录 git init→commit→push，同 publish-pipeline 形态） */
export async function seedVaultRepo(dataDir: string, vaultId: number, files: Record<string, string>): Promise<void> {
  const repoPath = vaultRepoPath(dataDir, vaultId);
  const work = path.join(dataDir, `seed-${vaultId}-${++seedSeq}`);
  await gitOut(['init', '-b', 'main', work]);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(work, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
  }
  await gitOut(['-C', work, 'add', '.']);
  await gitOut(['-C', work, '-c', 'user.email=seed@notegit.test', '-c', 'user.name=seed', 'commit', '-m', 'seed']);
  await gitOut(['-C', work, 'push', repoPath, 'HEAD:refs/heads/main']);
  await rm(work, { recursive: true, force: true });
}

export async function browseHarness(): Promise<BrowseHarness> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'notegit-s4t1-'));
  const dbFile = path.join(dataDir, 'db', 'notegit.sqlite');
  await mkdir(path.dirname(dbFile), { recursive: true });
  const db = openDatabase(dbFile);
  migrate(db, MIGRATIONS);
  for (const ddl of FIXTURE_DDL) db.exec(ddl); // 合并后 no-op
  const pepper = { active: { version: 1, key: randomBytes(32) }, retired: [] as never[] };
  const app = buildApp({ db, pepper, bootstrapTokenFile: path.join(dataDir, 'config', 'bootstrap.token'), dataDir });
  await app.ready();
  const now = new Date();
  return {
    app,
    db,
    dataDir,
    session(employeeId) {
      const sid = createSession(db, employeeId, pepper.active.key, now, DEFAULT_SESSION_TIMEOUTS).sid;
      return { cookie: `ngt_sid=${sid}` };
    },
    close: async () => {
      await app.close();
      db.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

/** 建员工 + 建库行 + bare 仓库 init（可选种子文件）——返回仓库路径 */
export async function seededVault(
  h: BrowseHarness,
  slug: string,
  createdBy: number,
  files?: Record<string, string>,
): Promise<number> {
  const vaultId = addVault(h.db, slug, createdBy);
  await initBareVaultRepo(h.dataDir, vaultId);
  if (files) await seedVaultRepo(h.dataDir, vaultId, files);
  return vaultId;
}

export { addEmployee, addVault, addMember };

/** 仓库路径（测试对照 spawn ls-tree 用） */
export function repoPathOf(h: BrowseHarness, vaultId: number): string {
  return vaultRepoPath(h.dataDir, vaultId);
}

/** 在既有提交之上追加一笔（clone→写→commit→push，快进）——实时读测试用。
 *  S24-T1：直连 push 不经 HTTP/hook settle（无审计行）——push 后显式失效树缓存，
 *  与生产 push 的失效语义对齐（尾随失效见 s24-tree-cache.test.ts 行为锁定）。 */
export async function pushToVault(h: BrowseHarness, vaultId: number, files: Record<string, string>): Promise<void> {
  const repoPath = vaultRepoPath(h.dataDir, vaultId);
  const work = path.join(h.dataDir, `push-${vaultId}-${++seedSeq}`);
  await gitOut(['clone', repoPath, work]);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(work, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
  }
  await gitOut(['-C', work, 'add', '.']);
  await gitOut(['-C', work, '-c', 'user.email=seed@notegit.test', '-c', 'user.name=seed', 'commit', '-m', 'more']);
  await gitOut(['-C', work, 'push', 'origin', 'HEAD:refs/heads/main']);
  await rm(work, { recursive: true, force: true });
  invalidateVaultTreeCache(repoPath);
}

/** spawn `git ls-tree`（-z 原始名）→ [type, name] 序列——页面渲染一致性对照 */
export async function lsTreeSeq(repoPath: string, branch: string, dirPath: string): Promise<string[]> {
  const target = dirPath === '' ? `refs/heads/${branch}` : `refs/heads/${branch}:${dirPath}`;
  const out = await gitOut(['--git-dir', repoPath, 'ls-tree', '-l', '-z', target]);
  return out
    .split('\0')
    .filter((rec) => rec !== '')
    .map((rec) => {
      const meta = rec.slice(0, rec.indexOf('\t'));
      const [, type] = meta.split(' ');
      const name = rec.slice(rec.indexOf('\t') + 1);
      return `${type} ${name}`;
    });
}

/** 从页面 HTML 提取目录条目序列（data 属性）——与 lsTreeSeq 同构 */
export function pageEntrySeq(body: string): string[] {
  const seq: string[] = [];
  const re = /<li data-type="(tree|blob|commit)" data-name="([^"]*)"(?: data-size="([^"]*)")?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) seq.push(`${m[1]} ${m[2]}`);
  return seq;
}
