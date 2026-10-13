import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateKnowledgeDoc } from 'notegit-validation';
import { composeDocument, type EditFormFields } from '../src/web/edit/form.ts';
import { mapIssuesToForm } from '../src/web/edit/errors.ts';

// S4-T3 表单错误映射单元测试（validation.md §6.2 定位字段 → 表单呈现）：
// issue 一律来自 validateKnowledgeDoc 对组装文档的真实校验（单一来源——不用
// 手搓 issue 形状），经 mapIssuesToForm 断言分桶：六字段 / extra 区（行定位
// 换算）/ general / warnings（W 级不阻断）。

const EMPTY: EditFormFields = { title: '', owner: '', description: '', tags: '', status: '', source: '', extra: '' };

/** 表单 → 组装 → 真实校验 → 映射（与 submitEditForm 同链，减去发布组件） */
function feedbackOf(fields: EditFormFields, body = '') {
  const composed = composeDocument(fields, body);
  const issues = validateKnowledgeDoc('docs/x.md', composed.text);
  return { composed, feedback: mapIssuesToForm(issues, composed) };
}

test('E-FM-009：title 超长映射 title 字段（含文档行号）', () => {
  const { feedback } = feedbackOf({ ...EMPTY, title: 'x'.repeat(201) });
  const e = (feedback.byField.title ?? []).find((i) => i.code === 'E-FM-009');
  assert.ok(e !== undefined, JSON.stringify(feedback.byField.title));
  assert.equal(e.line, 2, 'title 首行=第 2 行（确定性布局）');
  assert.ok(e.message.includes('200'), '模板含上限值');
});

test('E-FM-007：extra 区不安全构造（锚点）映射 extra 桶并附区内行号', () => {
  const { composed, feedback } = feedbackOf({
    ...EMPTY, title: 'T', extra: 'department: 财务部\nweird: &anchor 1\nreviewers: [a]',
  });
  assert.ok(composed.extraStartLine === 3 && composed.extraLineCount === 3);
  const e = (feedback.byField.extra ?? []).find((i) => i.code === 'E-FM-007');
  assert.ok(e !== undefined, JSON.stringify(feedback.byField.extra));
  assert.equal(e.extraLine, 2, '锚点在 extra 第 2 行 → 区内行号');
  assert.equal(e.line, composed.extraStartLine! + 1, '文档行号原样透传');
});

test('E-FM-006：extra 重复六字段键 → 键名映射六字段桶（重复键=title），行指向 extra 出现行', () => {
  const { feedback } = feedbackOf({ ...EMPTY, title: 'T', extra: 'title: "dup"' });
  // 注册表 E-FM-006 定位带 field=重复键名 → title 桶；行 3 = extra 内出现处
  const e = (feedback.byField.title ?? []).find((i) => i.code === 'E-FM-006');
  assert.ok(e !== undefined, JSON.stringify(feedback.byField.title));
  assert.equal(e.line, 3, '重复键行号指向 extra 内出现处');
  assert.equal(feedback.blocked, true);
});

test('E-FM-006：extra 自重复（非六字段键）→ extra 桶（因果归属——六字段不可能产生解析层错误）', () => {
  const { feedback } = feedbackOf({ ...EMPTY, title: 'T', extra: 'department: a\ndepartment: b' });
  const e = (feedback.byField.extra ?? []).find((i) => i.code === 'E-FM-006');
  assert.ok(e !== undefined, JSON.stringify(feedback.byField.extra));
});

test('E-FM-002：extra 区 YAML 语法错误 → extra 桶（yaml 库行号可能指区块头——区内行号缺省、文档行号保留）', () => {
  const { feedback } = feedbackOf({ ...EMPTY, title: 'T', extra: 'ok: 1\nbad: [unclosed' });
  const e = (feedback.byField.extra ?? []).find((i) => i.code === 'E-FM-002');
  assert.ok(e !== undefined, JSON.stringify(feedback.byField.extra));
  assert.equal(e.extraLine, undefined, '行号不在 extra 区间时不给误导性区内行号');
  assert.ok(e.message.includes('解析失败'));
});

test('E-FM-001：无 frontmatter 语义（空表单组装出空块）→ general 桶缺失 title 主错', () => {
  // 空表单组装 `---\n---\n`：块存在但无键——主错是 E-FM-003（title 缺失）
  const { feedback } = feedbackOf({ ...EMPTY });
  assert.equal(feedback.blocked, true);
  assert.ok((feedback.byField.title ?? []).some((i) => i.code === 'E-FM-003'));
  assert.ok(feedback.general.length === 0, '空块不产生 general 噪音');
});

test('W-FM-101：可选字段缺失进 warnings 桶、不计阻断、附字段提示', () => {
  const { feedback } = feedbackOf({ ...EMPTY, title: 'T' });
  assert.equal(feedback.blocked, false, '仅 W 级 ⇒ 不阻断');
  assert.equal(feedback.warnings.length, 3, 'owner/description/source 各一条');
  assert.ok(feedback.warnings.every((w) => w.code === 'W-FM-101' && w.message.includes('不影响提交')));
});

test('E-FM-008：frontmatter 超资源常量（无行号）→ extra 桶（体量必来自 extra 区）', () => {
  const big = `k: ${'x'.repeat(70_000)}`;
  const { feedback } = feedbackOf({ ...EMPTY, title: 'T', extra: big });
  const e = (feedback.byField.extra ?? []).find((i) => i.code === 'E-FM-008');
  assert.ok(e !== undefined, JSON.stringify(feedback.byField.extra));
  assert.equal(e.line, undefined, '资源级问题无行号（§6.2 语义）');
  assert.equal(e.extraLine, undefined, '无区内行号——不给误导定位');
  assert.equal(feedback.blocked, true);
});

test('映射分桶互斥：字段级多错误并存各归其桶（解析层短路由上例单独覆盖）', () => {
  const { feedback } = feedbackOf({
    ...EMPTY,
    title: 'x'.repeat(201), // E-FM-009（title 桶）
    status: 'weird',        // E-FM-005（status 桶——表单直填非法值，下拉防呆的校验兜底）
  });
  assert.ok((feedback.byField.title ?? []).some((i) => i.code === 'E-FM-009'));
  assert.ok((feedback.byField.status ?? []).some((i) => i.code === 'E-FM-005'), 'status 非法直填也走 E-FM-005');
  assert.ok(feedback.warnings.every((w) => w.code === 'W-FM-101'), 'owner/description/source 缺失仅 W 级');
  assert.equal(feedback.blocked, true);
});
