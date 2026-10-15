// 只跑 ② 与 ③（读已测）
import fs from 'node:fs';
const BASE='http://127.0.0.1:3211';
const cookie=f=>fs.readFileSync(f,'utf8').split('\n').filter(l=>l.includes('ngt_sid')).map(l=>l.split('\t').slice(-2).join('=')).join('; ');
const alice=cookie('/tmp/bench-alice.jar');
const H={cookie:alice};
const pct=(a,p)=>a.length?a[Math.min(a.length-1,Math.floor(a.length*p))]:0;
const stats=lat=>{const s=[...lat].sort((x,y)=>x-y);return {n:s.length,p50:Math.round(pct(s,.5)),p95:Math.round(pct(s,.95)),p99:Math.round(pct(s,.99)),max:Math.round(s[s.length-1]??0)};};
const out=JSON.parse(fs.readFileSync('/tmp/bench-results.json','utf8'));
let head=(await (await fetch(BASE+'/api/v1/vaults/bench-big/index-status',{headers:H})).json()).head_commit;
const wlat=[];const wt0=performance.now();
for(let i=0;i<30;i++){
  const s=performance.now();
  const r=await fetch(BASE+'/api/v1/vaults/bench-big/submissions',{method:'POST',headers:{cookie:alice,'content-type':'application/json',origin:BASE},body:JSON.stringify({base_commit:head,message:`bench write ${i}`,changes:[{path:`docs/d${String(i).padStart(3,'0')}.md`,content:`---\ntitle: bench ${i}\n---\n\n写基准 ${i}。`}]})});
  const j=await r.json().catch(()=>({}));
  wlat.push(performance.now()-s);
  if(r.status===201)head=j.commit; else {console.log('write fail at',i,r.status,JSON.stringify(j).slice(0,100));break;}
}
out.scenarios.write_seq={...stats(wlat),wall_ms:Math.round(performance.now()-wt0),wps:+(wlat.length/(performance.now()-wt0)*1000).toFixed(2)};
console.log('② 顺序写×30:',JSON.stringify(out.scenarios.write_seq));
const base=head;
const res=[...Array(8)].map(()=>fetch(BASE+'/api/v1/vaults/bench-big/submissions',{method:'POST',headers:{cookie:alice,'content-type':'application/json',origin:BASE},body:JSON.stringify({base_commit:base,message:'conflict probe',changes:[{path:'docs/d001.md',content:'---\ntitle: 冲突探针\n---\n\nx'}]})}).then(r=>r.status));
const codes={};for(const c of await Promise.all(res))codes[c]=(codes[c]||0)+1;
out.scenarios.write_conflict={codes};
console.log('②b 并发冲突写×8:',JSON.stringify(codes),'(期望 201×1+409×7)');
// 写负载下的读（后台顺序写进行时并发读——简化：跑一轮读测受刚才写影响的索引延迟）
const st2=await (await fetch(BASE+'/api/v1/vaults/bench-big/index-status',{headers:H})).json();
console.log('②c 写后索引状态: lag_ms=',st2.lag_ms,'head=',st2.head_commit?.slice(0,7));
out.scenarios.write_index_lag={lag_ms:st2.lag_ms};
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
console.log('SAVED');
