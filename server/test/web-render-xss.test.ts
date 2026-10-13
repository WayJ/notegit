import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../src/web/view/render.ts';

// S4-T2 XSS 样本集（breakdown §2.3 完成标准：「XSS 样本集（script/iframe/
// javascript:/data: 等）全部被清理或拒载」；验收 S2 安全渲染侧）。
//
// 断言策略（与「剥离或拒载」对应的可观测面）：
// 1. 结构白名单——输出中出现的每个标签都来自渲染器白名单（h1-h6/p/ul/ol/li/
//    blockquote/pre/code/table/thead/tbody/tr/th/td/hr/a/img/em/strong/br/span），
//    属性仅 href/src/alt/title/class/data-*，且不得出现 on* 事件属性；
// 2. 协议白名单——输出中每个 href/src 值要么 http(s):// 开头、要么无协议
//    （相对/锚点），javascript:/data:/vbscript:/file: 一律拒载；
// 3. script/iframe 等危险标签整段剥离（标签与其内容都不出现在输出）。
//
// 渲染管线的安全不变量：原文文本仅经 escapeHtml 进入输出；输出里的标签全部
// 由渲染器自身生成（服务端清理唯一通道——原文 HTML 永不被解释）。

/** 输出允许的标签与属性（渲染器自身生成面——白名单之外即违规） */
const ALLOWED_TAGS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'ul', 'ol', 'li', 'blockquote',
  'pre', 'code', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'a',
  'img', 'em', 'strong', 'br', 'span',
]);
const ALLOWED_ATTRS = /^(href|src|alt|title|class|data-[a-z0-9-]+)$/;

/** 结构白名单断言：扫描输出中全部 `<tag ...>` 形态（渲染器保证属性值内无裸 `>`，
 *  故逐标签正则可靠），逐个核对标签名/属性名/事件属性。 */
function assertOnlyWhitelistedTags(html: string, label: string): void {
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^<>]*?)?)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    const name = m[1].toLowerCase();
    assert.ok(ALLOWED_TAGS.has(name), `${label}: 出现白名单外标签 <${name}>（输出片段：${m[0]}）`);
    const attrs = m[2] ?? '';
    assert.doesNotMatch(attrs, /\son[a-zA-Z]+\s*=/i, `${label}: 出现事件属性（${m[0]}）`);
    const attrRe = /\s([a-zA-Z-][a-zA-Z0-9:-]*)(\s*=\s*("[^"]*"|'[^']*'))?/g;
    let a: RegExpExecArray | null;
    while ((a = attrRe.exec(attrs)) !== null) {
      assert.match(a[1], ALLOWED_ATTRS, `${label}: 出现白名单外属性 ${a[1]}（${m[0]}）`);
    }
  }
}

/** 协议白名单断言：输出中全部 href/src 值必须 http(s) 或无协议（相对/锚点） */
function assertWhitelistUrls(html: string, label: string): void {
  const re = /\s(?:href|src)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const v = m[1];
    const hasScheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.test(v);
    if (hasScheme) {
      assert.match(v, /^https?:\/\//i, `${label}: href/src 协议非白名单（${v}）`);
    }
  }
}

/** 单样本全清断言：结构白名单 + 协议白名单 + 无危险标签文本形态 */
function assertClean(sample: string, label: string, html: string): void {
  assert.ok(!/<script/i.test(html), `${label}: 输出含 <script`);
  assert.ok(!/<iframe/i.test(html), `${label}: 输出含 <iframe`);
  assertOnlyWhitelistedTags(html, label);
  assertWhitelistUrls(html, label);
}

test('XSS：script 块（块级与行内）整段剥离——标签与内容都不出现', () => {
  const samples = [
    '<script>alert(1)</script>',
    '正文段落 <script>alert(1)</script> 继续',
    "<script>\nvar x = '<b>恶意</b>';\n</script>\n\n后续段落",
  ];
  for (const s of samples) {
    const { html, strippedHtml } = renderMarkdown(s);
    assert.ok(strippedHtml, '应如实标记发生了 HTML 剥离');
    assert.ok(!html.includes('alert(1)'), `script 内容必须一并剥离（输入：${s}）`);
    assertClean(s, 'script', html);
  }
});

test('XSS：大小写与空白混淆（<ScRiPt>、java\\tscript:）同样剥离/拒载', () => {
  const { html } = renderMarkdown('<ScRiPt>alert(1)</ScRiPt>');
  assert.ok(!html.includes('alert(1)'));
  assertClean('<ScRiPt>', '大写混淆', html);

  // URL 内制表符混淆：含控制字符/空白的 URL 一律拒载（浏览器会剥离制表符后再解析协议）
  const tab = renderMarkdown('[点我](java\tscript:alert(1))');
  assert.ok(!tab.html.includes('<a '), '含空白/控制字符的 URL 拒载为纯文本');
  assertClean('tab', '空白混淆', tab.html);
});

test('XSS：iframe（含 src 载荷）整段剥离', () => {
  const { html } = renderMarkdown('<iframe src="https://evil.example/x"></iframe>');
  assert.ok(!html.includes('evil.example'));
  assert.ok(!/<iframe/i.test(html));
  const { html: inline } = renderMarkdown('前文 <iframe src="javascript:alert(1)"></iframe> 后文');
  assert.ok(inline.includes('前文'));
  assert.ok(inline.includes('后文'));
  assert.ok(!inline.includes('alert(1)'));
  assertClean('iframe', 'iframe 行内', inline);
});

