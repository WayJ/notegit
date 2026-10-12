import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rulesVersion, rulesManifest } from '../src/rules-version.ts'
import { readContractJson } from './helpers/contracts.ts'

test('rulesVersion() 读自 docs/contracts/rules-version.json（唯一机器来源，D6：不硬编码）', () => {
  const manifest = readContractJson('rules-version.json')
  assert.equal(rulesVersion(), manifest.rulesVersion)
  assert.match(rulesVersion(), /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/)
})

test('rulesManifest() 暴露 manifest 全文（status/changelog 随契约演进）', () => {
  const manifest = readContractJson('rules-version.json')
  const m = rulesManifest()
  assert.equal(m.rulesVersion, manifest.rulesVersion)
  assert.equal(m.contract, manifest.contract)
  assert.ok(Array.isArray(m.changelog) && m.changelog.length >= 1)
})
