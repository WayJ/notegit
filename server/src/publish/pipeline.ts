import type { DatabaseSync } from 'node:sqlite';
import type { Report } from 'notegit-validation';
import { createValidator } from 'notegit-validation';
import type { VaultRole } from '../auth/lifecycle.ts';
import { reauthorizeAtExecutionPoint } from '../auth/lifecycle.ts';
import { recordAuditEvent } from '../audit/audit.ts';
import { branchWriteRules, type VaultBranchColumns } from '../vaults/branch-rules.ts';
import { createDbMembershipSource } from '../vaults/membership.ts';
import { vaultRepoPath } from '../vaults/repo-path.ts';
import { refCommandRejection, ZERO_OID, type RefCommand } from '../githttp/ref-rules.ts';
import {
  measureVaultBytes,
  newPushId,
  settlePushByRefState,
  settlePushRejected,
} from '../githttp/receive-audit.ts';
import { buildCandidateCommit, type CandidateResult, type CommitIdentity, type WebSubmitChange } from './candidate.ts';
import type { DraftPreserved } from './draft.ts';
import { execGit } from './git-exec.ts';

/**
 * 发布管线（S3-T7；架构 §5.4 第三入口与「网页不能通过直接 update-ref 绕过接收
 * 规则」、§9 候选提交）：Web 发布与 Git receive 共用的单一组件链——
 *
 *   candidate（候选提交构造）→ audit（vault.web_submit pending 预记录，
 *   fail-closed）→ authorization（S2 成员关系）→ branch-rules（S3 ref-rules
 *   唯一判定源 refCommandRejection）→ validation（packages/validation，
 *   scope=web-submit）→ base-commit（预期旧 commit 比对，不符拒绝不覆盖）→
 *   execution-point（identity §5.1 第 3 层：update-ref 前实时复查权限与分支
 *   规则——在途撤权/降级/配置翻转在此拒绝）→ update-ref（带预期旧值的原子
 *   CAS）→ settle（按 ref 实际值核对终态，不虚报成功）。
 *
 * 与 push 的同构锚点（S4 验收场景 S4 的代码基础）：
 * - ref 级规则：refCommandRejection（githttp/ref-rules.ts 唯一判定源，
 *   pre-receive/update hook 同源复用）；
 * - 内容规则：createValidator（packages/validation，sprint D7 单一来源）；
 * - 审计链：vault.web_submit pending 预记录先于检查（T6「预记早于校验」同锚
 *   点——崩溃覆盖窗口最大化），拒绝 settle rejected、成功按实际 OID settle
 *   succeeded——settle 消费 T6 导出面（settlePushRejected/settlePushByRefState
 *   按 detail.pushId 关联，两 kind 通吃）；中断残留 pending 由启动清扫标
 *   unresolved（与 push 同一恢复对账面）；
 * - 执行点复查：reauthorizeAtExecutionPoint + 重读库配置（与 update hook
 *   executionPointRecheck 同构）。
 *
 * 结构性禁跳步：步骤是常量表 PUBLISH_STAGES 驱动的有序链——运行器在每步
 * 开始前断言其全部前序步骤已执行（代码断言，违规即抛）；update-ref 只出现
 * 在本文件 updateRefStep 一处，且不经 index.ts 导出——外部不存在「只更新
 * 引用」的入口（结构性断言见 publish-structure.test.ts）。
 */

export const PUBLISH_STAGES = [
  'candidate',
  'audit',
  'authorization',
  'branch-rules',
  'validation',
  'base-commit',
  'execution-point',
  'update-ref',
  'settle',
] as const;

export type PublishStage = (typeof PUBLISH_STAGES)[number];

export interface PublishWebSubmitInput {
  readonly db: DatabaseSync;
  readonly dataDir: string;
  /** 认证主体（S4 会话归因：审计主体=认证员工，carrierRef=session:<id>；不信 commit author——identity §8） */
  readonly subject: { employeeId: number; carrierRef: string };
  readonly vaultSlug: string;
  readonly branch: string;
  /** 预期旧 commit（CAS 旧值；null=分支创建/空库根提交） */
  readonly baseCommit: string | null;
  readonly changes: readonly WebSubmitChange[];
  readonly message: string;
  readonly identity: CommitIdentity;
  /** 提交时间（ISO；缺省服务端当前时钟——测试注 deterministic 值） */
  readonly committedAt?: string;
  /** 审计行时间戳（ISO；缺省服务端当前时钟） */
  readonly occurredAt?: string;
  /** 步骤完成后的观察缝（测试注入/S4 进度提示）；不能改变步骤序列——结构上不可跳步 */
  readonly hooks?: { afterStep?(stage: PublishStage): void | Promise<void> };
}

