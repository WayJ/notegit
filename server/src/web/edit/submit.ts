import type { DatabaseSync } from 'node:sqlite';
import type { Issue, Report } from 'notegit-validation';
import { publishWebSubmit, type CommitIdentity, type PublishResult } from '../../publish/index.ts';
import { DraftsService } from '../../drafts/service.ts';
import { composeDocument, type EditFormFields } from './form.ts';
import { mapIssuesToForm, type FormFeedback } from './errors.ts';

/**
 * S4-T3 编辑表单提交占位调用面（S3-T7 发布组件唯一消费入口；HTTP 路由接线
 * 属 S4-T7——本模块即「表单校验→发布组件调用」的最小闭环）：
 *
 * - 表单字段 → composeDocument 组装全文（含 frontmatter）→ 以单文件 upsert
 *   变更走 publishWebSubmit 完整检查链（候选→审计→授权→分支规则→校验→
 *   base-commit→执行点→update-ref→settle）。
 * - 校验单一来源：不在本模块另设校验，错误全部取自组件 validation 阶段报告
 *   （scope=web-submit，rulesVersion 同报告——D7），仅做表单字段映射。
 * - 校验拒绝（stage='validation'）与成功（可含 W 级警告）均附表单映射；
 *   其他阶段拒绝（授权/base-commit/维护等）映射为 null——表单只呈现组件
 *   的 reason（T7 接线时转 HTTP 语义）。
 * - S4-T6 草稿状态流转挂点：published 后把提交者本人在该路径的现行草稿标
 *   已提交（架构 §6「发布后清理或标为已提交」——标记路径，行保留可追溯；
 *   仅本人草稿：他人草稿按作者私有不受影响，留待其 base 过时的 T7 冲突面）。
 *   拒绝（任何阶段）不动草稿——S3-T7 DraftPreserved「不发布、保留草稿」的
 *   存储侧对应（草稿保持 active 可恢复）。
 */

export interface EditSubmitInput {
  readonly db: DatabaseSync;
  readonly dataDir: string;
  readonly subject: { readonly employeeId: number; readonly carrierRef: string };
  readonly vaultSlug: string;
  readonly branch: string;
  readonly path: string;
  readonly fields: EditFormFields;
  readonly body: string;
  readonly baseCommit: string | null;
  readonly message?: string;
  readonly identity: CommitIdentity;
  readonly committedAt?: string;
  readonly occurredAt?: string;
}

export interface EditSubmitOutcome {
  /** S3-T7 组件结果原样透传（T7 接线消费；含拒绝阶段与草稿保留语义） */
  readonly publish: PublishResult;
  /** 校验阶段拒绝/成功含警告时的表单映射；其他阶段 null */
  readonly form: FormFeedback | null;
}

/** 报告中本路径文件的 issue（表单单文件编辑——只映射自己的文件） */
function issuesForPath(report: Report, path: string): readonly Issue[] {
  return report.files.find((x) => x.path === path)?.issues ?? [];
}

export async function submitEditForm(input: EditSubmitInput): Promise<EditSubmitOutcome> {
  const composed = composeDocument(input.fields, input.body);
  const publish = await publishWebSubmit({
    db: input.db,
    dataDir: input.dataDir,
    subject: input.subject,
    vaultSlug: input.vaultSlug,
    branch: input.branch,
    baseCommit: input.baseCommit,
    changes: [{ kind: 'upsert', path: input.path, mode: '100644', content: composed.text }],
    message: input.message ?? `Web 编辑：${input.path}`,
    identity: input.identity,
    ...(input.committedAt !== undefined ? { committedAt: input.committedAt } : {}),
    ...(input.occurredAt !== undefined ? { occurredAt: input.occurredAt } : {}),
  });

  if (publish.kind === 'rejected') {
    if (publish.stage === 'validation' && publish.report !== undefined) {
      return { publish, form: mapIssuesToForm(issuesForPath(publish.report, input.path), composed) };
    }
    return { publish, form: null };
  }
  // published：报告 result='pass' 可含 W 级警告（温和提示不阻断）。
  // 草稿标已提交（S4-T6 挂点，见模块头注）：发布已成功（ref 已前进）——标记
  // 失败不回滚发布也不虚假报错，草稿保持 active 由作者再提交（markCommitted
  // 对无草稿/已提交行本就幂等）。
  try {
    new DraftsService({ db: input.db }).markCommitted(
      input.vaultSlug,
      input.subject.employeeId,
      input.path,
      input.committedAt,
    );
  } catch {
    // 发布结果以组件为准；草稿标记属可恢复的一致性尾差（不吞没发布事实）
  }
  return { publish, form: mapIssuesToForm(issuesForPath(publish.report, input.path), composed) };
}
