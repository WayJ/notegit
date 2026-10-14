import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browseHarness, seededVault, addEmployee, addMember, type BrowseHarness } from './web-browse-fixtures.ts';

// S12-T1 附件粘贴/拖拽（D4）：编辑页正文 textarea 的 paste/drop 事件——剪贴板/
// 拖拽文件取 File → 既有 POST /vaults/{slug}/upload/{文档目录}/{原文件名}
// （octet-stream，S4-T4 端点全量判定）→ 成功后按类型回插引用（image/* →
// ![](url)；其余 → [name](url)）。判定单一来源=端点（编辑器不预判类型白名单——
// 端点拒即如实显示 error.code+hint）。fetch 层以 JS 形态断言锁定；端点侧行为
// （415/清单外 422 信封字段）以编辑器消费形状为准在此锁定。

const DOC = '---\ntitle: "First 笔记"\n---\n\n# 正文标题\n\n内容。\n';

async function setup() {
  const h = await browseHarness();
  const alice = addEmployee(h.db, { username: 'alice' });
  const bob = addEmployee(h.db, { username: 'bob' });
  const vaultId = await seededVault(h, 'alpha', alice, {
    'README.md': '# 导航\n',
    'docs/first.md': DOC,
  });
  addMember(h.db, vaultId, alice, 'editor', alice);
  addMember(h.db, vaultId, bob, 'reader', alice);
  return { h, alice, bob, vaultId };
}

function get(h: BrowseHarness, url: string, employeeId: number) {
  return h.app.inject({ method: 'GET', url, headers: h.session(employeeId) });
}

test('粘贴/拖拽 JS 形态：正文 textarea 绑 paste/drop/dragover；octet-stream 上传既有端点；按类型回插引用', async () => {
  const { h, alice } = await setup();
  try {
    const res = await get(h, '/vaults/alpha/edit/docs/first.md', alice);
    assert.equal(res.statusCode, 200, res.body);
    // 正文 textarea 的事件编排（paste 取 clipboardData.files；drop 取 dataTransfer.files；
    // dragover preventDefault——否则浏览器默认打开文件）
    assert.ok(res.body.includes("addEventListener('paste'"), 'paste 事件');
    assert.ok(res.body.includes("addEventListener('drop'"), 'drop 事件');
    assert.ok(res.body.includes("addEventListener('dragover'"), 'dragover 阻止默认');
    assert.ok(res.body.includes('.files'), '剪贴板/拖拽文件列表取 File');
    // 上传走既有端点（web 域 octet-stream——与上传页同一传输契约）
    assert.ok(res.body.includes('const UPLOAD_BASE ='), '上传基址常量（文档所在目录拼目标路径）');
    assert.ok(res.body.includes('"/vaults/alpha/upload"'), '端点=既有 POST /vaults/{slug}/upload');
    assert.ok(res.body.includes("'content-type': 'application/octet-stream'"), 'octet-stream 传输契约');
    // 回插：image/* → ![](url)；其余 → [name](url)（呈现形态选择——非类型白名单）
    assert.ok(res.body.includes("startsWith('image/')"), 'image/* 判定（仅回插形态）');
    assert.ok(res.body.includes("'![]('"), '图片回插 ![](url)');
    assert.ok(res.body.includes("']('"), '其余回插 [name](url)');
    assert.ok(res.body.includes('selectionStart'), '光标处回插（不覆盖既有正文）');
    // 上传中/失败如实呈现（状态行复用；端点拒即显示 error.code+hint——不预判）
    assert.ok(res.body.includes('上传中'), '上传中提示');
    assert.ok(res.body.includes('上传失败'), '失败提示');
    assert.ok(res.body.includes('error.code'), '端点错误码如实呈现');
    assert.ok(res.body.includes('hint'), '修正建议 hint 透传');
  } finally {
    await h.close();
  }
});

test('reader 只读态不携带粘贴/拖拽脚本（无写入口——形态延续）', async () => {
  const { h, bob } = await setup();
  try {
    const res = await get(h, '/vaults/alpha/edit/docs/first.md', bob);
    assert.equal(res.statusCode, 200, res.body);
    assert.ok(!res.body.includes("addEventListener('paste'"), '只读态无 paste 编排');
    assert.ok(!res.body.includes('UPLOAD_BASE'), '只读态无上传编排');
  } finally {
    await h.close();
  }
});

test('端点侧行为锁定（编辑器消费的形状）：成功 {ok,url}；415 非_octet_stream；清单外 422 error.code+hint', async () => {
  const { h, alice } = await setup();
  try {
    // 成功形状：编辑器回插消费 r.ok / r.url
    const ok = await h.app.inject({
      method: 'POST',
      url: '/vaults/alpha/upload/docs/shot.png',
      headers: { 'content-type': 'application/octet-stream', origin: 'http://localhost', ...h.session(alice) },
      payload: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    });
    assert.equal(ok.statusCode, 200, ok.body);
    const okBody = ok.json() as { ok: boolean; path: string; url: string | null };
    assert.equal(okBody.ok, true);
    assert.ok(typeof okBody.url === 'string' && okBody.url.length > 0, '成功携带回插用附件 URL');

    // 415：编辑器 fetch 恒带 octet-stream，此处锁定端点对传输契约的判定（编排兜底如实呈现）
    const wrong = await h.app.inject({
      method: 'POST',
      url: '/vaults/alpha/upload/docs/shot.png',
      headers: { 'content-type': 'text/plain', origin: 'http://localhost', ...h.session(alice) },
      payload: 'x',
    });
    assert.equal(wrong.statusCode, 415, wrong.body);

    // 清单外扩展（svg）：端点判定单一来源——422 E-LIMIT-002 + error.code + hint（编辑器如实显示）
    const svg = await h.app.inject({
      method: 'POST',
      url: '/vaults/alpha/upload/docs/icon.svg',
      headers: { 'content-type': 'application/octet-stream', origin: 'http://localhost', ...h.session(alice) },
      payload: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
    });
    assert.equal(svg.statusCode, 422, svg.body);
    const svgBody = svg.json() as { error: { code: string; hint?: string } };
    assert.equal(svgBody.error.code, 'E-LIMIT-002');
    assert.ok(typeof svgBody.error.hint === 'string' && svgBody.error.hint.length > 0, '信封携带 hint');
  } finally {
    await h.close();
  }
});
