import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultConfig, withOverrides, globMatch } from '../src/config.ts'
import { readContractJson } from './helpers/contracts.ts'

test('defaultConfig() 与 validation-defaults.json 全键一致（运行时读取，D6：不硬编码）', () => {
  const defaults = readContractJson('validation-defaults.json')
  const cfg = defaultConfig()
  assert.equal(cfg.maxDocumentBytes, defaults.adminConfigurable['validation.limits.maxDocumentBytes'].default)
  assert.equal(cfg.maxAttachmentBytes, defaults.adminConfigurable['validation.limits.maxAttachmentBytes'].default)
  assert.deepEqual(cfg.attachmentAllowedExtensions, defaults.adminConfigurable['validation.limits.attachmentAllowedExtensions'].default)
  assert.equal(cfg.maxPushBytes, defaults.adminConfigurable['validation.limits.maxPushBytes'].default)
  assert.equal(cfg.vaultCapacityBytes, defaults.adminConfigurable['validation.limits.vaultCapacityBytes'].default)
  assert.deepEqual(cfg.additionalNavPatterns, defaults.adminConfigurable['validation.exemptions.additionalNavPatterns'].default)
  assert.deepEqual(cfg.specialFilePatterns, defaults.adminConfigurable['validation.exemptions.specialFilePatterns'].default)
  assert.equal(cfg.validationTimeoutMs, defaults.runtime['validation.runtime.validationTimeoutMs'].default)
  assert.equal(cfg.maxConcurrentValidations, defaults.runtime['validation.runtime.maxConcurrentValidations'].default)
  assert.equal(cfg.maxValidationMemoryMb, defaults.runtime['validation.runtime.maxValidationMemoryMb'].default)
})

test('defaultConfig() 每次返回独立副本（防调用方污染默认值）', () => {
  const a = defaultConfig()
  a.attachmentAllowedExtensions.push('.svg')
  assert.deepEqual(defaultConfig().attachmentAllowedExtensions, ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf'])
})

test('withOverrides：仅覆盖给定键，其余保持默认', () => {
  const cfg = withOverrides(defaultConfig(), { maxDocumentBytes: 100 })
  assert.equal(cfg.maxDocumentBytes, 100)
  assert.equal(cfg.maxPushBytes, defaultConfig().maxPushBytes)
  const cfg2 = withOverrides(cfg, { attachmentAllowedExtensions: ['.png'] })
  assert.deepEqual(cfg2.attachmentAllowedExtensions, ['.png'])
  assert.equal(cfg2.maxDocumentBytes, 100)
})

test('globMatch：* 单段、** 跨段、? 单字符、字面量精确', () => {
  assert.equal(globMatch('.gitignore', '.gitignore'), true)
  assert.equal(globMatch('.gitignore', 'docs/.gitignore'), false)
  assert.equal(globMatch('AGENTS.md', 'agents.md'), false, '模式匹配大小写敏感（仅 README 判定不敏感）')
  assert.equal(globMatch('*.draft.md', 'a.draft.md'), true)
  assert.equal(globMatch('*.draft.md', 'd/a.draft.md'), false)
  assert.equal(globMatch('docs/**/INDEX.md', 'docs/a/b/INDEX.md'), true)
  assert.equal(globMatch('docs/**/INDEX.md', 'docs/INDEX.md'), true)
  assert.equal(globMatch('**/.editorconfig', 'a/b/.editorconfig'), true)
  assert.equal(globMatch('?.md', 'a.md'), true)
  assert.equal(globMatch('?.md', 'ab.md'), false)
})
