import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stringify } from 'yaml'
import { validate } from '../src/validate.ts'
import type { FileInput, ValidateInput } from '../src/validate.ts'
import { validateKnowledgeDoc } from '../src/frontmatter.ts'
import { schemaCheck } from './helpers/schema-check.ts'
import { contractsDir, readContractJson } from './helpers/contracts.ts'

/**
 * docs/contracts/examples/ 7 份示例逐份复现（S3-T3 验收基准）。
 * 对比口径：剥离 $comment 与 message（示例消息为人工润色文案，注册表模板见 §6.2——由
 * registry.test.ts 与契约表交叉核对）；其余字段（rulesVersion/scope/result/exitCode/
 * summary/refs/files 与 issue 定位字段）全等。每份产出报告同时过内嵌 schema 校验。
 */

const reportSchema = JSON.parse(readFileSync(new URL('schemas/validation-report.schema.json', contractsDir), 'utf8'))

function example(name: string): any {
  return JSON.parse(readFileSync(new URL(`examples/${name}`, contractsDir), 'utf8'))
}

/** 剥离 $comment 与 message 后的规范形（用于与实现产出全等比较）。 */
function normalize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalize)
  if (node !== null && typeof node === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === '$comment' || k === 'message') continue
      out[k] = normalize(v)
    }
    return out
  }
  return node
}

function doc(fm: string, body = '\n正文。\n'): string {
  return `---\n${fm}---\n${body}`
}

const FULL_FM = 'title: 差旅报销制度\nowner: zhangsan\ndescription: 摘要\nsource: 财务部\n'
const f = (path: string, content: string | Uint8Array = doc(FULL_FM), mode = '100644'): FileInput => ({ path, mode, content })

async function reproduce(name: string, input: ValidateInput) {
  const expected = normalize(example(name))
  const produced = await validate(input)
  assert.deepEqual(schemaCheck(reportSchema, produced), [], `${name}: 产出报告须过 schema`)
  assert.deepEqual(normalize(JSON.parse(JSON.stringify(produced))), expected, name)
  return produced
}

test('示例 1/7 report-pass-with-warnings：pre-commit 通过含警告', async () => {
  const onboarding =
    '---\ntitle: 入职指南\ndescription: 流程\nsource: HR\n---\n' +
    Array.from({ length: 8 }, (_, i) => `第${i + 1}行`).join('\n') +
    '\n详见[请假政策](policy/leave.md)。\n'
  await reproduce('report-pass-with-warnings.json', {
    scope: 'pre-commit',
    files: [f('docs/travel/reimburse.md'), f('docs/hr/onboarding.md', onboarding)],
  })
})

test('示例 2/7 report-field-errors-partial：pre-commit 同批 1 过 1 败', async () => {
  const forecast = '---\nowner: zhangsan\ndescription: 预测\nsource: 财务\n---\n\n正文\n'
  await reproduce('report-field-errors-partial.json', {
    scope: 'pre-commit',
    files: [f('docs/finance/report-q3.md'), f('docs/finance/forecast.md', forecast)],
  })
})

test('示例 3/7 report-dangerous-tree：pre-receive 拒危险 tree（symlink+gitlink，逐提交归因）', async () => {
  await reproduce('report-dangerous-tree.json', {
    scope: 'pre-receive',
    vaultId: 'vault-013',
    refs: [
      {
        ref: 'refs/heads/main',
        headOld: '5c3f1a2bd8e94f07c1a6b2d3e4f5a6b7c8d9e0f1',
        headNew: '9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b',
        commits: [
          { commit: '8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9a', parent: '5c3f1a2bd8e94f07c1a6b2d3e4f5a6b7c8d9e0f1', changes: [f('docs/finance/evil-link', new TextEncoder().encode('/etc/passwd'), '120000')] },
          {
            commit: '9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b',
            parent: '8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9a',
            changes: [f('vendor/lib', new Uint8Array(0), '160000'), f('docs/finance/notes.md')],
          },
        ],
      },
    ],
  })
})

