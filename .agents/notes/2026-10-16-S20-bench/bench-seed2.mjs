import fs from 'node:fs';
const BASE='http://127.0.0.1:3211';
const cookie=j=>fs.readFileSync(j,'utf8').split('\n').filter(l=>l.includes('ngt_sid')).map(l=>l.split('\t').slice(-2).join('=')).join('; ');
const adminC=cookie('/tmp/bench-admin.jar');
const H={ 'content-type':'application/json', origin:BASE };
const post=async(p,body,c)=>{const r=await fetch(BASE+p,{method:'POST',headers:{...H,cookie:c},body:JSON.stringify(body)});return {status:r.status,json:await r.json().catch(()=>({}))};};
// 库现状
const vs=await (await fetch(BASE+'/api/v1/vaults',{headers:{cookie:adminC}})).json();
console.log('existing vaults:', (vs.vaults||[]).map(v=>v.slug).join(','));
for(const s of ['bench-big','bench-a','bench-b','bench-c']) if(!(vs.vaults||[]).some(v=>v.slug===s)) console.log('create',s,(await post('/api/v1/vaults',{slug:s,name:s},adminC)).status);
// alice
let r=await post('/api/v1/admin/employees',{username:'alice',display_name:'测'},adminC);
let rt=r.json.password_reset_token;
if(!rt){console.log('invite resp:',r.status,JSON.stringify(r.json).slice(0,120));}
else {
  console.log('reset:',(await fetch(BASE+'/api/v1/auth/password-reset',{method:'POST',headers:H,body:JSON.stringify({reset_token:rt,new_password:'Alice-Bench-2026!x'})})).status);
}
const lg=await fetch(BASE+'/api/v1/auth/login',{method:'POST',headers:H,body:JSON.stringify({username:'alice',password:'Alice-Bench-2026!x'})});
const aliceC='ngt_sid='+(lg.headers.getSetCookie?.()[0]||'').split('ngt_sid=')[1]?.split(';')[0];
fs.writeFileSync('/tmp/bench-alice.c','x'); // 占位
console.log('alice login:', lg.status, aliceC?'cookie-ok':'cookie-fail');
for(const s of ['bench-big','bench-a','bench-b','bench-c'])
  console.log('grant',s,(await fetch(BASE+`/api/v1/vaults/${s}/members/alice`,{method:'PUT',headers:{...H,cookie:adminC},body:JSON.stringify({role:'editor'})})).status);
fs.writeFileSync('/tmp/bench-alice-cookie.txt',aliceC||'');
// bench-big：500 文档
const files=Array.from({length:500},(_,i)=>({path:`docs/d${String(i).padStart(3,'0')}.md`,content:`---\ntitle: 文档 ${i}\ntags: [bench, batch${i%10}]\n---\n\n# 文档 ${i}\n\n这是基准种子文档 ${i}。`.repeat(3)}));
const c0=await post('/api/v1/vaults/bench-big/submissions',{base_commit:null,message:'seed: 500 docs',changes:files},aliceC);
console.log('big seed:',c0.status,c0.json.commit?.slice(0,7)||JSON.stringify(c0.json).slice(0,120));
let head=c0.json.commit;
for(let k=1;k<=19;k++){
  const rr=await post('/api/v1/vaults/bench-big/submissions',{base_commit:head,message:`seed edit ${k}`,changes:[{path:`docs/d${String(k*7%500).padStart(3,'0')}.md`,content:`---\ntitle: 文档 ${k*7%500} rev${k}\n---\n\n第 ${k} 次修订。`}]},aliceC);
  if(rr.status!==201){console.log('edit fail',k,rr.status);break;}
  head=rr.json.commit;
}
console.log('big history:',head?.slice(0,7));
for(const s of ['bench-a','bench-b','bench-c']){
  const fs40=Array.from({length:40},(_,i)=>({path:`docs/f${i}.md`,content:`---\ntitle: ${s}-${i}\n---\n\n${s} 文档 ${i}。`}));
  console.log(s,'seed:',(await post(`/api/v1/vaults/${s}/submissions`,{base_commit:null,message:'seed',changes:fs40},aliceC)).status);
}
console.log('SEED DONE');
