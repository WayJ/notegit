import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftPutUrl, type DraftPutBody } from '../src/web/edit/draft.ts';

// S4-T3 草稿 API 形状占位（api.md §7；存储本体属 S4-T6）：URL 形状与请求体键
// 是本任务交付的「形状先定」——T6 落地端点后本模块即为其消费面。

test('draftPutUrl：§7 路径形状，路径段逐段编码（库 slug 与树路径）', () => {
  assert.equal(draftPutUrl('alpha', 'docs/first.md'), '/api/v1/vaults/alpha/drafts/docs/first.md');
  assert.equal(
    draftPutUrl('团队 知识', 'docs/报销 制度/差旅.md'),
    '/api/v1/vaults/%E5%9B%A2%E9%98%9F%20%E7%9F%A5%E8%AF%86/drafts/docs/%E6%8A%A5%E9%94%80%20%E5%88%B6%E5%BA%A6/%E5%B7%AE%E6%97%85.md',
  );
});

test('DraftPutBody：§7 请求体键（content + base_commit，base 可 null=空库）', () => {
  const body: DraftPutBody = { content: '---\ntitle: T\n---\nB', base_commit: null };
  assert.deepEqual(Object.keys(body).sort(), ['base_commit', 'content']);
  const body2: DraftPutBody = { content: 'x', base_commit: 'a'.repeat(40) };
  assert.equal(body2.base_commit, 'a'.repeat(40));
});
