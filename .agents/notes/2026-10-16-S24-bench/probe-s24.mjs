// S24 探针组（plan S3：302/401/404 同体/越权过滤——S21 同组零漂移核实）。
// 在 scratch :3211（S24 合并态代码）上执行；Secure cookie 下走 fetch + 手写 jar。
import fs from 'node:fs';
const BASE='http://127.0.0.1:3211';
const cookie=f=>fs.readFileSync(f,'utf8').split('\n').filter(l=>l.includes('ngt_sid')).map(l=>l.split('\t').slice(-2).join('=')).join('; ');
const alice=cookie('/tmp/bench-alice.jar');
const admin=cookie('/tmp/bench-admin.jar');
const results=[];
const check=(name,ok,detail='')=>{results.push({name,pass:ok,detail});console.log(ok?'PASS':'FAIL','—',name,detail?`(${detail})`:'');};

// P1 anon 页面 / → 302 /login
{
  const r=await fetch(BASE+'/',{redirect:'manual'});
  check('P1 anon / → 302 /login', r.status===302 && (r.headers.get('location')||'').includes('/login'), `${r.status} → ${r.headers.get('location')}`);
}
// P2 anon 库页面 → 302（未认证不泄露库存在性——重定向统一）
{
  const r=await fetch(BASE+'/vaults/bench-big',{redirect:'manual'});
  check('P2 anon vault 页 → 302', r.status===302, `${r.status}`);
}
// P3 anon API → 401
{
  const r=await fetch(BASE+'/api/v1/vaults');
  const body=await r.text();
  check('P3 anon API → 401', r.status===401 && body.includes('error'), `${r.status}`);
}
// P4 越权=不存在 同 404 同体（D-IC-06）：admin 建无 alice 授权库，alice 读之 vs 读不存在库
{
  const cr=await fetch(BASE+'/api/v1/vaults',{method:'POST',headers:{'content-type':'application/json',origin:BASE,cookie:admin},body:JSON.stringify({slug:'probe-priv',name:'probe-priv'})});
  const a=await fetch(BASE+'/api/v1/vaults/probe-priv/tree',{headers:{cookie:alice}});
  const ba=await a.text();
  const b=await fetch(BASE+'/api/v1/vaults/no-such-vault-xyz/tree',{headers:{cookie:alice}});
  const bb=await b.text();
  check('P4 越权 404 与不存在 404 逐字节同体', a.status===404 && b.status===404 && ba===bb, `create=${cr.status} priv=${a.status} none=${b.status} identical=${ba===bb}`);
}
// P5 favicon 200
{
  const r=await fetch(BASE+'/favicon.ico');
  check('P5 favicon 200', r.status===200, `${r.status} ${r.headers.get('content-type')}`);
}
// P6 协商缓存：ETag 在位 + cache-control no-cache（树端点，缓存层之上语义不变）
{
  const r=await fetch(BASE+'/api/v1/vaults/bench-big/tree',{headers:{cookie:alice}});
  await r.arrayBuffer();
  const cc=r.headers.get('cache-control')||'';
  const et=r.headers.get('etag')||'';
  check('P6 ETag+no-cache 在位', !!et && cc.includes('no-cache'), `etag=${et.slice(0,16)} cc=${cc}`);
}
// P7 缓存热窗内安全语义不漂移：anon 与未授权读在缓存热的情况下仍 401/404（先 admin 热读再探）
{
  await (await fetch(BASE+'/api/v1/vaults/probe-priv/tree',{headers:{cookie:admin}})).arrayBuffer(); // 热（admin 有权）
  const a=await fetch(BASE+'/api/v1/vaults/probe-priv/tree'); // anon
  const b=await fetch(BASE+'/api/v1/vaults/probe-priv/tree',{headers:{cookie:alice}}); // alice 无授权
  check('P7 缓存热时 anon 401 / 无授权 404', a.status===401 && b.status===404, `anon=${a.status} alice=${b.status}`);
}
const fails=results.filter(r=>!r.pass).length;
console.log(fails===0?`ALL ${results.length} PASS`:`${fails} FAIL / ${results.length}`);
fs.writeFileSync(new URL('./probe-s24.json',import.meta.url),JSON.stringify({date:new Date().toISOString(),results},null,1));
