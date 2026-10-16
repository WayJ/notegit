import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { browseHarness, seededVault, addEmployee, addMember, type BrowseHarness } from './web-browse-fixtures.ts';
import { adminPage } from '../src/web/pages.ts';

/**
 * S22-T1 技术债清偿渲染/行为断言（tech-debt-tracker TD-1/TD-2；S22-D3）：
 *
 * - TD-1 admin 员工表创建时间相对化：ngt.relTime（app.js 单源，语义镜像
 *   服务端 formatRelativeTime——刚刚/分/时/天/超一周回日期、NaN 回落原文、
 *   未来时刻钳为刚刚）；员工行单元格不再裸传 ISO。
 * - TD-2 browse 头部上传入口去裸括号：完整短语「上传文件」、无 `(<a …upload`
 *   括号包裹（href 不变——web-browse-perm.test.ts 既有断言继续锁定入口在位）。
 */

// ── TD-1：ngt.relTime 行为（vm 直跑 app.js，语义逐案对照服务端实现） ─────────

const NOW = new Date('2026-10-16T12:00:00Z');

test('TD-1 ngt.relTime 行为矩阵：与 formatRelativeTime 同语义（含 NaN/未来回落）', async () => {
  const js = await readFile(
    fileURLToPath(new URL('../src/web/assets/app.js', import.meta.url)),
    'utf8',
  );
  const sandbox: { window: Record<string, unknown> } = { window: {} };
  vm.runInNewContext(js, sandbox);
  const ngt = sandbox.window.ngt as { relTime(iso: string, now?: Date): string };
  assert.equal(typeof ngt.relTime, 'function', 'window.ngt.relTime 在位');

  const cases: Array<[string, string]> = [
    ['2026-10-16T11:59:30Z', '刚刚'], // 30 秒
    ['2026-10-16T11:55:00Z', '5 分钟前'],
    ['2026-10-16T09:00:00Z', '3 小时前'],
    ['2026-10-14T12:00:00Z', '2 天前'],
    ['2026-10-10T12:00:00Z', '6 天前'], // ≤7 天仍相对
    ['2026-10-08T12:00:00Z', '2026-10-08'], // >7 天回绝对日期
    ['not-a-date', 'not-a-date'], // NaN 回落原文（时钟异常如实）
    ['2026-10-17T12:00:00Z', '刚刚'], // 未来时刻钳 0（服务端同款 Math.max）
  ];
  for (const [iso, want] of cases) {
    assert.equal(ngt.relTime(iso, NOW), want, `relTime(${iso})`);
  }
});

test('TD-1 admin 员工行走 ngt.relTime：单元格不再裸传 created_at', () => {
  const html = adminPage({ username: 'boss', display_name: '库主管', is_instance_admin: true });
  assert.ok(html.includes('ngt.relTime(e.created_at)'), '员工行创建时间经 ngt.relTime 渲染');
  assert.ok(!html.includes('e.created_at]'), 'cells 数组不再裸传 ISO（相对化后才入单元格）');
});

// ── TD-2：browse 头部上传入口去裸括号 ────────────────────────────────────────

interface Fix {
  h: BrowseHarness;
  admin: number;
}

let f: Fix;

before(async () => {
  const h = await browseHarness();
  const admin = addEmployee(h.db, { username: 'alice' });
  const vaultId = await seededVault(h, 'alpha', admin, {
    'README.md': '# nav\n',
    'docs/guide.md': '---\ntitle: 指南\n---\n\n正文。\n',
  });
  addMember(h.db, vaultId, admin, 'admin', admin);
  f = { h, admin };
});

after(async () => {
  await f.h.close();
});

test('TD-2 写者头部：上传文件完整短语、无裸括号包裹（href 不变）', async () => {
  const page = await f.h.app.inject({ method: 'GET', url: '/vaults/alpha/browse/docs', headers: f.h.session(f.admin) });
  assert.equal(page.statusCode, 200, page.body);
  assert.ok(page.body.includes('>上传文件</a>'), '完整短语「上传文件」在位');
  assert.ok(!/<a[^>]*>\(<a[^>]*href="[^"]*\/upload/.test(page.body), '不再有括号包裹的上传入口');
  assert.ok(page.body.includes('href="/vaults/alpha/upload/docs"'), '上传 href 不变（入口语义零漂移）');
});
