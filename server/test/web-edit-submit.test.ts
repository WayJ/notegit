import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { browseHarness, seededVault, addMember, gitOut, repoPathOf, type BrowseHarness } from './web-browse-fixtures.ts';
import { submitEditForm } from '../src/web/edit/submit.ts';
import type { EditFormFields } from '../src/web/edit/form.ts';

// S4-T3 提交占位调用面集成测试（breakdown §2.3 S4-T3 行：「表单校验→发布组件
// 调用」最小可用闭环）：表单字段 → 组装文档 → S3-T7 publishWebSubmit（唯一
// 发布入口）→ 校验报告 issue 映射为表单字段定位（E-FM 码 + 行）。校验单一来
// 源 = 发布组件 validation 阶段（packages/validation，D7）——本模块不另设
// 第二套校验，只做映射。
//
// 被测形态：真实 SQLite + 真实 bare 仓库（web-browse-fixtures 夹具——与
// browse/view 路由测试同源）；ref 前后比对用直通 git（不经生产读面）。

interface Fix {
  h: BrowseHarness;
  vaultId: number;
  repoPath: string;
  seedMain: string;
  alice: number;
  bob: number;
  close(): Promise<void>;
}

let f: Fix;

before(async () => {
  const h = await browseHarness();
  const alice = 1; // addEmployee 自增起始（web-browse-fixtures 建库序列）
  const bob = 2;
  // 建两名员工：复用夹具导出（browseHarness 的 db 已含 FIXTURE_DDL）
  const { addEmployee } = await import('./web-browse-fixtures.ts');
  addEmployee(h.db, { username: 'alice' });
  addEmployee(h.db, { username: 'bob' });
  const vaultId = await seededVault(h, 'docs', alice, {
    'README.md': '# nav\n',
    'notes/first.md': '---\ntitle: First\n---\nbody\n',
  });
  addMember(h.db, vaultId, alice, 'editor', alice);
  addMember(h.db, vaultId, bob, 'editor', alice);
  const repoPath = repoPathOf(h, vaultId);
  const seedMain = (await gitOut(['--git-dir', repoPath, 'rev-parse', 'main'])).trim();
  f = {
    h, vaultId, repoPath, seedMain, alice, bob,
    close: async () => {
      await h.close();
    },
  };
});

after(async () => {
  await f.close();
});

beforeEach(async () => {
  await gitOut(['--git-dir', f.repoPath, 'update-ref', 'refs/heads/main', f.seedMain]);
});

const WHEN = '2026-10-13T12:00:00.000Z';
const IDENT = { name: 'alice', email: 'alice@notegit.test' };

const EMPTY_FIELDS: EditFormFields = {
  title: '', owner: '', description: '', tags: '', status: '', source: '', extra: '',
};

function submit(over: Partial<EditSubmitArgs> = {}) {
  return submitEditForm({
    db: f.h.db,
    dataDir: f.h.dataDir,
    subject: { employeeId: f.alice, carrierRef: 'session:1' },
    vaultSlug: 'docs',
    branch: 'main',
    path: 'notes/new.md',
    fields: { ...EMPTY_FIELDS, title: 'New note' },
    body: '正文。',
    baseCommit: f.seedMain,
    identity: IDENT,
    committedAt: WHEN,
    occurredAt: WHEN,
    ...over,
  });
}

type EditSubmitArgs = Parameters<typeof submitEditForm>[0];

async function headMain(): Promise<string> {
  return (await gitOut(['--git-dir', f.repoPath, 'rev-parse', 'main'])).trim();
}

// ── 完成标准 1：缺 title 提交被阻且提示含 E-FM-003 与行定位（TDD 先 RED） ──

test('缺 title 提交被阻：rejected@validation，title 字段映射 E-FM-003 且含行定位，ref 不动', async () => {
  const out = await submit({ fields: { ...EMPTY_FIELDS, owner: 'alice' } }); // title 空、其余留空（W 级）
  assert.equal(out.publish.kind, 'rejected');
  if (out.publish.kind !== 'rejected') return;
  assert.equal(out.publish.stage, 'validation', '缺 title 必须在校验阶段被拒（单一来源）');
  assert.ok(out.form !== null, '校验拒绝必须携带表单映射');
  if (out.form === null) return;
  assert.equal(out.form.blocked, true, 'error 级 ⇒ 阻断');
  const titleIssues = out.form.byField.title ?? [];
  const e = titleIssues.find((i) => i.code === 'E-FM-003');
  assert.ok(e !== undefined, `title 字段应映射 E-FM-003（实际：${JSON.stringify(titleIssues)}）`);
  assert.ok(typeof e.line === 'number' && e.line >= 2, `行定位缺失或非法（line=${String(e.line)}）`);
  assert.ok(e.message.includes('去空白后为空'), '提示文案来自注册表模板');
  // ref 不动（不发布、不静默覆盖）
  assert.equal(await headMain(), f.seedMain, '校验拒绝不得移动 ref');
});