export interface PublishedResult {
  readonly kind: 'published';
  readonly submitId: string;
  readonly ref: string;
  /** 实际旧值（CAS 保证 = baseCommit；创建态为 null） */
  readonly oldOid: string | null;
  readonly newOid: string;
  /** 校验报告（result='pass'；含 rulesVersion） */
  readonly report: Report;
  readonly executedSteps: readonly PublishStage[];
}

export interface RejectedResult {
  readonly kind: 'rejected';
  /** 拒绝发生的步骤（executedSteps 的最后一步） */
  readonly stage: PublishStage;
  /** 人读拒绝原因（与 push 拒绝文案同风格） */
  readonly reason: string;
  readonly submitId: string;
  /** 不发布 ⇒ 草稿保留（S4 语义；见 draft.ts） */
  readonly draft: DraftPreserved;
  /** 校验阶段必有（含 result='error' 的 fail-closed 形态）；其他阶段缺省 */
  readonly report?: Report;
  readonly executedSteps: readonly PublishStage[];
}

export type PublishResult = PublishedResult | RejectedResult;

interface Ctx {
  readonly input: PublishWebSubmitInput;
  readonly db: DatabaseSync;
  readonly submitId: string;
  /** null = slug 无映射（candidate 步骤拒绝；repoPath 同因空串不可用） */
  vaultId: number | null;
  repoPath: string;
  candidate: CandidateResult | null;
  /** authorization 步骤产出：成员关系（vaultId + role） */
  membership: { vaultId: number; role: VaultRole } | null;
  /** authorization 步骤产出：库配置列（execution-point 重读最新值） */
  vault: VaultBranchColumns | null;
  ref: string | null;
  cmd: RefCommand | null;
  report: Report | null;
  /** 审计行是否已预记录（candidate 失败/库不存在时为 false——无行可清算） */
  preRecorded: boolean;
  executed: PublishStage[];
}

type StepOutcome = { ok: true } | { ok: false; rejection: RejectedResult };

interface Step {
  readonly stage: PublishStage;
  run(ctx: Ctx): Promise<StepOutcome>;
}

function draftOf(ctx: Ctx, report?: Report): DraftPreserved {
  return {
    preserved: true,
    changes: ctx.input.changes,
    baseCommit: ctx.input.baseCommit,
    branch: ctx.input.branch,
    ...(report === undefined ? {} : { report }),
  };
}

function rejectAt(ctx: Ctx, stage: PublishStage, reason: string, report?: Report): StepOutcome {
  return {
    ok: false,
    rejection: {
      kind: 'rejected',
      stage,
      reason,
      submitId: ctx.submitId,
      draft: draftOf(ctx, report),
      ...(report === undefined ? {} : { report }),
      executedSteps: [...ctx.executed],
    },
  };
}