test('XSS：javascript:/vbscript:/data: 链接一律拒载（降级为纯文本，无 <a>）', () => {
  const samples = [
    '[点我](javascript:alert(1))',
    '[点我](JAVASCRIPT:alert(1))',
    '[点我](vbscript:msgbox(1))',
    '[点我](data:text/html,<script>alert(1)</script>)',
    '[点我](file:///etc/passwd)',
    '[点我](mailto:a@b.c)',
  ];
  for (const s of samples) {
    const { html } = renderMarkdown(s);
    assert.ok(!html.includes('<a '), `非白名单协议链接不得生成锚点（${s}）`);
    assert.ok(html.includes('点我'), `链接文字保留为纯文本（${s}）`);
    assertClean(s, '协议链接', html);
  }
});

test('XSS：data:/javascript: 图片拒载（无 <img>）；SVG 载荷同样拒载', () => {
  const samples = [
    '![x](data:image/svg+xml;base64,PHN2Zy8+)',
    '![x](javascript:alert(1))',
    '![x](data:text/html,<b>)',
  ];
  for (const s of samples) {
    const { html } = renderMarkdown(s);
    assert.ok(!html.includes('<img'), `非白名单协议图片不得生成 img（${s}）`);
    assertClean(s, '协议图片', html);
  }
});

test('XSS：原始 HTML img 的事件属性（on*）随标签剥离——onerror/onload 不可达', () => {
  const { html, strippedHtml } = renderMarkdown('<img src=x onerror=alert(1) onload=alert(2)>');
  assert.ok(strippedHtml);
  assert.ok(!/<img/i.test(html), '原始 HTML img 不得进入输出');
  assert.ok(!/onerror|onload/i.test(html), '事件属性文本也不得残留');
  assertClean('onerror', '事件属性', html);

  const div = renderMarkdown('<div onclick="alert(1)">可见文本</div>');
  assert.ok(div.html.includes('可见文本'), '非危险容器标签剥离后正文保留');
  assert.ok(!/onclick/i.test(div.html));
  assertClean('onclick', 'div 事件', div.html);
});

test('XSS：meta 刷新 / svg onload / form / style / 注释载荷全部剥离', () => {
  const samples = [
    '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
    '<svg onload=alert(1)></svg>',
    '<form action="javascript:alert(1)"><input type=submit></form>',
    '<style>body{background:url(javascript:alert(1))}</style>',
    '<!-- <script>alert(1)</script> -->',
  ];
  for (const s of samples) {
    const { html } = renderMarkdown(s);
    assert.ok(!html.includes('alert(1)'), `载荷必须整段剥离（${s}）`);
    assertClean(s, '杂项载荷', html);
  }
});

test('XSS：畸形构造（未闭合标签、< 起头非标签文本）不逃逸为可执行输出', () => {
  const samples = [
    '<script>alert(1)', // 未闭合 script：到块尾全剥离
    '<<script>alert(1)</script>', // 多余 < 前缀
    '<img src=x onerror=alert(1)', // 未闭合标签
    'a < b 且 3 < 4 的普通文本', // 非标签 <
  ];
  for (const s of samples) {
    const { html } = renderMarkdown(s);
    assert.ok(!html.includes('alert(1)'), `畸形载荷不得外泄（${s}）`);
    assert.ok(!/<script/i.test(html));
    assertClean(s, '畸形', html);
  }
  const plain = renderMarkdown('a < b 且 3 < 4 的普通文本');
  assert.ok(plain.html.includes('&lt;'), '普通 < 转义显示');
});

test('白名单正向：http/https/相对/锚点链接与 http(s) 图片正常生成', () => {
  const { html } = renderMarkdown(
    [
      '[外链](https://example.com/a?b=1#c)',
      '[http 链接](http://example.com/)',
      '[相对文档](./other.md) 与 [上级](../docs/x.md) 与 [站内](/vaults/a/browse)',
      '[锚点](#section)',
      '![外图](https://example.com/pic.png)',
    ].join('\n\n'),
  );
  assert.match(html, /href="https:\/\/example\.com\/a\?b=1#c"/);
  assert.match(html, /href="http:\/\/example\.com\//);
  assert.match(html, /href="\.\/other\.md"/);
  assert.match(html, /href="\.\.\/docs\/x\.md"/);
  assert.match(html, /href="\/vaults\/a\/browse"/);
  assert.match(html, /href="#section"/);
  assert.match(html, /<img src="https:\/\/example\.com\/pic\.png" alt="外图">/);
  assertClean('正向', '白名单正向', html);
});

test('白名单正向：仓库相对图片经附件回调生成鉴权 URL（S4-T4 通道接口）', () => {
  const { html } = renderMarkdown('![截图](screenshots/login.png)', {
    attachmentImageUrl: (p) => `/vaults/alpha/attachments/${encodeURIComponent(p)}`,
  });
  assert.match(html, /<img src="\/vaults\/alpha\/attachments\/screenshots%2Flogin\.png" alt="截图">/);
  assertClean('附件回调', '附件回调', html);
});

test('附件通道未接入（回调缺省/返回 null）：占位标注而非 <img>', () => {
  for (const r of [undefined, () => null]) {
    const { html } = renderMarkdown('![截图](screenshots/login.png)', r === undefined ? {} : { attachmentImageUrl: r });
    assert.ok(!html.includes('<img'), '未接入附件通道不得生成 img');
    assert.match(html, /data-attachment="screenshots\/login\.png"/, '占位标注携带原始引用路径');
    assert.ok(html.includes('截图'), 'alt 文本保留');
  }
});
