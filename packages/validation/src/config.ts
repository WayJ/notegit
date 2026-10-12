/** 管理员可配置限制与豁免（validation-defaults.json 为默认值唯一机器来源，运行时读取）。 */
import { readContractJson } from './contract.ts'

export interface ValidationConfig {
  maxDocumentBytes: number
  maxAttachmentBytes: number
  attachmentAllowedExtensions: string[]
  maxPushBytes: number
  vaultCapacityBytes: number
  additionalNavPatterns: string[]
  specialFilePatterns: string[]
  validationTimeoutMs: number
  maxConcurrentValidations: number
  maxValidationMemoryMb: number
}

interface DefaultsFile {
  adminConfigurable: Record<string, { default: unknown }>
  runtime: Record<string, { default: unknown }>
}

function readDefaults(): ValidationConfig {
  const d = readContractJson<DefaultsFile>('validation-defaults.json')
  const a = d.adminConfigurable
  const r = d.runtime
  return {
    maxDocumentBytes: a['validation.limits.maxDocumentBytes'].default as number,
    maxAttachmentBytes: a['validation.limits.maxAttachmentBytes'].default as number,
    attachmentAllowedExtensions: [...(a['validation.limits.attachmentAllowedExtensions'].default as string[])],
    maxPushBytes: a['validation.limits.maxPushBytes'].default as number,
    vaultCapacityBytes: a['validation.limits.vaultCapacityBytes'].default as number,
    additionalNavPatterns: [...(a['validation.exemptions.additionalNavPatterns'].default as string[])],
    specialFilePatterns: [...(a['validation.exemptions.specialFilePatterns'].default as string[])],
    validationTimeoutMs: r['validation.runtime.validationTimeoutMs'].default as number,
    maxConcurrentValidations: r['validation.runtime.maxConcurrentValidations'].default as number,
    maxValidationMemoryMb: r['validation.runtime.maxValidationMemoryMb'].default as number,
  }
}

/** 每次返回深拷贝（含数组），调用方可安全改写。 */
export function defaultConfig(): ValidationConfig {
  return readDefaults()
}

export type ConfigOverrides = Partial<Omit<ValidationConfig, 'attachmentAllowedExtensions' | 'additionalNavPatterns' | 'specialFilePatterns'>> & {
  attachmentAllowedExtensions?: string[]
  additionalNavPatterns?: string[]
  specialFilePatterns?: string[]
}

/** 管理员覆盖：仅覆盖给定键；判定型键的接受集变化属部署级偏差，不改变 rulesVersion（validation.md §7.3-4）。 */
export function withOverrides(base: ValidationConfig, overrides: ConfigOverrides): ValidationConfig {
  return { ...base, ...overrides, attachmentAllowedExtensions: [...(overrides.attachmentAllowedExtensions ?? base.attachmentAllowedExtensions)], additionalNavPatterns: [...(overrides.additionalNavPatterns ?? base.additionalNavPatterns)], specialFilePatterns: [...(overrides.specialFilePatterns ?? base.specialFilePatterns)] }
}

/** 最小 glob：`*` 单段内任意、`?` 单字符、`**` 跨段。大小写敏感（仅 README 判定大小写不敏感，validation.md §2-2）。 */
export function globMatch(pattern: string, path: string): boolean {
  const pSegs = pattern.split('/')
  const fSegs = path.split('/')
  const matchSegs = (pi: number, fi: number): boolean => {
    if (pi === pSegs.length) return fi === fSegs.length
    if (pSegs[pi] === '**') {
      for (let k = fi; k <= fSegs.length; k++) if (matchSegs(pi + 1, k)) return true
      return false
    }
    if (fi >= fSegs.length) return false
    return segRegex(pSegs[pi]).test(fSegs[fi]) && matchSegs(pi + 1, fi + 1)
  }
  return matchSegs(0, 0)
}

function segRegex(seg: string): RegExp {
  let re = ''
  for (const ch of seg) {
    if (ch === '*') re += '[^/]*'
    else if (ch === '?') re += '[^/]'
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`, 'u')
}
