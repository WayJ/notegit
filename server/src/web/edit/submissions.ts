import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import {
  authorize,
  rejectAuth,
  type AuthSuccess,
  type MembershipSource,
  type RequestAuthenticator,
  type VaultScope,
} from '../../auth/lifecycle.ts';
import type { MaintenanceGate } from '../../maintenance/gate.ts';
import { createDbMembershipSource } from '../../vaults/membership.ts';
import { VaultService } from '../../vaults/service.ts';
import { vaultRepoPath } from '../../vaults/repo-path.ts';
import { effectiveConfig } from '../../limits/engine.ts';
import { execGit } from '../../publish/git-exec.ts';
import type { RejectedResult, WebSubmitChange } from '../../publish/index.ts';
import { submitComposedChanges } from './submit.ts';

/**
 * S4-T7 提交端点（api.md §8.2；breakdown §2.3 S4-T7 行；架构 §6/§5.4、DOD-07）：
 *
 * - POST /api/v1/vaults/{slug}/submissions（写；editor+）：编辑页「提交」按钮的
 *   消费端点（edit/pages.ts SUBMIT_URL 自 T3 定形即指向此路径）。请求
 *   {base_commit, message?, changes:[{path,content}|{path,content_base64}|
 *   {path,delete:true}]} → submitComposedChanges（submit 面，S4-T6 草稿流转
 *   挂点单点保持）→ S3-T7 publishWebSubmit——**预期旧 commit（CAS）为唯一
 *   冲突机制**：base-commit 阶段比对不符或 update-ref 原子 CAS 竞态 →
 *   409 E-RES-003（信封 details={base_commit, current_head}——当前 tip 提示
 *   刷新；不覆盖、草稿完整保留）。
 * - 错误映射（§8.2 错误列）：validation 422 = T2 报告（非信封）；授权前置 =
 *   认证四状态 401 + authorize write（reader 403 E-AUTHZ-001、非成员/未知库
 *   404 E-RES-001，D-IC-06）——组件链仍全量复核（authorization 404 /
 *   branch-rules 403 / execution-point 按因 403·404·503）；请求形态 400
 *   E-RES-004（缺必填/双形态/非 SHA base_commit/库外 OID——组件 candidate
 *   阶段同判库内存在性，此处为 API 语义前置）；内部 fail-closed 500。
 * - 维护模式双层（同 upload/rename 形态）：HTTP 层第一道 = app 级
 *   maintenanceGuard（/api/v1 非安全方法自动覆盖，503 E-MAINT-001）；组件层
 *   最后一道 = submitComposedChanges 透传 maintenanceGate（execution-point
 *   复查）。CSRF 由 app 级 csrfGuard 同源校验（会话载体）。
 * - 传输护栏（同 drafts 形态）：插件作用域覆盖 application/json 解析器
 *   bodyLimit 只升不降——防 Fastify 缺省 1 MiB 先于热配置容量给出费解 413。
 */

export interface SubmissionRoutesOptions {
  readonly db: DatabaseSync;
  readonly authenticateRequest: RequestAuthenticator;
  /** 数据目录（生产装配恒传入；缺省 = S2 测试形态，提交呈 503 如实标注） */
  readonly dataDir?: string;
  /** 维护闸门（组件层最后一道；HTTP 层第一道在 app 级 maintenanceGuard） */
  readonly maintenanceGate?: MaintenanceGate;
}

/** 传输护栏下限（同 drafts 形态） */
const SUBMISSION_BODY_GUARD_FLOOR = 8 * 1024 * 1024;

/** base_commit 形状：SHA-1/SHA-256 hex（名称形态交组件判定——此处只拒明显非 OID） */
const OID_SHAPE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

/** base64（标准字母表 + 可选填充；不允许空白/URL 变体——宽容解析会吞字节错位） */
const BASE64_SHAPE = /^[A-Za-z0-9+/]+={0,2}$/;

interface ParsedSubmission {
  readonly baseCommit: string | null;
  readonly message: string | undefined;
  readonly changes: readonly WebSubmitChange[];
}