/** 拒绝已定后的审计清算（行不存在或审计库不可写时只留痕——拒绝本身已生效） */
function settleRejectedSafe(ctx: Ctx, reason: string, detail?: Record<string, unknown>): void {
  if (!ctx.preRecorded) return;
  try {
    settlePushRejected(ctx.db, { pushId: ctx.submitId, reason, detail });
  } catch (err) {
    console.error(`[notegit publish] 警告：审计清算失败（拒绝已生效）：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** vault.web_submit pending 预记录（storage-model §6 模式；与 preRecordPendingPush 同构——单命令单行单事务） */
function preRecordPendingWebSubmit(
  db: DatabaseSync,
  input: {
    employeeId: number;
    carrierRef: string;
    vaultId: number;
    ref: string;
    oldOid: string;
    newOid: string;
    submitId: string;
    occurredAt: string;
    detail?: Record<string, unknown>;
  },
): number {
  db.exec('BEGIN IMMEDIATE');
  try {
    recordAuditEvent(db, {
      occurredAt: input.occurredAt,
      actorKind: 'employee',
      subject: { employeeId: input.employeeId, carrierRef: input.carrierRef, entry: 'web' },
      eventKind: 'vault.web_submit',
      vaultId: input.vaultId,
      refName: input.ref,
      oldCommit: input.oldOid,
      newCommit: input.newOid,
      status: 'pending',
      detail: { pushId: input.submitId, ...(input.detail ?? {}) }, // pushId=T6 settle/清扫的关联键
    });
    const id = Number((db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id);
    db.exec('COMMIT');
    return id;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

async function revParseQuiet(repoPath: string, ref: string): Promise<string | null> {
  try {
    return (await execGit(['rev-parse', '--verify', '--quiet', ref], { cwd: repoPath })).trim();
  } catch {
    return null;
  }
}

const candidateStep: Step = {
  stage: 'candidate',
  async run(ctx) {
    if (ctx.vaultId === null) {
      return rejectAt(ctx, 'candidate', `库 ${ctx.input.vaultSlug} 不存在（slug 映射缺失）——拒绝`);
    }
    try {
      ctx.candidate = await buildCandidateCommit({
        repoPath: ctx.repoPath,
        baseCommit: ctx.input.baseCommit,
        changes: ctx.input.changes,
        message: ctx.input.message,
        identity: ctx.input.identity,
        ...(ctx.input.committedAt === undefined ? {} : { committedAt: ctx.input.committedAt }),
      });
      return { ok: true };
    } catch (err) {
      return rejectAt(ctx, 'candidate', `候选提交构造失败（不发布）：${err instanceof Error ? err.message : String(err)}`);
    }
  },
};

const auditStep: Step = {
  stage: 'audit',
  async run(ctx) {
    const vaultId = ctx.vaultId!;
    const ref = `refs/heads/${ctx.input.branch}`; // 审计先行：ref 名本轮尚未过分支校验（与 receive-pack 先给命令后检查同构）
    const oldOid = ctx.input.baseCommit ?? ZERO_OID;
    let vaultCurrentBytes: number | undefined;
    try {
      vaultCurrentBytes = await measureVaultBytes(ctx.repoPath); // E-LIMIT-005 计量口径（与 push 预记 detail 同构）
    } catch {
      // 计量缺失只少不少（T6 同语义）
    }
    try {
      preRecordPendingWebSubmit(ctx.db, {
        employeeId: ctx.input.subject.employeeId,
        carrierRef: ctx.input.subject.carrierRef,
        vaultId,
        ref,
        oldOid,
        newOid: ctx.candidate!.commitOid,
        submitId: ctx.submitId,
        occurredAt: ctx.input.occurredAt ?? new Date().toISOString(),
        ...(vaultCurrentBytes === undefined ? {} : { detail: { vaultCurrentBytes } }),
      });
      ctx.preRecorded = true;
      return { ok: true };
    } catch (err) {
      // fail-closed：宁可拒发布，不产生无审计的引用更新（T6 同锚点）；无行可清算
      return rejectAt(ctx, 'audit', `审计预记录失败——fail-closed 拒绝：${err instanceof Error ? err.message : String(err)}`);
    }
  },
};

const authorizationStep: Step = {
  stage: 'authorization',
  async run(ctx) {
    const membership = createDbMembershipSource(ctx.db).lookup(ctx.input.vaultSlug, ctx.input.subject.employeeId);
    if (membership === undefined) {
      settleRejectedSafe(ctx, 'authorization', { why: 'membership-revoked-or-absent' });
      return rejectAt(
        ctx,
        'authorization',
        `employee=${ctx.input.subject.employeeId} 于 ${ctx.input.vaultSlug} 无成员关系（或授权后已撤权）——拒绝`,
      );
    }
    const vault = ctx.db
      .prepare('SELECT default_branch, main_admin_only FROM vaults WHERE id = ?')
      .get(membership.vaultId) as VaultBranchColumns | undefined;
    if (vault === undefined) {
      settleRejectedSafe(ctx, 'authorization', { why: 'vault-config-missing' });
      return rejectAt(ctx, 'authorization', `vault id=${membership.vaultId} 配置缺失——fail-closed 拒绝`);
    }
    ctx.membership = membership;
    ctx.vault = vault;
    return { ok: true };
  },
};

const branchRulesStep: Step = {
  stage: 'branch-rules',
  async run(ctx) {
    const membership = ctx.membership!;
    const vault = ctx.vault!;
    // 分支名 git 原生校验（防注入形态；refCommandRejection 的命名空间检查以构造保证）
    try {
      await execGit(['check-ref-format', '--branch', ctx.input.branch], { cwd: ctx.repoPath });
    } catch {
      const reason = `分支名「${ctx.input.branch}」非法（git check-ref-format 拒绝）`;
      settleRejectedSafe(ctx, 'authorization', { rules: [reason] });
      return rejectAt(ctx, 'branch-rules', reason);
    }
    const ref = `refs/heads/${ctx.input.branch}`;
    const cmd: RefCommand = { ref, oldOid: ctx.input.baseCommit ?? ZERO_OID, newOid: ctx.candidate!.commitOid };
    const rejection = refCommandRejection(cmd, branchWriteRules(vault), membership.role);
    if (rejection !== null) {
      settleRejectedSafe(ctx, 'authorization', { rules: [rejection] });
      return rejectAt(ctx, 'branch-rules', rejection);
    }
    ctx.ref = ref;
    ctx.cmd = cmd;
    return { ok: true };
  },
};

const validationStep: Step = {
  stage: 'validation',
  async run(ctx) {
    const vaultId = ctx.vaultId!;
    const candidate = ctx.candidate!;
    // 单一来源（sprint D7）：与 pre-receive 同一 createValidator；scope=web-submit
    // 按「根据 base commit 构造的完整候选提交」校验变更集；候选全 tree 路径进
    // knownPaths（链接存在性基线）与 treePaths（E-PATH-004 基线——与 pre-receive
    // 的 CommitDelta.treePaths 同语义，存量路径大小写冲突同构拦截）
    const report = await createValidator().validate({
      scope: 'web-submit',
      vaultId: String(vaultId),
      commit: candidate.commitOid,
      files: candidate.changedFiles.map((x) => ({ ...x })),
      knownPaths: candidate.candidateTreePaths,
      treePaths: candidate.candidateTreePaths,
    });
    ctx.report = report;
    if (report.result !== 'pass') {
      settleRejectedSafe(ctx, 'validation', {
        rulesVersion: report.rulesVersion,
        result: report.result,
        exitCode: report.exitCode,
        errorCount: report.summary.errorCount,
        warningCount: report.summary.warningCount,
      });
      return rejectAt(ctx, 'validation', `内容校验未通过（rulesVersion=${report.rulesVersion}，result=${report.result}，exitCode=${report.exitCode}）——不发布，草稿已保留`, report);
    }
    return { ok: true };
  },
};

const baseCommitStep: Step = {
  stage: 'base-commit',
  async run(ctx) {
    const ref = ctx.ref!;
    const actual = await revParseQuiet(ctx.repoPath, ref);
    const expected = ctx.input.baseCommit;
    const matches = expected === null ? actual === null : actual === expected;
    if (!matches) {
      settleRejectedSafe(ctx, 'base-commit', {
        why: 'expected-old-commit-mismatch',
        ...(actual === null ? {} : { actualRefOid: actual }),
      });
      return rejectAt(
        ctx,
        'base-commit',
        `预期旧 commit 不符：期望 ${expected ?? '（分支不存在）'}，实际 ${actual ?? '（分支不存在）'}——拒绝发布不覆盖（并发冲突，草稿已保留，刷新基线后可重提）`,
      );
    }
    return { ok: true };
  },
};

const executionPointStep: Step = {
  stage: 'execution-point',
  async run(ctx) {
    // identity §5.1 第 3 层（与 update hook executionPointRecheck 同构）：
    // update-ref 前实时复查——在途撤权/降级在此拒绝（§5.2 行 4）
    const decision = reauthorizeAtExecutionPoint(
      createDbMembershipSource(ctx.db),
      ctx.input.subject.employeeId,
      ctx.input.vaultSlug,
    );
    if (!decision.allowed) {
      const why = decision.reason === 'forbidden' ? 'reader-at-execution-point' : 'membership-revoked-or-absent';
      const reason =
        decision.reason === 'forbidden'
          ? `${ctx.ref}：只读成员不可发布（执行点复查）`
          : `employee=${ctx.input.subject.employeeId} 于 ${ctx.input.vaultSlug} 无成员关系（执行点复查：检查后、update-ref 前撤权或非成员）——拒绝`;
      settleRejectedSafe(ctx, 'authorization', { checkpoint: 'execution-point', why });
      return rejectAt(ctx, 'execution-point', reason);
    }
    // 分支规则复查：重读库配置（在途 main_admin_only 翻转/默认分支变化在此生效）
    const vaultNow = ctx.db
      .prepare('SELECT default_branch, main_admin_only FROM vaults WHERE id = ?')
      .get(ctx.vaultId!) as VaultBranchColumns | undefined;
    if (vaultNow === undefined) {
      settleRejectedSafe(ctx, 'authorization', { checkpoint: 'execution-point', why: 'vault-config-missing' });
      return rejectAt(ctx, 'execution-point', `vault id=${ctx.vaultId} 配置缺失（执行点复查）——fail-closed 拒绝`);
    }
    const rejection = refCommandRejection(ctx.cmd!, branchWriteRules(vaultNow), decision.role);
    if (rejection !== null) {
      settleRejectedSafe(ctx, 'authorization', { checkpoint: 'execution-point', rules: [rejection] });
      return rejectAt(ctx, 'execution-point', rejection);
    }
    return { ok: true };
  },
};

const updateRefStep: Step = {
  stage: 'update-ref',
  async run(ctx) {
    const cmd = ctx.cmd!;
    try {
      // 原子 CAS：带预期旧值（全零=必须不存在）——比对步骤之后到执行之间的
      // 并发移动在此被拒，绝不覆盖
      await execGit(['update-ref', cmd.ref, cmd.newOid, cmd.oldOid], { cwd: ctx.repoPath });
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      settleRejectedSafe(ctx, 'base-commit', { why: 'cas-race', error: message });
      return rejectAt(ctx, 'update-ref', `update-ref 原子更新失败（预期旧 commit 已被并发改变，不覆盖）：${message}`);
    }
  },
};

const settleStep: Step = {
  stage: 'settle',
  async run(ctx) {
    const report = ctx.report!;
    const candidate = ctx.candidate!;
    const ref = ctx.ref!;
    // 按引用实际值核对终态（T6 导出面；old→new 成链 / 不符 rejected——不虚报成功）
    await settlePushByRefState(ctx.db, {
      pushId: ctx.submitId,
      actualOf: (refName) => revParseQuiet(ctx.repoPath, refName),
      detail: {
        rulesVersion: report.rulesVersion,
        result: report.result,
        exitCode: report.exitCode,
        errorCount: report.summary.errorCount,
      },
    });
    const actual = await revParseQuiet(ctx.repoPath, ref);
    if (actual !== candidate.commitOid) {
      return rejectAt(ctx, 'settle', `ref 已离开候选值（update-ref 后被并发写入移动）——按实际结果记 rejected，不虚报成功`);
    }
    return { ok: true };
  },
};

const STEPS: readonly Step[] = [
  candidateStep,
  auditStep,
  authorizationStep,
  branchRulesStep,
  validationStep,
  baseCommitStep,
  executionPointStep,
  updateRefStep,
  settleStep,
];

/** 单一入口：按 PUBLISH_STAGES 有序执行；任何异常 fail-closed 拒绝（不发布） */
export async function publishWebSubmit(input: PublishWebSubmitInput): Promise<PublishResult> {
  const submitId = newPushId();
  // slug→id 映射先行（架构 §3.2：稳定 ID → vaultRepoPath，不拼接用户输入）；
  // 库不存在时 candidateStep 拒绝（repoPath 空串不可用——无候选可言，也无审计行；
  // push 同形态：refs 发现 404 于 hook 之前）
  const vaultRow = input.db.prepare('SELECT id FROM vaults WHERE slug = ?').get(input.vaultSlug) as { id: number } | undefined;
  const ctx: Ctx = {
    input,
    db: input.db,
    submitId,
    vaultId: vaultRow === undefined ? null : vaultRow.id,
    repoPath: vaultRow === undefined ? '' : vaultRepoPath(input.dataDir, vaultRow.id),
    candidate: null,
    membership: null,
    vault: null,
    ref: null,
    cmd: null,
    report: null,
    preRecorded: false,
    executed: [],
  };

  const finish = (outcome: StepOutcome): PublishResult => {
    if (outcome.ok) {
      const published: PublishedResult = {
        kind: 'published',
        submitId,
        ref: ctx.ref!,
        oldOid: ctx.input.baseCommit,
        newOid: ctx.candidate!.commitOid,
        report: ctx.report!,
        executedSteps: [...ctx.executed],
      };
      return published;
    }
    return outcome.rejection;
  };

  for (const step of STEPS) {
    // 结构性禁跳步（代码断言）：任一步骤开始前，其全部前序步骤必须已执行
    const stageIdx = PUBLISH_STAGES.indexOf(step.stage);
    for (const prev of PUBLISH_STAGES.slice(0, stageIdx)) {
      if (!ctx.executed.includes(prev)) {
        throw new Error(`发布管线结构违规：步骤 ${step.stage} 在 ${prev} 未执行时被调用（禁跳步——PUBLISH_STAGES 有序链被破坏）`);
      }
    }
    ctx.executed.push(step.stage);
    try {
      const outcome = await step.run(ctx);
      if (!outcome.ok) return finish(outcome);
    } catch (err) {
      // 未预期异常：fail-closed 拒绝（不发布）；审计行若已预记录则清算为 rejected
      const message = err instanceof Error ? err.message : String(err);
      settleRejectedSafe(ctx, 'runtime', { error: message });
      return finish(rejectAt(ctx, step.stage, `发布管线异常（fail-closed 不发布）：${message}`));
    }
    await input.hooks?.afterStep?.(step.stage);
  }
  return finish({ ok: true });
}
