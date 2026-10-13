import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeDocument, parseDocForForm, titleFromFilename, type EditFormFields } from '../src/web/edit/form.ts';

// S4-T3 表单字段模型单元测试：组装确定性布局（错误行映射依赖）、从文件名生成
// title、既有文档 → 表单回填解析（best-effort：校验权威在发布组件，这里只为
// 回填展示——六字段进表单、其余键原样进 extra 文本区、正文进 textarea）。

const EMPTY: EditFormFields = { title: '', owner: '', description: '', tags: '', status: '', source: '', extra: '' };

// ── 组装：确定性布局 ────────────────────────────────────────────────────────

test('组装布局：空白字段整行省略，六字段自第 2 行定序，JSON 流式标量', () => {
  const doc = composeDocument(
    { ...EMPTY, title: 'T', description: 'D', source: 'S' },
    '正文',
  );
  assert.equal(doc.text, '---\ntitle: "T"\ndescription: "D"\nsource: "S"\n---\n正文');
  assert.equal(doc.extraStartLine, null);
  assert.equal(doc.extraLineCount, 0);
});

test('组装布局：tags 逗号输入 → JSON 数组；extra 原样附后且行定位正确', () => {
  const doc = composeDocument(
    { ...EMPTY, title: 'T', tags: '人事, 报销,,', status: 'draft', extra: 'department: 财务部\nreviewers: [a, b]' },
    'B',
  );
  assert.equal(doc.text, '---\ntitle: "T"\ntags: ["人事","报销"]\nstatus: "draft"\ndepartment: 财务部\nreviewers: [a, b]\n---\nB');
  assert.equal(doc.extraStartLine, 5, '六字段占 3 行（title/tags/status）→ extra 自第 5 行');
  assert.equal(doc.extraLineCount, 2);
});

test('组装布局：含特殊字符字段值 JSON 转义（YAML 双引号子集，防注入）', () => {
  const doc = composeDocument({ ...EMPTY, title: 'a: *anchor #comment\n"quoted"' }, '');
  assert.equal(doc.text, '---\ntitle: "a: *anchor #comment\\n\\"quoted\\""\n---\n');
});

test('组装布局：extra 首尾空白行剪除、内部缩进保留', () => {
  const doc = composeDocument({ ...EMPTY, title: 'T', extra: '\n\nkey:\n  - x\n\n' }, '');
  assert.equal(doc.text, '---\ntitle: "T"\nkey:\n  - x\n---\n');
  assert.equal(doc.extraStartLine, 3);
  assert.equal(doc.extraLineCount, 2);
});

// ── titleFromFilename（架构 §5.1：新建时从文件名生成，提交前可改） ────────

test('titleFromFilename：去 .md 扩展名；不改写内容；无扩展名原样', () => {
  assert.equal(titleFromFilename('docs/差旅报销.md'), '差旅报销');
  assert.equal(titleFromFilename('notes/README.md'), 'README');
  assert.equal(titleFromFilename('a/b/notes.txt'), 'notes.txt');
  assert.equal(titleFromFilename('plain'), 'plain');
});

// ── 回填解析：既有文档 → 表单 ──────────────────────────────────────────────

test('回填：六字段（流式列表/带引号标量）进表单，其余键原样进 extra，正文切出', () => {
  const text = [
    '---',
    'title: "差旅报销制度"',
    'owner: zhangsan',
    'tags: [人事, 报销]',
    'status: draft',
    'department: 财务部',
    'reviewers:',
    '  - a',
    '  - b',
    '---',
    '',
    '# 差旅报销制度',
    '正文。',
  ].join('\n');
  const p = parseDocForForm(text);
  assert.equal(p.fields.title, '差旅报销制度');
  assert.equal(p.fields.owner, 'zhangsan');
  assert.equal(p.fields.tags, '人事, 报销');
  assert.equal(p.fields.status, 'draft');
  assert.equal(p.fields.description, '');
  assert.equal(p.fields.source, '');
  assert.equal(p.extra, 'department: 财务部\nreviewers:\n  - a\n  - b');
  assert.equal(p.body, '\n# 差旅报销制度\n正文。');
});

test('回填：块式 tags 列表 → 逗号输入形态', () => {
  const text = '---\ntitle: T\ntags:\n  - a\n  - b\n---\nB';
  const p = parseDocForForm(text);
  assert.equal(p.fields.tags, 'a, b');
  assert.equal(p.extra, '');
});

test('回填：无 frontmatter（README/旧文档）→ 表单全空、正文=全文', () => {
  const p = parseDocForForm('# 导航\n内容');
  assert.deepEqual(p.fields, { title: '', owner: '', description: '', tags: '', status: '', source: '' });
  assert.equal(p.extra, '');
  assert.equal(p.body, '# 导航\n内容');
});

test('回填：单引号与裸标量都能取值（best-effort，不设第二套校验）', () => {
  const p = parseDocForForm("---\ntitle: '单引'\nowner: bare\n---\nX");
  assert.equal(p.fields.title, '单引');
  assert.equal(p.fields.owner, 'bare');
});
