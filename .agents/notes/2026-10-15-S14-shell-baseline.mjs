import fs from 'node:fs';
const BASE = 'http://127.0.0.1:3210';
const ROUTES = ['/', '/vaults', '/vaults/team-handbook', '/vaults/team-handbook/browse',
  '/vaults/team-handbook/browse/docs', '/vaults/team-handbook/view/docs/README.md',
  '/vaults/team-handbook/view/docs/travel.md', '/vaults/team-handbook/edit/docs/travel.md',
  '/vaults/team-handbook/edit/new', '/vaults/team-handbook/history',
  '/vaults/team-handbook/history/docs/travel.md', '/vaults/team-handbook/activity',
  '/vaults/team-handbook/upload', '/vaults/team-handbook/rename/docs/travel.md',
  '/vaults/team-handbook/delete/docs/travel.md', '/search', '/search?q=roadmap',
  '/drafts', '/cite', '/credentials', '/admin', '/login'];
function cookieOf(jar) {
  return fs.readFileSync(jar, 'utf8').split('\n')
    .filter(l => l.trim() && !l.startsWith('# '))
    .map(l => l.split('\t').slice(-2).join('=')).join('; ');
}
const roles = { alice: '/tmp/demo-alice.jar', bob: '/tmp/demo-bob.jar', admin: '/tmp/demo-admin.jar' };
const out = {};
for (const [role, jar] of Object.entries(roles)) {
  const cookie = cookieOf(jar);
  out[role] = {};
  for (const r of ROUTES) {
    const res = await fetch(BASE + r, { headers: { cookie }, redirect: 'manual' });
    const body = res.status === 200 ? await res.text() : '';
    const links = [...new Set([...body.matchAll(/href="([^"]+)"/g)].map(m=>m[1]).filter(h=>h.startsWith('/')))].sort();
    out[role][r] = { status: res.status, links };
  }
}
fs.writeFileSync('/tmp/s14-baseline.json', JSON.stringify(out, null, 1));
for (const [role, pages] of Object.entries(out)) {
  const codes = {};
  for (const v of Object.values(pages)) codes[v.status] = (codes[v.status]||0)+1;
  console.log(role, codes, 'links:', Object.values(pages).reduce((n,v)=>n+v.links.length,0));
}
