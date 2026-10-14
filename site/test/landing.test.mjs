// S13-T1 落地页结构契约测试（node:test，零依赖，D21 零构建）。
// 断言对象是 site/index.html 与 site/assets/site.css 的静态文本。
// URL 契约（master 已定，T1/T2 共守）只断言 href 形态正确，
// 不断言目标文件存在——目标 HTML 由 S13-T2 的 build-site.mjs 产出。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const siteDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// 文件缺失时读为空串：让每条断言以「缺特性」失败（RED），而非模块级报错
function read(rel) {
  try {
    return readFileSync(path.join(siteDir, rel), 'utf8');
  } catch {
    return '';
  }
}
const html = read('index.html');
const css = read('assets/site.css');

// master 已定的站内 URL 契约（相对自 site/index.html，D2 全相对路径）
const DOC_CONTRACT = [
  'docs/user/README.html',
  'docs/user/quickstart.html',
  'docs/user/contributing.html',
  'docs/user/permissions.html',
  'docs/user/history-boundary.html',
  'docs/admin/README.html',
  'docs/deploy/README.html',
  'docs/known-limitations.html',
  'docs/release-notes-v0.2.0.html',
];
const GITHUB_URL = 'https://github.com/WayJ/notegit';
// deploy/README.md「快速开始」三条命令——落地页须如实摘录，不改写
const DEPLOY_COMMANDS = [
  'docker build -f deploy/Dockerfile -t notegit:0.1.0 .',
  'docker run -d --name notegit -p 127.0.0.1:3000:3000 -v notegit-data:/data notegit:0.1.0',
  'docker compose -f deploy/docker-compose.yml up -d --build',
];
// 任务卡指定的六项能力卡主题
const CAPABILITY_TITLES = [
  'Git 唯一真源',
  '三入口一致授权',
  '统一校验',
  '历史与还原',
  '全文检索',
  '备份恢复演练',
];

test('文档骨架：zh-CN 声明、viewport meta 与页面标题', () => {
  assert.match(html, /<html lang="zh-CN">/);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(html, /<title>Notegit — /);
});

test('hero 主标题使用 architecture §1 定位措辞（不夸大）', () => {
  assert.match(html, /<h1[^>]*>\s*Git 为唯一真源的企业知识库\s*<\/h1>/);
});

test('页头：产品名 + 一句话定位 + GitHub/文档双 CTA', () => {
  const header = html.match(/<header[\s\S]*?<\/header>/)?.[0] ?? '';
  assert.ok(header.length > 0, '应有 <header> 区块');
  assert.ok(header.includes('Notegit'), '页头应含产品名 Notegit');
  assert.ok(header.includes('人与 AI 共用的企业知识库'), '页头应含一句话定位');
  assert.ok(header.includes(`href="${GITHUB_URL}"`), '页头应有 GitHub CTA');
  assert.match(header, /href="docs\//, '页头应有文档 CTA（站内相对链接）');
});

test('核心能力卡网格 ≥ 6 张', () => {
  const count = (html.match(/<article class="feature-card"/g) ?? []).length;
  assert.ok(count >= 6, `能力卡应 ≥ 6 张，实际 ${count}`);
});

test('六项能力主题齐全（与任务卡清单一致）', () => {
  for (const title of CAPABILITY_TITLES) {
    assert.ok(html.includes(title), `缺少能力卡标题：${title}`);
  }
});

test('三入口说明段：Web / Git / CLI 与同一套权限', () => {
  const section = html.match(/<section id="entrances"[\s\S]*?<\/section>/)?.[0] ?? '';
  assert.ok(section.length > 0, '应有 id="entrances" 区段');
  for (const word of ['Web', 'Git', 'CLI']) {
    assert.ok(section.includes(word), `三入口段应提及 ${word}`);
  }
  assert.ok(section.includes('同一套权限'), '应说明三入口共用同一套库权限');
});

test('快速部署段如实摘录 deploy/README.md 三条命令', () => {
  for (const cmd of DEPLOY_COMMANDS) {
    assert.ok(html.includes(cmd), `部署段应逐字包含：${cmd}`);
  }
});

test('URL 契约：九个文档链接齐备', () => {
  for (const href of DOC_CONTRACT) {
    assert.ok(html.includes(`href="${href}"`), `缺少契约链接：${href}`);
  }
});

test('URL 契约：页面全部 docs/ 链接均在契约集内（无杜撰目标）', () => {
  const hrefs = [...html.matchAll(/href="(docs\/[^"]*)"/g)].map((m) => m[1]);
  assert.ok(hrefs.length > 0, '页面应存在 docs/ 链接');
  for (const href of hrefs) {
    assert.ok(DOC_CONTRACT.includes(href), `非契约 docs/ 链接：${href}`);
  }
});

test('零外部资源引用（GitHub 仓库链接除外）', () => {
  assert.ok(!/<script[^>]*\ssrc=/.test(html), '不得引用任何 script src');
  assert.ok(
    html.includes('<link rel="stylesheet" href="assets/site.css">'),
    '唯一样式表应为站内相对路径 assets/site.css',
  );
  assert.ok(!/<img[^>]*\ssrc="https?:/.test(html), '不得引用外部图片');
  const external = [...html.matchAll(/(?:href|src)="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
  for (const url of external) {
    assert.ok(url.startsWith(GITHUB_URL), `非 GitHub 外链：${url}`);
  }
});

test('CSS 在 :root 以语义名定义 DESIGN.md token', () => {
  for (const token of [
    '--canvas:',
    '--primary:',
    '--surface-dark:',
    '--ink:',
    '--font-display:',
    '--font-body:',
    '--spacing-section:',
    '--rounded-lg:',
  ]) {
    assert.ok(css.includes(token), `缺少 token 定义：${token}`);
  }
});

test('CSS 正文零裸 hex，颜色一律引用 token 变量', () => {
  const body = css.replace(/:root\s*\{[^}]*\}/g, '');
  const hex = body.match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}(?![0-9a-fA-F])/);
  assert.equal(hex, null, `token 定义之外出现裸 hex：${hex?.[0] ?? ''}`);
  const varRefs = (body.match(/var\(--/g) ?? []).length;
  assert.ok(varRefs >= 10, `token 变量引用应 ≥ 10 处，实际 ${varRefs}`);
});

test('移动端单列：≤767px 时网格塌缩为单列', () => {
  assert.match(css, /@media\s*\(max-width:\s*767px\)[\s\S]*?grid-template-columns:\s*1fr/);
});

test('能力宣称不越 known-limitations：不出现实时协作/多租户/SaaS', () => {
  assert.doesNotMatch(html, /实时协作|多租户|SaaS/);
});

test('页脚：版本 v0.2.0、许可证如实未声明、GitHub 链接', () => {
  const footer = html.match(/<footer[\s\S]*?<\/footer>/)?.[0] ?? '';
  assert.ok(footer.length > 0, '应有 <footer> 区块');
  assert.ok(footer.includes('v0.2.0'), '页脚应标版本 v0.2.0');
  assert.ok(footer.includes('许可证：未声明'), '页脚应如实写「许可证：未声明」（仓库无 LICENSE）');
  assert.ok(footer.includes(`href="${GITHUB_URL}"`), '页脚应有 GitHub 链接');
});
