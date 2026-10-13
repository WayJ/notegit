import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rulesVersion } from 'notegit-validation';
import { browseHarness, seededVault, addEmployee, addMember, gitOut, repoPathOf, type BrowseHarness } from './web-browse-fixtures.ts';

// S4-T8 web-submit 失败响应与契约示例同构断言（breakdown §2.3 S4-T8 完成标准三：
// 「web-submit 失败响应形状与 examples/report-web-submit-draft-rejected.json 一致
// （schema 校验）」；S4 plan 验收场景 S1 收口）。
//
// 同构 = 三层断言：
// 1. schema 校验：422 响应体过 docs/contracts/schemas/validation-report.schema.json
//    （本文件自带该 schema 所用特性子集的校验器——不引新依赖）；
// 2. 示例同构：响应体的字段词汇与示例一致（示例呈现的每个节点键都在响应中、
//    响应顶层不携带示例词汇之外的信封字段）；
// 3. 语义锚：scope=web-submit、result↔exitCode 映射、README exempt、E-FM-001
//    issue 四元组（severity/code/rule/message）、rulesVersion 与包内一致。
// 阴性对照（非空验证器）：示例本身过 schema；被破坏的报告被拒。

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(here, '..', '..', 'docs', 'contracts', 'schemas', 'validation-report.schema.json');
const EXAMPLE_PATH = path.join(here, '..', '..', 'docs', 'contracts', 'examples', 'report-web-submit-draft-rejected.json');

type Schema = Record<string, unknown>;

/** JSON Schema 2020-12 特性子集校验器（本仓库 schema 实际用到的全部特性）——
 *  返回全部违规（空数组=通过）。不支持特性直接抛错（宁可炸不静默放行）。 */
function validateSchema(instance: unknown, schema: Schema, root: Schema, at: string): string[] {
  const errs: string[] = [];
  if ('$ref' in schema) {
    const ref = schema['$ref'] as string;
    assert.ok(ref.startsWith('#/$defs/'), `不支持的外部 ref：${ref}`);
    return validateSchema(instance, (root['$defs'] as Record<string, Schema>)[ref.slice('#/$defs/'.length)]!, root, at);
  }
  if ('allOf' in schema) {
    for (const sub of schema['allOf'] as Schema[]) errs.push(...validateSchema(instance, sub, root, at));
  }
  if ('if' in schema && !validateSchema(instance, schema['if'] as Schema, root, at).length) {
    if ('then' in schema) errs.push(...validateSchema(instance, schema['then'] as Schema, root, at));
  }
  if ('type' in schema) {
    const types = Array.isArray(schema['type']) ? (schema['type'] as string[]) : [schema['type'] as string];
    const ok =
      types.some((t) =>
        t === 'object' ? typeof instance === 'object' && instance !== null && !Array.isArray(instance)
        : t === 'array' ? Array.isArray(instance)
        : t === 'integer' ? typeof instance === 'number' && Number.isInteger(instance)
        : t === 'null' ? instance === null
        : typeof instance === t,
      );
    if (!ok) return [...errs, `${at}：类型应为 ${types.join('|')}，实际 ${Array.isArray(instance) ? 'array' : String(instance)}（${typeof instance}）`];
  }
  if ('const' in schema && instance !== schema['const']) errs.push(`${at}：const 应为 ${JSON.stringify(schema['const'])}，实际 ${JSON.stringify(instance)}`);
  if ('enum' in schema && !(schema['enum'] as unknown[]).includes(instance)) {
    errs.push(`${at}：enum 取值 ${JSON.stringify(instance)} 不在 ${JSON.stringify(schema['enum'])}`);
  }
  if (typeof instance === 'string') {
    if ('pattern' in schema && !new RegExp(schema['pattern'] as string).test(instance)) {
      errs.push(`${at}：pattern 不匹配 ${schema['pattern']}（${instance}）`);
    }
    if ('minLength' in schema && instance.length < (schema['minLength'] as number)) {
      errs.push(`${at}：短于 minLength ${schema['minLength']}`);
    }
  }
  if (typeof instance === 'number' && 'minimum' in schema && instance < (schema['minimum'] as number)) {
    errs.push(`${at}：小于 minimum ${schema['minimum']}`);
  }
  if (Array.isArray(instance) && 'items' in schema) {
    instance.forEach((el, i) => errs.push(...validateSchema(el, schema['items'] as Schema, root, `${at}[${i}]`)));
  }
  if (typeof instance === 'object' && instance !== null && !Array.isArray(instance)) {
    const props = (schema['properties'] ?? {}) as Record<string, Schema>;
    for (const key of (schema['required'] as string[] | undefined) ?? []) {
      if (!(key in instance)) errs.push(`${at}：缺必填键 ${key}`);
    }
    for (const [key, val] of Object.entries(instance)) {
      if (key in props) errs.push(...validateSchema(val, props[key]!, root, `${at}.${key}`));
    }
  }
  return errs;
}

