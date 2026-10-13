import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repoPathOfRef, attachmentUrl } from '../src/web/view/attachments.ts';

// S4-T4 附件通道纯函数单测（breakdown §2.3 S4-T4 行「附件 URL 不可枚举」与
// view/attachments.ts T2 接口占位的 T4 落地）：Markdown 相对图片引用 → 仓库路径
// 解析（文档目录语义 + 越界/畸形拒绝）与 blob 寻址 URL 构造（不可猜测成分 =
// 40+ hex blob OID——选型：按 blob 寻址，见 .agents/notes/2026-10-13-S4-T4-upload.md）。

test('repoPathOfRef：相对引用解析到文档所在目录（T2 接口注释语义）', () => {
  assert.equal(repoPathOfRef('docs/guide.md', 'shots/login.png'), 'docs/shots/login.png');
  assert.equal(repoPathOfRef('docs/guide.md', './a.png'), 'docs/a.png');
  assert.equal(repoPathOfRef('guide.md', 'a.png'), 'a.png');
});

test('repoPathOfRef：../ 上溯与 / 仓库根绝对引用', () => {
  assert.equal(repoPathOfRef('docs/guide.md', '../assets/a.png'), 'assets/a.png');
  assert.equal(repoPathOfRef('docs/nested/guide.md', '../../a.png'), 'a.png');
  assert.equal(repoPathOfRef('docs/guide.md', '/assets/a.png'), 'assets/a.png');
  assert.equal(repoPathOfRef('docs/guide.md', '/a.png'), 'a.png');
});

test('repoPathOfRef：越出仓库根 / 畸形引用一律 null（不产出可查询路径）', () => {
  assert.equal(repoPathOfRef('docs/guide.md', '../../escape.png'), null, '越出根');
  assert.equal(repoPathOfRef('guide.md', '../up.png'), null, '根文档上溯即越界');
  assert.equal(repoPathOfRef('docs/guide.md', 'a//b.png'), null, '空段');
  assert.equal(repoPathOfRef('docs/guide.md', 'img/'), null, '尾随斜杠空段');
  assert.equal(repoPathOfRef('docs/guide.md', ''), null, '空引用');
  assert.equal(repoPathOfRef('docs/guide.md', 'a\\b.png'), null, '反斜杠');
  assert.equal(repoPathOfRef('docs/guide.md', 'a\x01.png'), null, '控制字符');
});

test('attachmentUrl：blob 寻址 URL（含 40 hex OID 与转义文件名）', () => {
  const oid = '0123456789abcdef0123456789abcdef01234567';
  assert.equal(attachmentUrl('alpha', oid, 'logo.png'), `/vaults/alpha/attach/${oid}/logo.png`);
  // slug 与文件名按段 URL 转义（空格/非 ASCII/斜杠不出新段）
  assert.equal(
    attachmentUrl('my vault', oid, '图 片.png'),
    `/vaults/my%20vault/attach/${oid}/%E5%9B%BE%20%E7%89%87.png`,
  );
});
