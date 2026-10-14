import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { spawn } from 'node:child_process';
import type { DatabaseSync } from 'node:sqlite';
import type { Report } from 'notegit-validation';
import type { AuthSuccess } from '../../auth/lifecycle.ts';
import { authorize } from '../../auth/lifecycle.ts';
import type { MaintenanceGate } from '../../maintenance/gate.ts';
import { createDbMembershipSource } from '../../vaults/membership.ts';
import { VaultService } from '../../vaults/service.ts';
import { vaultRepoPath } from '../../vaults/repo-path.ts';
import { publishWebSubmit, type RejectedResult } from '../../publish/index.ts';
import { execGit } from '../../publish/git-exec.ts';
import { html, sendPageNotFound } from '../page-kit.ts';
import { canWriteVault } from '../role-gate.ts';
import { hintFor } from '../hints.ts';
import { browseUrl, viewUrl } from '../browse/pages.ts';
import { readEntryAt, treePathOk } from '../browse/tree.ts';
import { renamePage, deleteConfirmPage, opStatePage, type OpNotice } from './pages.ts';

/**
 * S4-T5 重命名与删除路由（breakdown §2.3 S4-T5 行；validation §2.5；架构 §5.2/§6）：
 *
 * - POST /vaults/{slug}/rename/{path}：重命名 = upsert(新路径) + delete(旧路径)
 *   单变更集走 S3-T7 publishWebSubmit 唯一发布入口——**按目标路径重新判定**
 *   知识文档规则（validation §2.5 第 5 点）：改为 `.md` 须有合法 frontmatter
 *   （E-FM 码由组件报告映射回表单），改名 README.md 即豁免（判定全部来自组件
 *   validation 阶段，本模块不设第二套校验——sprint D7）。目标已存在拒绝不覆盖；
 *   同路径无操作 400。
 * - POST /vaults/{slug}/delete/{path}：删除不做元数据校验（validation §2.5），
 *   单条 delete 变更走发布组件；Git 历史不动（旧提交原样保留——S5 历史页可查
 *   旧版本，还原不丢数据）。
 * - GET rename/delete：表单/确认页（无写操作；read 成员门槛，写权限由提交时
 *   组件 authorization/branch-rules 判定——与 edit 族同形态）。
 * - base commit：请求时解析默认分支 HEAD 作 CAS 旧值（同 upload/edit 形态）。
 * - 维护模式：HTTP 层第一道 = 组装点 webWriteGuard（503）；组件层最后一道 =
 *   publishWebSubmit maintenanceGate 注入（双层同构——upload/T4 注记）。
 *
 * D5 模块自声明：组装点 append 一行注册本模块；辅助面（requireVault/
 * headCommit/blob 读取）与 upload 模块同构各自持有——模块间零导入。
 */

export interface RenameRoutesOptions {
  readonly db: DatabaseSync;
  readonly dataDir?: string;
  readonly requirePageUser: (req: FastifyRequest, reply: FastifyReply) => Promise<AuthSuccess | null>;
  /** 维护闸门（S4-T5 缝；缺省 = 无 gate 调用形态不检查——同 pipeline 缺省语义） */
  readonly maintenanceGate?: MaintenanceGate;
}

/** 拒绝阶段 → HTTP 状态码（T7 错误提示整合前的最小语义映射——同 upload 形态） */
function statusOfStage(stage: RejectedResult['stage'], reason: string): number {
  if (stage === 'validation') return 422; // 内容校验拒绝（E-FM/E-PATH/E-LIMIT 码）
  if (stage === 'authorization' || stage === 'branch-rules') return 403; // 写权限
  if (stage === 'base-commit') return 409; // CAS 旧值不符（并发冲突——不静默覆盖）
  if (stage === 'execution-point') return reason.includes('维护') ? 503 : 403; // 组件层维护复查（与 HTTP 层双层）
  return 500; // candidate/audit/update-ref/settle：组件内部失败（fail-closed，不发布）
}

/** 报告首个 error 级 issue → 表单 notice（E-FM 码 + 行定位——单文件变更取首个；
 *  S4-T8 统一提示：附修正建议 hint） */
function firstErrorNotice(report: Report | undefined): OpNotice | undefined {
  if (report === undefined) return undefined;
  for (const file of report.files) {
    const issue = file.issues.find((x) => x.severity === 'error');
    if (issue !== undefined) {
      return {
        code: issue.code,
        message: issue.message,
        ...(issue.line !== undefined ? { line: issue.line } : {}),
        ...(hintFor(issue.code) !== undefined ? { hint: hintFor(issue.code) } : {}),
      };
    }
  }
  return undefined;
}

