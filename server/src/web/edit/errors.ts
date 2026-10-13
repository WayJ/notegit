import type { Issue } from 'notegit-validation';
import { SIX_FIELD_KEYS, type ComposedDocument, type SixFieldKey } from './form.ts';

/**
 * S4-T3 表单错误映射（validation.md §6.2 定位字段 → 表单呈现）：
 *
 * - 六字段 issue（issue.field ∈ 六字段）→ 该字段的行内错误（E-FM-003/004/005/009）。
 * - 文档级 issue（E-FM-001/002/006/007/008——无 field）落在 extra 块行区间内时
 *   → extra 文本区（附区内 1 起始行号），否则 → general（表单顶部）。
 * - warning（W-FM-101 等）→ 温和提示区，不计入 blocked（架构 §5.3：提示但允许）。
 * - 行号语义 = 知识文档内 1 起始行号（§6.2），原样透传不做换算。
 */

export type FormFieldKey = SixFieldKey | 'extra';

export interface FormIssue {
  readonly code: string;
  readonly message: string;
  /** 文档行号（契约 §6.2 行号语义，原样透传） */
  readonly line?: number;
  /** extra 文本区内 1 起始行号（定位展示用） */
  readonly extraLine?: number;
}

export interface FormFeedback {
  /** 任一 error 级 ⇒ true（W 级不阻断） */
  readonly blocked: boolean;
  readonly byField: Readonly<Partial<Record<FormFieldKey, readonly FormIssue[]>>>;
  readonly general: readonly FormIssue[];
  readonly warnings: readonly FormIssue[];
}

/** 解析层错误码族（E-FM-002/006/007/008）：六字段经 JSON 序列化不可能产生，
 *  存在 extra 时因果上必属 extra 区（yaml 库行号可能指向区块开头而非肇事行） */
const PARSE_LEVEL_CODES = new Set(['E-FM-002', 'E-FM-006', 'E-FM-007', 'E-FM-008']);

function toFormIssue(issue: Issue): FormIssue {
  return { code: issue.code, message: issue.message, ...(issue.line !== undefined ? { line: issue.line } : {}) };
}

export function mapIssuesToForm(
  issues: readonly Issue[],
  layout: Pick<ComposedDocument, 'extraStartLine' | 'extraLineCount'>,
): FormFeedback {
  const six = new Set<string>(SIX_FIELD_KEYS);
  const byField: Partial<Record<FormFieldKey, FormIssue[]>> = {};
  const general: FormIssue[] = [];
  const warnings: FormIssue[] = [];
  let blocked = false;

  for (const issue of issues) {
    if (issue.severity === 'warning') {
      warnings.push(toFormIssue(issue));
      continue;
    }
    if (issue.severity === 'error') blocked = true;
    if (issue.field !== undefined && six.has(issue.field)) {
      (byField[issue.field as SixFieldKey] ??= []).push(toFormIssue(issue));
      continue;
    }
    const { extraStartLine, extraLineCount } = layout;
    const inExtraRegion =
      extraStartLine !== null &&
      issue.line !== undefined &&
      issue.line >= extraStartLine &&
      issue.line < extraStartLine + extraLineCount;
    if (extraLineCount > 0 && (inExtraRegion || PARSE_LEVEL_CODES.has(issue.code))) {
      ((byField.extra ??= []) as FormIssue[]).push({
        ...toFormIssue(issue),
        ...(inExtraRegion && issue.line !== undefined && extraStartLine !== null
          ? { extraLine: issue.line - extraStartLine + 1 }
          : {}),
      });
      continue;
    }
    general.push(toFormIssue(issue));
  }

  return { blocked, byField, general, warnings };
}