/** §8.2 请求体形态：base_commit 必填（string|null）、changes ≥1 项、每项恰一内容形态 */
function parseSubmissionBody(body: unknown): ParsedSubmission | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  if (!('base_commit' in b)) return null;
  const base = b['base_commit'];
  if (base !== null && (typeof base !== 'string' || !OID_SHAPE.test(base))) return null;
  if (b['message'] !== undefined && typeof b['message'] !== 'string') return null;
  if (!Array.isArray(b['changes']) || b['changes'].length === 0) return null;
  const changes: WebSubmitChange[] = [];
  for (const raw of b['changes']) {
    if (typeof raw !== 'object' || raw === null) return null;
    const c = raw as Record<string, unknown>;
    if (typeof c['path'] !== 'string' || c['path'] === '') return null;
    const content = typeof c['content'] === 'string';
    const base64 = typeof c['content_base64'] === 'string';
    const del = c['delete'] === true;
    if ([content, base64, del].filter(Boolean).length !== 1) return null; // 恰一形态（零或多种=形态错误）
    if (del) {
      changes.push({ kind: 'delete', path: c['path'] });
      continue;
    }
    if (content) {
      changes.push({ kind: 'upsert', path: c['path'], mode: '100644', content: c['content'] as string });
      continue;
    }
    const encoded = c['content_base64'] as string;
    if (encoded === '' || !BASE64_SHAPE.test(encoded) || encoded.length % 4 !== 0) return null;
    changes.push({ kind: 'upsert', path: c['path'], mode: '100644', content: Buffer.from(encoded, 'base64') });
  }
  return { baseCommit: base as string | null, message: b['message'] as string | undefined, changes };
}

/** ref 当前值（409 details.current_head——响应时点实况）；未知 ref = null */
async function refHead(repoPath: string, branch: string): Promise<string | null> {
  try {
    return (await execGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repoPath })).trim() || null;
  } catch {
    return null;
  }
}

/** base_commit 是否库内真实提交（组件 candidate 阶段同判——API 语义前置：400 而非组件拒绝） */
async function commitInRepo(repoPath: string, oid: string): Promise<boolean> {
  try {
    await execGit(['rev-parse', '--verify', '--quiet', `${oid}^{commit}`], { cwd: repoPath });
    return true;
  } catch {
    return false;
  }
}

function sendError(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  return reply.code(status).send({ error: { code, message } });
}

