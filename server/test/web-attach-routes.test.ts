import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig } from 'notegit-validation';
import { setAppSetting } from '../src/limits/engine.ts';
import { browseHarness, seededVault, addEmployee, addMember, type BrowseHarness } from './web-browse-fixtures.ts';

// S4-T4 附件读取端点 + view 附件通道接线（breakdown §2.3 S4-T4 完成标准后两条：
// 「无权成员持有效附件 URL 访问 404」「附件 URL 不可枚举」；预览页图片显示打通
// = T2 attachments.ts 占位接口的 T4 装配）。选型：按 blob 寻址（URL 不可猜测
// 成分 = 40 hex blob OID），鉴权逐请求判定——两者互补，见 view/attachments.ts。

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pngBytes = (fill = 64) => Buffer.concat([PNG_MAGIC, Buffer.alloc(fill, 0x61)]);

const GUIDE_MD = [
  '---',
  'title: 指南',
  '---',
  '',
  '徽标：![徽标](../assets/logo.png)',
  '缺失：![缺失](nope.png)',
  '',
].join('\n');

interface Ctx {
  h: BrowseHarness;
  oid: string;
  url: string;
  bytes: Buffer;
}

/** alice 上传 assets/logo.png（取回 blob OID 与附件 URL）；bob=reader、carol=非成员 */
async function setup(): Promise<Ctx> {
  const h = await browseHarness();
  const alice = addEmployee(h.db, { username: 'alice' });
  addEmployee(h.db, { username: 'bob' });
  addEmployee(h.db, { username: 'carol' });
  const vaultId = await seededVault(h, 'alpha', alice, { 'docs/guide.md': GUIDE_MD });
  addMember(h.db, vaultId, alice, 'editor', alice);
  addMember(h.db, vaultId, alice + 1, 'reader', alice);
  const bytes = pngBytes();
  const res = await h.app.inject({
    method: 'POST',
    url: '/vaults/alpha/upload/assets/logo.png',
    headers: { 'content-type': 'application/octet-stream', origin: 'http://localhost', ...h.session(alice) },
    payload: bytes,
  });
  assert.equal(res.statusCode, 200, res.body);
  const { url } = res.json() as { url: string };
  const oid = /\/attach\/([0-9a-f]{40})\//.exec(url)![1]!;
  return { h, oid, url, bytes };
}

test('附件读取完成标准 3：无权成员持有效附件 URL 访问 404（与不存在同体）', async () => {
  const { h, url } = await setup();
  try {
    const denied = await h.app.inject({ method: 'GET', url, headers: h.session(3) }); // carol 非成员
    assert.equal(denied.statusCode, 404, denied.body);
    const ghost = await h.app.inject({
      method: 'GET',
      url: url.replace('/alpha/', '/ghost/'),
      headers: h.session(3),
    });
    assert.equal(ghost.statusCode, 404);
    assert.equal(denied.body, ghost.body, '无权与不存在同体（D-IC-06——持有效 URL 也不例外）');
    assert.match(denied.headers['content-type'] as string, /^text\/html/);
  } finally {
    await h.close();
  }
});

test('附件读取：read 成员 200 原始字节 + 安全响应头；未认证 302 /login', async () => {
  const { h, url, bytes } = await setup();
  try {
    const ok = await h.app.inject({ method: 'GET', url, headers: h.session(2) }); // bob reader：read 即可读附件
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(ok.headers['content-type'], 'image/png');
    assert.equal(ok.headers['x-content-type-options'], 'nosniff');
    assert.equal(ok.headers['cache-control'], 'private, no-store'); // 库内容不落共享缓存
    assert.deepEqual(ok.rawPayload, bytes, '字节原样（无 utf8 破坏）');

    const anon = await h.app.inject({ method: 'GET', url });
    assert.equal(anon.statusCode, 302);
    assert.equal(anon.headers['location'], '/login');
  } finally {
    await h.close();
  }
});

test('附件 URL 不可枚举：无列表面；伪造/不存在 OID 404 与畸形同体', async () => {
  const { h, oid, url } = await setup();
  try {
    // URL 形状：blob OID（40 hex 内容散列）为不可猜测成分——非路径序号/可递推形态
    assert.match(url, /^\/vaults\/alpha\/attach\/[0-9a-f]{40}\/logo\.png$/);
    assert.notEqual(url.includes(oid), false);

    // 不存在 OID（伪造）与畸形 OID 同 404 同体（无存在性 oracle）
    const fabricated = url.replace(oid, 'f'.repeat(40));
    const malformed = url.replace(oid, 'not-an-oid');
    const a = await h.app.inject({ method: 'GET', url: fabricated, headers: h.session(2) });
    const b = await h.app.inject({ method: 'GET', url: malformed, headers: h.session(2) });
    assert.equal(a.statusCode, 404);
    assert.equal(b.statusCode, 404);
    assert.equal(a.body, b.body, '伪造与畸形不可区分');

    // 无列表面：attach 根与无 OID 形态 404
    for (const probe of ['/vaults/alpha/attach/', '/vaults/alpha/attach', '/vaults/alpha/attach/']) {
      const res = await h.app.inject({ method: 'GET', url: probe, headers: h.session(2) });
      assert.equal(res.statusCode, 404, `${probe} 不得提供枚举面`);
    }
  } finally {
    await h.close();
  }
});