// ── 完成标准 4：W-FM-101 仅温和提示不阻断（可选字段缺失照常发布） ──

test('W-FM-101 不阻断：仅 title 提交照常发布，warnings 映射 3 条 W 级且 blocked=false', async () => {
  const out = await submit({ fields: { ...EMPTY_FIELDS, title: 'New note' } }); // owner/description/source 缺失
  assert.equal(out.publish.kind, 'published');
  if (out.publish.kind !== 'published') return;
  assert.ok(out.form !== null && out.form.blocked === false, 'W 级不得阻断（架构 §5.3）');
  if (out.form === null) return;
  assert.equal(out.form.byField.title, undefined, '无 error 级不得落字段错误');
  assert.equal(out.form.warnings.length, 3, 'owner/description/source 各一条 W-FM-101');
  assert.ok(out.form.warnings.every((w) => w.code === 'W-FM-101'), JSON.stringify(out.form.warnings));
  // 走通发布组件：ref 前进、报告 pass、全链步骤
  assert.notEqual(out.publish.newOid, f.seedMain);
  assert.equal(out.publish.report.result, 'pass');
  assert.equal(out.publish.report.summary.warningCount, 3);
  assert.equal(out.publish.executedSteps[out.publish.executedSteps.length - 1], 'settle');
  assert.equal(await headMain(), out.publish.newOid, 'ref 应前进到发布提交');
});

// ── 完成标准 5：合法提交（含额外字段安全 YAML 值）走通发布组件 ──

test('合法提交走通发布组件：六字段 + 额外字段（安全 YAML 值）落库为组装全文', async () => {
  const out = await submit({
    fields: {
      title: '差旅报销制度',
      owner: 'zhangsan',
      description: '简述',
      tags: '人事, 报销',
      status: 'draft',
      source: '财务部正式发文',
      extra: 'department: 财务部\nreviewers: [a, b]',
    },
    body: '\n# 差旅报销制度\n\n正文。',
  });
  assert.equal(out.publish.kind, 'published');
  if (out.publish.kind !== 'published') return;
  assert.equal(out.publish.report.result, 'pass');
  assert.equal(out.publish.report.summary.errorCount, 0);
  // 发布提交的 blob = 组装全文（额外字段原样保留、六字段 JSON 流式标量）
  const blob = await gitOut(['--git-dir', f.repoPath, 'cat-file', 'blob', `${out.publish.newOid}:${'notes/new.md'}`]);
  assert.ok(blob.includes('title: "差旅报销制度"'), blob);
  assert.ok(blob.includes('tags: ["人事","报销"]'), 'tags 逗号输入组装为列表');
  assert.ok(blob.includes('status: "draft"'), blob);
  assert.ok(blob.includes('department: 财务部'), '额外字段原样保留（安全 YAML 值）');
  assert.ok(blob.includes('reviewers: [a, b]'), blob);
  assert.ok(blob.includes('# 差旅报销制度'), '正文 verbatim');
  assert.ok(out.form !== null && out.form.blocked === false && out.form.warnings.length === 0);
});

// ── 完成标准 2/3：status 下拉防呆 + 校验双保险；tags 非列表映射 E-FM-004 ──

test('status 非法值（绕过下拉经 extra 注入）双保险：校验拒绝 E-FM-005 映射 status 字段', async () => {
  const out = await submit({
    path: 'notes/bad-status.md',
    fields: { ...EMPTY_FIELDS, title: '有题', extra: 'status: archived' }, // 下拉外值——校验兜底
  });
  assert.equal(out.publish.kind, 'rejected');
  if (out.publish.kind !== 'rejected') return;
  assert.equal(out.publish.stage, 'validation');
  const st = (out.form?.byField.status ?? []).find((i) => i.code === 'E-FM-005');
  assert.ok(st !== undefined, `status 字段应映射 E-FM-005（实际：${JSON.stringify(out.form?.byField.status)}）`);
  assert.ok(st.message.includes('active/draft/deprecated'), '提示允许值（注册表模板）');
  assert.equal(await headMain(), f.seedMain);
});

test('tags 非列表输入（extra 覆盖为标量）映射 E-FM-004 到 tags 字段', async () => {
  const out = await submit({
    path: 'notes/bad-tags.md',
    fields: { ...EMPTY_FIELDS, title: '有题', extra: 'tags: 人事' }, // 非列表——契约 §3.3 示例同款
  });
  assert.equal(out.publish.kind, 'rejected');
  if (out.publish.kind !== 'rejected') return;
  assert.equal(out.publish.stage, 'validation');
  const tg = (out.form?.byField.tags ?? []).find((i) => i.code === 'E-FM-004');
  assert.ok(tg !== undefined, `tags 字段应映射 E-FM-004（实际：${JSON.stringify(out.form?.byField.tags)}）`);
  assert.ok(tg.message.includes('tags'), '模板含字段名');
  assert.equal(await headMain(), f.seedMain);
});
