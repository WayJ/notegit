/** 附件、类型与容量限制（validation.md §5）：逐文件判定 E-LIMIT-001/002/003；push 级判定 E-LIMIT-004/005（问题落 refs 层面）。 */
import type { Issue } from './issue.ts'
import { issueOf } from './registry.ts'
import type { ValidationConfig } from './config.ts'
import type { FileClass } from './paths.ts'

/** 逐文件判定。special 类（specialFilePatterns 命中）契约未定义容量限额，不做判定（任务决策，见 architecture-notes）。 */
export function checkFileLimits(path: string, byteLen: number, cls: FileClass, cfg: ValidationConfig): Issue[] {
  const name = path.split('/').pop() ?? ''
  const lower = name.toLowerCase()
  if (cls === 'knowledge' || cls === 'readme-exempt' || cls === 'nav-exempt') {
    if (byteLen > cfg.maxDocumentBytes) {
      return [
        issueOf('E-LIMIT-001', { path, actual: byteLen, limit: cfg.maxDocumentBytes }, { limitKey: 'validation.limits.maxDocumentBytes' }),
      ]
    }
    return []
  }
  if (cls === 'special') return []
  // attachment：清单制（不在清单即拒绝，§5.2 设计裁决）；扩展名匹配大小写不敏感
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.')) : ''
  if (!cfg.attachmentAllowedExtensions.includes(ext)) {
    return [
      issueOf('E-LIMIT-002', { path, actual: ext === '' ? '（无扩展名）' : ext, expected: cfg.attachmentAllowedExtensions.join(' ') }),
    ]
  }
  if (byteLen > cfg.maxAttachmentBytes) {
    return [
      issueOf('E-LIMIT-003', { path, actual: byteLen, limit: cfg.maxAttachmentBytes }, { limitKey: 'validation.limits.maxAttachmentBytes' }),
    ]
  }
  return []
}

/** push 级判定（E-LIMIT-004/005）：每个受影响 ref 一条 issue（全有或全无由报告 refs 层表达）。 */
export function checkPushLimits(refNames: string[], pushBytes: number, vaultCurrentBytes: number, cfg: ValidationConfig): Issue[] {
  const issues: Issue[] = []
  if (pushBytes > cfg.maxPushBytes) {
    for (const ref of refNames) {
      issues.push(
        issueOf('E-LIMIT-004', { ref, actual: pushBytes, limit: cfg.maxPushBytes }, { ref, limitKey: 'validation.limits.maxPushBytes' }),
      )
    }
  }
  if (vaultCurrentBytes + pushBytes > cfg.vaultCapacityBytes) {
    for (const ref of refNames) {
      issues.push(
        issueOf(
          'E-LIMIT-005',
          { ref, actual: vaultCurrentBytes + pushBytes, limit: cfg.vaultCapacityBytes },
          { ref, limitKey: 'validation.limits.vaultCapacityBytes' },
        ),
      )
    }
  }
  return issues
}