/** 形状同构（示例 → 实际）：示例呈现的每个键在实际对应节点存在且类型一致（数组
 *  逐元素、对象递归；null 视为存在即可——示例无 null 值节点）。 */
function assertShapeIsomorphic(example: unknown, actual: unknown, at: string): void {
  if (Array.isArray(example)) {
    assert.ok(Array.isArray(actual), `${at}：示例为数组，实际不是`);
    for (let i = 0; i < example.length; i++) assertShapeIsomorphic(example[i]!, (actual as unknown[])[i]!, `${at}[${i}]`);
    return;
  }
  if (typeof example === 'object' && example !== null) {
    assert.ok(typeof actual === 'object' && actual !== null && !Array.isArray(actual), `${at}：示例为对象，实际不是`);
    for (const [key, val] of Object.entries(example)) {
      assert.ok(key in (actual as object), `${at}：缺示例呈现的键 ${key}`);
      assertShapeIsomorphic(val, (actual as Record<string, unknown>)[key], `${at}.${key}`);
    }
    return;
  }
  assert.equal(typeof actual, typeof example, `${at}：类型应与示例一致（${typeof example}）`);
}

test('同构断言基础：契约示例本身通过 schema（校验器非空转 + 示例合法）', async () => {
  const schema = JSON.parse(await readFile(SCHEMA_PATH, 'utf8')) as Schema;
  const example = JSON.parse(await readFile(EXAMPLE_PATH, 'utf8')) as unknown;
  const errs = validateSchema(example, schema, schema, '$');
  assert.deepEqual(errs, [], '示例应通过 schema 校验');
});

test('同构断言基础：被破坏的报告被校验器拒绝（阴性对照——断言有牙）', async () => {
  const schema = JSON.parse(await readFile(SCHEMA_PATH, 'utf8')) as Schema;
  const example = JSON.parse(await readFile(EXAMPLE_PATH, 'utf8')) as Record<string, unknown>;
  // 破坏 1：issue 缺 rule（必填）
  const broken1 = structuredClone(example) as Record<string, unknown>;
  const files = broken1['files'] as { issues: Record<string, unknown>[] }[];
  delete files[1]!['issues'][0]!['rule'];
  assert.ok(validateSchema(broken1, schema, schema, '$').some((e) => e.includes('rule')), '缺 rule 应被拒');
  // 破坏 2：result=fail 但 exitCode=0（if/then 映射锁定）
  const broken2 = structuredClone(example) as Record<string, unknown>;
  broken2['exitCode'] = 0;
  assert.ok(validateSchema(broken2, schema, schema, '$').some((e) => e.includes('const')), 'exitCode 与 result 映射应被锁定');
  // 破坏 3：错误码形状不符注册表 pattern
  const broken3 = structuredClone(example) as Record<string, unknown>;
  ((broken3['files'] as { issues: Record<string, unknown>[] }[])[1]!['issues'][0]!['code'] = 'XX-1');
  assert.ok(validateSchema(broken3, schema, schema, '$').some((e) => e.includes('pattern')), '码形应被 pattern 拒');
});