export const submissionsPlugin: FastifyPluginAsync<SubmissionRoutesOptions> = async (
  instance: FastifyInstance,
  options: SubmissionRoutesOptions,
) => {
  const source: MembershipSource = createDbMembershipSource(options.db);
  const vaults = new VaultService({ db: options.db }); // 只读消费（getVaultRow）

  // 传输护栏（见 SUBMISSION_BODY_GUARD_FLOOR 注）：插件作用域内覆盖 application/json
  // 解析器（本域唯一 JSON 端点是提交；编辑页组装全文可近 maxDocumentBytes ×6）
  const bodyLimit = Math.max(effectiveConfig({ db: options.db }).maxDocumentBytes * 6, SUBMISSION_BODY_GUARD_FLOOR);
  instance.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit }, (_req, body, done) => {
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      done(err as Error, undefined); // 非法 JSON → app 级错误处理 400 E-RES-004
    }
  });

  /** token 载体的 scope 收窄（identity §3.4）；会话载体 = 员工全量权限 */
  function scopeOf(outcome: AuthSuccess): VaultScope | undefined {
    if (outcome.carrier === 'token' && outcome.token) {
      return { access: outcome.token.scopeAccess, vaultIds: outcome.token.scopeVaultIds };
    }
    return undefined;
  }

  /** 服务端注入的提交身份（identity §8：同 upload/rename 形态——审计主体不信 commit author） */
  function identityOf(who: AuthSuccess): { name: string; email: string } {
    return { name: who.subject.username, email: `${who.subject.username}@users.notegit.invalid` };
  }

  instance.post('/api/v1/vaults/:slug/submissions', async (req: FastifyRequest, reply: FastifyReply) => {
    const { slug } = req.params as { slug: string };

    // 认证（identity §5.1 第 1 层）：四状态精确 401 映射（api 域 JSON——页面 302 形态不适配）
    const outcome = await options.authenticateRequest(req);
    if (!outcome.ok) return rejectAuth(reply, outcome);
    const auth: AuthSuccess = outcome;

    // 授权前置（§8.2 editor+）：reader 403、非成员/未知库 404 同码同体（D-IC-06）。
    // 组件链仍全量复核（authorization/branch-rules/execution-point——纵深，非替代）
    const decision = authorize(source, auth.subject.employee_id, slug, 'write', scopeOf(auth));
    if (!decision.allowed) {
      if (decision.reason === 'forbidden') return sendError(reply, 403, 'E-AUTHZ-001', '权限不足');
      return sendError(reply, 404, 'E-RES-001', '资源不存在或无权访问');
    }
    const vault = vaults.getVaultRow(slug);
    if (!vault) return sendError(reply, 404, 'E-RES-001', '资源不存在或无权访问'); // fail-closed
    if (options.dataDir === undefined) {
      return reply.code(503).send({ error: { message: '内容暂不可用（仓库存储未挂接——仅测试形态会出现）' } });
    }
    const repoPath = vaultRepoPath(options.dataDir, vault.id);

    // 请求形态（400 E-RES-004）：§8.2 形状前置判定（路径/内容规则一律归组件
    // validation 阶段 T2 报告——单一来源 D7）
    const parsed = parseSubmissionBody(req.body);
    if (parsed === null) {
      return sendError(
        reply,
        400,
        'E-RES-004',
        '请求形态错误（base_commit 必填 string|null（SHA 形状）、changes ≥1 项且每项恰一内容形态 content|content_base64|delete）',
      );
    }
    if (parsed.baseCommit !== null && !(await commitInRepo(repoPath, parsed.baseCommit))) {
      return sendError(reply, 400, 'E-RES-004', '请求形态错误（base_commit 不是库内提交）');
    }

    // submit 面（submitComposedChanges → publishWebSubmit；S4-T6 草稿流转挂点单点保持）
    const publish = await submitComposedChanges({
      db: options.db,
      dataDir: options.dataDir,
      subject: { employeeId: auth.subject.employee_id, carrierRef: auth.carrierRef },
      vaultSlug: vault.slug,
      branch: vault.default_branch, // v1 仅默认分支（api.md §8.3）
      baseCommit: parsed.baseCommit,
      changes: parsed.changes,
      message: parsed.message ?? `Web 提交（${parsed.changes.length} 项变更）`,
      identity: identityOf(auth),
      ...(options.maintenanceGate !== undefined ? { maintenanceGate: options.maintenanceGate } : {}),
    });

    if (publish.kind === 'published') {
      // 201 {commit, branch, report}（§8.2 成功形态；report = T2 报告 pass 可含 W 级）
      return reply.code(201).send({ commit: publish.newOid, branch: vault.default_branch, report: publish.report });
    }

    // 拒绝 → HTTP 语义（§8.2 错误列）
    const rejected = publish as RejectedResult;
    if (rejected.stage === 'validation') {
      return reply.code(422).send(rejected.report); // T2 报告（非信封；草稿保留）
    }
    if (rejected.stage === 'base-commit' || rejected.stage === 'update-ref') {
      // CAS 冲突（预期旧 commit 不符 / 原子更新竞态）——409 + 当前 tip 提示刷新
      const currentHead = await refHead(repoPath, vault.default_branch);
      return reply.code(409).send({
        error: {
          code: 'E-RES-003',
          message: '分支已前进：base_commit 与当前 HEAD 不一致（并发冲突，草稿已保留——刷新基线后可重提，不静默覆盖）',
          details: { base_commit: parsed.baseCommit, current_head: currentHead },
        },
      });
    }
    if (rejected.stage === 'authorization') return sendError(reply, 404, 'E-RES-001', '资源不存在或无权访问');
    if (rejected.stage === 'branch-rules') return sendError(reply, 403, 'E-AUTHZ-001', '权限不足');
    if (rejected.stage === 'execution-point') {
      if (rejected.reason.includes('维护')) {
        return reply.code(503).send({
          error: { code: 'E-MAINT-001', message: '维护中：写入被拒绝', details: { maintenance: true } },
        });
      }
      if (rejected.reason.includes('无成员关系') || rejected.reason.includes('配置缺失')) {
        return sendError(reply, 404, 'E-RES-001', '资源不存在或无权访问');
      }
      return sendError(reply, 403, 'E-AUTHZ-001', '权限不足'); // 只读成员/分支规则复查
    }
    // candidate/audit/settle：组件内部 fail-closed（不发布；无注册码——如实 500）
    return reply.code(500).send({ error: { message: rejected.reason } });
  });
};
