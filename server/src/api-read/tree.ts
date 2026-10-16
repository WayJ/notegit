import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { authorize, rejectAuth, type AuthSuccess, type RequestAuthenticator, type VaultScope } from '../auth/lifecycle.ts';
import { createDbMembershipSource } from '../vaults/membership.ts';
import { VaultService } from '../vaults/service.ts';
import type { GitExecOptions } from '../publish/git-exec.ts';
import { readTreeCached } from '../readcache/tree-cache.ts';
import { vaultRepoPath } from '../vaults/repo-path.ts';

/**
 * S18-T2 目录树读取端点（agent 读协议 v1 机器面——E6 R01/D36/D38，S18 D1/D2/D4）：
 *
 * GET /api/v1/vaults/{slug}/tree[?ref=<commit OID>] → 200
 * `{vault, ref, commit_oid, entries:[{path, type(tree|blob), size}], truncated}`。
 *
 * - 扁平路径数组（`ls-tree -r -t` 全树递归——agent 自行构树，不预设层级形态）；
 *   上限 1000 条 + `truncated:true` 如实标注（D4/Q-E6-1 v1 形态，与 search 100
 *   截断同哲学）；子模块（commit 条目）不属 v1 契约，如实不出现（与页面族同判）。
 * - ref 语义（D38）：缺省 = 默认分支 HEAD；ref 只收 commit OID（hex 缩写/全
 *   SHA——与 version 页同判），分支名等 rev 形态 400 如实拒；hex 形态但未知/
 *   非提交 → 404 反存在性。`ref` 回显请求值（缺省回显默认分支名），
 *   `commit_oid` 恒为解析后的全 SHA。
 * - 协商缓存（D2，S16 热修同构）：ETag=`"<commit OID>"` + `Cache-Control:
 *   no-cache`，If-None-Match 命中 304——内容即 commit 锚定，HEAD 前进即时生效。
 * - 认证/授权：统一缝 authenticateRequest（匿名 401）+ authorize read 门槛
 *   （token scope 交集收窄）；无权/不存在/空库/未知路径一律 404 E-RES-001 同
 *   信封（D-IC-06 API 面）；GET 免 CSRF；只读无审计行；写通道零变更。
 * - ls-tree 执行沿 browse/tree.ts 的注入缝形态（runGit 参数可注入，可测）；
 *   缺省经单源跨请求树缓存（S24-T1，readcache/tree-cache.ts——失效钩子+TTL
 *   兜底+fail-closed，读端点响应零变化）；注入 runGit 时直通不缓存（测试缝）。
 *
 * D1 文件所有权：本文件归 S18-T2；api-read/vaults.ts 归 T1（路由注册组装点
 * app.ts 各持一行，互不改他人行）。
 */

/** D4 上限：单响应条目数（超出 truncated:true 如实标注，不承诺分页） */
export const TREE_ENTRY_LIMIT = 1000;

export type TreeReadRouteOptions = {
  readonly db: DatabaseSync;
  readonly authenticateRequest: RequestAuthenticator;
  /** 数据目录（生产装配恒传入；缺省 = 无仓库存储的测试形态 → 503 如实标注） */
  readonly dataDir?: string;
};

export type RunGit = (args: readonly string[], options: GitExecOptions) => Promise<string>;

/** `ls-tree -l -z` 行形态（与 browse/tree.ts 同式——条目形态两处同构） */
const LS_TREE_LINE = /^(\d{6}) (tree|blob|commit) ([0-9a-f]{40,64})(?:\s+(\d+|-))?\t([\s\S]*)$/;

/** 提交 OID 寻址形状（hex 缩写/全 SHA——与 history/version.ts 同判，只收 OID） */
const OID_SHAPE = /^[0-9a-f]{4,64}$/;

/** git 已运行但退出非零（语义失败：ref/路径不存在）；spawn 层失败（仓库目录缺失等）为 false */
function isGitExitFailure(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('git ');
}

export type FlatTreeRead =
  | { kind: 'ok'; entries: FlatTreeEntry[]; truncated: boolean }
  | { kind: 'not-found' }
  | { kind: 'unavailable' };

export interface FlatTreeEntry {
  readonly path: string;
  readonly type: 'tree' | 'blob';
  /** blob 字节数（ls-tree -l）；tree 无 → null（字段在场，值如实） */
  readonly size: number | null;
}

/**
 * 全树扁平读取（`ls-tree -r -t -l -z <rev>`）：单次 spawn（注入缝可测——
 * 恒一次调用，N+1 禁止同 browse/tree.ts readLastCommits）；-z 名字不转义、
 * 递归路径直出。子模块（commit 条目）跳过——不虚构 v1 契约外类型。
 * 截断在解析后按输出序取前 TREE_ENTRY_LIMIT 条（树序=深度优先字节序）。
 */
export async function readFlatTree(repoPath: string, rev: string, runGit: RunGit = readTreeCached): Promise<FlatTreeRead> {
  let out: string;
  try {
    out = await runGit(['ls-tree', '-r', '-t', '-l', '-z', '--full-tree', rev], { cwd: repoPath });
  } catch (err) {
    if (!isGitExitFailure(err)) return { kind: 'unavailable' };
    return { kind: 'not-found' };
  }
  const entries: FlatTreeEntry[] = [];
  let total = 0;
  for (const rec of out.split('\0')) {
    if (rec === '') continue;
    const m = LS_TREE_LINE.exec(rec);
    if (m === null) continue; // 未知形态跳过（不虚构条目）
    if (m[2] === 'commit') continue; // 子模块不属 v1 契约（tree|blob）
    total += 1;
    if (entries.length >= TREE_ENTRY_LIMIT) continue; // 继续计数以便如实标注截断
    entries.push({
      path: m[5],
      type: m[2] as FlatTreeEntry['type'],
      size: m[4] !== undefined && m[4] !== '-' ? Number(m[4]) : null,
    });
  }
  return { kind: 'ok', entries, truncated: total > TREE_ENTRY_LIMIT };
}

