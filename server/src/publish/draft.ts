import type { Report } from 'notegit-validation';
import type { WebSubmitChange } from './candidate.ts';

/**
 * 草稿保留语义（S3-T7 定义接口与语义；存储本体属 S4——validation 示例
 * report-web-submit-draft-rejected.json 的「不发布、保留草稿和错误提示」）：
 *
 * - 发布组件不拥有草稿存储：变更清单由调用方（S4）持有，组件只读消费；
 *   任何「不发布」的结果（rejected，无论阶段）都原样回传提交输入，
 *   `preserved: true` 是调用方续存草稿的接口契约——组件侧不存在删除、
 *   覆盖或吞没草稿的路径（结构上无此代码）。
 * - 校验拒绝（stage='validation'）附完整报告：错误提示的单一来源
 * （rulesVersion 同报告，D7 单一来源——S4 不得另行渲染错误集）。
 * - 冲突拒绝（stage='base-commit'）同样保留草稿（DOD-07「冲突草稿保留」：
 *   后提交方被拒、先前提交不被覆盖，草稿待刷新基线后重提）。
 * - `kind: 'published'` 结果不携带草稿：S4 消费成功态后自行删除草稿。
 */
export interface DraftPreserved {
  readonly preserved: true;
  /** 提交时传入的变更清单（逐字回传——不吞没、不改动） */
  readonly changes: readonly WebSubmitChange[];
  /** 提交时的预期旧 commit（刷新基线重提的对照输入） */
  readonly baseCommit: string | null;
  /** 提交的目标分支 */
  readonly branch: string;
  /** 校验拒绝时的完整报告（错误提示来源；其他拒绝阶段缺省） */
  readonly report?: Report;
}