test('web-submit 失败响应：422 报告过 schema + 与契约示例同构 + 语义锚', async () => {
  const schema = JSON.parse(await readFile(SCHEMA_PATH, 'utf8')) as Schema;
  const example = JSON.parse(await readFile(EXAMPLE_PATH, 'utf8')) as Record<string, unknown>;
  const { $comment: _drop, ...exampleShape } = example; // $comment 为文档注记，不入形状

  const h = await browseHarness();
  try {
    const alice = addEmployee(h.db, { username: 'alice' });
    const vaultId = await seededVault(h, 'iso', alice, {
      'README.md': '# 导航\n',
      'docs/finance/policy.md': '---\ntitle: 现行政策\n---\n\n正文。\n',
    });
    addMember(h.db, vaultId, alice, 'editor', alice);
    const repoPath = repoPathOf(h, vaultId);
    const head = (await gitOut(['--git-dir', repoPath, 'rev-parse', 'refs/heads/main'])).trim();

    // 与示例同构的失败提交：README upsert（pass、exempt）+ 无 frontmatter 的
    // .md upsert（fail、E-FM-001）——示例 6/6 的可复现形态
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/vaults/iso/submissions',
      headers: { 'content-type': 'application/json', origin: 'http://localhost', ...h.session(alice) },
      payload: {
        base_commit: head,
        message: '同构样例',
        changes: [
          { path: 'README.md', content: '# 导航（更新）\n' },
          { path: 'docs/finance/new-policy.md', content: '新政策正文（缺 frontmatter）。\n' },
        ],
      },
    });
    assert.equal(res.statusCode, 422, res.body);
    const report = res.json() as Record<string, unknown>;

    // 1. schema 校验
    const errs = validateSchema(report, schema, schema, '$');
    assert.deepEqual(errs, [], `422 报告应过 schema：${errs.join('；')}`);

    // 2. 示例同构：示例呈现的键全部在；顶层词汇不超出示例（无信封包裹/私加字段）
    assertShapeIsomorphic(exampleShape, report, '$');
    assert.deepEqual(
      Object.keys(report).sort(),
      Object.keys(exampleShape).sort(),
      '顶层键集应与示例一致（同构——不携带示例外的信封字段）',
    );

    // 3. 语义锚
    assert.equal(report['scope'], 'web-submit');
    assert.equal(report['result'], 'fail');
    assert.equal(report['exitCode'], 1);
    assert.equal(report['rulesVersion'], rulesVersion(), 'rulesVersion 与单一机器来源一致');
    assert.equal(report['vaultId'], String(vaultId));
    assert.match(String(report['commit']), /^[0-9a-f]{40,64}$/, '候选 commit OID');
    const files = report['files'] as { path: string; status: string; exempt?: boolean; issues: Record<string, unknown>[] }[];
    const readme = files.find((x) => x.path === 'README.md')!;
    const bad = files.find((x) => x.path === 'docs/finance/new-policy.md')!;
    assert.equal(readme.status, 'pass');
    assert.equal(readme.exempt, true, 'README 以 exempt=true 标注（示例同款）');
    assert.deepEqual(Object.keys(readme).sort(), ['exempt', 'issues', 'path', 'status']);
    assert.equal(bad.status, 'fail');
    assert.equal(bad.exempt, undefined);
    const issue = bad.issues.find((x) => x['code'] === 'E-FM-001')!;
    assert.equal(issue['severity'], 'error');
    assert.equal(issue['rule'], 'frontmatter.missing');
    assert.equal(typeof issue['message'], 'string');
    const summary = report['summary'] as Record<string, number>;
    assert.equal(summary['filesTotal'], 2);
    assert.equal(summary['filesPassed'], 1);
    assert.equal(summary['filesFailed'], 1);
    assert.equal(summary['errorCount'], 1);
    assert.equal(summary['warningCount'], 0);
    assert.equal(report['refs'], undefined, 'web-submit 无 refs（示例同款——非 push 场景）');
  } finally {
    await h.close();
  }
});