/** 解析 ref 参数 → commit 全 SHA；不合法形态返回 null（由调用方区分 400/404 呈现） */
export type RefResolve =
  | { kind: 'ok'; commitOid: string }
  /** 非 OID 形态（分支名等 rev 形态——D38 v1 不支持，400 如实） */
  | { kind: 'bad-shape' }
  /** hex 形态但未知/非提交（404 反存在性），或 unborn 默认分支（404） */
  | { kind: 'not-found' }
  | { kind: 'unavailable' };

export async function resolveRefCommit(
  repoPath: string,
  defaultBranch: string,
  ref: string | undefined,
): Promise<RefResolve> {
  const spec = ref === undefined || ref === '' ? `refs/heads/${defaultBranch}` : `${ref}^{commit}`;
  if (ref !== undefined && ref !== '' && !OID_SHAPE.test(ref)) return { kind: 'bad-shape' };
  try {
    return { kind: 'ok', commitOid: (await readTreeCached(['rev-parse', '--verify', spec], { cwd: repoPath })).trim() };
  } catch (err) {
    if (!isGitExitFailure(err)) return { kind: 'unavailable' };
    return { kind: 'not-found' };
  }
}

function sendError(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  return reply.code(status).send({ error: { code, message } });
}

function sendNotFound(reply: FastifyReply): FastifyReply {
  return sendError(reply, 404, 'E-RES-001', '资源不存在或无权访问');
}

export function registerTreeReadRoutes(app: FastifyInstance, opts: TreeReadRouteOptions): void {
  const vaults = new VaultService({ db: opts.db }); // 只读消费（getVaultRow）
  const membershipSource = createDbMembershipSource(opts.db); // 三入口同源成员判定

  /** 认证 + read 门槛（token scope 交集收窄）；无权=不存在 404 同信封（D-IC-06）。
   *  read 动作不产 forbidden——reader 即满足门槛，全部拒绝形态统一 404。 */
  async function requireReadVault(
    req: FastifyRequest,
    reply: FastifyReply,
    slug: string,
  ): Promise<{ who: AuthSuccess; vault: { id: number; slug: string; defaultBranch: string } } | null> {
    const outcome = await opts.authenticateRequest(req);
    if (!outcome.ok) return rejectAuth(reply, outcome), null;
    const who: AuthSuccess = outcome;
    const scope: VaultScope | undefined =
      who.carrier === 'token' && who.token !== undefined
        ? { access: who.token.scopeAccess, vaultIds: who.token.scopeVaultIds }
        : undefined;
    const decision = authorize(membershipSource, who.subject.employee_id, slug, 'read', scope);
    if (!decision.allowed) return sendNotFound(reply), null;
    const row = vaults.getVaultRow(slug);
    if (!row) return sendNotFound(reply), null; // fail-closed
    return { who, vault: { id: row.id, slug: row.slug, defaultBranch: row.default_branch } };
  }

  app.get('/api/v1/vaults/:slug/tree', async (req: FastifyRequest, reply: FastifyReply) => {
    const { slug } = req.params as { slug: string };
    const guard = await requireReadVault(req, reply, slug);
    if (!guard) return reply;
    const { vault } = guard;
    if (opts.dataDir === undefined) {
      return reply.code(503).send({ error: { message: '内容暂不可用（仓库存储未挂接——仅测试形态会出现）' } });
    }
    const rawRef = (req.query as { ref?: unknown }).ref;
    if (rawRef !== undefined && typeof rawRef !== 'string') {
      return sendError(reply, 400, 'E-RES-004', '请求形态错误：ref 必须为 commit OID 字符串');
    }
    const ref = typeof rawRef === 'string' && rawRef !== '' ? rawRef : undefined;
    const repoPath = vaultRepoPath(opts.dataDir, vault.id);
    const resolved = await resolveRefCommit(repoPath, vault.defaultBranch, ref);
    if (resolved.kind === 'bad-shape') {
      return sendError(reply, 400, 'E-RES-004', '请求形态错误：ref 只支持 commit OID（分支名等 rev 形态 v1 不支持——D38）');
    }
    if (resolved.kind === 'not-found') return sendNotFound(reply);
    if (resolved.kind === 'unavailable') {
      return reply.code(503).send({ error: { message: '内容暂不可用（仓库目录缺失或读取失败）' } });
    }
    const read = await readFlatTree(repoPath, resolved.commitOid);
    if (read.kind !== 'ok') {
      return reply.code(503).send({ error: { message: '内容暂不可用（仓库目录缺失或读取失败）' } });
    }
    const etag = `"${resolved.commitOid}"`;
    reply.header('cache-control', 'no-cache').header('etag', etag);
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    return reply.send({
      vault: vault.slug,
      ref: ref ?? vault.defaultBranch,
      commit_oid: resolved.commitOid,
      entries: read.entries,
      truncated: read.truncated,
    });
  });
}
