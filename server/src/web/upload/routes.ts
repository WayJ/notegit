import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { spawn } from 'node:child_process';
import type { DatabaseSync } from 'node:sqlite';
import type { Issue, Report } from 'notegit-validation';
import type { AuthSuccess } from '../../auth/lifecycle.ts';
import { authorize } from '../../auth/lifecycle.ts';
import { createDbMembershipSource } from '../../vaults/membership.ts';
import { VaultService } from '../../vaults/service.ts';
import { effectiveConfig } from '../../limits/engine.ts';
import { publishWebSubmit, type PublishResult, type RejectedResult } from '../../publish/index.ts';
import { execGit } from '../../publish/git-exec.ts';
import { vaultRepoPath } from '../../vaults/repo-path.ts';
import { sendPageNotFound } from '../page-kit.ts';
import { ATTACHMENT_OID_PATTERN, attachmentUrl } from '../view/attachments.ts';
import { readEntryAt, treePathOk } from '../browse/tree.ts';

/**
 * S4-T4 上传与附件服务（breakdown §2.3 S4-T4 行；api.md §13 S4-T4 两行）：
 *
 * - POST /vaults/{slug}/upload/{path}（application/octet-stream，请求体=原始
 *   字节）：上传即走候选提交——publishWebSubmit（S3-T7 发布组件唯一入口）
 *   单文件 upsert 变更，**按 T3 定形的形状**（edit/submit.ts 同构：每提交单
 *   文件；附件与引用它的 Markdown 变更**分步提交**——先传附件得 blob 寻址
 *   URL，再经 T3 表单提交引用它的 Markdown，两个各自完整的发布链）。判定
 *   单一来源 = 组件 validation 阶段（sprint D7：本端点不设第二套校验，只做
 *   错误映射——E-LIMIT 码携带 limit/limitKey/expected 定位字段）。
 * - GET /vaults/{slug}/attach/{oid}[/{name}]（附件读取端点，本模块同文件）：
 *   一律经鉴权（authorize read；无权 404 反存在性同页 D-IC-06）；按 blob
 *   寻址（URL 不可枚举——选型记录见 view/attachments.ts 文件头）。
 * - base commit：请求时解析默认分支 HEAD 作 CAS 旧值（并发写入由组件
 *   base-commit 阶段拒绝 409——完整冲突保护/草稿语义属 S4-T7）。
 * - 维护模式：本路由未接 gate 实例（WebRoutesOptions 无此缝——同 T3 占位
 *   调用面形态；HTTP 层统一接线属 S4-T7，见 pipeline.ts maintenanceGate 注）。
 *
 * D5 模块自声明：不改 web/routes.ts 既有行（组装点 append 一行注册本模块）。
 */

export interface UploadRoutesOptions {
  readonly db: DatabaseSync;
  readonly dataDir?: string;
  readonly requirePageUser: (req: FastifyRequest, reply: FastifyReply) => Promise<AuthSuccess | null>;
}

/**
 * 上传请求体护栏（防滥用天花板；同 githttp bodyGuardCeiling 裁决形态）：
 * 组装时读一次生效 maxAttachmentBytes、只升不降（floor 64 MiB）——护栏永不
 * 先于热生效的 E-LIMIT-003 判定给出费解 413；正式判定逐请求走发布组件
 * validation 阶段（limits 引擎覆盖链实时读取）。
 */
const UPLOAD_BODY_GUARD_FLOOR = 64 * 1024 * 1024;

/** 上传传输契约：唯一接受的内容类型（原始字节；.md 与图片同形） */
const UPLOAD_CONTENT_TYPE = 'application/octet-stream';

/** 拒绝阶段 → HTTP 状态码（T7 错误提示整合前的最小语义映射） */
function statusOfStage(stage: RejectedResult['stage']): number {
  if (stage === 'validation') return 422; // 内容校验拒绝（含 E-LIMIT/E-FM/E-PATH 码）
  if (stage === 'authorization' || stage === 'branch-rules' || stage === 'execution-point') return 403; // 写权限
  if (stage === 'base-commit') return 409; // CAS 旧值不符（并发冲突——不静默覆盖）
  return 500; // candidate/audit/update-ref/settle：组件内部失败（fail-closed，不发布）
}

/** 报告内全部 error 级 issue（单文件上传——映射自组件报告，不另设判定） */
function errorIssuesOf(report: Report | undefined): Issue[] {
  if (report === undefined) return [];
  const out: Issue[] = [];
  for (const file of report.files) out.push(...file.issues.filter((x) => x.severity === 'error'));
  return out;
}

