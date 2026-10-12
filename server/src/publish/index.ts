/**
 * 发布组件公共面（S3-T7；架构 §5.4 第三入口）——S4 Web 发布的消费入口。
 *
 * 值导出仅两件：publishWebSubmit（唯一发布入口——内部为 PUBLISH_STAGES 有序
 * 组件链，结构上不可跳步，见 pipeline.ts）与 PUBLISH_STAGES（链的声明——结构
 * 断言与 S4 进度提示消费）。候选构造（buildCandidateCommit）与 git 执行
 * （execGit）刻意不导出：外部不存在绕过链的「只构造/只更新引用」入口
 * （publish-structure.test.ts 对导出面做结构性断言）。
 */
export { publishWebSubmit, PUBLISH_STAGES } from './pipeline.ts';
export type { PublishWebSubmitInput, PublishResult, PublishedResult, RejectedResult, PublishStage } from './pipeline.ts';
export type { DraftPreserved } from './draft.ts';
export type { WebSubmitChange, WebSubmitUpsert, WebSubmitDelete, CommitIdentity } from './candidate.ts';
