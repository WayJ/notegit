// S24-T2 基准复跑（E8 DOD-E8-02）：① 并发读梯度 + ③ agent 扇出 + 304 补测。
// 逻辑与 S20 归档脚本逐字同口径（bench-run.mjs ① / bench-run2.mjs ③）——仅
// 合并为一脚本并追加 304 探针；before 数字直接引用 capacity.md 不重测（S24 D4）。
import fs from 'node:fs';
const BASE='http://127.0.0.1:3211';
const cookie=f=>fs.readFileSync(f,'utf8').split('\n').filter(l=>l.includes('ngt_sid')).map(l=>l.split('\t').slice(-2).join('=')).join('; ');
const alice=cookie('/tmp/bench-alice.jar');
const H={cookie:alice};
const pct=(a,p)=>a.length?a[Math.min(a.length-1,Math.floor(a.length*p))]:0;
const stats=lat=>{const s=[...lat].sort((x,y)=>x-y);return {n:s.length,p50:Math.round(pct(s,.5)),p95:Math.round(pct(s,.95)),p99:Math.round(pct(s,.99)),max:Math.round(s[s.length-1]??0)};};
async function concurrentRead(paths,level,perWorker){
  const lat=[];let errs=0;const t0=performance.now();
  const worker=async()=>{for(let i=0;i<perWorker;i++){const p=paths[i%paths.length];const s=performance.now();try{const r=await fetch(BASE+p,{headers:H});await r.arrayBuffer();if(r.status!==200&&r.status!==304)errs++;}catch{errs++;}lat.push(performance.now()-s);}};
  await Promise.all(Array.from({length:level},worker));
  const wall=Math.round(performance.now()-t0);
  return {...stats(lat),errs,wall_ms:wall,rps:+(lat.length/wall*1000).toFixed(1)};
}
const out={env:{node:process.version,date:new Date().toISOString(),data:'bench-big 500 docs/20 commits + a/b/c 40 docs（fresh 种子，S24 同口径）',code:'sprint/S24 合并态（S24-T1 树缓存）'},scenarios:{}};
// ① 并发读（五读端点混合——与 S20 同五路径）
const paths=['/api/v1/vaults','/api/v1/vaults/bench-big/tree','/api/v1/vaults/bench-big/docs/docs/d250.md','/api/v1/vaults/bench-big/index-status','/api/v1/search?q=文档'];
for(const lvl of [10,50,100]){
  out.scenarios[`read_c${lvl}`]=await concurrentRead(paths,lvl,Math.round(2000/lvl));
  console.log(`① 并发读 c${lvl}:`,JSON.stringify(out.scenarios[`read_c${lvl}`]));
}
// ③ agent 扇出爬取（与 S20 同构：vaults → 每库全树 → 每库前 20 blob 并发）
const t3=performance.now();const lat3=[];
const vs=await (await fetch(BASE+'/api/v1/vaults',{headers:H})).json();
const trees={};
for(const v of vs.vaults){const s=performance.now();trees[v.slug]=await (await fetch(`${BASE}/api/v1/vaults/${v.slug}/tree`,{headers:H})).json();lat3.push(performance.now()-s);}
let docsFetched=0;
for(const v of vs.vaults){
  const blobs=(trees[v.slug].entries||[]).filter(e=>e.type==='blob').slice(0,20);
  await Promise.all(blobs.map(async b=>{const s=performance.now();const r=await fetch(`${BASE}/api/v1/vaults/${v.slug}/docs/${b.path}`,{headers:H});await r.arrayBuffer();lat3.push(performance.now()-s);docsFetched++;}));
}
out.scenarios.agent_fanout={...stats(lat3),requests:lat3.length,docs:docsFetched,wall_ms:Math.round(performance.now()-t3)};
console.log('③ 扇出爬取:',JSON.stringify(out.scenarios.agent_fanout));
// 304 补测（capacity.md 遗留项——agent 携带 If-None-Match 的节省）：tree 端点
// 首取 200 收 ETag，此后 50 次带 If-None-Match 复取（热度窗口内=缓存命中+304 短路）
const turl=BASE+'/api/v1/vaults/bench-big/tree';
const first=await fetch(turl,{headers:H});
const etag=first.headers.get('etag');
await first.arrayBuffer();
const l304=[];let codes={};
for(let i=0;i<50;i++){const s=performance.now();const r=await fetch(turl,{headers:{...H,'if-none-match':etag}});await r.arrayBuffer();codes[r.status]=(codes[r.status]||0)+1;l304.push(performance.now()-s);}
out.scenarios.conditional_get={etag_present:!!etag,codes,...stats(l304)};
console.log('304 补测:',JSON.stringify(out.scenarios.conditional_get));
fs.writeFileSync(new URL('./bench-results-s24.json',import.meta.url),JSON.stringify(out,null,1));
console.log('SAVED');