/** issue 定位字段透传（契约 §6.2：limit/limitKey/actual/expected/line/field） */
function locatorOf(issue: Issue): Record<string, string | number | string[]> {
  const loc: Record<string, string | number | string[]> = {};
  if (issue.actual !== undefined) loc['actual'] = issue.actual as string | number;
  if (issue.expected !== undefined) loc['expected'] = issue.expected as string | number | string[];
  if (issue.limit !== undefined) loc['limit'] = issue.limit;
  if (issue.limitKey !== undefined) loc['limitKey'] = issue.limitKey;
  if (issue.line !== undefined) loc['line'] = issue.line;
  if (issue.field !== undefined) loc['field'] = issue.field;
  return loc;
}

/** 服务端注入的提交身份（identity §8：审计主体=认证员工，不信可填写的 author；
 *  web 会话提交无外部邮箱——合成 notegit.invalid 域（RFC 2606 保留）仅作展示） */
function identityOf(who: AuthSuccess): { name: string; email: string } {
  return { name: who.subject.username, email: `${who.subject.username}@users.notegit.invalid` };
}

/** 默认分支 HEAD（CAS 旧值；空库=null 分支创建语义——同 edit/routes.ts 形态） */
async function headCommit(repoPath: string, branch: string): Promise<string | null> {
  try {
    const out = await execGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repoPath });
    const oid = out.trim();
    return oid === '' ? null : oid;
  } catch {
    return null; // 未知 ref（空库）
  }
}

/**
 * 读取 blob 原始字节（二进制安全）。execGit 面向文本（stdout→utf8 string——
 * 会破坏图片字节），故本模块自带 buffer 版（超时 SIGKILL/退出码语义同源）：
 * git 退出非零（OID 不存在/非 blob）→ null（调用方按 404 反存在性处理）；
 * spawn 层失败（仓库目录缺失等）→ reject（存储不一致，不冒充 404）。
 */
function readBlobBytes(dataDir: string, vaultId: number, oid: string): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['cat-file', 'blob', oid], { cwd: vaultRepoPath(dataDir, vaultId) });
    const stdout: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stdout.on('data', (c: Buffer) => stdout.push(c));
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code === 0 ? Buffer.concat(stdout) : null);
    });
  });
}

/**
 * 附件响应内容类型（按 URL 文件名段）：仅升格已知安全类型；**svg 一律
 * octet-stream**——纵使管理员把 .svg 加进清单（清单制可配），也不以
 * image/svg+xml 出面（内嵌脚本属执行面，纵深防御）；未知/缺名同 octet-stream
 * 且强制下载。附件读取一律 nosniff（防嗅探升格）+ private, no-store（库内容
 * 不落共享缓存——撤权后无残留副本面）。
 */
const ATTACH_CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.md': 'text/markdown; charset=utf-8',
};

function attachContentType(filename: string | undefined): { contentType: string; disposition?: 'attachment' } {
  if (filename === undefined) return { contentType: 'application/octet-stream', disposition: 'attachment' };
  const dot = filename.lastIndexOf('.');
  const ext = dot === -1 ? '' : filename.slice(dot).toLowerCase();
  const known = ATTACH_CONTENT_TYPES[ext];
  return known === undefined
    ? { contentType: 'application/octet-stream', disposition: 'attachment' }
    : { contentType: known };
}