test('svg 纵获准入库也不以 image/svg+xml 出面（octet-stream + nosniff 纵深防御）', async () => {
  const { h } = await setup();
  try {
    setAppSetting(h.db, {
      key: 'validation.limits.attachmentAllowedExtensions',
      value: [...defaultConfig().attachmentAllowedExtensions, '.svg'],
    });
    const up = await h.app.inject({
      method: 'POST',
      url: '/vaults/alpha/upload/assets/icon.svg',
      headers: { 'content-type': 'application/octet-stream', origin: 'http://localhost', ...h.session(1) },
      payload: '<svg onload="alert(1)"/>',
    });
    assert.equal(up.statusCode, 200, up.body);
    const { url } = up.json() as { url: string };
    const res = await h.app.inject({ method: 'GET', url, headers: h.session(1) });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'application/octet-stream', 'svg 不升格为可执行内容类型');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
  } finally {
    await h.close();
  }
});

test('附件读取：无文件名段（裸 OID）→ 200 octet-stream；PDF → application/pdf', async () => {
  const { h, oid } = await setup();
  try {
    const bare = await h.app.inject({ method: 'GET', url: `/vaults/alpha/attach/${oid}`, headers: h.session(1) });
    assert.equal(bare.statusCode, 200);
    assert.equal(bare.headers['content-type'], 'application/octet-stream');

    const pdf = await h.app.inject({
      method: 'POST',
      url: '/vaults/alpha/upload/assets/doc.pdf',
      headers: { 'content-type': 'application/octet-stream', origin: 'http://localhost', ...h.session(1) },
      payload: Buffer.from('%PDF-1.4 stub'),
    });
    assert.equal(pdf.statusCode, 200, pdf.body);
    const res = await h.app.inject({
      method: 'GET',
      url: (pdf.json() as { url: string }).url,
      headers: h.session(1),
    });
    assert.equal(res.headers['content-type'], 'application/pdf');
  } finally {
    await h.close();
  }
});

test('预览页通道接线：相对引用 → <img 指向 attach URL>；缺失引用保留占位标注', async () => {
  const { h, oid } = await setup();
  try {
    const res = await h.app.inject({ method: 'GET', url: '/vaults/alpha/view/docs/guide.md', headers: h.session(2) });
    assert.equal(res.statusCode, 200, res.body);
    const img = `<img src="/vaults/alpha/attach/${oid}/logo.png" alt="徽标">`;
    assert.ok(res.body.includes(img), `应渲染鉴权附件 <img>（实际含：${res.body.slice(res.body.indexOf('img-') !== -1 ? res.body.indexOf('img-') - 40 : 0, res.body.indexOf('img-') + 200)}）`);
    assert.ok(!/<img [^>]*\.\.\/assets/.test(res.body), '不得直出仓库相对路径为 src');

    const m = /<span class="img-attachment" data-attachment="nope\.png"/.exec(res.body);
    assert.ok(m !== null, '缺失引用仍占位标注（携带原始引用路径）');
    assert.ok(!new RegExp(`src="[^"]*nope\\.png"`).test(res.body), '缺失引用不产生 img src');
  } finally {
    await h.close();
  }
});

test('预览页通道接线：/ 仓库根绝对引用可解析；越出仓库根保留占位', async () => {
  const h = await browseHarness();
  try {
    const alice = addEmployee(h.db, { username: 'alice' });
    const vaultId = await seededVault(h, 'beta', alice, {
      'README.md': '# nav\n',
      'assets/root.png': 'root-stub',
      'deep/doc.md': '---\ntitle: D\n---\n根：![r](/assets/root.png)\n越界：![e](../../x.png)\n',
    });
    addMember(h.db, vaultId, alice, 'editor', alice);
    const res = await h.app.inject({ method: 'GET', url: '/vaults/beta/view/deep/doc.md', headers: h.session(alice) });
    assert.equal(res.statusCode, 200, res.body);
    assert.match(res.body, /<img src="\/vaults\/beta\/attach\/[0-9a-f]{40}\/root\.png" alt="r">/);
    assert.match(res.body, /<span class="img-attachment" data-attachment="\.\.\/\.\.\/x\.png"/, '越界引用占位');
  } finally {
    await h.close();
  }
});
