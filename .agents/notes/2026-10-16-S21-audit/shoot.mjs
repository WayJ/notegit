import { chromium } from 'playwright-core';

const BASE = 'http://127.0.0.1:3210';
const OUT = '/tmp/notegit-shots';

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});

async function newPage(ctxOpts) {
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') console.log('[console.error]', page.url(), m.text().slice(0, 200)); });
  page.on('pageerror', e => console.log('[pageerror]', page.url(), String(e).slice(0, 200)));
  return { ctx, page };
}

async function login(page, user, pass) {
  await page.goto(BASE + '/login', { waitUntil: 'networkidle' });
  await page.fill('input[name=username]', user);
  await page.fill('input[name=password]', pass);
  await page.click('button[type=submit]');
  await page.waitForURL(u => !u.pathname.includes('login'), { timeout: 5000 });
}

const desktop = { viewport: { width: 1440, height: 900 }, baseURL: BASE };
const mobile = { viewport: { width: 390, height: 844 }, baseURL: BASE, isMobile: true, hasTouch: true };

// — anonymous: login page —
{
  const { ctx, page } = await newPage(desktop);
  await page.goto(BASE + '/login', { waitUntil: 'networkidle' });
  await page.screenshot({ path: `${OUT}/01-login.png`, fullPage: true });
  await ctx.close();
}

// — admin desktop —
{
  const { ctx, page } = await newPage(desktop);
  await login(page, 'admin', 'Admin-Demo-2026!');
  const shots = [
    ['02-home', '/'],
    ['03-vaults', '/vaults'],
    ['04-browse', '/vaults/product-notes'],
    ['05-doc', '/vaults/product-notes/docs/roadmap.md'],
    ['06-edit', '/vaults/product-notes/edit/docs/roadmap.md'],
    ['07-history', '/vaults/product-notes/history'],
    ['08-search', '/search?q=roadmap'],
    ['09-drafts', '/drafts'],
    ['10-credentials', '/credentials'],
    ['11-admin', '/admin'],
    ['12-activity', '/vaults/product-notes/activity'],
    ['13-notfound', '/vaults/nope'],
    ['14-empty-search', '/search?q=zzzznotfound'],
  ];
  for (const [name, url] of shots) {
    try {
      await page.goto(BASE + url, { waitUntil: 'networkidle' });
      await page.waitForTimeout(150);
      await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
      console.log('ok', name, '→', page.url().replace(BASE, ''));
    } catch (e) { console.log('FAIL', name, String(e).slice(0, 150)); }
  }
  await ctx.close();
}

// — admin mobile —
{
  const { ctx, page } = await newPage(mobile);
  await login(page, 'admin', 'Admin-Demo-2026!');
  const shots = [
    ['m1-home', '/'],
    ['m2-browse', '/vaults/product-notes'],
    ['m3-doc', '/vaults/product-notes/docs/roadmap.md'],
    ['m4-search', '/search?q=roadmap'],
    ['m5-admin', '/admin'],
  ];
  for (const [name, url] of shots) {
    try {
      await page.goto(BASE + url, { waitUntil: 'networkidle' });
      await page.waitForTimeout(150);
      await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
      console.log('ok', name);
    } catch (e) { console.log('FAIL', name, String(e).slice(0, 150)); }
  }
  await ctx.close();
}

// — bob (普通员工, 空权限视角) mobile+desktop home —
{
  const { ctx, page } = await newPage(desktop);
  await login(page, 'bob', 'Bob-Demo-2026!');
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${OUT}/15-bob-home.png`, fullPage: true });
  console.log('ok 15-bob-home');
  await ctx.close();
}

await browser.close();
console.log('DONE');
