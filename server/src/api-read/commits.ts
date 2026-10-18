import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { authorize, rejectAuth, type AuthSuccess, type RequestAuthenticator, type VaultScope } from '../auth/lifecycle.ts';
import { execGit } from '../publish/git-exec.ts';
import { createDbMembershipSource } from '../vaults/membership.ts';
import { treePathOk } from '../web/browse/tree.ts';
import { VaultService } from '../vaults/service.ts';
import { vaultRepoPath } from '../vaults/repo-path.ts';
import { resolveRefCommit } from './tree.ts';

/**
 * S37 提交历史端点（agent 读协议机器面——平台「版本历史/新建文档基线」数据源）：
 *
 * GET /api/v1/vaults/{slug}/commits[?limit=&path=&ref=<commit OID>] → 200
 * `{vault, ref, commit_oid, commits:[{oid, short_oid, message, author_name,
 * author_email, authored_at}], has_more}`。
 *
 * - 此前历史只有 Web 页面族（web/history），无 API——平台侧 /commits 调用 404
 *   即由此来。git log 语义与 web/history/log.ts 同构（路径级附 --follow，
 *   多取 1 条探测 has_more），但不复用其固定分页常量——limit 由调用方给
 *   （1..100，缺省 50）。
 * - ref 语义与 tree/docs 端点同判（D38，resolveRefCommit 单一实现）：缺省=
 *   默认分支 HEAD；只收 commit OID；hex 未知 404 反存在性、分支名等 rev 400。
 * - 路径形态非法与不存在同响应（404 E-RES-001，不泄露树内容——D-IC-06）。
 * - 认证/授权与 tree/docs 同构（匿名 401；read 门槛+token scope 收窄；无权=
 *   不存在 404 同信封；GET 免 CSRF；只读无审计行；写通道零变更）。
 * - author_* 是 Git 元数据（推送方可填——DOD-03，非审计主体），如实透出。
 * - 空库（unborn 默认分支）返回空列表 has_more=false，与 web 历史页空态同判。
 */

export type CommitsReadRouteOptions = {
  readonly db: DatabaseSync;
  readonly authenticateRequest: RequestAuthenticator;
  readonly dataDir?: string;
};

/** log 机器格式：\x1f 分隔字段、-z 记录间 NUL（名字/主题不转义、无换行歧义——web/history/log.ts 同式） */
const LOG_FORMAT = '%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s';

interface CommitRow {
  readonly oid: string;
  readonly short_oid: string;
  readonly message: string;
  readonly author_name: string;
  readonly author_email: string;
  readonly authored_at: string;
}

function sendError(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  return reply.code(status).send({ error: { code, message } });
}

function sendNotFound(reply: FastifyReply): FastifyReply {
  return sendError(reply, 404, 'E-RES-001', '资源不存在或无权访问');
}

export function registerCommitsReadRoutes(app: FastifyInstance, opts: CommitsReadRouteOptions): void {
  const vaults = new VaultService({ db: opts.db });
  const membershipSource = createDbMembershipSource(opts.db);

  /** 认证 + read 门槛（与 tree/docs.ts 同构——D1 各模块自持，避免跨任务共享文件） */
  async function requireReadVault(
    req: FastifyRequest,
    reply: FastifyReply,
    slug: string,
  ): Promise<{ vault: { id: number; slug: string; defaultBranch: string } } | null> {
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
    return { vault: { id: row.id, slug: row.slug, defaultBranch: row.default_branch } };
  }

  app.get('/api/v1/vaults/:slug/commits', async (req: FastifyRequest, reply: FastifyReply) => {
    const { slug } = req.params as { slug: string };
    const guard = await requireReadVault(req, reply, slug);
    if (!guard) return reply;
    const { vault } = guard;
    if (opts.dataDir === undefined) {
      return reply.code(503).send({ error: { message: '内容暂不可用（仓库存储未挂接——仅测试形态会出现）' } });
    }
    const query = req.query as Record<string, unknown>;

    const rawLimit = query.limit;
    if (rawLimit !== undefined && (typeof rawLimit !== 'string' || !/^\d+$/.test(rawLimit))) {
      return sendError(reply, 400, 'E-RES-004', '请求形态错误：limit 必须为正整数');
    }
    const limit = rawLimit === undefined ? 50 : Number(rawLimit);
    if (limit < 1 || limit > 100) {
      return sendError(reply, 400, 'E-RES-004', '请求形态错误：limit 取值范围 1..100');
    }

    const filePath = typeof query.path === 'string' ? query.path : '';
    if (filePath !== '' && !treePathOk(filePath)) return sendNotFound(reply);

    const rawRef = query.ref;
    if (rawRef !== undefined && typeof rawRef !== 'string') {
      return sendError(reply, 400, 'E-RES-004', '请求形态错误：ref 必须为 commit OID 字符串');
    }
    const ref = typeof rawRef === 'string' && rawRef !== '' ? rawRef : undefined;
    const repoPath = vaultRepoPath(opts.dataDir, vault.id);
    const resolved = await resolveRefCommit(repoPath, vault.defaultBranch, ref);
    if (resolved.kind === 'bad-shape') {
      return sendError(reply, 400, 'E-RES-004', '请求形态错误：ref 只支持 commit OID（分支名等 rev 形态 v1 不支持——D38）');
    }
    if (resolved.kind === 'not-found') {
      // 缺省（默认分支）不存在的唯一常态是 unborn——刚建的空库（web 历史页「尚无提交」同判），
      // 返回空列表：平台建库即进目录/新建文档的基线路径（显式 ref 的未知 OID 仍 404 反存在性）。
      if (ref !== undefined) return sendNotFound(reply);
      return reply.send({
        vault: vault.slug,
        ref: vault.defaultBranch,
        commit_oid: '',
        commits: [],
        has_more: false,
      });
    }
    if (resolved.kind === 'unavailable') {
      return reply.code(503).send({ error: { message: '内容暂不可用（仓库目录缺失或读取失败）' } });
    }

    const args = ['log', '-z', `--format=${LOG_FORMAT}`, '-n', String(limit + 1), resolved.commitOid];
    if (filePath !== '') args.push('--follow', '--', filePath);
    let out: string;
    try {
      out = await execGit(args, { cwd: repoPath });
    } catch {
      return reply.code(503).send({ error: { message: '内容暂不可用（仓库目录缺失或读取失败）' } });
    }
    const commits: CommitRow[] = [];
    for (const rec of out.split('\0')) {
      if (rec === '') continue;
      const f = rec.split('\x1f');
      if (f.length < 6) continue; // 未知形态跳过（不虚构条目）
      commits.push({
        oid: f[0]!,
        short_oid: f[1]!,
        author_name: f[2]!,
        author_email: f[3]!,
        authored_at: f[4]!,
        message: f.slice(5).join('\x1f'), // 主题内嵌分隔符时并回（字段序保障）
      });
    }
    const has_more = commits.length > limit;
    return reply.send({
      vault: vault.slug,
      ref: ref ?? vault.defaultBranch,
      commit_oid: resolved.commitOid,
      commits: has_more ? commits.slice(0, limit) : commits,
      has_more,
    });
  });
}