/** 拒绝阶段 → 错误码（S4-T8 统一提示：api.md §1 注册码；同页不泄露额外信息——
 *  404/403 形态不变，仅 notice 携带 code+hint） */
function codeOfStage(stage: RejectedResult['stage'], reason: string): string | undefined {
  if (stage === 'authorization') return 'E-RES-001';
  if (stage === 'branch-rules') return 'E-AUTHZ-001';
  if (stage === 'base-commit') return 'E-RES-003';
  if (stage === 'execution-point') return reason.includes('维护') ? 'E-MAINT-001' : 'E-AUTHZ-001';
  return undefined; // validation（取报告 issue 码）/ candidate·audit·update-ref·settle（无注册码——T7 注记不杜撰）
}

/** 服务端注入的提交身份（identity §8：同 upload 形态） */
function identityOf(who: AuthSuccess): { name: string; email: string } {
  return { name: who.subject.username, email: `${who.subject.username}@users.notegit.invalid` };
}

/** 默认分支 HEAD（CAS 旧值；空库=null 分支创建语义——同 upload/edit 形态） */
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
 * 读取 blob 原始字节（二进制安全——重命名可能是附件）。execGit 面向文本
 * （stdout→utf8 会破坏二进制），故与 upload/routes.ts 同形自带 buffer 版
 * （超时 SIGKILL/退出码语义同源）：git 退出非零 → null（调用方按状态页处理）。
 */
function readBlobBytes(repoPath: string, oid: string): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['cat-file', 'blob', oid], { cwd: repoPath });
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

/** 所在目录（删除/取消返回 browse 落点） */
function parentOf(p: string): string {
  const slash = p.lastIndexOf('/');
  return slash === -1 ? '' : p.slice(0, slash);
}