test('示例 4/7 report-push-multiref：多 ref 全拒 + N-UPGRADE-001 + E-LIMIT-001', async () => {
  const head = '---\ntitle: t\nowner: o\ndescription: d\nsource: s\n---\n\n'
  const deck = head + 'x'.repeat(2097152 - Buffer.byteLength(head, 'utf8'))
  assert.equal(Buffer.byteLength(deck, 'utf8'), 2097152)
  const featureCommits = Array.from({ length: 3 }, (_, i) => ({
    commit: `feat-${i}`,
    parent: i === 0 ? 'aabbccddeeff0011223344556677889900112233' : `feat-${i - 1}`,
    changes: [] as FileInput[],
  }))
  await reproduce('report-push-multiref.json', {
    scope: 'pre-receive',
    vaultId: 'vault-013',
    clientRulesVersion: '0.9.0',
    refs: [
      {
        ref: 'refs/heads/main',
        headOld: '5c3f1a2bd8e94f07c1a6b2d3e4f5a6b7c8d9e0f1',
        headNew: '1f2e3d4c5b6a798877665544332211ffeeddccbba',
        commits: [{ commit: '1f2e3d4c5b6a798877665544332211ffeeddccbba', parent: '5c3f1a2bd8e94f07c1a6b2d3e4f5a6b7c8d9e0f1', changes: [f('docs/travel/policy/deck.md', deck), f('docs/travel/policy/intro.md')] }],
      },
      { ref: 'refs/heads/feature/travel-policy', headOld: 'aabbccddeeff0011223344556677889900112233', headNew: '998877665544332211ffeeddccbbaa9988776655', commits: featureCommits },
    ],
  })
})

test('示例 5/7 report-runtime-error：校验超时 → error/exit 2、refs 全拒、files 空', async () => {
  let t = 0
  const clock = () => (t === 0 ? (t = 1000) : 21000)
  const commits = Array.from({ length: 120 }, (_, i) => ({
    commit: `c${i}`,
    parent: i === 0 ? '5c3f1a2bd8e94f07c1a6b2d3e4f5a6b7c8d9e0f1' : `c${i - 1}`,
    changes: [] as FileInput[],
  }))
  await reproduce('report-runtime-error.json', {
    scope: 'pre-receive',
    vaultId: 'vault-013',
    clock,
    refs: [{ ref: 'refs/heads/main', headOld: '5c3f1a2bd8e94f07c1a6b2d3e4f5a6b7c8d9e0f1', headNew: '1234567890abcdef1234567890abcdef12345678', commits }],
  })
})

test('示例 6/7 report-web-submit-draft-rejected：web-submit 失败不发布、README exempt', async () => {
  await reproduce('report-web-submit-draft-rejected.json', {
    scope: 'web-submit',
    vaultId: 'vault-013',
    commit: '7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d',
    files: [f('README.md', '# 知识库导航\n'), f('docs/finance/new-policy.md', '# 新政策\n无 frontmarker\n')],
  })
})

test('示例 7/7 frontmatter-cases.json：全部用例按 expect 复现（object 经 YAML 化走全链路，raw 直灌）', () => {
  const cases = readContractJson('examples/frontmatter-cases.json').cases as Array<{
    name: string
    kind: string
    expect: string
    expectedCodes: string[]
    frontmatter: unknown
  }>
  assert.equal(cases.length, 15)
  for (const c of cases) {
    if (c.name.startsWith('raw-oversized')) continue // 生成用例在 frontmatter.test.ts 覆盖（契约注记）
    const text = c.kind === 'object' ? doc(`${stringify(c.frontmatter as Record<string, unknown>)}`) : doc(c.frontmatter as string)
    const got = validateKnowledgeDoc('docs/t/x.md', text)
      .filter((i) => i.severity === 'error')
      .map((i) => i.code)
      .sort()
    assert.deepEqual(got, [...c.expectedCodes].sort(), c.name)
  }
})
