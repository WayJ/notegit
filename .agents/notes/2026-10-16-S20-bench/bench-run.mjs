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
const out={env:{node:process.version,date:new Date().toISOString(),data:'bench-big 500 docs/20 commits + a/b/c 40 docs'},scenarios:{}};
// ① 并发读（tree 大库 + docs 单文档 + vaults + index-status + search）
const paths=['/api/v1/vaults','/api/v1/vaults/bench-big/tree','/api/v1/vaults/bench-big/docs/docs/d250.md','/api/v1/vaults/bench-big/index-status','/api/v1/search?q=文档'];
for(const lvl of [10,50,100]){
  out.scenarios[`read_c${lvl}`]=await concurrentRead(paths,lvl,Math.round(2000/lvl));
  console.log(`① 并发读 c${lvl}:`,JSON.stringify(out.scenarios[`read_c${lvl}`]));
}
// ② 突发写：CAS 链式顺序提交 ×30（每次 1 文档改）
// 经 index-status 取 head
const st=await (await fetch(BASE+'/api/v1/vaults/bench-big/index-status',{headers:H})).json();
let head=st.head_commit;
const wlat=[];const wt0=performance.now();
for(let i=0;i<30;i++){
  const s=performance.now();
  const r=await fetch(BASE+'/api/v1/vaults/bench-big/submissions',{method:'POST',headers:{cookie:alice,'content-type':'application/json',origin:BASE},body:JSON.stringify({base_commit:head,message:`bench write ${i}`,changes:[{path:`docs/d${String(i).padStart(3,'0')}.md`,content:`---\ntitle: bench ${i}\n---\n\n写基准 ${i}。`}]})});
  const j=await r.json().catch(()=>({}));
  wlat.push(performance.now()-s);
  if(r.status===201)head=j.commit; else {console.log('write fail at',i,r.status);break;}
}
out.scenarios.write_seq={...stats(wlat),wall_ms:Math.round(performance.now()-wt0),wps:+(wlat.length/(performance.now()-wt0)*1000).toFixed(2)};
console.log('② 顺序写×30:',JSON.stringify(out.scenarios.write_seq));
// ②b 并发冲突写：8 个并发同 base 提交——期望 1×201 + 7×409（CAS 背压）
const base=head;const res=[...Array(8)].map(()=>fetch(BASE+'/api/v1/vaults/bench-big/submissions',{method:'POST',headers:{cookie:alice,'content-type':'application/json',origin:BASE},body:JSON.stringify({base_commit:base,message:'conflict probe',changes:[{path:'docs/d001.md',content:'---\ntitle: 冲突探针\n---\n\nx'}]})}).then(r=>r.status));
const codes={};for(const c of await Promise.all(res))codes[c]=(codes[c]||0)+1;
out.scenarios.write_conflict={codes};
console.log('②b 并发冲突写×8:',JSON.stringify(codes),'(期望 201×1+409×7)');
// ③ 跨库扇出（agent 爬取型）：vaults → tree×4 → 每库 docs×20
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
fs.writeFileSync('/tmp/bench-results.json',JSON.stringify(out,null,1));
console.log('SAVED /tmp/bench-results.json');