export function registerRenameRoutes(app: FastifyInstance, opts: RenameRoutesOptions): void {
  const vaults = new VaultService({ db: opts.db }); // 只读消费（getVaultRow）
  const membershipSource = createDbMembershipSource(opts.db); // 三入口同源成员判定

  // 表单 POST 唯一内容类型（rename/delete 按钮=原生表单，无 JS、无新依赖）
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body: string, done) =>
    done(null, Object.fromEntries(new URLSearchParams(body))),
  );

  /** 页面域统一守卫：认证 → authorize read（无权=不存在 404）→ 库行 fail-closed */
  async function requireVault(
    req: FastifyRequest,
    reply: FastifyReply,
    slug: string,
  ): Promise<{ who: AuthSuccess; vault: { slug: string; name: string; id: number; defaultBranch: string } } | null> {
    const who = await opts.requirePageUser(req, reply);
    if (!who) return null;
    const decision = authorize(membershipSource, who.subject.employee_id, slug, 'read');
    if (!decision.allowed) return sendPageNotFound(reply), null; // 无权=不存在（D-IC-06）
    const row = vaults.getVaultRow(slug);
    if (!row) return sendPageNotFound(reply), null; // fail-closed
    return { who, vault: { slug: row.slug, name: row.name, id: row.id, defaultBranch: row.default_branch } };
  }

  /** 源条目形态守卫：blob 放行；目录 302 browse（edit 族同判）；其余 404/状态页。
   *  viewer=S12-T2 状态页账户位（呈现层可选参数——coordinator 批准扩展）。 */
  async function requireSourceEntry(
    reply: FastifyReply,
    vault: { slug: string; name: string; id: number; defaultBranch: string },
    entryPath: string,
    viewer?: { username: string; is_instance_admin?: boolean },
  ): Promise<{ oid: string; size: number | undefined } | null> {
    const read = await readEntryAt(opts.dataDir!, vault.id, vault.defaultBranch, entryPath);
    if (read.kind === 'unavailable') {
      return html(reply, opStatePage(vault, '内容暂不可用（仓库目录缺失或读取失败）。', viewer)), null;
    }
    if (read.kind === 'ok') {
      if (read.entry.type === 'tree') {
        reply.redirect(browseUrl(vault.slug, entryPath), 302); // 目录操作转 browse（无目录级重命名/删除——最小可用面）
        return null;
      }
      if (read.entry.type === 'blob') return { oid: read.entry.oid, size: read.entry.size };
      return sendPageNotFound(reply), null; // commit（子模块）——不支持
    }
    return sendPageNotFound(reply), null; // missing / not-found / no-commits：不存在（反存在性同页）
  }

  /** 组件拒绝 → 表单/确认页回显（同页提示；状态码按阶段映射；S4-T8 统一提示
   *  附错误码+修正建议——validation 取报告 issue 码，其余按阶段映射注册码） */
  function renderRejected(
    reply: FastifyReply,
    vault: { slug: string; name: string },
    publish: RejectedResult,
    page: 'rename' | 'delete',
    path: string,
    to: string,
    viewer?: { username: string; is_instance_admin: boolean },
  ): FastifyReply {
    const stageCode = codeOfStage(publish.stage, publish.reason);
    const notice: OpNotice =
      publish.stage === 'validation'
        ? (firstErrorNotice(publish.report) ?? { message: publish.reason })
        : {
            message: publish.reason,
            ...(stageCode !== undefined ? { code: stageCode } : {}),
            ...(stageCode !== undefined && hintFor(stageCode) !== undefined ? { hint: hintFor(stageCode) } : {}),
          };
    const status = statusOfStage(publish.stage, publish.reason);
    return reply.code(status).send(
      page === 'rename'
        ? renamePage({ vault, from: path, to, notice, ...(viewer !== undefined ? { viewer } : {}) })
        : deleteConfirmPage({ vault, path, notice, ...(viewer !== undefined ? { viewer } : {}) }),
    );
  }

  // ── 重命名 ────────────────────────────────────────────────────────────────
  app.get('/vaults/:slug/rename/*', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const guard = await requireVault(req, reply, slug);
    if (!guard) return reply;
    const { who, vault } = guard;
    if (opts.dataDir === undefined) {
      return html(
        reply,
        opStatePage(
          vault,
          '内容暂不可用（仓库存储未挂接——仅测试形态会出现）。',
          { username: who.subject.username, is_instance_admin: who.subject.is_instance_admin }, // S12-T2 账户位（批准扩展）
        ),
      );
    }
    const entryPath = ((req.params as Record<string, string>)['*'] ?? '').replace(/\/+$/, '');
    if (entryPath === '' || !treePathOk(entryPath)) return sendPageNotFound(reply);
    const entry = await requireSourceEntry(reply, vault, entryPath, { username: who.subject.username, is_instance_admin: who.subject.is_instance_admin });
    if (!entry) return reply;
    return html(
      reply,
      renamePage({
        vault,
        from: entryPath,
        to: entryPath,
        // S10-T2 权限感知：reader 直开 URL 呈只读态（D4：门槛 read 成员不变；
        // canWriteVault 唯一判定面，D17 呈现层——POST 侧鉴权原样）
        canWrite: canWriteVault(membershipSource, who.subject.employee_id, vault.slug),
        viewer: { username: who.subject.username, is_instance_admin: who.subject.is_instance_admin },
      }),
    );
  });

  app.post('/vaults/:slug/rename/*', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const guard = await requireVault(req, reply, slug);
    if (!guard) return reply;
    const { who, vault } = guard;
    if (opts.dataDir === undefined) {
      return reply.code(503).type('text/plain; charset=utf-8').send('内容暂不可用（仓库存储未挂接——仅测试形态会出现）。');
    }
    const entryPath = ((req.params as Record<string, string>)['*'] ?? '').replace(/\/+$/, '');
    const form = (req.body ?? {}) as Record<string, string>;
    const to = String(form['to'] ?? '').trim();
    const viewer = { username: who.subject.username, is_instance_admin: who.subject.is_instance_admin };
    const fail = (status: number, notice: OpNotice) =>
      reply.code(status).send(renamePage({ vault, from: entryPath, to, notice, viewer }));

    if (entryPath === '' || !treePathOk(entryPath) || to === '' || !treePathOk(to)) {
      return sendPageNotFound(reply); // 畸形路径=不存在（与 upload 同判，D-IC-06）
    }
    if (to === entryPath) return fail(400, { message: '路径未变化：新路径与原路径相同' });

    const entry = await requireSourceEntry(reply, vault, entryPath, { username: who.subject.username, is_instance_admin: who.subject.is_instance_admin });
    if (!entry) return reply;

    // 目标已存在：拒绝不覆盖（重命名不是覆盖写入；删除须走显式删除流程）
    const target = await readEntryAt(opts.dataDir, vault.id, vault.defaultBranch, to);
    if (target.kind === 'unavailable') {
      return html(reply, opStatePage(vault, '内容暂不可用（仓库目录缺失或读取失败）。', viewer));
    }
    if (target.kind === 'ok') return fail(409, { message: `目标路径已存在：${to}（不覆盖既有文件）` });

    let bytes: Buffer;
    try {
      const read = await readBlobBytes(vaultRepoPath(opts.dataDir, vault.id), entry.oid);
      if (read === null) throw new Error('blob 不在库内');
      bytes = read;
    } catch {
      return html(reply, opStatePage(vault, '内容暂不可用（原文件读取失败）。', viewer));
    }

    const repoPath = vaultRepoPath(opts.dataDir, vault.id);
    const baseCommit = await headCommit(repoPath, vault.defaultBranch);
    const publish = await publishWebSubmit({
      db: opts.db,
      dataDir: opts.dataDir,
      subject: { employeeId: who.subject.employee_id, carrierRef: who.carrierRef },
      vaultSlug: vault.slug,
      branch: vault.defaultBranch,
      baseCommit,
      // 单变更集：目标路径 upsert（内容逐字节保留）+ 源路径 delete——
      // 目标路径重判定由组件 validation 阶段完成（README 豁免含在内）
      changes: [
        { kind: 'upsert', path: to, mode: '100644', content: bytes },
        { kind: 'delete', path: entryPath },
      ],
      message: `Web 重命名：${entryPath} → ${to}`,
      identity: identityOf(who),
      ...(opts.maintenanceGate !== undefined ? { maintenanceGate: opts.maintenanceGate } : {}),
    });

    if (publish.kind === 'rejected') {
      return renderRejected(reply, vault, publish, 'rename', entryPath, to, viewer);
    }
    return reply.redirect(viewUrl(vault.slug, to), 302);
  });

  // ── 删除 ──────────────────────────────────────────────────────────────────
  app.get('/vaults/:slug/delete/*', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const guard = await requireVault(req, reply, slug);
    if (!guard) return reply;
    const { who, vault } = guard;
    if (opts.dataDir === undefined) {
      return html(
        reply,
        opStatePage(
          vault,
          '内容暂不可用（仓库存储未挂接——仅测试形态会出现）。',
          { username: who.subject.username, is_instance_admin: who.subject.is_instance_admin }, // S12-T2 账户位（批准扩展）
        ),
      );
    }
    const entryPath = ((req.params as Record<string, string>)['*'] ?? '').replace(/\/+$/, '');
    if (entryPath === '' || !treePathOk(entryPath)) return sendPageNotFound(reply);
    const entry = await requireSourceEntry(reply, vault, entryPath, { username: who.subject.username, is_instance_admin: who.subject.is_instance_admin });
    if (!entry) return reply;
    return html(
      reply,
      deleteConfirmPage({
        vault,
        path: entryPath,
        // S10-T2 权限感知：同 rename GET——reader 只读态（D4/D17）
        canWrite: canWriteVault(membershipSource, who.subject.employee_id, vault.slug),
        viewer: { username: who.subject.username, is_instance_admin: who.subject.is_instance_admin },
      }),
    );
  });

  app.post('/vaults/:slug/delete/*', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const guard = await requireVault(req, reply, slug);
    if (!guard) return reply;
    const { who, vault } = guard;
    if (opts.dataDir === undefined) {
      return reply.code(503).type('text/plain; charset=utf-8').send('内容暂不可用（仓库存储未挂接——仅测试形态会出现）。');
    }
    const entryPath = ((req.params as Record<string, string>)['*'] ?? '').replace(/\/+$/, '');
    if (entryPath === '' || !treePathOk(entryPath)) return sendPageNotFound(reply);

    const entry = await requireSourceEntry(reply, vault, entryPath, { username: who.subject.username, is_instance_admin: who.subject.is_instance_admin });
    if (!entry) return reply;

    const repoPath = vaultRepoPath(opts.dataDir, vault.id);
    const baseCommit = await headCommit(repoPath, vault.defaultBranch);
    const viewer = { username: who.subject.username, is_instance_admin: who.subject.is_instance_admin };
    const publish = await publishWebSubmit({
      db: opts.db,
      dataDir: opts.dataDir,
      subject: { employeeId: who.subject.employee_id, carrierRef: who.carrierRef },
      vaultSlug: vault.slug,
      branch: vault.defaultBranch,
      baseCommit,
      // 单条 delete：不做元数据校验（validation §2.5）；候选构造要求路径在基线
      // tree 中（requireSourceEntry 已确认存在）——Git 历史不动
      changes: [{ kind: 'delete', path: entryPath }],
      message: `Web 删除：${entryPath}`,
      identity: identityOf(who),
      ...(opts.maintenanceGate !== undefined ? { maintenanceGate: opts.maintenanceGate } : {}),
    });

    if (publish.kind === 'rejected') {
      return renderRejected(reply, vault, publish, 'delete', entryPath, entryPath, viewer);
    }
    return reply.redirect(browseUrl(vault.slug, parentOf(entryPath)), 302);
  });
}