export function registerUploadRoutes(app: FastifyInstance, opts: UploadRoutesOptions): void {
  const vaults = new VaultService({ db: opts.db }); // 只读消费（getVaultRow）
  const membershipSource = createDbMembershipSource(opts.db); // 三入口同源成员判定

  // 原始字节解析器 + 传输护栏（见 UPLOAD_BODY_GUARD_FLOOR 注）
  const bodyLimit = Math.max(effectiveConfig({ db: opts.db }).maxAttachmentBytes, UPLOAD_BODY_GUARD_FLOOR);
  app.addContentTypeParser(UPLOAD_CONTENT_TYPE, { parseAs: 'buffer', bodyLimit }, (_req, body, done) =>
    done(null, body),
  );

  /** 页面域统一守卫：认证 → authorize read（无权=不存在 404）→ 库行 fail-closed */
  async function requireVault(
    req: FastifyRequest,
    reply: FastifyReply,
    slug: string,
  ): Promise<{ who: AuthSuccess; vault: { slug: string; id: number; defaultBranch: string } } | null> {
    const who = await opts.requirePageUser(req, reply);
    if (!who) return null;
    const decision = authorize(membershipSource, who.subject.employee_id, slug, 'read');
    if (!decision.allowed) return sendPageNotFound(reply), null; // 无权=不存在（D-IC-06）
    const row = vaults.getVaultRow(slug);
    if (!row) return sendPageNotFound(reply), null; // fail-closed
    return { who, vault: { slug: row.slug, id: row.id, defaultBranch: row.default_branch } };
  }

  app.post('/vaults/:slug/upload/*', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const guard = await requireVault(req, reply, slug);
    if (!guard) return reply;
    const { who, vault } = guard;
    if (opts.dataDir === undefined) {
      return reply.code(503).send({ ok: false, stage: 'candidate', reason: '仓库存储未挂接（仅测试形态会出现）' });
    }
    // 传输契约（唯一内容类型）：其余类型 415（未注册类型由 Fastify 默认同码拒绝）
    const contentType = String(req.headers['content-type'] ?? '');
    if (!contentType.startsWith(UPLOAD_CONTENT_TYPE)) {
      return reply.code(415).send({ ok: false, reason: `上传请求体须为 ${UPLOAD_CONTENT_TYPE}（原始字节）` });
    }
    const entryPath = ((req.params as Record<string, string>)['*'] ?? '').replace(/^\/+/, '');
    if (entryPath === '' || !treePathOk(entryPath)) return sendPageNotFound(reply); // 畸形路径=不存在

    const bytes = req.body as Buffer;
    const baseCommit = await headCommit(vaultRepoPath(opts.dataDir, vault.id), vault.defaultBranch);

    const publish = await publishWebSubmit({
      db: opts.db,
      dataDir: opts.dataDir,
      subject: { employeeId: who.subject.employee_id, carrierRef: who.carrierRef },
      vaultSlug: vault.slug,
      branch: vault.defaultBranch,
      baseCommit,
      changes: [{ kind: 'upsert', path: entryPath, mode: '100644', content: bytes }],
      message: `Web 上传：${entryPath}`,
      identity: identityOf(who),
    });

    if (publish.kind === 'rejected') {
      const issues = errorIssuesOf(publish.report);
      const first = issues[0];
      return reply.code(statusOfStage(publish.stage)).send({
        ok: false,
        stage: publish.stage,
        reason: publish.reason,
        ...(first === undefined ? {} : { error: { code: first.code, message: first.message, ...locatorOf(first) } }),
        ...(publish.report === undefined ? {} : { issues }),
      });
    }

    // 成功：解析新 HEAD 下该路径条目 → blob 寻址附件 URL（读失败如实置 null）
    let url: string | null = null;
    const entry = await readEntryAt(opts.dataDir, vault.id, vault.defaultBranch, entryPath);
    if (entry.kind === 'ok' && entry.entry.type === 'blob') {
      url = attachmentUrl(vault.slug, entry.entry.oid, entry.entry.name);
    }
    return reply.code(200).send({ ok: true, path: entryPath, commit: publish.newOid, url });
  });

  // GET /vaults/{slug}/attach/{oid}[/{name}]：附件读取端点（一律经鉴权——
  // authorize read，无权 404 反存在性同页；按 blob 寻址——URL 不可枚举，
  // 选型记录见 view/attachments.ts 文件头）。
  app.get('/vaults/:slug/attach/:oid/:name', async (req, reply) => {
    return serveAttach(req, reply);
  });
  app.get('/vaults/:slug/attach/:oid', async (req, reply) => {
    return serveAttach(req, reply);
  });

  async function serveAttach(req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    const { slug, oid, name } = req.params as { slug: string; oid: string; name?: string };
    const guard = await requireVault(req, reply, slug);
    if (!guard) return reply;
    if (opts.dataDir === undefined) {
      return reply.code(503).type('text/plain; charset=utf-8').send('内容暂不可用（仓库存储未挂接）。');
    }
    if (!ATTACHMENT_OID_PATTERN.test(oid)) return sendPageNotFound(reply); // 畸形=不存在（无 oracle）
    let bytes: Buffer | null;
    try {
      bytes = await readBlobBytes(opts.dataDir, guard.vault.id, oid);
    } catch {
      return reply.code(503).type('text/plain; charset=utf-8').send('内容暂不可用（仓库读取失败）。');
    }
    if (bytes === null) return sendPageNotFound(reply); // OID 不在库内=不存在（同体 404）
    const { contentType, disposition } = attachContentType(name);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('cache-control', 'private, no-store');
    if (disposition !== undefined) reply.header('content-disposition', disposition);
    return reply.code(200).type(contentType).send(bytes);
  }
}
