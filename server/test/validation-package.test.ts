import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { validate, rulesVersion, ERROR_REGISTRY } from 'notegit-validation'

/**
 * 构建断言（sprint S3 D7 / breakdown S3-T3）：server 从 workspace 包 notegit-validation
 * 取校验定义（本测试的 import 即断言——包不可解析则编译失败）；rulesVersion 与契约
 * manifest 一致（运行时读文件比对，D6：不硬编码版本号）。
 */

const manifest = JSON.parse(
  readFileSync(new URL('../../docs/contracts/rules-version.json', import.meta.url), 'utf8'),
) as { rulesVersion: string }

test('server 消费 notegit-validation：rulesVersion 与 docs/contracts/rules-version.json 一致', () => {
  assert.equal(rulesVersion(), manifest.rulesVersion)
})

test('server 消费 notegit-validation：错误码注册表完整可用（24 码契约化身）', () => {
  assert.equal(ERROR_REGISTRY.length, 24)
  assert.ok(ERROR_REGISTRY.some((e) => e.code === 'E-RUN-001'))
})

test('server 消费 notegit-validation：validate 端到端冒烟（合规文档 → pass/0）', async () => {
  const report = await validate({
    scope: 'web-submit',
    vaultId: 'vault-smoke',
    commit: 'c0ffee',
    files: [
      { path: 'README.md', mode: '100644', content: '# 导航\n' },
      { path: 'docs/a.md', mode: '100644', content: '---\ntitle: t\nowner: o\ndescription: d\nsource: s\n---\n\nx\n' },
    ],
  })
  assert.equal(report.result, 'pass')
  assert.equal(report.exitCode, 0)
  assert.equal(report.rulesVersion, manifest.rulesVersion)
  assert.equal(report.files[0].exempt, true)
})
